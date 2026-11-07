import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
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
    { configured: !!connections[environment]?.credentials, revision: connections[environment]?.revision ?? null }])),
    journal: { ...journal, entries: journal.entries.slice(-100), handled: undefined },
    stale: !journal.updatedAt || Date.now() - journal.updatedAt > 30000 };
}
export function registerTrading(app, authorize) {
  const base = '/api/terminal/trading';
  const guarded = (fn) => async (request, reply) => {
    try { return await fn(request); }
    catch (error) { return reply.code(error.status ?? 503).send({ message: error.status ? error.message : 'Trading service busy or unavailable. Retry shortly; check worker status if this persists.' }); }
  };
  app.get(base, { preHandler: authorize }, guarded(async () => present(await load())));
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
        if (!['apiKey', 'secret', 'passphrase'].every((key) => typeof body[key] === 'string' && body[key].trim().length && body[key].length <= 512 && !/[\r\n\x00]/.test(body[key]))) fail(400, 'Enter all three credentials');
        if (Object.entries(state.connections).some(([name, value]) => name !== environment && value.credentials?.apiKey === body.apiKey.trim())) fail(400, 'Demo and live must use different API keys');
        state.connections[environment] = { revision: randomUUID(), credentials: { apiKey: body.apiKey.trim(), secret: body.secret.trim(), passphrase: body.passphrase } };
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
