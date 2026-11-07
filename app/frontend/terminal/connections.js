export function createConnectionsPanel(getAuthorization, onChange, editExecution) {
  const el = id => document.getElementById(id);
  let state, editingId = null, editingRevision = null, busy = false, generation = 0, execution = {};
  const status = text => { el('settings-status').textContent = text; };
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
    const controls = document.createElement('div'); controls.className = 'key-actions'; controls.append(...actions);
    card.append(content, controls); return card;
  }
  function render() {
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
  async function api(url, method = 'GET', body) {
    const auth = getAuthorization(), version = generation;
    if (!auth) throw new Error('Sign in to your workspace first.');
    const response = await fetch(url, { method, headers: { authorization: auth, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
    const data = await response.json();
    if (auth !== getAuthorization() || version !== generation) throw new Error('Session changed');
    if (!response.ok) throw Object.assign(new Error(data.message ?? 'Could not update saved connections.'), { status: response.status });
    return data;
  }
  async function refresh() {
    if (!getAuthorization() || busy) return;
    const version = generation;
    try {
      state = await api('/api/terminal/connections'); render();
      execution = (await api('/api/terminal/trading')).connections; render();
    } catch (error) { if (getAuthorization() && version === generation) status(error.message); }
  }
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
      closeEditor(); onChange(state); status(method === 'DELETE' ? 'Connection removed from this dashboard.' : suffix.endsWith('/activate') ? 'Monitoring connection selected. Checking the account within 90 seconds.' : 'Connection saved. Other saved keys are unchanged.');
    } catch (error) { if (getAuthorization() && version === generation) { if (error.status === 409) closeEditor(); status(error.message); } }
    finally { busy = false; if (version === generation) { render(); void refresh(); } }
  }
  async function removeExecution(environment) {
    if (busy || !getAuthorization()) return;
    const version = ++generation; busy = true; render();
    try {
      const result = await api('/api/terminal/trading/connection', 'DELETE', { environment });
      execution = result.connections; status('Execution key removed. New entries are stopped.');
    } catch (error) { if (getAuthorization() && version === generation) status(error.message); }
    finally { busy = false; if (version === generation) render(); }
  }
  function open() {
    document.querySelector('.settings-menu').open = false; closeEditor(); render();
    el('settings-dialog').showModal(); void refresh();
  }
  function clear() { generation++; state = undefined; execution = {}; closeEditor(); render(); status('Sign in to your workspace first.'); }
  el('open-settings').addEventListener('click', open);
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
  return { open, clear, update(value) { if (!busy) { state = value; render(); } } };
}
