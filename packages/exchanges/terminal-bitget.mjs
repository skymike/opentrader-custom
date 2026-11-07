import { createHmac } from 'node:crypto';

const routes = {
  GET: new Set(['account/accounts', 'account/account', 'position/all-position', 'order/detail', 'order/orders-pending',
    'order/orders-plan-pending', 'market/contracts', 'market/ticker']),
  POST: new Set(['order/place-order', 'order/cancel-order']),
};
const base = { productType: 'USDT-FUTURES', marginCoin: 'USDT' };
export const validQuantity = (value) => (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) && Number.isFinite(Number(value)) && Number(value) >= 0;
export function validatePositions(rows) {
  if (!Array.isArray(rows) || rows.some((row) => typeof row.symbol !== 'string' || !['long', 'short'].includes(row.holdSide) || !validQuantity(row.total))) throw new Error('Malformed position response');
  return rows;
}
export function createBitget(environment, credentials, fetcher = fetch, clock = Date.now) {
  if (!['demo', 'live'].includes(environment) || !['apiKey', 'secret', 'passphrase'].every((key) =>
    typeof credentials?.[key] === 'string' && credentials[key].length > 0)) throw new Error('Trading credentials required');
  async function request(method, endpoint, params) {
    if (!routes[method]?.has(endpoint)) throw new Error('Unsupported trading route');
    const path = '/api/v2/mix/' + endpoint;
    const query = method === 'GET' ? '?' + new URLSearchParams(params).toString() : '';
    const body = method === 'POST' ? JSON.stringify(params) : '';
    const timestamp = String(clock());
    const headers = { 'Content-Type': 'application/json', 'ACCESS-KEY': credentials.apiKey,
      'ACCESS-PASSPHRASE': credentials.passphrase, 'ACCESS-TIMESTAMP': timestamp,
      'ACCESS-SIGN': createHmac('sha256', credentials.secret).update(timestamp + method + path + query + body).digest('base64'),
      ...(environment === 'demo' ? { paptrading: '1' } : {}) };
    try {
      const response = await fetcher('https://api.bitget.com' + path + query,
        { method, headers, ...(body ? { body } : {}), signal: AbortSignal.timeout(10000), redirect: 'error' });
      const result = await response.json();
      if (!response.ok || result.code !== '00000') throw new Error('Exchange request failed');
      return result.data;
    } catch { throw new Error('Exchange request failed; reconcile before any retry'); }
  }
  async function context(symbol) {
    const [accounts, positions, pending, contract, ticker, account, triggers, trailing, protection] = await Promise.all([
      request('GET', 'account/accounts', base), request('GET', 'position/all-position', base),
      request('GET', 'order/orders-pending', { productType: base.productType }),
      request('GET', 'market/contracts', { productType: base.productType, symbol }),
      request('GET', 'market/ticker', { productType: base.productType, symbol }),
      request('GET', 'account/account', { ...base, symbol }),
      ...['normal_plan', 'track_plan', 'profit_loss'].map((planType) => request('GET', 'order/orders-plan-pending', { productType: base.productType, planType, limit: '100' })),
    ]);
    const balance = accounts.find((row) => row.marginCoin === 'USDT');
    const rule = contract.find((row) => row.symbol === symbol);
    const quote = ticker.find((row) => row.symbol === symbol);
    validatePositions(positions);
    if (![pending, triggers, trailing, protection].every((result) => Array.isArray(result?.entrustedList)) || !rule || !quote) throw new Error('Incomplete exchange response');
    return { equity: Number(balance?.usdtEquity), available: Number(balance?.available),
      positions: positions.filter((row) => Number(row.total) > 0), orders: [pending, triggers, trailing, protection].flatMap((result) => result.entrustedList),
      price: Number(quote.lastPr), quoteTime: Number(quote.ts), account,
      rules: { step: Number(rule.sizeMultiplier), minSize: Number(rule.minTradeNum), minCost: Number(rule.minTradeUSDT),
        tick: Number(rule.priceEndStep) * 10 ** -Number(rule.pricePlace), maxSize: Number(rule.maxOrderQty), status: rule.symbolStatus } };
  }
  return { request, context,
    accountSnapshot: async () => {
      const rows = await request('GET', 'account/accounts', base);
      const balance = rows.find(row => row.marginCoin === 'USDT');
      return { equity: Number(balance?.usdtEquity), available: Number(balance?.available) };
    },
    detail: (entry, closing = false) => request('GET', 'order/detail', { productType: base.productType, symbol: entry.symbol,
      clientOid: closing ? entry.closeId : entry.id }),
    positions: async () => validatePositions(await request('GET', 'position/all-position', base)),
    protection: async (symbol) => {
      const result = await request('GET', 'order/orders-plan-pending', { productType: base.productType, symbol, planType: 'profit_loss', limit: '100' });
      if (!Array.isArray(result?.entrustedList)) throw new Error('Protective order response unavailable');
      return result.entrustedList;
    },
    submit: (entry) => request('POST', 'order/place-order', { ...base, symbol: entry.symbol, marginMode: 'isolated',
      size: String(entry.quantity), price: String(entry.limit), side: entry.side === 'long' ? 'buy' : 'sell',
      orderType: 'limit', force: 'ioc', clientOid: entry.id, reduceOnly: 'NO',
      presetStopLossPrice: String(entry.stop), presetStopSurplusPrice: String(entry.target),
      presetStopLossExecutePrice: '0', presetStopSurplusExecutePrice: '0' }),
    cancel: (entry) => request('POST', 'order/cancel-order', { ...base, symbol: entry.symbol, clientOid: entry.id }),
    close: (entry, quantity) => request('POST', 'order/place-order', { ...base, symbol: entry.symbol, marginMode: 'isolated',
      size: String(quantity), side: entry.side === 'long' ? 'sell' : 'buy', orderType: 'market',
      clientOid: entry.closeId, reduceOnly: 'YES' }),
  };
}
