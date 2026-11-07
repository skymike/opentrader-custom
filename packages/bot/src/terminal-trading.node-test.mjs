import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { registerTerminal } from './terminal.ts';
import { atomicJson, emptyJournal } from '../../exchanges/terminal-trading-store.mjs';

test('trading API authenticates, redacts keys, requires live acknowledgement and binds approvals', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'trade-api-'));
  const prior = { password: process.env.ADMIN_PASSWORD, path: process.env.TERMINAL_TRADING_PATH };
  process.env.ADMIN_PASSWORD = 'test-password'; process.env.TERMINAL_TRADING_PATH = directory;
  const app = Fastify(); registerTerminal(app);
  const headers = { authorization: 'test-password' }, url = '/api/terminal/trading';
  try {
    assert.equal((await app.inject({ url })).statusCode, 401);
    let response = await app.inject({ url, headers });
    assert.equal(response.statusCode, 200);
    let settings = response.json().settings;
    assert.equal(settings.environment, 'demo'); assert.equal(settings.armed, false);
    const payload = { environment: 'live', apiKey: 'fixture-key', secret: 'fixture-secret', passphrase: 'fixture-pass' };
    assert.equal((await app.inject({ url: url + '/connection', method: 'PUT', headers: { ...headers, origin: 'https://evil.example' }, payload })).statusCode, 403);
    response = await app.inject({ url: url + '/connection', method: 'PUT', headers, payload });
    assert.equal(response.statusCode, 200);
    assert.ok(!response.body.includes('fixture'));
    settings = response.json().settings;
    response = await app.inject({ url, method: 'PUT', headers, payload: { ...settings, environment: 'live' } });
    assert.equal(response.statusCode, 200); settings = response.json().settings;
    assert.equal((await app.inject({ url, method: 'PUT', headers, payload: { ...settings, armed: true } })).statusCode, 400);
    response = await app.inject({ url, method: 'PUT', headers, payload: { ...settings, armed: true, liveAcknowledgement: 'ENABLE LIVE TRADING' } });
    assert.equal(response.statusCode, 200); assert.equal(response.json().settings.armed, true);
    assert.equal((await app.inject({ url: url + '/command', method: 'POST', headers, payload: { action: 'approve', proposalId: 'made-up' } })).statusCode, 409);
    const j = emptyJournal(); j.entries.push({ id: 'active', environment: 'live', status: 'unknown' });
    await atomicJson(join(directory, 'journal.json'), j);
    assert.equal((await app.inject({ url: url + '/connection', method: 'PUT', headers, payload })).statusCode, 409);
    response = await app.inject({ url, headers });
    assert.ok(!response.body.includes('fixture')); assert.ok(response.json().connections.live.configured);
  } finally {
    await app.close();
    if (prior.password === undefined) delete process.env.ADMIN_PASSWORD; else process.env.ADMIN_PASSWORD = prior.password;
    if (prior.path === undefined) delete process.env.TERMINAL_TRADING_PATH; else process.env.TERMINAL_TRADING_PATH = prior.path;
    await rm(directory, { recursive: true, force: true });
  }
});
