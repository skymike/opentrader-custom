import { randomUUID } from 'node:crypto';
import { registerMarkets } from './terminal-markets-api.mjs';
import { readMarkets } from './terminal-markets.mjs';
import { join } from 'node:path';
import { createTradingClient } from './terminal-exchange-router.mjs';
import { checkConnection, withConnectionCheck } from './terminal-connection-check.mjs';
import { tradingPath, defaultSettings, validateSettings, emptyJournal, validateJournal, activeEntry,
  readJson, atomicJson, withTradingLock } from './terminal-trading-store.mjs';

const fail = (status, message) => { const error = new Error(message); error.status = status; throw error; };
async function load() {
  const directory = tradingPath();
  return { directory,
    settings: validateSettings(await readJson(join(directory, 'settings.json'), defaultSettings())),
    connections: await readJson(join(directory, 'connections.json'), {}),
    journal: validateJournal(await readJson(join(directory, 'journal.json'), emptyJournal())) };
}
function present({ settings, connections, journal }) {
  return { settings, connections: Object.fromEntries(['demo', 'live'].map((environment) => [environment,
    { configured: !!connections[environment]?.credentials, revision: connections[environment]?.revision ?? null, apiVersion: connections[environment]?.apiVersion ?? 'v2' }])),
    journal: { ...journal, entries: journal.entries.slice(-100), handled: undefined },
    stale: !journal.updatedAt || Date.now() - journal.updatedAt > 30000 };
}
export function registerTrading(app, authorize) {
  registerMarkets(app, authorize);
  const base = '/api/terminal/trading';
  const guarded = (fn) => async (request, reply) => {
    try { return await fn(request); }
    catch (error) { return reply.code(error.status ?? 503).send({ message: error.status ? error.message : 'Trading service busy or unavailable. Retry shortly; check worker status if this persists.' }); }
  };
  app.get(base, { preHandler: authorize }, guarded(async () => present(await load())));
  app.post(base + '/connection/check', { preHandler: authorize, bodyLimit: 512 }, guarded(request => {
    const environment = request.body?.environment;
    if (!['demo', 'live'].includes(environment)) fail(400, 'Choose demo or live');
    return withConnectionCheck(tradingPath() + ':' + environment, async () => {
      const connection = (await load()).connections[environment];
      if (!connection?.credentials) fail(404, 'Save this execution key first');
      if (request.body?.revision !== connection.revision) fail(409, 'Connection changed. Refresh and test again.');
      const result = await checkConnection({ ...connection, environment, apiVersion: connection.apiVersion ?? 'v2' });
      if ((await load()).connections[environment]?.revision !== connection.revision) fail(409, 'Connection changed during the test. Test the updated key again.');
      return { ...result, revision: connection.revision };
    });
  }));
  app.put(base, { preHandler: authorize, bodyLimit: 2048 }, guarded(async (request) => withTradingLock(tradingPath(), async () => {
    const state = await load(), body = request.body;
    if (!body || body.revision !== state.settings.revision) fail(409, 'Settings changed; refresh before saving');
    const next = { revision: randomUUID(), environment: body.environment, mode: body.mode, armed: body.armed,
      maxNotional: body.maxNotional, riskPct: body.riskPct, dailyLossPct: body.dailyLossPct };
    try { validateSettings(next); } catch { fail(400, 'Choose valid trading modes and limits'); }
    const switching = next.environment !== state.settings.environment || next.mode !== state.settings.mode;
    if (switching) next.armed = false;
    if (next.armed && !state.connections[next.environment]?.credentials) fail(400, 'Save trading credentials for this environment first');
    if (next.armed && next.environment === 'live' && body.liveAcknowledgement !== 'ENABLE LIVE TRADING') fail(400, 'Type ENABLE LIVE TRADING to enable real orders');
    state.settings = next;
    await atomicJson(join(state.directory, 'settings.json'), next);
    state.journal.proposals = [];
    delete state.journal.demoTest;
    await atomicJson(join(state.directory, 'journal.json'), state.journal);
    return present(state);
  })));
  app.route({ method: ['PUT', 'DELETE'], url: base + '/connection', preHandler: authorize, bodyLimit: 4096,
    handler: guarded(async (request) => withTradingLock(tradingPath(), async () => {
      const state = await load(), body = request.body;
      const environment = body?.environment;
      if (!['demo', 'live'].includes(environment)) fail(400, 'Choose demo or live');
      if (state.journal.entries.some((entry) => entry.environment === environment && activeEntry(entry))) fail(409, 'Resolve managed orders and positions before replacing this connection');
      if (request.method === 'DELETE') delete state.connections[environment];
      else {
        const apiVersion = body.apiVersion ?? 'v2';
        if (!['v2', 'v3'].includes(apiVersion)) fail(400, 'Choose Classic V2 or Unified V3');
        let credentials = state.connections[environment]?.credentials;
        if (!['apiKey', 'secret', 'passphrase'].every((key) => body[key] === undefined || body[key] === '')) {
          if (!['apiKey', 'secret', 'passphrase'].every((key) => typeof body[key] === 'string' && body[key].trim().length && body[key].length <= 512 && !/[\r\n\x00]/.test(body[key]))) fail(400, 'Enter all three credentials');
          credentials = { apiKey: body.apiKey.trim(), secret: body.secret.trim(), passphrase: body.passphrase };
        }
        if (!credentials) fail(400, 'Enter all three credentials');
        if (Object.entries(state.connections).some(([name, value]) => name !== environment && value.credentials?.apiKey === credentials.apiKey)) fail(400, 'Demo and live must use different API keys');
        state.connections[environment] = { revision: randomUUID(), apiVersion, credentials };
      }
      // Persist disarm before replacing credentials; a crash between writes cannot arm the replacement.
      state.settings = { ...state.settings, armed: false, revision: randomUUID() };
      await atomicJson(join(state.directory, 'settings.json'), state.settings);
      await atomicJson(join(state.directory, 'connections.json'), state.connections);
      state.journal.proposals = [];
      delete state.journal.days[environment]; delete state.journal.accounts[environment];
      await atomicJson(join(state.directory, 'journal.json'), state.journal);
      return present(state);
    })) });
  app.post(base + '/check', { preHandler: authorize, bodyLimit: 512 }, guarded(async (request) => {
    const state = await load(), environment = request.body?.environment;
    if (!['demo', 'live'].includes(environment)) fail(400, 'Choose demo or live');
    const connection = state.connections[environment];
    if (!connection?.credentials) fail(400, 'Save this connection first');
    try {
      const context = await createTradingClient(environment, connection.credentials, connection.apiVersion ?? 'v2').context('BTCUSDT');
      return { connected: true, environment, apiVersion: connection.apiVersion ?? 'v2', equity: context.equity, available: context.available,
        positions: context.positions.length, orders: context.orders.length, account: context.account };
    } catch (error) { fail(400, 'Connection check failed' + (error.exchangeCode ? ' (Bitget code ' + error.exchangeCode + ')' : '') + '. Check API type, demo/live key and permissions.'); }
  }));
  app.post(base + '/demo-test', { preHandler: authorize, bodyLimit: 512 }, guarded(async (request) => withTradingLock(tradingPath(), async () => {
    const state = await load();
    if (state.settings.environment !== 'demo' || !state.settings.armed) fail(400, 'Enable demo entries before requesting a test trade');
    const symbol = request.body?.symbol;
    if (!(await readMarkets()).pairs.some(pair => pair.symbol === symbol && pair.watch && pair.trade)) fail(400, 'Choose a pair enabled for Trade.');
    if (state.journal.entries.some(activeEntry)) fail(409, 'Close and reconcile the previous test first');
    state.journal.demoTest = { id: randomUUID(), symbol, createdAt: Date.now(), expiresAt: Date.now() + 300000 };
    state.journal.proposals = [];
    await atomicJson(join(state.directory, 'journal.json'), state.journal);
    return { queued: true, environment: 'demo', maxNotional: 20, mode: state.settings.mode };
  })));
  app.post(base + '/command', { preHandler: authorize, bodyLimit: 1024 }, guarded(async (request) => withTradingLock(tradingPath(), async () => {
    const state = await load(), body = request.body;
    if (!['approve', 'reject', 'close', 'reset-halt'].includes(body?.action)) fail(400, 'Unknown trading action');
    const command = { id: randomUUID(), action: body.action, environment: state.settings.environment,
      revision: state.settings.revision, expiresAt: Date.now() + 60000 };
    if (['approve', 'reject'].includes(body.action)) {
      const proposal = state.journal.proposals.find((p) => p.id === body.proposalId && p.revision === state.settings.revision && p.expiresAt > Date.now());
      if (!proposal || !state.settings.armed || state.settings.mode !== 'approval' || Date.now() - state.journal.updatedAt > 30000) fail(409, 'Proposal expired or settings changed; refresh');
      command.proposalId = proposal.id;
      command.expiresAt = proposal.expiresAt;
    } else if (body.action === 'close') {
      const entry = state.journal.entries.find((e) => e.id === body.entryId && activeEntry(e));
      if (!entry) fail(409, 'No active managed order found');
      command.entryId = entry.id; command.environment = entry.environment;
    } else {
      if (state.journal.entries.some(activeEntry)) fail(409, 'Reconcile outstanding orders before resetting a halt');
      delete state.journal.halted[state.settings.environment];
      await atomicJson(join(state.directory, 'journal.json'), state.journal);
      return { queued: false, message: 'Halt reset; daily loss limits remain in effect' };
    }
    const commands = await readJson(join(state.directory, 'commands.json'), []);
    const pending = commands.filter((c) => c.expiresAt >= Date.now() && !state.journal.handled.includes(c.id));
    if (pending.length >= 50) fail(409, 'Wait for pending commands to finish');
    pending.push(command);
    await atomicJson(join(state.directory, 'commands.json'), pending);
    return { queued: true, commandId: command.id };
  })));
}
