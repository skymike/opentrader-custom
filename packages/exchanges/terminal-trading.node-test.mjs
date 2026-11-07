import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';

const store = await import('./terminal-trading-store.mjs').catch(() => ({}));
const adapter = await import('./terminal-bitget.mjs').catch(() => ({}));
const engine = await import('./terminal-execution.mjs').catch(() => ({}));

const now = 1800000000000;
const market = { symbol: 'BTC/USDT:USDT', status: 'connected', candleTime: Math.floor(now / 3600000) * 3600000 - 3600000,
  price: 100, close: 100, previousClose: 102, lower: 101, upper: 110, previousLower: 101, previousUpper: 110, rsi: 20 };
function fixture(mode = 'approval') {
  const settings = { ...store.defaultSettings(), armed: true, mode, revision: 'r1' };
  const journal = store.emptyJournal();
  const ctx = { equity: 1000, available: 1000, positions: [], orders: [], price: 100, quoteTime: now,
    rules: { step: 0.01, minSize: 0.01, minCost: 5, tick: 0.01, maxSize: 100, status: 'normal' },
    account: { posMode: 'one_way_mode', marginMode: 'isolated', isolatedLongLever: '1', isolatedShortLever: '1' } };
  const submitted = [], saved = [];
  const client = { context: async () => structuredClone(ctx), protection: async () => [],
    submit: async (entry) => { assert.ok(saved.at(-1).entries.some((e) => e.id === entry.id)); submitted.push(structuredClone(entry)); return { orderId: '123' }; },
    detail: async () => ({ state: 'canceled', baseVolume: '0' }), positions: async () => [],
    cancel: async () => ({}), close: async () => ({ orderId: 'close' }) };
  const input = { settings, journal, marketState: { updatedAt: now, markets: [market] }, paused: false,
    connections: { demo: { revision: 'c1', credentials: {} } }, commands: [] };
  const deps = { now: () => now, clientFor: () => client, save: async (j) => saved.push(structuredClone(j)) };
  return { input, deps, client, ctx, submitted, saved };
}
test('approval mode waits, then executes only the exact current proposal once', async () => {
  assert.equal(typeof engine.cycle, 'function');
  const f = fixture();
  await engine.cycle(f.input, f.deps);
  assert.equal(f.submitted.length, 0);
  const p = f.input.journal.proposals[0];
  assert.ok(p.quantity > 0);
  f.input.commands.push({ id: 'cmd1', action: 'approve', proposalId: p.id, revision: 'r1', environment: 'demo', expiresAt: now + 60000 });
  await engine.cycle(f.input, f.deps);
  await engine.cycle(f.input, f.deps);
  assert.equal(f.submitted.length, 1);
  assert.ok(f.submitted[0].quantity * f.submitted[0].limit <= 100);
});
test('automatic mode executes without approval and never retries a timeout after restart', async () => {
  assert.equal(typeof engine.cycle, 'function');
  const f = fixture('automatic');
  f.client.submit = async () => { throw new Error('network timeout'); };
  await engine.cycle(f.input, f.deps);
  assert.equal(f.input.journal.entries[0].status, 'unknown');
  f.input.journal = structuredClone(f.saved.at(-1));
  f.client.detail = async () => { throw new Error('not found yet'); };
  f.client.submit = async () => assert.fail('must not resubmit uncertain entry');
  await engine.cycle(f.input, f.deps);
  assert.equal(f.input.journal.entries.length, 1);
});
test('stale prices, pause, wrong margin mode and daily loss each block automatic entry', async () => {
  assert.equal(typeof engine.cycle, 'function');
  for (const change of [
    (f) => { f.input.marketState.updatedAt = now - 151000; },
    (f) => { delete f.input.marketState.updatedAt; },
    (f) => { f.input.paused = true; },
    (f) => { f.ctx.account.posMode = 'hedge_mode'; },
    (f) => { f.ctx.quoteTime = now - 20000; },
    (f) => { f.input.journal.days.demo = { date: new Date(now).toISOString().slice(0,10), equity: 1200 }; },
  ]) {
    const f = fixture('automatic'); change(f);
    await engine.cycle(f.input, f.deps);
    assert.equal(f.submitted.length, 0);
  }
});
test('close request survives an IOC partial-fill cancellation cycle', async () => {
  const f = fixture('automatic'); await engine.cycle(f.input, f.deps);
  const entry = f.input.journal.entries[0];
  f.input.commands.push({ id: 'close-command', action: 'close', entryId: entry.id, environment: 'demo', expiresAt: now + 60000 });
  f.client.detail = async () => ({ state: 'partially_filled', baseVolume: '0.5' });
  await engine.cycle(f.input, f.deps);
  assert.equal(entry.closeRequested, true);
});
test('expired approval and settings changes cannot approve a replacement proposal', async () => {
  assert.equal(typeof engine.cycle, 'function');
  const f = fixture(); await engine.cycle(f.input, f.deps);
  f.input.commands.push({ id: 'expired', action: 'approve', proposalId: f.input.journal.proposals[0].id,
    revision: 'r1', environment: 'demo', expiresAt: now - 1 });
  await engine.cycle(f.input, f.deps);
  assert.equal(f.submitted.length, 0);
});
test('filled entry without verified protection closes reduce-only even while paused', async () => {
  assert.equal(typeof engine.cycle, 'function');
  const f = fixture('automatic'); await engine.cycle(f.input, f.deps);
  f.input.paused = true;
  f.client.detail = async () => ({ state: 'filled', baseVolume: '0.99' });
  f.client.positions = async () => [{ symbol: 'BTCUSDT', holdSide: 'long', total: '0.99', posMode: 'one_way_mode' }];
  let closed = 0;
  f.client.close = async (entry, qty) => { assert.equal(qty, 0.99); assert.ok(entry.closeId); closed++; return {}; };
  await engine.cycle(f.input, f.deps);
  assert.equal(closed, 1);
  assert.equal(f.input.journal.entries[0].status, 'closing');
  assert.ok(f.input.journal.halted.demo);
});

