import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { registerTerminal } from './terminal.ts';

test('saved monitoring keys migrate without losing credentials, support CRUD and selection, and never expose secrets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'saved-keys-'));
  const keys = ['ADMIN_PASSWORD', 'TERMINAL_CREDENTIALS_PATH', 'TERMINAL_STATE_PATH', 'TERMINAL_CONTROL_PATH'];
  const old = keys.map(k => process.env[k]);
  process.env.ADMIN_PASSWORD = 'test-admin';
  process.env.TERMINAL_CREDENTIALS_PATH = join(directory, 'bitget.json');
  process.env.TERMINAL_STATE_PATH = join(directory, 'state.json');
  process.env.TERMINAL_CONTROL_PATH = join(directory, 'control.json');
  const legacy = { revision: 'existing', updatedAt: 123, apiVersion: 'v3', environment: 'demo', permission: 'read-only',
    credentials: { apiKey: 'old-key-123456', secret: 'old-private-secret', passphrase: 'old-private-passphrase' } };
  await writeFile(process.env.TERMINAL_CREDENTIALS_PATH, JSON.stringify(legacy));
  const app = Fastify(); registerTerminal(app);
  const headers = { authorization: 'test-admin' }, url = '/api/terminal/connections';
  const get = async () => (await app.inject({ url, headers })).json();
  const mutate = async (method, suffix, payload = {}) => app.inject({ url: url + suffix, headers, method,
    payload: { ...payload, collectionRevision: (await get()).collectionRevision } });
  try {
    assert.equal((await app.inject(url)).statusCode, 401);
    const initial = await get();
    assert.deepEqual(JSON.parse(await readFile(process.env.TERMINAL_CREDENTIALS_PATH, 'utf8')), legacy, 'listing does not rewrite credentials');
    assert.equal(initial.connections.length, 1);
    const id = initial.connections[0].id;
    assert.equal(initial.connections[0].apiVersion, 'v3');
    assert.equal(initial.connections[0].environment, 'demo');
    for (const secret of Object.values(legacy.credentials)) assert.ok(!JSON.stringify(initial).includes(secret));
    assert.equal((await app.inject({ url, method: 'POST', payload: {} })).statusCode, 401);
    assert.equal((await app.inject({ url, method: 'POST', headers: { ...headers, origin: 'https://evil.example' }, payload: {} })).statusCode, 403);
    const created = await mutate('POST', '', { name: 'Classic live', apiVersion: 'v2', environment: 'live', permission: 'read-write',
      apiKey: 'new-key-987654', secret: 'new-private-secret', passphrase: 'new-private-passphrase' });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().connections.length, 2);
    assert.equal(created.json().id, id, 'adding another key must not silently switch monitoring');
    assert.equal(created.json().revision, 'existing');
    const added = created.json().connections.find(c => c.id !== id);
    const edited = await mutate('PUT', '/' + added.id, { name: 'Renamed live', apiVersion: 'v2', environment: 'live', permission: 'read-only' });
    assert.equal(edited.statusCode, 200);
    const stored = JSON.parse(await readFile(process.env.TERMINAL_CREDENTIALS_PATH, 'utf8'));
    assert.equal(stored.connections.find(c => c.id === added.id).credentials.secret, 'new-private-secret');
    assert.equal(stored.credentials.secret, legacy.credentials.secret);
    if (process.platform !== 'win32') assert.equal((await stat(process.env.TERMINAL_CREDENTIALS_PATH)).mode & 0o777, 0o600);
    await writeFile(process.env.TERMINAL_STATE_PATH, JSON.stringify({ connectionRevision: 'existing', account: { equity: 10 }, agents: { paused: false }, equityHistory: [[1,10]] }));
    assert.equal((await mutate('POST', '/' + added.id + '/activate')).statusCode, 200);
    const state = (await app.inject({ url: '/api/terminal/state', headers })).json();
    assert.equal(state.account, null);
    assert.equal(state.accountStatus, 'validating');
    assert.equal(JSON.parse(await readFile(process.env.TERMINAL_CREDENTIALS_PATH, 'utf8')).credentials.secret, 'new-private-secret');
    const removed = await mutate('DELETE', '/' + added.id);
    assert.equal(removed.json().configured, false);
    assert.equal(removed.json().connections.length, 1, 'removing active key must not remove other saved keys');
    assert.equal(removed.json().id, null, 'do not auto-select another account after removing active key');
    assert.equal((await mutate('PUT', '/' + id, { name: 'bad', permission: 'read-only', apiVersion: 'v4', environment: 'live' })).statusCode, 400);
    assert.equal((await mutate('PUT', '/' + id, { name: 'bad', permission: 'read-only', apiKey: 'partial' })).statusCode, 400);
    const current = await get();
    assert.equal((await app.inject({ url: url + '/' + id, method: 'DELETE', headers, payload: { collectionRevision: 'old' } })).statusCode, 409);
    assert.equal((await mutate('POST', '/' + id + '/activate')).statusCode, 200);
    // Old clients update the active profile without deleting saved profiles.
    assert.equal((await app.inject({ url: '/api/terminal/connection', method: 'PUT', headers, payload: { permission: 'read-write' } })).statusCode, 200);
    assert.equal((await get()).connections.length, current.connections.length);
    assert.equal((await get()).environment, 'demo', 'legacy partial edit preserves API/environment');
    assert.ok(!(await app.inject({ url, headers })).body.includes('private-secret'));
    const revision = (await get()).collectionRevision;
    const concurrent = await Promise.all(['Name A', 'Name B'].map(name => app.inject({ url: url + '/' + id,
      method: 'PUT', headers, payload: { name, permission: 'read-only', collectionRevision: revision } })));
    assert.deepEqual(concurrent.map(r => r.statusCode).sort(), [200, 409], 'two tabs cannot silently overwrite each other');
    for (const [apiVersion, environment] of [['v2', 'demo'], ['v3', 'live']]) {
      const added = await mutate('POST', '', { name: `${apiVersion} ${environment}`, apiVersion, environment,
        permission: 'read-only', apiKey: 'test-key-123456', secret: 'test-secret-hidden', passphrase: 'test-pass-hidden' });
      assert.equal(added.statusCode, 201);
      assert.ok(!added.body.includes('test-secret-hidden'));
      assert.ok(!added.body.includes('test-pass-hidden'));
      assert.equal(added.json().connections.at(-1).apiVersion, apiVersion);
      assert.equal(added.json().connections.at(-1).environment, environment);
    }
    await writeFile(process.env.TERMINAL_CREDENTIALS_PATH, '{broken');
    assert.equal((await app.inject({ url, headers })).statusCode, 503);
    assert.equal((await app.inject({ url, headers, method: 'POST', payload: { collectionRevision: null,
      permission: 'read-only', apiKey: 'some-key', secret: 'some-secret', passphrase: 'some-pass' } })).statusCode, 503);
    assert.equal(await readFile(process.env.TERMINAL_CREDENTIALS_PATH, 'utf8'), '{broken', 'corrupt storage is never overwritten');
  } finally {
    await app.close(); keys.forEach((k,i) => { if (old[i] === undefined) delete process.env[k]; else process.env[k] = old[i]; });
    await rm(directory, { recursive: true, force: true });
  }
});
