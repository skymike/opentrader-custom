const node = (tag, text, className) => {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
};
const compact = value => Number.isFinite(value) ? new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value) : '—';
const price = value => Number.isFinite(value) ? value.toLocaleString(undefined, { maximumSignificantDigits: 7 }) : '—';
export function createMarketsPanel(getAuthorization, onSaved) {
  let state, busy = false, generation = 0, loadedAt = 0, marketState = [];
  const open = node('button', 'Markets', 'secondary'); open.id = 'open-markets'; open.type = 'button';
  (document.querySelector('.toolbar') ?? document.querySelector('main')).prepend(open);
  const select = node('select'); select.id = 'chart-market'; select.setAttribute('aria-label', 'Chart market');
  document.querySelector('.symbol-tabs')?.replaceChildren(select);
  const dialog = node('dialog', undefined, 'markets-dialog'); dialog.id = 'markets-dialog'; dialog.setAttribute('aria-labelledby', 'markets-title');
  dialog.innerHTML = `<div class="markets-heading"><div><p class="eyebrow">YOUR MARKET LIST</p><h2 id="markets-title">Watch & trade</h2></div><button type="button" class="secondary" id="close-markets" aria-label="Close markets">✕</button></div>
    <p class="muted">Watch follows prices and signals. Trade makes a pair eligible for your execution settings.</p>
    <p id="markets-status" role="status">Sign in to manage pairs.</p>
    <fieldset id="markets-fields" disabled><div class="markets-actions"><button id="markets-top10" type="button">Add Top 10 by volume</button><span id="markets-count" class="muted"></span></div>
    <form id="market-add"><label class="sr-only" for="market-search">Search Bitget USDT perpetual pairs</label><input id="market-search" list="market-options" placeholder="Search a pair, e.g. XRP" autocomplete="off"><datalist id="market-options"></datalist><button type="submit" class="secondary">Add to Watch</button></form>
    <div class="markets-table-wrap"><table class="markets-table"><thead><tr><th>Pair / status</th><th>Price</th><th>24h volume · USDT</th><th>Watch</th><th>Trade</th><th><span class="sr-only">Remove</span></th></tr></thead><tbody id="market-rows"></tbody></table></div>
    <p class="muted markets-footnote">Up to 25 pairs · Shared price feed · 1h strategy. Changing Trade stops new entries until you re-enable them. Existing positions stay monitored.</p></fieldset>`;
  document.body.append(dialog);
  const el = id => document.getElementById(id);
  const status = text => { el('markets-status').textContent = text; };
  const chart = symbol => {
    select.value = symbol;
    document.dispatchEvent(new CustomEvent('terminal-market-select', { detail: { symbol } }));
  };
  select.addEventListener('change', () => chart(select.value));
  async function api(method = 'GET', body) {
    const auth = getAuthorization(), current = generation;
    if (!auth) throw new Error('Sign in to manage pairs.');
    const response = await fetch('/api/terminal/markets', { method, headers: { authorization: auth, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), cache: 'no-store', signal: AbortSignal.timeout(10000) });
    const data = await response.json();
    if (current !== generation || auth !== getAuthorization()) throw new Error('Session changed. Sign in again.');
    if (!response.ok) throw new Error(data.message ?? 'Market settings unavailable.');
    return data;
  }
  function render() {
    el('markets-fields').disabled = busy || !state || !getAuthorization();
    if (!state) return;
    const watch = state.pairs.filter(p => p.watch), trade = state.pairs.filter(p => p.trade);
    open.textContent = `Markets · ${watch.length} watch / ${trade.length} trade`;
    el('markets-count').textContent = `${state.pairs.length} / ${state.maxMarkets} pairs`;
    el('markets-top10').disabled = !state.catalogFresh;
    el('market-options').replaceChildren(...state.catalog.filter(m => !state.pairs.some(p => p.symbol === m.symbol)).map(m => {
      const option = node('option'); option.value = m.symbol.split(':')[0]; return option;
    }));
    const old = select.value;
    select.replaceChildren(...watch.map(p => { const option = node('option', p.symbol.split(':')[0]); option.value = p.symbol.split('/')[0] + 'USDT'; return option; }));
    select.disabled = !watch.length;
    if (watch.some(p => p.symbol.split('/')[0] + 'USDT' === old)) select.value = old;
    else if (watch.length) chart(select.value);
    el('market-rows').replaceChildren(...state.pairs.map(pair => {
      const live = marketState.find(m => m.symbol === pair.symbol), quote = live?.status === 'connected' ? live : state.catalog.find(m => m.symbol === pair.symbol);
      const row = node('tr'), label = node('td'), button = node('button', pair.symbol.split(':')[0], 'market-chart-link');
      button.type = 'button'; button.disabled = !pair.watch; button.title = 'Show this pair on the chart';
      button.addEventListener('click', () => { chart(pair.symbol.split('/')[0] + 'USDT'); dialog.close(); });
      label.append(button, node('small', !pair.watch ? 'Not watched' : live?.status === 'connected' ? '● Watching' : '○ Waiting for data'));
      row.append(label, node('td', price(quote?.price)), node('td', compact(quote?.volume)));
      for (const key of ['watch', 'trade']) {
        const cell = node('td'), input = node('input'); input.type = 'checkbox'; input.checked = pair[key];
        input.setAttribute('aria-label', `${key === 'watch' ? 'Watch' : 'Trade'} ${pair.symbol.split(':')[0]}`);
        input.addEventListener('change', () => {
          const pairs = state.pairs.map(p => p.symbol !== pair.symbol ? p : { ...p, [key]: input.checked,
            ...(key === 'trade' && input.checked ? { watch: true } : {}), ...(key === 'watch' && !input.checked ? { trade: false } : {}) });
          void save({ pairs }, pair.trade !== pairs.find(p => p.symbol === pair.symbol).trade);
        }); cell.append(input); row.append(cell);
      }
      const cell = node('td'), remove = node('button', 'Remove', 'secondary'); remove.type = 'button'; remove.setAttribute('aria-label', 'Remove ' + pair.symbol.split(':')[0]);
      remove.addEventListener('click', () => void save({ pairs: state.pairs.filter(p => p.symbol !== pair.symbol) }, pair.trade)); cell.append(remove); row.append(cell);
      return row;
    }));
  }
  async function refresh(force = false) {
    if (busy || !getAuthorization() || (!force && loadedAt && Date.now() - loadedAt < 30000)) return;
    busy = true; const current = generation; render();
    try { state = await api(); loadedAt = Date.now(); status(state.catalogFresh ? 'New pairs start in Watch only. Top 10 uses Bitget’s 24h USDT volume.' : 'Market list is delayed. Existing pairs can still be turned off.'); }
    catch (error) { if (current === generation) status(error.message); }
    finally { if (current === generation) { busy = false; render(); } }
  }
  async function save(change, tradeChanged = false) {
    if (busy || !state) return;
    busy = true; const current = generation; render(); status('Saving pairs…');
    try {
      state = await api('PUT', { revision: state.revision, ...change }); loadedAt = Date.now();
      el('market-search').value = '';
      status(tradeChanged ? 'Saved. New entries are stopped. Review execution settings, then re-enable when ready.' : 'Saved. Watchlist updates on the next scan, usually within 30 seconds.');
      onSaved?.();
    } catch (error) { if (current === generation) { status(error.message); loadedAt = 0; } }
    finally { if (current === generation) { busy = false; render(); } }
  }
  open.addEventListener('click', () => { dialog.showModal(); void refresh(true); });
  el('close-markets').addEventListener('click', () => dialog.close());
  el('markets-top10').addEventListener('click', () => void save({ action: 'top10' }));
  el('market-add').addEventListener('submit', event => {
    event.preventDefault(); if (!state || busy) return;
    const text = el('market-search').value.trim().toUpperCase();
    const found = state.catalog.find(m => [m.base, m.id, m.symbol, m.symbol.split(':')[0]].includes(text));
    if (!found) { status('Choose a pair from the Bitget search list.'); return; }
    if (state.pairs.some(p => p.symbol === found.symbol)) { status('This pair is already in your list.'); return; }
    void save({ pairs: [...state.pairs, { symbol: found.symbol, watch: true, trade: false }] });
  });
  return { start: () => void refresh(), update(value) { marketState = value.markets ?? []; if (dialog.open && !busy) render(); },
    clear() { generation++; state = undefined; busy = false; loadedAt = 0; marketState = []; dialog.close();
      open.textContent = 'Markets'; select.replaceChildren(); el('market-rows').replaceChildren(); el('market-options').replaceChildren(); status('Sign in to manage pairs.'); render(); } };
}
