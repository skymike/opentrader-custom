export function createTradingPanel(getAuthorization, onConnections = () => {}) {
  const el = (id) => document.getElementById(id);
  let state, busy = false, generation = 0, dirty = false, connectionInitialized = false;
  const fields = ['environment', 'mode', 'maxNotional', 'riskPct', 'dailyLossPct'];
  const status = (message) => { el('trading-status').textContent = message; };
  async function api(path = '', method = 'GET', body) {
    const auth = getAuthorization(), version = generation;
    if (!auth) throw new Error('Sign in first');
    const response = await fetch('/api/terminal/trading' + path, { method, headers: { authorization: auth, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
    const data = await response.json();
    if (version !== generation || auth !== getAuthorization()) throw new Error('Session changed');
    if (!response.ok) throw new Error(data.message ?? 'Trading request failed');
    return data;
  }
  function button(label, action, disabled = false) {
    const node = document.createElement('button'); node.type = 'button'; node.className = 'secondary';
    node.textContent = label; node.disabled = disabled; node.addEventListener('click', action); return node;
  }
  async function command(payload) {
    try { await api('/command', 'POST', payload); status('Request queued. Waiting for the worker to confirm.'); await refresh(); }
    catch (error) { if (getAuthorization()) status(error.message); }
  }
  function render() {
    if (!state) return;
    const { settings, connections, journal, stale } = state;
    onConnections(connections);
    if (!connectionInitialized) {
      el('trade-api-version').value = connections[el('trade-key-environment').value].apiVersion;
      connectionInitialized = true;
    }
    el('trading-fields').disabled = false;
    if (!dirty) for (const key of fields) el('trade-' + key).value = settings[key];
    el('trading-badge').textContent = `${settings.environment.toUpperCase()} · ${settings.mode === 'automatic' ? 'Automatic' : 'Approval'} · ${settings.armed ? 'Entries enabled' : 'Entries stopped'}`;
    el('trading-badge').classList.toggle('live-trading', settings.environment === 'live');
    el('trade-arm').textContent = settings.armed ? 'Stop new entries' : `Enable ${settings.environment} entries`;
    el('trade-arm').classList.toggle('stop-entries', settings.armed);
    el('trade-arm').disabled = dirty && !settings.armed;
    el('trade-unsaved').hidden = !dirty;
    el('trade-limits').textContent = `${settings.riskPct}% risk · 2% SL / 4% TP`;
    el('trade-risk-summary').textContent = `${settings.riskPct}% equity · ${settings.dailyLossPct}% daily loss limit`;
    el('demo-test-order').disabled = settings.environment !== 'demo' || !settings.armed || stale;
    status((stale ? 'Worker not reporting fresh status. ' : '') + (journal.message ?? 'Waiting for execution worker.'));
    el('trade-connection-status').textContent = ['demo','live'].map(env => `${env === 'demo' ? 'Demo' : 'Live'} ${connections[env].configured ? connections[env].apiVersion.toUpperCase() + ' saved' : 'not set'}`).join(' · ');
    const account = journal.accounts[settings.environment];
    el('trade-account').textContent = account ? `Equity ${account.equity.toFixed(2)} · Available ${account.available.toFixed(2)} USDT · ${new Date(account.updatedAt).toLocaleTimeString()}` : `${settings.environment === 'demo' ? 'Demo' : 'Live'} account awaiting check`;
    el('trade-proposal-count').textContent = (journal.proposals ?? []).length;
    el('trade-proposals-empty').hidden = !!journal.proposals?.length;
    el('trade-proposals').replaceChildren(...(journal.proposals ?? []).map((proposal) => {
      const card = document.createElement('section');
      const heading = document.createElement('h3'); heading.textContent = `${settings.environment.toUpperCase()} · ${proposal.source === 'demo-test' ? 'TEST TRADE · ' : ''}${proposal.side.toUpperCase()} ${proposal.symbol}`;
      const text = document.createElement('p'); text.textContent = `${proposal.quantity} units · Limit ${proposal.limit} · Stop ${proposal.stop} · Target ${proposal.target} · Estimated risk ${proposal.riskAmount.toFixed(2)} USDT`;
      const expiry = document.createElement('small'); expiry.textContent = `Expires ${new Date(proposal.expiresAt).toLocaleTimeString()}. IOC order: any unfilled quantity is cancelled.`;
      const disabled = stale || dirty || proposal.expiresAt <= Date.now() || !settings.armed;
      card.append(heading, text, expiry, button('Approve trade', () => command({ action: 'approve', proposalId: proposal.id }), disabled),
        button('Reject', () => command({ action: 'reject', proposalId: proposal.id }), disabled));
      return card;
    }));
    const active = entry => !['closed', 'unfilled', 'rejected'].includes(entry.status);
    const openEntries = journal.entries.filter(active);
    const closedEntries = [...journal.entries].reverse().filter(entry => !active(entry)).slice(0,20);
    el('trade-position-count').textContent = openEntries.length;
    el('trade-orders-empty').hidden = !!openEntries.length;
    el('trade-history-count').textContent = `${closedEntries.length} recent results`;
    function entryRow(entry) {
      const row = document.createElement('section');
      const text = document.createElement('p'); text.textContent = `${entry.environment.toUpperCase()} · ${entry.symbol} ${entry.side ?? ''} · ${entry.status} · Filled ${entry.filled ?? 0} / ${entry.quantity ?? 0}${entry.message ? ' · ' + entry.message : ''}`;
      row.append(text);
      if (active(entry)) row.append(button('Close managed position', () => {
        if (confirm(`Close this ${entry.environment.toUpperCase()} ${entry.symbol} managed position at market?`)) void command({ action: 'close', entryId: entry.id });
      }));
      return row;
    }
    el('trade-orders').replaceChildren(...openEntries.map(entryRow));
    el('trade-history').replaceChildren(...closedEntries.map(entryRow));
    if (!closedEntries.length) el('trade-history').textContent = 'No completed trades yet.';
    el('trade-reset').hidden = !journal.halted[settings.environment];
    el('trade-halt').hidden = !journal.halted[settings.environment];
    el('trade-halt').textContent = journal.halted[settings.environment] ? 'Safety halt · ' + journal.halted[settings.environment] : '';
  }
  async function refresh() {
    if (!getAuthorization() || busy) return;
    busy = true;
    try { state = await api(); render(); }
    catch (error) { if (getAuthorization()) { status(error.message); el('trade-proposals').replaceChildren(); } }
    finally { busy = false; }
  }
  for (const key of fields) el('trade-' + key).addEventListener('input', () => {
    dirty = true; el('trade-unsaved').hidden = false; el('trade-arm').disabled = !state?.settings.armed;
  });
  async function save(armed, stopOnly = false) {
    if (!state) return;
    let acknowledgement;
    if (armed && el('trade-environment').value === 'live') {
      acknowledgement = prompt('This enables real-money trading. Type ENABLE LIVE TRADING to continue.');
      if (acknowledgement !== 'ENABLE LIVE TRADING') return;
    }
    const payload = { ...state.settings, armed, liveAcknowledgement: acknowledgement };
    if (!stopOnly) for (const key of fields) payload[key] = ['environment', 'mode'].includes(key) ? el('trade-' + key).value : Number(el('trade-' + key).value);
    try { state = await api('', 'PUT', payload); if (!stopOnly) dirty = false; render(); }
    catch (error) { status(error.message); }
  }
  el('trading-form').addEventListener('submit', (event) => { event.preventDefault(); void save(false); });
  el('trade-arm').addEventListener('click', () => void save(!state?.settings.armed, !!state?.settings.armed));
  el('trade-reset').addEventListener('click', () => {
    if (confirm('Reset the safety halt after reviewing the issue? If entries are enabled, automatic trading may resume.')) void command({ action: 'reset-halt' });
  });
  el('trading-connection-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      state = await api('/connection', 'PUT', { environment: el('trade-key-environment').value, apiVersion: el('trade-api-version').value,
        apiKey: el('trade-key').value, secret: el('trade-secret').value, passphrase: el('trade-passphrase').value });
      for (const key of ['trade-key', 'trade-secret', 'trade-passphrase']) el(key).value = '';
      dirty = false; render();
    } catch (error) { status(error.message); }
  });
  el('trade-key-environment').addEventListener('change', () => { el('trade-api-version').value = state?.connections[el('trade-key-environment').value]?.apiVersion ?? 'v2'; });
  el('trade-check-key').addEventListener('click', async () => {
    status('Checking account connection…');
    try { const result = await api('/check', 'POST', { environment: el('trade-key-environment').value });
      status(`Connected: ${result.environment.toUpperCase()} ${result.apiVersion.toUpperCase()} · Equity ${result.equity} USDT · Available ${result.available} USDT · ${result.account.posMode}, ${result.account.marginMode}, leverage ${result.account.isolatedLongLever ?? 'not set'}`);
    } catch (error) { status(error.message); }
  });
  el('demo-test-order').addEventListener('click', async () => {
    try { await api('/demo-test', 'POST', { symbol: el('demo-test-symbol').value }); status('Demo test queued. Approval mode will wait for your approval; automatic mode will submit one test order.'); }
    catch (error) { status(error.message); }
  });
  el('trade-remove-key').addEventListener('click', async () => {
    if (!confirm(`Remove the ${el('trade-key-environment').value.toUpperCase()} execution key? New entries will be stopped.`)) return;
    try { state = await api('/connection', 'DELETE', { environment: el('trade-key-environment').value }); dirty = false; render(); }
    catch (error) { status(error.message); }
  });
  function clear() {
    generation++; state = undefined; dirty = false; connectionInitialized = false;
    el('trading-fields').disabled = true;
    el('trading-form').reset(); el('trading-connection-form').reset();
    el('trade-proposals').replaceChildren(); el('trade-orders').replaceChildren();
    el('trade-history').replaceChildren(); el('trade-unsaved').hidden = true;
    el('trade-halt').hidden = true; el('trade-halt').textContent = ''; el('trade-reset').hidden = true;
    el('trade-proposals-empty').hidden = false; el('trade-orders-empty').hidden = false;
    el('trade-proposal-count').textContent = '0'; el('trade-position-count').textContent = '0'; el('trade-history-count').textContent = '0 recent results';
    el('trading-badge').textContent = 'Sign in to view trading';
    el('trade-account').textContent = ''; el('trade-connection-status').textContent = '';
    status('Sign in to manage demo and live execution.');
  }
  clear();
  setInterval(() => void refresh(), 5000);
  return { refresh, clear, async editConnection(environment) {
    await refresh();
    if (!getAuthorization() || !state) return;
    el('execution-connections').open = true;
    el('trade-key-environment').value = environment;
    el('trade-api-version').value = state.connections[environment]?.apiVersion ?? 'v2';
    for (const key of ['trade-key', 'trade-secret', 'trade-passphrase']) el(key).value = '';
    el('execution-connections').scrollIntoView({ block: 'center' }); el('trade-api-version').focus();
    status(`Editing ${environment.toUpperCase()} execution key. Leave all three credentials blank to keep it, or replace all three. Saving stops new entries.`);
  } };
}
