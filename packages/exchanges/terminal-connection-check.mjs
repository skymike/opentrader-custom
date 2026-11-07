import { createBitget } from './terminal-bitget.mjs';
import { createBitgetV3 } from './terminal-bitget-v3.mjs';

const pending = new Set();
export async function withConnectionCheck(key, action) {
  if (pending.has(key) || pending.size >= 4) {
    throw Object.assign(new Error('A connection test is already running. Try again shortly.'), { status: 429 });
  }
  pending.add(key);
  try { return await action(); } finally { pending.delete(key); }
}

// Reuse signing, but strictly restrict this transport to account/position GETs.
const allowed = new Set(['/api/v2/mix/account/accounts', '/api/v2/mix/position/all-position',
  '/api/v3/account/assets', '/api/v3/position/current-position']);
export async function checkConnection(connection) {
  let exchangeCode, httpStatus, unreachable = false;
  const fetcher = async (url, options) => {
    const parsed = new URL(url);
    if (options.method !== 'GET' || parsed.origin !== 'https://api.bitget.com' || !allowed.has(parsed.pathname)) throw new Error('Unsupported connection test');
    let response;
    try { response = await fetch(url, options); }
    catch { unreachable = true; throw new Error('Account request unavailable'); }
    if (!response.ok) httpStatus = response.status;
    try {
      const result = await response.clone().json();
      if (result.code !== '00000' && /^\d{5,6}$/.test(String(result.code))) exchangeCode = String(result.code);
    } catch { /* Never return exchange messages or signed requests. */ }
    return response;
  };
  try {
    if (!['v2', 'v3'].includes(connection.apiVersion)) throw new Error('Invalid account API');
    const unified = connection.apiVersion === 'v3';
    const client = (unified ? createBitgetV3 : createBitget)(connection.environment, connection.credentials, fetcher);
    const results = await Promise.allSettled([
      client.request('GET', unified ? 'account/assets' : 'account/accounts', unified ? {} : { productType: 'USDT-FUTURES', marginCoin: 'USDT' }),
      client.positions(),
    ]);
    if (results.some(result => result.status === 'rejected')) throw new Error('Account check failed');
    const assets = results[0].value;
    const balances = unified ? assets?.assets : assets;
    if (!Array.isArray(balances)) throw new Error('Incomplete balances');
    const coin = balances.find(row => (unified ? row.coin : row.marginCoin) === 'USDT');
    const values = [unified ? assets.usdtEquity : coin ? coin.usdtEquity : 0, coin ? coin.available : 0];
    if (values.some(value => !['number','string'].includes(typeof value) || String(value).trim() === '' || !Number.isFinite(Number(value)))) throw new Error('Incomplete balances');
    return { status: 'connected', checkedAt: Date.now(), message: 'Account and positions are readable. Order permissions were not tested.' };
  } catch {
    const message = unreachable ? 'Could not reach Bitget or the request timed out. Try again shortly.' :
      httpStatus === 429 ? 'Bitget is limiting requests. Wait a moment and test again.' :
      `Bitget could not confirm account access${exchangeCode ? ` (code ${exchangeCode})` : ''}. Check API version, Demo/Live, credentials, read permissions and IP allowlist.`;
    return { status: 'error', checkedAt: Date.now(), message };
  }
}
