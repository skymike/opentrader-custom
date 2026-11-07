export function createConnectionsPanel(getAuthorization, onChange, editExecution) {
  const el = id => document.getElementById(id);
  let state, editingId = null, editingRevision = null, busy = false, generation = 0, execution = {};
  let session = 0;
  let started = false, autoRun = null, monitorLoaded = false, executionLoaded = false, loadError = false;
  let monitorVersion = 0, executionVersion = 0;
  const checks = new Map();
  const checkId = (connection, purpose) => JSON.stringify([purpose, connection.id ?? connection.environment, connection.revision]);
  const status = text => { el('settings-status').textContent = text; };
  function savedKeys() {
    return [...(state?.connections ?? []).map(connection => ({ connection, purpose: 'Monitoring' })),
      ...Object.entries(execution).filter(([, c]) => c.configured).map(([environment, c]) => ({ connection: { ...c, environment }, purpose: 'Execution' }))];
  }
  function renderHealth() {
    const keys = savedKeys();
    const results = keys.map(({ connection, purpose }) => {
      const result = checks.get(checkId(connection, purpose));
      return result?.revision === connection.revision ? result.status : 'waiting';
    });
    const connected = results.filter(value => value === 'connected').length;
    const errors = results.filter(value => value === 'error').length;
    const remaining = results.length - connected - errors;
    el('key-health').textContent = !getAuthorization() ? 'Saved keys · Sign in to check' :
      !monitorLoaded || !executionLoaded ? (loadError ? 'Saved keys unavailable · Open settings' : 'Checking saved keys…') :
      !keys.length ? 'No saved keys · Add a connection' :
      `Saved keys · ${connected} / ${keys.length} connected${errors ? ` · ${errors} error${errors === 1 ? '' : 's'}` : ''}${remaining ? ` · ${remaining} checking` : ''}`;
    el('open-key-health').classList.toggle('has-errors', errors > 0 || (loadError && (!monitorLoaded || !executionLoaded)));
  }
  // One background check at a time, once per saved revision per signed-in page session.
  async function checkSavedKeys() {
    if (autoRun || busy || !getAuthorization()) return;
    const run = Symbol(); autoRun = run;
    try {
      while (autoRun === run && getAuthorization() && !busy) {
        const next = savedKeys().find(({ connection, purpose }) => checks.get(checkId(connection, purpose))?.revision !== connection.revision);
        if (!next) break;
        await testConnection(next.connection, next.purpose, false);
      }
    } finally { if (autoRun === run) autoRun = null; }
  }
  function button(text, action, className = 'secondary') {
    const node = document.createElement('button'); node.type = 'button'; node.textContent = text; node.className = className;
    node.disabled = busy || !getAuthorization(); node.addEventListener('click', action); return node;
  }
  function row(connection, purpose, actions) {
    const card = document.createElement('article'); card.className = 'saved-key';
    const content = document.createElement('div');
    const name = document.createElement('h4'); name.textContent = connection.name; content.append(name);
    const badges = document.createElement('div'); badges.className = 'key-badges';
    for (const [label, className] of [[connection.apiVersion === 'v3' ? 'Unified · V3' : 'Classic · V2', ''],
      [connection.environment === 'demo' ? 'Demo' : 'Live', connection.environment], [purpose, '']]) {
      const badge = document.createElement('span'); badge.className = 'key-badge ' + className; badge.textContent = label; badges.append(badge);
    }
    if (connection.active) { const selected = document.createElement('span'); selected.className = 'key-badge selected'; selected.textContent = 'Selected'; badges.append(selected); }
    content.append(badges);
    if (connection.keyHint) { const hint = document.createElement('small'); hint.textContent = 'API key ' + connection.keyHint + ' · ' + (connection.permission === 'read-write' ? 'Read-write declared' : 'Read-only declared'); content.append(hint); }
    const previous = checks.get(checkId(connection, purpose));
    const result = previous?.revision === connection.revision ? previous : null;
    const feedback = document.createElement('div'); feedback.className = 'key-check ' + (result?.status ?? 'untested'); feedback.setAttribute('role', 'status');
    const label = document.createElement('strong');
    label.textContent = ({ connected: 'Connected', error: 'Connection error', testing: 'Testing…' })[result?.status] ?? 'Waiting to check';
    feedback.append(label);
    if (result?.checkedAt) { const time = document.createElement('span'); time.textContent = ' · Last test ' + new Date(result.checkedAt).toLocaleTimeString(); feedback.append(time); }
    if (result?.message && result.status === 'error') { const message = document.createElement('small'); message.textContent = result.message; feedback.append(message); }
    content.append(feedback);
    const test = button(result?.status === 'testing' ? 'Testing…' : 'Test connection', () => void testConnection(connection, purpose));
    test.disabled ||= result?.status === 'testing'; actions.unshift(test);
    const controls = document.createElement('div'); controls.className = 'key-actions'; controls.append(...actions);
    card.append(content, controls); return card;
  }
  function render() {
    renderHealth();
    el('add-connection').disabled = busy || !getAuthorization();
    el('settings-fields').disabled = busy || !getAuthorization();
    el('saved-connections').replaceChildren(...(state?.connections ?? []).map(c => row(c, 'Monitoring', [
      ...(!c.active ? [button('Use for monitoring', () => void mutate('POST', '/' + c.id + '/activate'))] : []),
      button('Edit', () => edit(c)), button('Remove', () => {
        if (confirm(`Remove “${c.name}” (${c.apiVersion.toUpperCase()} · ${c.environment.toUpperCase()}) from this dashboard?${c.active ? ' Its displayed account data will be cleared.' : ''} This does not revoke the key at Bitget.`)) void mutate('DELETE', '/' + c.id);
      }, 'secondary danger')
    ])));
    if (!state?.connections?.length) el('saved-connections').textContent = getAuthorization() ? 'No monitoring connections saved. Add your first key above.' : 'Sign in to view saved keys.';
    el('saved-execution-keys').replaceChildren(...Object.entries(execution).filter(([, c]) => c.configured).map(([environment, c]) => row(
      { ...c, environment, name: `${environment === 'demo' ? 'Demo' : 'Live'} execution key` }, 'Execution', [
        button('Edit', () => { el('settings-dialog').close(); void editExecution(environment); }),
        button('Remove', () => {
          if (confirm(`Remove the ${environment.toUpperCase()} execution key? New entries will be stopped. Keys with managed orders or positions cannot be removed.`)) void removeExecution(environment);
        }, 'secondary danger')
      ])));
    if (!Object.values(execution).some(c => c.configured)) el('saved-execution-keys').textContent = getAuthorization() ? 'No execution keys saved.' : 'Sign in to view saved keys.';
  }
  async function api(url, method = 'GET', body, testing = false) {
    const auth = getAuthorization(), version = generation, usedSession = session;
    if (!auth) throw new Error('Sign in to your workspace first.');
    const response = await fetch(url, { method, headers: { authorization: auth, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
    const data = await response.json();
    if (auth !== getAuthorization() || usedSession !== session || (!testing && version !== generation)) throw new Error('Session changed');
    if (!response.ok) throw Object.assign(new Error(data.message ?? 'Could not update saved connections.'), { status: response.status });
    return data;
  }
  async function testConnection(connection, purpose, manual = true) {
    const id = checkId(connection, purpose), usedSession = session;
    if (!getAuthorization() || busy || (checks.get(id)?.status === 'testing' && checks.get(id)?.revision === connection.revision)) return;
    const pending = { revision: connection.revision, status: 'testing' };
    checks.set(id, pending); render();
    if (manual) status('Testing saved account access. Results appear beside each key.');
    try {
      const monitoring = purpose === 'Monitoring';
      const result = await api(monitoring ? '/api/terminal/connections/' + connection.id + '/check' : '/api/terminal/trading/connection/check',
        'POST', { revision: connection.revision, ...(!monitoring ? { environment: connection.environment } : {}) }, true);
      if (usedSession === session && checks.get(id) === pending) checks.set(id, { ...result, revision: connection.revision });
    } catch (error) {
      if (usedSession === session && checks.get(id) === pending) checks.set(id, { revision: connection.revision, status: 'error', checkedAt: Date.now(),
        message: error.name === 'TimeoutError' ? 'The test timed out. Try again shortly.' : error.message });
    } finally { if (usedSession === session) render(); }
  }
  async function refresh() {
    if (!getAuthorization() || busy) return;
    const version = generation, monitoring = monitorVersion, executing = executionVersion;
    try {
      const nextState = await api('/api/terminal/connections');
      if (monitorVersion === monitoring) { monitorVersion++; state = nextState; monitorLoaded = true; loadError = false; render(); void checkSavedKeys(); }
      const nextExecution = (await api('/api/terminal/trading')).connections;
      if (executionVersion === executing) { executionVersion++; execution = nextExecution; executionLoaded = true; render(); void checkSavedKeys(); }
    } catch (error) { if (getAuthorization() && version === generation) { loadError = true; renderHealth(); status(error.message); } }
  }
  function start() { if (!started && getAuthorization()) { started = true; void refresh(); } }
  function closeEditor() { editingId = null; el('settings-form').reset(); el('settings-form').hidden = true; }
  function edit(connection) {
    editingId = connection?.id ?? null; editingRevision = state?.collectionRevision ?? null;
    el('settings-form').reset(); el('settings-form').hidden = false;
    el('connection-editor-title').textContent = connection ? 'Edit monitoring connection' : 'Add monitoring connection';
    el('connection-name').value = connection?.name ?? '';
    el('monitor-api-version').value = connection?.apiVersion ?? 'v2';
    el('monitor-environment').value = connection?.environment ?? 'live';
    el('settings-form').elements.permission.value = connection?.permission ?? 'read-only';
    el('credentials-help').textContent = connection ? 'Leave all three credential fields blank to keep the saved key, or enter all three to replace it.' : 'Enter your API key, secret and passphrase. Secret values are never displayed again.';
    el('settings-fields').disabled = busy || !getAuthorization(); updatePermission();
    el('connection-name').focus(); el('settings-form').scrollIntoView({ block: 'nearest' });
  }
  function updatePermission() {
    el('permission-note').textContent = el('settings-form').elements.permission.value === 'read-write'
      ? 'Read-write declared. This monitoring connection still only reads account data. Execution keys are managed separately.'
      : 'Read-only is sufficient for balances and positions.';
  }
  async function mutate(method, suffix = '', body = {}) {
    if (busy || !getAuthorization()) return;
    const version = ++generation; busy = true; render(); status('Saving connection changes…');
    try {
      state = await api('/api/terminal/connections' + suffix, method, { ...body, collectionRevision: method === 'PUT' ? editingRevision : state?.collectionRevision ?? null });
      monitorVersion++;
      closeEditor(); onChange(state); status(method === 'DELETE' ? 'Connection removed from this dashboard.' : suffix.endsWith('/activate') ? 'Monitoring connection selected. Checking the account within 90 seconds.' : 'Connection saved. Other saved keys are unchanged.');
    } catch (error) { if (getAuthorization() && version === generation) { if (error.status === 409) closeEditor(); status(error.message); } }
    finally { busy = false; if (version === generation) { render(); void refresh(); } }
  }
  async function removeExecution(environment) {
    if (busy || !getAuthorization()) return;
    const version = ++generation; busy = true; render();
    try {
      const result = await api('/api/terminal/trading/connection', 'DELETE', { environment });
      executionVersion++; execution = result.connections; status('Execution key removed. New entries are stopped.');
    } catch (error) { if (getAuthorization() && version === generation) status(error.message); }
    finally { busy = false; if (version === generation) { render(); void checkSavedKeys(); } }
  }
  function open() {
    document.querySelector('.settings-menu').open = false; closeEditor(); render();
    el('settings-dialog').showModal(); void refresh();
  }
  function clear() {
    generation++; session++; monitorVersion++; executionVersion++; autoRun = null; started = false; monitorLoaded = false; executionLoaded = false; loadError = false;
    checks.clear(); state = undefined; execution = {}; closeEditor(); render(); status('Sign in to your workspace first.');
  }
  el('open-settings').addEventListener('click', open);
  el('open-key-health').addEventListener('click', open);
  el('close-settings').addEventListener('click', () => el('settings-dialog').close());
  el('settings-dialog').addEventListener('close', () => { closeEditor(); if (location.hash === '#settings') history.replaceState(null, '', location.pathname); });
  el('add-connection').addEventListener('click', () => edit(null));
  el('cancel-connection').addEventListener('click', closeEditor);
  el('settings-form').addEventListener('change', updatePermission);
  el('settings-form').addEventListener('submit', event => {
    event.preventDefault(); void mutate(editingId ? 'PUT' : 'POST', editingId ? '/' + editingId : '', {
      name: el('connection-name').value, apiVersion: el('monitor-api-version').value, environment: el('monitor-environment').value,
      permission: el('settings-form').elements.permission.value, apiKey: el('api-key').value, secret: el('api-secret').value, passphrase: el('api-passphrase').value });
  });
  return { open, clear, start,
    update(value) { if (!busy) { monitorVersion++; state = value; monitorLoaded = true; render(); void checkSavedKeys(); } },
    updateExecution(value) { if (!busy) { executionVersion++; execution = value; executionLoaded = true; render(); void checkSavedKeys(); } } };
}
