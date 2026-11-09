export function createManualFuturesPanel(getAuthorization, refresh) {
  const el = id => document.getElementById(id);
  const css = document.createElement('link');
  css.rel = 'stylesheet'; css.href = new URL('./manual-futures.css', import.meta.url); document.head.append(css);
  const botSettings = document.createElement('div');
  botSettings.className = 'futures-grid bot-futures-settings';
  botSettings.innerHTML = `<label>Leverage · 1–20×<input id="trade-leverage" type="number" min="1" max="20" step="1" value="1" required></label>
    <label>Order type<select id="trade-orderType" title="Bot limit orders are immediate-or-cancel: any unfilled remainder is cancelled."><option value="limit">Limit · IOC</option><option value="market">Market</option></select></label>
    <label>Direction<select id="trade-direction"><option value="both">Long & short</option><option value="long">Long only</option><option value="short">Short only</option></select></label>
    <label>Stop loss · %<input id="trade-stopLossPct" type="number" min="0.1" max="50" step="0.1" value="2" required></label>
    <label>Take profit · %<input id="trade-takeProfitPct" type="number" min="0.1" max="50" step="0.1" value="4" required></label>`;
  el('trade-unsaved').before(botSettings);
  const riskNote = el('trade-risk-settings').querySelector('small');
  if (riskNote) riskNote.textContent = 'Hourly Bollinger / RSI · One-way, isolated margin. Daily loss resets at UTC midnight and includes funding and transfers.';
  const container = el('trading-panel');
  const sidebar = container.closest('.terminal-sidebar');
  sidebar?.classList.add('has-futures-controls');
  const bot = document.createElement('div'); bot.id = 'futures-bot';
  bot.append(...container.childNodes);
  const manual = document.createElement('section'); manual.id = 'futures-manual'; manual.hidden = true;
  manual.innerHTML = `<div class="execution-heading"><h2>Manual futures</h2><strong id="manual-badge" class="execution-badge">DEMO</strong></div>
    <p class="muted" id="manual-pair">BTC / USDT · One-way · Isolated</p><p id="manual-account" class="muted">Account snapshot not loaded.</p><button id="manual-refresh" type="button" class="secondary">Refresh balance & positions</button>
    <form id="manual-form"><fieldset id="manual-fields" disabled><div class="futures-grid">
    <label>Account<select id="manual-environment"><option value="demo">Demo · Virtual funds</option><option value="live">Live · Real funds</option></select></label>
    <label>Action<select id="manual-action"><option value="open">Open</option><option value="close">Close · Reduce only</option></select></label>
    <label>Position side<select id="manual-side"><option value="long">Long</option><option value="short">Short</option></select></label>
    <label>Order type<select id="manual-orderType"><option value="limit">Limit</option><option value="market">Market</option></select></label>
    <label id="manual-quantity-label">Quantity · BTC<input id="manual-quantity" type="number" min="0.00000001" step="any" required></label>
    <label id="manual-limit-label">Limit price · USDT<input id="manual-limit" type="number" min="0.00000001" step="any" required></label>
    <label>Leverage · 1–20×<input id="manual-leverage" type="number" min="1" max="20" step="1" value="1" required></label>
    <label id="manual-stop-label">Stop loss · %<input id="manual-stopLossPct" type="number" min="0.1" max="50" step="0.1" value="2" required></label>
    <label id="manual-target-label">Take profit · %<input id="manual-takeProfitPct" type="number" min="0.1" max="50" step="0.1" value="4" required></label>
    </div><p id="manual-estimate" class="muted"></p><button id="manual-preview" type="submit">Review demo order</button></fieldset></form>
    <p id="manual-status" role="status">Sign in to trade.</p><div id="manual-orders"></div>`;
  const tabs = document.createElement('div'); tabs.className = 'futures-tabs'; tabs.setAttribute('aria-label', 'Trading controls');
  for (const [label, panel] of [['Bot', bot], ['Manual', manual]]) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary'; button.textContent = label;
    button.setAttribute('aria-controls', panel.id); button.setAttribute('aria-pressed', String(panel === bot));
    button.addEventListener('click', () => { bot.hidden = panel !== bot; manual.hidden = panel !== manual; container.scrollTop = 0; sidebar?.classList.toggle('manual-futures-active', panel === manual);
      for (const other of tabs.children) other.setAttribute('aria-pressed', String(other === button)); if (panel === manual) void loadContext(); });
    tabs.append(button);
  }
  container.append(tabs, bot, manual);
  const dialog = document.createElement('dialog'); dialog.id = 'manual-review';
  dialog.innerHTML = `<h2>Review futures order</h2><p id="manual-review-summary"></p><p id="manual-review-prices"></p><p id="manual-review-expiry" class="muted"></p>
    <label id="manual-live-label" hidden>Type PLACE LIVE ORDER<input id="manual-live-ack" autocomplete="off"></label>
    <p id="manual-review-status" role="status"></p><div class="settings-actions"><button id="manual-confirm" type="button">Confirm order</button><button id="manual-dismiss" class="secondary" type="button">Back</button></div>`;
  document.body.append(dialog);
  let state = null, symbol = 'BTCUSDT', preview = null, busy = false, generation = 0, contextGeneration = 0, draftGeneration = 0;
  const val = key => el('manual-' + key).value;
  const status = text => { el('manual-status').textContent = text; };
  const number = n => Number.isFinite(Number(n)) ? Number(n).toLocaleString(undefined, { maximumFractionDigits: 8 }) : '—';
  function invalidate() { draftGeneration++; preview = null; el('manual-confirm').disabled = true; if (dialog.open) dialog.close(); }
  async function api(path, body) {
    const auth = getAuthorization(), version = generation;
    if (!auth) throw Error('Sign in first.');
    const response = await fetch('/api/terminal/trading/manual/' + path, { method: body ? 'POST' : 'GET', headers: { authorization: auth, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
    const data = await response.json();
    if (version !== generation || auth !== getAuthorization()) throw Error('Session changed. Review again.');
    if (!response.ok) throw Error(data.message ?? 'Order request failed.');
    return data;
  }
  async function loadContext() {
    const version = ++contextGeneration;
    if (!getAuthorization() || !state?.connections?.[val('environment')]?.configured) { el('manual-account').textContent = 'Save an execution key to check balance and positions.'; return; }
    el('manual-account').textContent = 'Reading balance and positions…';
    try {
      const data = await api('context?' + new URLSearchParams({ environment: val('environment'), symbol: symbol.replace(/USDT$/, '/USDT:USDT') }));
      if (version !== contextGeneration) return;
      const positions = (data.positions ?? []).filter(p => p.symbol === symbol && Number(p.total) > 0).map(p => `${p.holdSide} ${number(p.total)} ${symbol.replace(/USDT$/, '')}`);
      el('manual-account').textContent = `${val('environment').toUpperCase()} · Available ${number(data.available)} USDT · Position: ${positions.join(', ') || 'none'} · Quote ${number(data.price)} · ${new Date().toLocaleTimeString()}`;
      if (!val('limit') && Number.isFinite(Number(data.price))) el('manual-limit').value = data.price;
      update();
    } catch (error) { if (version === contextGeneration) el('manual-account').textContent = error.message; }
  }
  el('manual-refresh').addEventListener('click', () => void loadContext());
  el('manual-environment').addEventListener('change', () => { el('manual-limit').value = ''; void loadContext(); });
  function update() {
    const env = val('environment'), closing = val('action') === 'close', market = val('orderType') === 'market';
    el('manual-badge').textContent = env === 'live' ? 'LIVE · REAL FUNDS' : 'DEMO · VIRTUAL FUNDS';
    el('manual-badge').classList.toggle('live-trading', env === 'live');
    el('manual-pair').textContent = symbol.replace(/USDT$/, ' / USDT') + ' · One-way · Isolated';
    el('manual-quantity-label').firstChild.textContent = 'Quantity · ' + symbol.replace(/USDT$/, '');
    el('manual-limit-label').hidden = market; el('manual-limit').disabled = market;
    for (const [label, key] of [['stop', 'stopLossPct'], ['target', 'takeProfitPct']]) {
      el('manual-' + label + '-label').hidden = closing; el('manual-' + key).disabled = closing;
    }
    el('manual-leverage').disabled = closing;
    const notional = Number(val('quantity')) * Number(val('limit'));
    el('manual-estimate').textContent = closing ? 'Reduce only: closes this side without opening an opposite position. Size is checked on review.' :
      market ? 'Market price, notional and margin are checked on review. Fees and slippage are additional.' :
      `Notional ${number(notional)} USDT · Est. margin ${number(notional / Number(val('leverage')))} USDT + fees. TP/SL percentages are price moves.`;
    el('manual-preview').textContent = `Review ${env} ${closing ? 'close' : 'order'}`;
    el('manual-fields').disabled = !getAuthorization() || !state || state.stale || busy;
    el('manual-preview').disabled = !state?.connections?.[env]?.configured;
    renderOrders();
  }
  function renderOrders() {
    const entries = (state?.journal?.entries ?? []).filter(e => e.source === 'manual' && e.environment === val('environment') && e.symbol.replaceAll('/', '').split(':')[0] === symbol);
    el('manual-orders').replaceChildren(...entries.slice(-5).reverse().map(entry => {
      const row = document.createElement('div'); row.className = 'manual-order';
      const text = document.createElement('p'); text.textContent = `${entry.side} · ${entry.status} · Filled ${number(entry.filled ?? 0)} / ${number(entry.quantity)}`; row.append(text);
      if (entry.orderType === 'limit' && !['closed', 'unfilled', 'rejected', 'cancelled', 'canceled'].includes(entry.status) && Number(entry.filled ?? 0) < Number(entry.quantity)) {
        const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'secondary'; cancel.textContent = 'Cancel remaining limit'; cancel.disabled = busy || !!state?.stale;
        cancel.addEventListener('click', async () => {
          if (!confirm(`Cancel the remaining ${entry.environment.toUpperCase()} ${entry.symbol} limit order? Filled positions remain open.`)) return;
          busy = true; update();
          try { await api('cancel', { entryId: entry.id }); status('Cancellation queued. Waiting for exchange confirmation.'); await refresh(); }
          catch (error) { status(error.message); } finally { busy = false; update(); }
        }); row.append(cancel);
      }
      return row;
    }));
  }
  el('manual-form').addEventListener('input', () => { invalidate(); update(); });
  el('manual-form').addEventListener('submit', async event => {
    event.preventDefault(); if (busy || el('manual-fields').disabled) return;
    const body = { environment: val('environment'), connectionRevision: state.connections[val('environment')].revision,
      symbol: symbol.replace(/USDT$/, '/USDT:USDT'), action: val('action'), side: val('side'), orderType: val('orderType'),
      quantity: Number(val('quantity')), leverage: Number(val('leverage')), stopLossPct: Number(val('stopLossPct')), takeProfitPct: Number(val('takeProfitPct')) };
    if (body.orderType === 'limit') body.limit = Number(val('limit'));
    const draftVersion = draftGeneration;
    busy = true; update(); status('Checking order and account…');
    try {
      const result = await api('preview', body);
      if (draftVersion !== draftGeneration || state?.stale || state?.connections?.[body.environment]?.revision !== body.connectionRevision) { status('Order selection or account changed. Review again.'); return; }
      preview = { ...body, ...result.preview };
      el('manual-review-summary').textContent = `${body.environment.toUpperCase()} · ${body.action.toUpperCase()} ${body.side.toUpperCase()} · ${body.symbol} · ${body.orderType.toUpperCase()} · ${number(preview.quantity)} base units · ${body.action === 'close' ? 'Reduce only' : body.leverage + '× leverage'}`;
      const price = preview.limit ?? preview.entry ?? preview.price;
      const notional = preview.notional ?? Number(price) * preview.quantity;
      el('manual-review-prices').textContent = `Reference price ${number(price)} · Notional ${number(notional)} USDT · Est. margin ${number(preview.margin ?? notional / body.leverage)} USDT${body.action === 'open' ? ` · Stop ${number(preview.stop)} · Target ${number(preview.target)}` : ''}. Fees/slippage may change execution.`;
      el('manual-review-expiry').textContent = `Valid until ${new Date(preview.expiresAt).toLocaleTimeString()}. ${body.orderType === 'limit' ? 'Unfilled limit orders may remain open until cancelled.' : 'Market orders execute at the available price.'}`;
      el('manual-live-label').hidden = body.environment !== 'live'; el('manual-live-ack').value = '';
      el('manual-review-status').textContent = ''; el('manual-confirm').disabled = body.environment === 'live';
      el('manual-confirm').textContent = `Confirm ${body.environment} ${body.action}`; dialog.showModal(); status('Review the order before confirming.');
    } catch (error) { status(error.message); }
    finally { busy = false; update(); }
  });
  el('manual-live-ack').addEventListener('input', () => { el('manual-confirm').disabled = !preview || val('live-ack') !== 'PLACE LIVE ORDER'; });
  el('manual-dismiss').addEventListener('click', invalidate);
  el('manual-confirm').addEventListener('click', async () => {
    if (!preview || busy) return;
    if (preview.expiresAt <= Date.now()) { invalidate(); status('Preview expired. Review again.'); return; }
    busy = true; el('manual-confirm').disabled = true; el('manual-dismiss').disabled = true; update();
    try { const result = await api('confirm', { previewId: preview.id, ...(preview.environment === 'live' ? { liveAcknowledgement: val('live-ack') } : {}) });
      invalidate(); status(`Order ${result.entry?.status ?? 'received'}. ${result.entry?.message ?? 'Check order status for exchange confirmation.'}`); await refresh(); void loadContext();
    } catch (error) { el('manual-review-status').textContent = error.message + ' Check order status before retrying.'; }
    finally { busy = false; el('manual-dismiss').disabled = false; update(); }
  });
  document.addEventListener('terminal-market-select', ({ detail }) => { if (!detail?.symbol || detail.symbol === symbol) return; symbol = detail.symbol; invalidate(); el('manual-quantity').value = ''; el('manual-limit').value = ''; update(); if (!manual.hidden) void loadContext(); });
  document.addEventListener('terminal-trading', ({ detail }) => {
    if (!detail) { generation++; contextGeneration++; invalidate(); el('manual-form').reset(); el('manual-account').textContent = 'Account snapshot not loaded.'; status('Sign in to trade.'); }
    else if (preview && (detail.stale || detail.connections?.[preview.environment]?.revision !== state?.connections?.[preview.environment]?.revision)) invalidate();
    state = detail; update();
    if (detail?.stale) status('Worker status is stale. Wait for a fresh account check.');
    else if (detail && !detail.connections?.[val('environment')]?.configured) status('Save an execution key in Settings to use this account.');
    else if (detail && el('manual-status').textContent === 'Sign in to trade.') status('Manual orders are independent of bot entry controls.');
  });
  setInterval(() => { if (preview && preview.expiresAt <= Date.now()) { invalidate(); status('Preview expired. Review again.'); } }, 1000);
  update();
}

