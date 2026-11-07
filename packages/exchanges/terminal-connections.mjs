import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { checkConnection, withConnectionCheck } from './terminal-connection-check.mjs';

const path = () => process.env.TERMINAL_CREDENTIALS_PATH ?? '/app/data/terminal/bitget.json';
const fail = (status, message) => { const error = new Error(message); error.status = status; throw error; };
const locks = new Map();
async function locked(filename, action) {
  const previous = locks.get(filename) ?? Promise.resolve();
  let release;
  const next = new Promise(resolve => { release = resolve; });
  locks.set(filename, next);
  await previous;
  try { return await action(); }
  finally { release(); if (locks.get(filename) === next) locks.delete(filename); }
}
function normalize(value) {
  if (!value) return { version: 2, connections: [], activeId: null, credentials: null,
    revision: null, collectionRevision: null, updatedAt: null, permission: 'read-only', apiVersion: 'v2', environment: 'live' };
  if (value.version === 2) {
    if (!Array.isArray(value.connections) || value.connections.length > 20 ||
        value.connections.some(c => !c || typeof c.id !== 'string' || typeof c.name !== 'string' || !c.credentials ||
          !['apiKey','secret','passphrase'].every(k => typeof c.credentials[k] === 'string' && c.credentials[k].length > 0) ||
          !['v2','v3'].includes(c.apiVersion) || !['demo','live'].includes(c.environment) || !['read-only','read-write'].includes(c.permission)) ||
        new Set(value.connections.map(c => c.id)).size !== value.connections.length ||
        (value.activeId !== null && !value.connections.some(c => c.id === value.activeId))) throw new Error('Invalid saved connections');
    return value;
  }
  const connection = value.credentials ? { id: 'legacy-' + (value.revision ?? 'monitor'), name: 'Bitget monitoring',
    permission: value.permission ?? 'read-only', apiVersion: value.apiVersion ?? 'v2', environment: value.environment ?? 'live',
    updatedAt: value.updatedAt ?? null, credentials: value.credentials } : null;
  return { ...normalize(null), ...value, version: 2, connections: connection ? [connection] : [],
    activeId: connection?.id ?? null, collectionRevision: value.revision ?? null };
}
export async function readConnection() {
  try { return normalize(JSON.parse(await readFile(path(), 'utf8'))); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function publicItem(connection, activeId) {
  return { id: connection.id, revision: profileRevision(connection), name: connection.name, apiVersion: connection.apiVersion,
    environment: connection.environment, permission: connection.permission, updatedAt: connection.updatedAt,
    keyHint: connection.credentials.apiKey.length > 8 ? '•••• ' + connection.credentials.apiKey.slice(-4) : '••••',
    active: connection.id === activeId };
}
const profileRevision = connection => connection.revision ?? String(connection.updatedAt ?? connection.id);
export function publicConnection(config) {
  const value = normalize(config);
  const active = value.connections.find(c => c.id === value.activeId);
  return { configured: !!active, id: active?.id ?? null, name: active?.name ?? null,
    permission: active?.permission ?? 'read-only', apiVersion: active?.apiVersion ?? 'v2', environment: active?.environment ?? 'live',
    revision: value.revision, updatedAt: value.updatedAt, collectionRevision: value.collectionRevision,
    capability: 'monitoring-only', connections: value.connections.map(c => publicItem(c, value.activeId)) };
}
function editProfile(body, previous) {
  if (!body || !['read-only','read-write'].includes(body.permission)) fail(400, 'Choose the API key permission');
  const apiVersion = body.apiVersion ?? previous?.apiVersion ?? 'v2';
  const environment = body.environment ?? previous?.environment ?? 'live';
  const name = body.name ?? previous?.name ?? 'Bitget monitoring';
  if (!['v2','v3'].includes(apiVersion) || !['demo','live'].includes(environment)) fail(400, 'Select API and environment');
  if (typeof name !== 'string' || !name.trim() || name.length > 60 || /[\r\n\x00]/.test(name)) fail(400, 'Enter a name up to 60 characters');
  const values = [body.apiKey, body.secret, body.passphrase];
  let credentials = previous?.credentials;
  if (!values.every(value => value === undefined || value === '')) {
    if (!values.every(value => typeof value === 'string' && value.trim().length && value.length <= 512 && !/[\r\n\x00]/.test(value))) {
      fail(400, 'Enter a valid API key, secret and passphrase together');
    }
    credentials = { apiKey: body.apiKey.trim(), secret: body.secret.trim(), passphrase: body.passphrase };
  }
  if (!credentials) fail(400, 'Enter all three Bitget credentials');
  return { id: previous?.id ?? randomUUID(), revision: randomUUID(), name: name.trim(), apiVersion, environment, permission: body.permission,
    credentials, updatedAt: Date.now() };
}
async function mutate(operation, id, body, legacy = false) {
  const filename = path();
  return locked(filename, async () => {
    const state = normalize(await readConnection());
    if (!legacy && body?.collectionRevision !== state.collectionRevision) fail(409, 'Saved connections changed. Refresh the list before trying again.');
    if (legacy) id = state.activeId;
    const index = state.connections.findIndex(c => c.id === id);
    let activeChanged = false;
    if (operation === 'create' || (legacy && operation === 'edit' && index < 0)) {
      if (state.connections.length >= 20) fail(400, 'You can save up to 20 monitoring connections');
      const item = editProfile(body);
      state.connections.push(item);
      if (legacy || state.connections.length === 1) { state.activeId = item.id; activeChanged = true; }
    } else if (operation === 'edit') {
      if (index < 0) fail(404, 'This saved connection no longer exists');
      state.connections[index] = editProfile(body, state.connections[index]);
      activeChanged = state.activeId === id;
    } else if (operation === 'activate') {
      if (index < 0) fail(404, 'This saved connection no longer exists');
      state.activeId = id; activeChanged = true;
    } else if (operation === 'remove') {
      if (index < 0 && !legacy) fail(404, 'This saved connection no longer exists');
      if (index >= 0) state.connections.splice(index, 1);
      if (state.activeId === id || legacy) { state.activeId = null; activeChanged = true; }
    }
    const active = state.connections.find(c => c.id === state.activeId);
    const saved = { version: 2, connections: state.connections, activeId: state.activeId, collectionRevision: randomUUID(),
      // Keep the active projection for the existing monitor and rollback-compatible readers.
      credentials: active?.credentials ?? null, permission: active?.permission ?? 'read-only',
      apiVersion: active?.apiVersion ?? 'v2', environment: active?.environment ?? 'live',
      revision: activeChanged ? randomUUID() : state.revision, updatedAt: activeChanged ? Date.now() : state.updatedAt };
    await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
    const temporary = filename + '.' + saved.collectionRevision + '.tmp';
    await writeFile(temporary, JSON.stringify(saved), { mode: 0o600, flag: 'wx' });
    await rename(temporary, filename);
    return publicConnection(saved);
  });
}
export function registerConnections(app, authorize) {
  const guarded = handler => async (request, reply) => {
    try { return await handler(request, reply); }
    catch (error) { return reply.code(error.status ?? 503).send({ message: error.status ? error.message : 'Connection settings are unavailable. Please try again.' }); }
  };
  for (const url of ['/api/terminal/connection', '/api/terminal/connections']) {
    app.get(url, { preHandler: authorize }, guarded(() => readConnection().then(publicConnection)));
  }
  app.route({ method: ['PUT','DELETE'], url: '/api/terminal/connection', preHandler: authorize, bodyLimit: 4096,
    handler: guarded(req => mutate(req.method === 'DELETE' ? 'remove' : 'edit', null, req.body, true)) });
  app.post('/api/terminal/connections', { preHandler: authorize, bodyLimit: 4096 }, guarded(async (req, reply) => {
    const result = await mutate('create', null, req.body); reply.code(201); return result;
  }));
  app.route({ method: ['PUT','DELETE'], url: '/api/terminal/connections/:id', preHandler: authorize, bodyLimit: 4096,
    handler: guarded(req => mutate(req.method === 'DELETE' ? 'remove' : 'edit', req.params.id, req.body)) });
  app.post('/api/terminal/connections/:id/activate', { preHandler: authorize, bodyLimit: 512 },
    guarded(req => mutate('activate', req.params.id, req.body)));
  app.post('/api/terminal/connections/:id/check', { preHandler: authorize, bodyLimit: 512 }, guarded(req =>
    withConnectionCheck(path() + ':' + req.params.id, async () => {
      const connection = (await readConnection())?.connections.find(c => c.id === req.params.id);
      if (!connection) fail(404, 'This saved connection no longer exists');
      const revision = profileRevision(connection);
      if (req.body?.revision !== revision) fail(409, 'Connection changed. Refresh the list and test again.');
      const result = await checkConnection(connection);
      const current = (await readConnection())?.connections.find(c => c.id === req.params.id);
      if (!current || profileRevision(current) !== revision) fail(409, 'Connection changed during the test. Test the updated key again.');
      return { ...result, revision };
    })));
}
