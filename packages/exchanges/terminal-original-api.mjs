import { join } from 'node:path';
import { apiProfilePath, readApiProfiles } from './bitget-api-profile.mjs';
import { atomicJson, readJson, tradingPath, withTradingLock, activeEntry } from './terminal-trading-store.mjs';
import { createTradingClient } from './terminal-exchange-router.mjs';
const fail = (status, message) => { const e = new Error(message); e.status = status; throw e; };
async function dependencies() {
  const [{ xprisma }, { exchangeProvider }] = await Promise.all([import('@opentrader/db'), import('@opentrader/exchanges')]);
  return { db: xprisma, provider: exchangeProvider };
}
export function registerOriginalApi(app, authorize, getDependencies = dependencies, clientFactory = createTradingClient) {
  const guarded = (fn) => async (req, reply) => {
    try { return await fn(req); } catch (error) { return reply.code(error.status ?? 503).send({ message: error.status ? error.message : 'Account operation failed. Check API type, permissions and connection.' }); }
  };
  async function requireIdle(db, id) {
    if (await db.bot.count({ where: { enabled: true, OR: [{ exchangeAccountId: id }, { additionalExchangeAccounts: { some: { id } } }] } }) ||
        await db.order.count({ where: { exchangeAccountId: id, status: { in: ['Idle', 'Placed'] } } })) fail(409, 'Stop this account’s bots and settle pending orders before switching API');
  }
  async function check(account, apiVersion) {
    const client = clientFactory(account.isDemoAccount ? 'demo' : 'live',
      { apiKey: account.apiKey, secret: account.secretKey, passphrase: account.password }, apiVersion);
    const context = await client.context('BTCUSDT');
    if (context.positions.length || context.orders.length) fail(409, 'Settle exchange positions and orders before switching API');
    return context;
  }
  app.get('/api/terminal/opentrader/accounts', { preHandler: authorize }, guarded(async () => {
    const { db } = await getDependencies();
    const profiles = readApiProfiles();
    return { accounts: (await db.exchangeAccount.findMany({ where: { exchangeCode: 'BITGET' } })).map((a) =>
      ({ id: a.id, name: a.name, environment: a.isDemoAccount ? 'demo' : 'live', apiVersion: profiles[a.id] ?? 'v2', expired: a.expired })) };
  }));
  app.put('/api/terminal/opentrader/accounts', { preHandler: authorize, bodyLimit: 512 }, guarded(async (req) => {
    const { id, apiVersion } = req.body ?? {};
    if (!Number.isSafeInteger(id) || !['v2', 'v3'].includes(apiVersion)) fail(400, 'Select an account and API');
    const { db, provider } = await getDependencies();
    const account = await db.exchangeAccount.findUnique({ where: { id } });
    if (account?.exchangeCode !== 'BITGET') fail(404, 'Bitget account not found');
    await requireIdle(db, id);
    return withTradingLock(tradingPath(), async () => {
      const journal = await readJson(join(tradingPath(), 'journal.json'), { entries: [] });
      if (journal.entries.some(activeEntry)) fail(409, 'Settle terminal-managed exposure before switching');
      await check(account, apiVersion);
      const profiles = readApiProfiles(); profiles[id] = apiVersion;
      await atomicJson(apiProfilePath(), profiles);
      provider.removeByAccountId(id);
      await db.exchangeAccount.update({ where: { id }, data: { expired: false } });
      return { saved: true, apiVersion };
    });
  }));
  app.post('/api/terminal/opentrader/import-demo', { preHandler: authorize, bodyLimit: 512 }, guarded(async () => withTradingLock(tradingPath(), async () => {
    const { db, provider } = await getDependencies();
    const connection = (await readJson(join(tradingPath(), 'connections.json'), {})).demo;
    if (!connection?.credentials) fail(400, 'Save your demo key in the terminal first');
    const journal = await readJson(join(tradingPath(), 'journal.json'), { entries: [] });
    if (journal.entries.some(activeEntry)) fail(409, 'Settle managed exposure before connecting another panel');
    const users = await db.user.findMany({ where: { role: 'Admin' }, take: 2 });
    if (users.length !== 1) fail(409, 'A single administrator account is required for this connection');
    const label = 'TERMINAL_BITGET_DEMO';
    let account = await db.exchangeAccount.findFirst({ where: { label } });
    if (account) {
      await requireIdle(db, account.id);
      await check(account, readApiProfiles()[account.id] ?? 'v2');
    }
    const data = { name: 'Bitget Demo', label, exchangeCode: 'BITGET', isDemoAccount: true, isPaperAccount: false,
      apiKey: connection.credentials.apiKey, secretKey: connection.credentials.secret, password: connection.credentials.passphrase, ownerId: users[0].id, expired: false };
    await check(data, connection.apiVersion ?? 'v2');
    account = account ? await db.exchangeAccount.update({ where: { id: account.id }, data }) : await db.exchangeAccount.create({ data });
    const profiles = readApiProfiles(); profiles[account.id] = connection.apiVersion ?? 'v2';
    await atomicJson(apiProfilePath(), profiles);
    provider.removeByAccountId(account.id);
    return { connected: true, id: account.id, apiVersion: profiles[account.id], environment: 'demo' };
  })));
}