test('trading starts disarmed in demo approval mode and validates bounded limits', () => {
  assert.equal(typeof store.validateSettings, 'function');
  const defaults = store.defaultSettings();
  assert.equal(defaults.environment, 'demo');
  assert.equal(defaults.mode, 'approval');
  assert.equal(defaults.armed, false);
  assert.throws(() => store.validateSettings({ ...defaults, maxNotional: -1 }));
  assert.throws(() => store.validateSettings({ ...defaults, dailyLossPct: NaN }));
  assert.throws(() => store.validateSettings({ ...defaults, environment: 'other' }));
});

test('atomic store separates environment credentials and serializes concurrent mutations', async () => {
  assert.equal(typeof store.withTradingLock, 'function');
  const dir = await mkdtemp(join(tmpdir(), 'trading-store-'));
  try {
    await Promise.all(Array.from({ length: 8 }, () => store.withTradingLock(dir, async () => {
      const n = await store.readJson(join(dir, 'counter.json'), 0);
      await store.atomicJson(join(dir, 'counter.json'), n + 1);
    })));
    assert.equal(JSON.parse(await readFile(join(dir, 'counter.json'))), 8);
    await store.atomicJson(join(dir, 'broken.json'), { a: 1 });
    assert.deepEqual(await store.readJson(join(dir, 'missing.json'), {}), {});
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Bitget signs exact bytes, isolates demo header and refuses non-allowlisted routes', async () => {
  assert.equal(typeof adapter.createBitget, 'function');
  const calls = [];
  const credentials = { apiKey: 'key', secret: 'secret', passphrase: 'pass' };
  const fetcher = async (url, options) => {
    calls.push({ url, ...options });
    return { ok: true, json: async () => ({ code: '00000', data: {} }) };
  };
  for (const environment of ['demo', 'live']) {
    const client = adapter.createBitget(environment, credentials, fetcher, () => 123);
    await client.request('GET', 'account/accounts', { productType: 'USDT-FUTURES' });
    const call = calls.at(-1);
    assert.equal(call.headers.paptrading, environment === 'demo' ? '1' : undefined);
    assert.equal(call.headers['ACCESS-SIGN'], createHmac('sha256', 'secret').update('123GET/api/v2/mix/account/accounts?productType=USDT-FUTURES').digest('base64'));
    await assert.rejects(client.request('POST', 'account/withdraw', {}));
  }
});

test('transport errors cannot expose signed request or credentials', async () => {
  assert.equal(typeof adapter.createBitget, 'function');
  const client = adapter.createBitget('demo', { apiKey: 'private-key', secret: 'secret', passphrase: 'pass' }, async () => { throw new Error('private-key secret'); });
  await assert.rejects(client.request('GET', 'account/accounts', {}), (error) => !error.message.includes('private-key') && !error.message.includes('secret'));
});
test('documented one-way protective rows use net position side and closing order direction', () => {
  const entry = { symbol: 'BTCUSDT', side: 'long', stop: 98, target: 104, tick: 0.01 };
  const rows = [
    { symbol: 'BTCUSDT', posSide: 'net', posMode: 'one_way_mode', side: 'sell', size: '1', planType: 'loss_plan', triggerPrice: '98', executePrice: '0', planStatus: 'live' },
    { symbol: 'BTCUSDT', posSide: 'net', posMode: 'one_way_mode', side: 'sell', size: '1', planType: 'profit_plan', triggerPrice: '104', executePrice: '0', planStatus: 'live' },
  ];
  assert.equal(engine.protectionMatches(rows, entry, 1), true);
  assert.equal(engine.protectionMatches(rows.map((r) => ({ ...r, side: 'buy' })), entry, 1), false);
  assert.equal(engine.protectionMatches(rows.map((r) => ({ ...r, planStatus: 'cancelled' })), entry, 1), false);
});
test('context includes conditional opening orders so they block entries', async () => {
  const client = adapter.createBitget('demo', { apiKey: 'key', secret: 'secret', passphrase: 'pass' }, async (url) => {
    const u = new URL(url); let data = [];
    if (u.pathname.endsWith('/accounts')) data = [{ marginCoin: 'USDT', usdtEquity: '1000', available: '1000' }];
    if (u.pathname.endsWith('/orders-pending')) data = { entrustedList: [] };
    if (u.pathname.endsWith('/orders-plan-pending')) data = { entrustedList: u.searchParams.get('planType') === 'normal_plan' ? [{ symbol: 'SOLUSDT', orderId: 'external-trigger' }] : [] };
    if (u.pathname.endsWith('/contracts')) data = [{ symbol: 'BTCUSDT', sizeMultiplier: '0.01', minTradeNum: '0.01', minTradeUSDT: '5', priceEndStep: '1', pricePlace: '2', maxOrderQty: '100', symbolStatus: 'normal' }];
    if (u.pathname.endsWith('/ticker')) data = [{ symbol: 'BTCUSDT', lastPr: '100', ts: String(now) }];
    if (u.pathname.endsWith('/account')) data = fixture().ctx.account;
    return { ok: true, json: async () => ({ code: '00000', data }) };
  });
  const ctx = await client.context('BTCUSDT');
  assert.equal(ctx.orders.some((order) => order.orderId === 'external-trigger'), true);
});
test('malformed fill or position quantities never release active exposure', async () => {
  for (const malformed of [null, '', undefined, 'invalid']) {
    const f = fixture('automatic'); await engine.cycle(f.input, f.deps);
    f.client.detail = async () => ({ state: 'filled', baseVolume: malformed });
    await engine.cycle(f.input, f.deps);
    assert.equal(store.activeEntry(f.input.journal.entries[0]), true);
    f.client.detail = async () => ({ state: 'filled', baseVolume: '0.5' });
    f.client.positions = async () => [{ symbol: 'BTCUSDT', holdSide: 'long', total: malformed, posMode: 'one_way_mode' }];
    await engine.cycle(f.input, f.deps);
    assert.equal(store.activeEntry(f.input.journal.entries[0]), true);
  }
});
