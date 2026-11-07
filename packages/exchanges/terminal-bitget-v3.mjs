import { createHmac } from 'node:crypto';
import { validatePositions } from './terminal-bitget.mjs';
const category = 'USDT-FUTURES';
const routes = { GET: new Set(['account/assets', 'account/settings', 'position/current-position', 'trade/order-info',
  'trade/unfilled-orders', 'trade/unfilled-strategy-orders', 'market/instruments', 'market/tickers']),
  POST: new Set(['trade/place-order', 'trade/cancel-order', 'trade/cancel-strategy-order']) };
const list = (data) => { if (!Array.isArray(data)) throw new Error('Malformed Unified response'); return data; };
export function normalizeUnifiedPositions(data) {
  return validatePositions(list(data?.list === null ? [] : data?.list).map((row) => ({ ...row, holdSide: row.posSide,
    posMode: row.holdMode, unrealizedPL: row.unrealisedPnl })));
}
export function createBitgetV3(environment, credentials, fetcher = fetch, clock = Date.now) {
  if (!['demo', 'live'].includes(environment) || !['apiKey', 'secret', 'passphrase'].every((key) => typeof credentials?.[key] === 'string' && credentials[key])) throw new Error('Trading credentials required');
  async function request(method, endpoint, params = {}) {
    if (!routes[method]?.has(endpoint)) throw new Error('Unsupported Unified route');
    const path = '/api/v3/' + endpoint;
    const queryString = method === 'GET' ? new URLSearchParams(params).toString() : '';
    const query = queryString ? '?' + queryString : '';
    const body = method === 'POST' ? JSON.stringify(params) : '';
    const timestamp = String(clock());
    const headers = { 'Content-Type': 'application/json', 'ACCESS-KEY': credentials.apiKey, 'ACCESS-PASSPHRASE': credentials.passphrase,
      'ACCESS-TIMESTAMP': timestamp, 'ACCESS-SIGN': createHmac('sha256', credentials.secret).update(timestamp + method + path + query + body).digest('base64'),
      ...(environment === 'demo' ? { paptrading: '1' } : {}) };
    try {
      const response = await fetcher('https://api.bitget.com' + path + query, { method, headers, ...(body ? { body } : {}), signal: AbortSignal.timeout(10000), redirect: 'error' });
      const result = await response.json();
      if (!response.ok || result.code !== '00000') {
        const error = new Error('Unified request rejected');
        error.exchangeCode = /^\d{5,6}$/.test(String(result.code)) ? String(result.code) : undefined;
        throw error;
      }
      return result.data;
    } catch (cause) { const error = new Error('Unified exchange request failed' + (cause.exchangeCode ? ' (code ' + cause.exchangeCode + ')' : '') + '; reconcile before retry'); error.exchangeCode = cause.exchangeCode; throw error; }
  }
  async function positions() { return normalizeUnifiedPositions(await request('GET', 'position/current-position', { category })); }
  async function strategies() { return list(await request('GET', 'trade/unfilled-strategy-orders', { category })); }
  async function context(symbol) {
    const [assets, settings, positionRows, orders, strategyRows, instruments, tickers] = await Promise.all([
      request('GET', 'account/assets'), request('GET', 'account/settings'), positions(), request('GET', 'trade/unfilled-orders', { category, limit: '100' }),
      strategies(), request('GET', 'market/instruments', { category, symbol }), request('GET', 'market/tickers', { category, symbol })]);
    const coin = list(assets.assets).find((a) => a.coin === 'USDT');
    const config = list(settings.symbolConfigList).find((row) => row.symbol === symbol && row.category === category);
    const rule = list(instruments).find((row) => row.symbol === symbol);
    const quote = list(tickers).find((row) => row.symbol === symbol);
    if (!rule || !quote) throw new Error('Unified market is unavailable');
    return { equity: Number(assets.usdtEquity), available: coin ? Number(coin.available) : 0, positions: positionRows.filter((row) => Number(row.total) > 0),
      orders: [...list(orders?.list), ...strategyRows], price: Number(quote.lastPrice), quoteTime: Number(quote.ts),
      account: { posMode: settings.holdMode, marginMode: config?.marginMode, isolatedLongLever: config?.leverage, isolatedShortLever: config?.leverage },
      rules: { step: Number(rule.quantityMultiplier), minSize: Number(rule.minOrderQty), minCost: Number(rule.minOrderAmount),
        tick: Number(rule.priceMultiplier), maxSize: rule.maxOrderQty === '' || rule.maxOrderQty === '0' ? Number.MAX_SAFE_INTEGER : Number(rule.maxOrderQty), status: rule.status === 'online' ? 'normal' : rule.status } };
  }
  async function protection(symbol) {
    const [rows, settings] = await Promise.all([strategies(), request('GET', 'account/settings')]);
    return rows.filter((r) => r.symbol === symbol && r.status === 'pending' && (!r.type || r.type === 'tpsl')).flatMap((row) => {
      // Unified one-way TPSL reports the closing order direction, not the protected position side.
      const holdSide = settings.holdMode === 'one_way_mode' ? ({ sell: 'long', buy: 'short' })[row.side] : row.posSide;
      const common = { symbol, holdSide, size: row.qty, orderId: row.orderId, clientOid: row.clientOid, planStatus: 'live' };
      return [
        ...(row.stopLoss && row.slOrderType === 'market' ? [{ ...common, planType: 'loss_plan', triggerPrice: row.stopLoss, executePrice: '0' }] : []),
        ...(row.takeProfit && row.tpOrderType === 'market' ? [{ ...common, planType: 'profit_plan', triggerPrice: row.takeProfit, executePrice: '0' }] : []),
      ];
    });
  }
  return { request, context, positions, protection, strategies,
    accountSnapshot: async () => {
      const assets = await request('GET', 'account/assets');
      const coin = list(assets.assets).find(row => row.coin === 'USDT');
      return { equity: Number(assets.usdtEquity), available: coin ? Number(coin.available) : 0 };
    },
    detail: async (entry, closing = false) => {
      const row = await request('GET', 'trade/order-info', { category, symbol: entry.symbol, clientOid: closing ? entry.closeId : entry.id });
      return { ...row, state: ({ cancelled: 'canceled', new: 'live' })[row.orderStatus] ?? row.orderStatus, baseVolume: row.cumExecQty, priceAvg: row.avgPrice };
    },
    submit: (entry) => request('POST', 'trade/place-order', { category, symbol: entry.symbol, marginMode: 'isolated',
      qty: String(entry.quantity), price: String(entry.limit), side: entry.side === 'long' ? 'buy' : 'sell', orderType: 'limit', timeInForce: 'ioc', clientOid: entry.id,
      reduceOnly: 'no', stopLoss: String(entry.stop), takeProfit: String(entry.target), slOrderType: 'market', tpOrderType: 'market', slTriggerBy: 'market', tpTriggerBy: 'market' }),
    cancel: (entry) => request('POST', 'trade/cancel-order', { category, symbol: entry.symbol, clientOid: entry.id }),
    close: (entry, quantity) => request('POST', 'trade/place-order', { category, symbol: entry.symbol, marginMode: 'isolated', qty: String(quantity),
      side: entry.side === 'long' ? 'sell' : 'buy', orderType: 'market', clientOid: entry.closeId, reduceOnly: 'yes' }),
  };
}
