const dialog = document.createElement('dialog');
dialog.style.cssText = 'max-width:640px;width:calc(100% - 48px);padding:24px;border:1px solid #8ca1bd;border-radius:12px;font:14px system-ui;color:#172b46;background:#fff';
dialog.innerHTML = `<h2>Bitget account API</h2><p>Select Classic V2 or Unified V3 for each OpenTrader account. The setting changes account and order requests. Stop bots and settle orders before switching.</p>
<form id="oa-login"><label>OpenTrader administrator password <input id="oa-password" type="password" autocomplete="current-password" required></label><button>Load accounts</button></form>
<p id="oa-status" role="status"></p><div id="oa-accounts"></div><p><button id="oa-import" type="button" disabled>Connect terminal demo key to OpenTrader</button></p>
<p><a href="/terminal/index.html#trading-panel">Set up demo/live keys in the custom terminal ↗</a></p><button id="oa-close" type="button">Close &amp; sign out</button>`;
document.body.append(dialog);
const el = (id) => dialog.querySelector('#' + id);
let auth;
async function request(path, method = 'GET', body) {
  const response = await fetch('/api/terminal/opentrader/' + path, { method, headers: { authorization: auth, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000) });
  const data = await response.json(); if (!response.ok) throw new Error(data.message ?? 'Sign in with the administrator password'); return data;
}
async function load() {
  const { accounts } = await request('accounts');
  el('oa-accounts').replaceChildren(...accounts.map((account) => {
    const row = document.createElement('p'); const label = document.createElement('label'); label.textContent = `${account.name} · ${account.environment.toUpperCase()} `;
    const select = document.createElement('select');
    for (const [value, text] of [['v2', 'Classic · V2'], ['v3', 'Unified · V3']]) { const option = document.createElement('option'); option.value = value; option.textContent = text; select.append(option); }
    select.value = account.apiVersion;
    const save = document.createElement('button'); save.type = 'button'; save.textContent = 'Check & save';
    save.onclick = async () => { save.disabled = true; el('oa-status').textContent = 'Checking account…';
      try { await request('accounts', 'PUT', { id: account.id, apiVersion: select.value }); el('oa-status').textContent = 'API saved and account verified. Refresh OpenTrader to update its account display.'; }
      catch (error) { el('oa-status').textContent = error.message; } finally { save.disabled = false; } };
    label.append(select); row.append(label, save); return row;
  }));
  if (!accounts.length) el('oa-accounts').textContent = 'No Bitget accounts yet. Save the demo connection in the custom terminal, then use the button below.';
  el('oa-import').disabled = false;
}
document.getElementById('open-original-api').onclick = () => dialog.showModal();
el('oa-login').onsubmit = async (event) => { event.preventDefault(); auth = el('oa-password').value; el('oa-password').value = '';
  try { await load(); el('oa-status').textContent = 'Choose the API that matches your Bitget account.'; } catch (error) { el('oa-status').textContent = error.message; } };
el('oa-import').onclick = async () => { el('oa-status').textContent = 'Verifying and connecting the saved demo account…';
  try { await request('import-demo', 'POST', {}); await load(); el('oa-status').textContent = 'Demo account connected. Refresh OpenTrader to see it.'; }
  catch (error) { el('oa-status').textContent = error.message; } };
el('oa-close').onclick = () => dialog.close();
dialog.addEventListener('close', () => { auth = undefined; el('oa-accounts').replaceChildren(); el('oa-status').textContent = ''; el('oa-import').disabled = true; });
