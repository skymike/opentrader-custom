import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { atomicJson } from '../../exchanges/terminal-trading-store.mjs';
const mod = await import('../../exchanges/terminal-original-api.mjs').catch(() => ({}));
test('original API switch rejects active bots and never returns stored credentials', async () => {
  assert.equal(typeof mod.registerOriginalApi, 'function');
  const app = Fastify();
  let active = 1;
  const db = { exchangeAccount: { findMany: async () => [{ id: 1, name: 'Demo', exchangeCode: 'BITGET', apiKey: 'secret-key', secretKey: 'secret', isDemoAccount: true }],
    findUnique: async () => ({ id: 1, exchangeCode: 'BITGET' }) }, bot: { count: async () => active }, order: { count: async () => 0 } };
  mod.registerOriginalApi(app, async (req, reply) => { if (req.headers.authorization !== 'test') return reply.code(401).send({}); }, async () => ({ db }));
  try {
    assert.equal((await app.inject('/api/terminal/opentrader/accounts')).statusCode, 401);
    const response = await app.inject({ url: '/api/terminal/opentrader/accounts', headers: { authorization: 'test' } });
    assert.equal(response.statusCode, 200); assert.ok(!response.body.includes('secret'));
    assert.equal((await app.inject({ url: '/api/terminal/opentrader/accounts', method: 'PUT', headers: { authorization: 'test' }, payload: { id: 1, apiVersion: 'v3' } })).statusCode, 409);
  } finally { await app.close(); }
});

test('import does not replace an existing key with exchange exposure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'original-api-'));
  const prior = process.env.TERMINAL_TRADING_PATH;
  process.env.TERMINAL_TRADING_PATH = directory;
  await atomicJson(join(directory, 'connections.json'), { demo: { apiVersion: 'v3', credentials: { apiKey: 'new', secret: 'new', passphrase: 'new' } } });
  let writes = 0;
  const app = Fastify();
  const db = { user: { findMany: async () => [{ id: 1 }] }, bot: { count: async () => 0 }, order: { count: async () => 0 },
    exchangeAccount: { findFirst: async () => ({ id: 4, isDemoAccount: true, apiKey: 'old' }), update: async () => { writes++; } } };
  mod.registerOriginalApi(app, async () => {}, async () => ({ db }), (environment, credentials, version) => {
    assert.equal(environment, 'demo'); assert.equal(credentials.apiKey, 'old'); assert.equal(version, 'v2');
    return { context: async () => ({ positions: [{ total: '1' }], orders: [] }) };
  });
  try {
    assert.equal((await app.inject({ url: '/api/terminal/opentrader/import-demo', method: 'POST' })).statusCode, 409);
    assert.equal(writes, 0);
  } finally {
    await app.close();
    if (prior === undefined) delete process.env.TERMINAL_TRADING_PATH; else process.env.TERMINAL_TRADING_PATH = prior;
    await rm(directory, { recursive: true, force: true });
  }
});
