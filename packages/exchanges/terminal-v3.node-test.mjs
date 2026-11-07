import assert from 'node:assert/strict';
import { test } from 'node:test';
import { protectionMatches } from './terminal-execution.mjs';
const mod = await import('./terminal-bitget-v3.mjs').catch(() => ({}));
const creds = { apiKey: 'fixture-key', secret: 'secret', passphrase: 'pass' };
test('OpenTrader explicitly selects API family instead of autodetecting or sharing cache', async () => {
  const profile = await import('./bitget-api-profile.mjs').catch(() => ({}));
  assert.equal(typeof profile.applyBitgetApi, 'function');
  const client = { options: {} };
  profile.applyBitgetApi(client, 'v3'); assert.equal(client.options.uta, true);
  profile.applyBitgetApi(client, 'v2'); assert.equal(client.options.uta, false);
  assert.throws(() => profile.applyBitgetApi(client, 'v4'));
});
test('Unified routes normalize account, positions, order state and protected submission', async () => {
  assert.equal(typeof mod.createBitgetV3, 'function');
  const calls = [];
  const data = {
    'account/assets': { usdtEquity: '1000', assets: [{ coin: 'USDT', available: '900' }] },
    'account/settings': { holdMode: 'one_way_mode', symbolConfigList: [{ symbol: 'BTCUSDT', category: 'USDT-FUTURES', marginMode: 'isolated', leverage: '1' }] },
    'position/current-position': { list: [{ symbol: 'BTCUSDT', posSide: 'long', holdMode: 'one_way_mode', total: '0.001', unrealisedPnl: '0' }] },
    'trade/unfilled-orders': { list: [] }, 'trade/unfilled-strategy-orders': [],
    'market/instruments': [{ symbol: 'BTCUSDT', quantityMultiplier: '0.0001', minOrderQty: '0.0001', minOrderAmount: '5', priceMultiplier: '0.1', maxOrderQty: '100', status: 'online' }],
    'market/tickers': [{ symbol: 'BTCUSDT', lastPrice: '100000', ts: '1800000000000' }],
    'trade/order-info': { orderStatus: 'cancelled', cumExecQty: '0.001', avgPrice: '100000' },
    'trade/place-order': { orderId: '123' },
  };
  const client = mod.createBitgetV3('demo', creds, async (url, options) => {
    const path = new URL(url).pathname.replace('/api/v3/', ''); calls.push({ path, ...options });
    assert.equal(options.headers.paptrading, '1');
    return { ok: true, json: async () => ({ code: '00000', data: data[path] }) };
  });
  const ctx = await client.context('BTCUSDT');
  assert.equal(ctx.account.posMode, 'one_way_mode'); assert.equal(ctx.available, 900);
  assert.equal(ctx.positions[0].holdSide, 'long');
  data['market/instruments'][0].maxOrderQty = '0';
  assert.equal((await client.context('BTCUSDT')).rules.maxSize, Number.MAX_SAFE_INTEGER);
  const entry = { id: 'entry', closeId: 'close', symbol: 'BTCUSDT', quantity: .001, limit: 100000, side: 'long', stop: 98000, target: 104000 };
  data['trade/unfilled-strategy-orders'] = [{ symbol: 'BTCUSDT', type: 'tpsl', status: 'pending', side: 'sell', posSide: 'short', qty: '.001', stopLoss: '98000', takeProfit: '104000', slOrderType: 'market', tpOrderType: 'market' }];
  assert.equal(protectionMatches(await client.protection('BTCUSDT'), { ...entry, tick: .1 }, .001), true);
  data['trade/unfilled-strategy-orders'][0].type = 'trigger';
  assert.equal((await client.protection('BTCUSDT')).length, 0);
  data['trade/unfilled-strategy-orders'] = [];
  assert.equal((await client.detail(entry)).state, 'canceled');
  await client.submit(entry);
  const body = JSON.parse(calls.at(-1).body);
  assert.equal(body.qty, '0.001'); assert.equal(body.timeInForce, 'ioc'); assert.equal(body.stopLoss, '98000');
  await client.close(entry, .001); assert.equal(JSON.parse(calls.at(-1).body).reduceOnly, 'yes');
  data['account/assets'] = { usdtEquity: '0', assets: [] };
  data['position/current-position'] = { list: null };
  assert.equal((await client.context('BTCUSDT')).available, 0);
  await assert.rejects(client.request('POST', 'account/withdraw', {}));
});
test('Unified adapter rejects invalid version environments and malformed exposure', async () => {
  assert.equal(typeof mod.createBitgetV3, 'function');
  assert.throws(() => mod.createBitgetV3('unknown', creds));
  const client = mod.createBitgetV3('live', creds, async (_url, opts) => {
    assert.equal(opts.headers.paptrading, undefined);
    return { ok: true, json: async () => ({ code: '00000', data: { list: [{ symbol: 'BTCUSDT', total: null }] } }) };
  });
  await assert.rejects(client.positions());
  assert.deepEqual(mod.normalizeUnifiedPositions({ list: null }), []);
  assert.throws(() => mod.normalizeUnifiedPositions({}));
});
