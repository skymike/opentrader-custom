export function createTradingPanel(getAuthorization) {
  const el = (id) => document.getElementById(id);
  let state, busy = false, generation = 0, dirty = false;
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
    el('trading-fields').disabled = false;
    if (!dirty) for (const key of fields) el('trade-' + key).value = settings[key];
    el('trading-badge').textContent = `${settings.environment.toUpperCase()} · ${settings.mode === 'automatic' ? 'Automatic' : 'Approval'} · ${settings.armed ? 'Entries enabled' : 'Entries stopped'}`;
    el('trading-badge').classList.toggle('live-trading', settings.environment === 'live');
    el('trade-arm').textContent = settings.armed ? 'Stop new entries' : 'Enable new entries';
    el('trade-arm').disabled = dirty;
    status((stale ? 'Worker not reporting fresh status. ' : '') + (journal.message ?? 'Waiting for execution worker.'));
    el('trade-connection-status').textContent = `Demo key: ${connections.demo.configured ? 'saved' : 'missing'} · Live key: ${connections.live.configured ? 'saved' : 'missing'}`;
    const account = journal.accounts[settings.environment];
    el('trade-account').textContent = account ? `${settings.environment.toUpperCase()} execution account · Equity ${account.equity.toFixed(2)} USDT · Available ${account.available.toFixed(2)} USDT · ${new Date(account.updatedAt).toLocaleTimeString()}` : 'Execution account has not been checked yet.';
    el('trade-proposals').replaceChildren(...(journal.proposals ?? []).map((proposal) => {
      const card = document.createElement('section');
      const heading = document.createElement('h3'); heading.textContent = `${settings.environment.toUpperCase()} · ${proposal.side.toUpperCase()} ${proposal.symbol}`;
      const text = document.createElement('p'); text.textContent = `${proposal.quantity} units · Limit ${proposal.limit} · Stop ${proposal.stop} · Target ${proposal.target} · Estimated risk ${proposal.riskAmount.toFixed(2)} USDT`;
      const expiry = document.createElement('small'); expiry.textContent = `Expires ${new Date(proposal.expiresAt).toLocaleTimeString()}. IOC order: any unfilled quantity is cancelled.`;
      const disabled = stale || dirty || proposal.expiresAt <= Date.now() || !settings.armed;
      card.append(heading, text, expiry, button('Approve trade', () => command({ action: 'approve', proposalId: proposal.id }), disabled),
        button('Reject', () => command({ action: 'reject', proposalId: proposal.id }), disabled));
      return card;
    }));
    el('trade-orders').replaceChildren(...[...journal.entries].reverse().slice(0, 20).map((entry) => {
      const row = document.createElement('section');
      const text = document.createElement('p'); text.textContent = `${entry.environment.toUpperCase()} · ${entry.symbol} ${entry.side ?? ''} · ${entry.status} · Filled ${entry.filled ?? 0} / ${entry.quantity ?? 0}${entry.message ? ' · ' + entry.message : ''}`;
      row.append(text);
      if (!['closed', 'unfilled', 'rejected'].includes(entry.status)) row.append(button('Close managed position', () => {
        if (confirm(`Close this ${entry.environment.toUpperCase()} ${entry.symbol} managed position at market?`)) void command({ action: 'close', entryId: entry.id });
      }));
      return row;
    }));
    el('trade-reset').hidden = !journal.halted[settings.environment];
  }
  async function refresh() {
    if (!getAuthorization() || busy) return;
    busy = true;
    try { state = await api(); render(); }
    catch (error) { if (getAuthorization()) { status(error.message); el('trade-proposals').replaceChildren(); } }
    finally { busy = false; }
  }
  for (const key of fields) el('trade-' + key).addEventListener('input', () => { dirty = true; el('trade-arm').disabled = true; });
  async function save(armed) {
    if (!state) return;
    let acknowledgement;
    if (armed && el('trade-environment').value === 'live') {
      acknowledgement = prompt('This enables real-money trading. Type ENABLE LIVE TRADING to continue.');
      if (acknowledgement !== 'ENABLE LIVE TRADING') return;
    }
    const payload = { ...state.settings, armed, liveAcknowledgement: acknowledgement };
    for (const key of fields) payload[key] = ['environment', 'mode'].includes(key) ? el('trade-' + key).value : Number(el('trade-' + key).value);
    try { state = await api('', 'PUT', payload); dirty = false; render(); }
    catch (error) { status(error.message); }
  }
  el('trading-form').addEventListener('submit', (event) => { event.preventDefault(); void save(false); });
  el('trade-arm').addEventListener('click', () => void save(!state?.settings.armed));
  el('trade-reset').addEventListener('click', () => void command({ action: 'reset-halt' }));
  el('trading-connection-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      state = await api('/connection', 'PUT', { environment: el('trade-key-environment').value,
        apiKey: el('trade-key').value, secret: el('trade-secret').value, passphrase: el('trade-passphrase').value });
      for (const key of ['trade-key', 'trade-secret', 'trade-passphrase']) el(key).value = '';
      dirty = false; render();
    } catch (error) { status(error.message); }
  });
  el('trade-remove-key').addEventListener('click', async () => {
    try { state = await api('/connection', 'DELETE', { environment: el('trade-key-environment').value }); dirty = false; render(); }
    catch (error) { status(error.message); }
  });
  function clear() {
    generation++; state = undefined; dirty = false;
    el('trading-fields').disabled = true;
    el('trading-form').reset(); el('trading-connection-form').reset();
    el('trade-proposals').replaceChildren(); el('trade-orders').replaceChildren();
    el('trading-badge').textContent = 'Sign in to view trading';
    el('trade-account').textContent = ''; el('trade-connection-status').textContent = '';
    status('Sign in to manage demo and live execution.');
  }
  clear();
  setInterval(() => void refresh(), 5000);
  return { refresh, clear };
}
