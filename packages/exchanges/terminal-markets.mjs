import { join, dirname } from 'node:path';
import { tradingPath, readJson } from './terminal-trading-store.mjs';

export const MAX_MARKETS = 25;
export const marketsPath = () => join(tradingPath(), 'markets.json');
export const catalogPath = () => process.env.TERMINAL_CATALOG_PATH ?? join(dirname(process.env.TERMINAL_STATE_PATH ?? '/terminal/state.json'), 'market-catalog.json');
export const toSymbolId = symbol => typeof symbol === 'string' && /^[A-Z0-9]{1,24}\/USDT:USDT$/.test(symbol) ? symbol.split('/')[0] + 'USDT' : null;
export const defaultMarkets = () => ({ version: 1, revision: 'initial', pairs: ['BTC','SOL'].map(base => ({ symbol: base + '/USDT:USDT', watch: true, trade: true })) });
export function validateMarkets(value) {
  if (!value || typeof value.revision !== 'string' || !Array.isArray(value.pairs) || value.pairs.length > MAX_MARKETS ||
      value.pairs.some(p => !p || !toSymbolId(p.symbol) || typeof p.watch !== 'boolean' || typeof p.trade !== 'boolean' || (p.trade && !p.watch)) ||
      new Set(value.pairs.map(p => p.symbol)).size !== value.pairs.length) throw new Error('Invalid market selections');
  return value;
}
export async function readMarkets() { return validateMarkets(await readJson(marketsPath(), defaultMarkets())); }
export async function readCatalog() {
  const value = await readJson(catalogPath(), { updatedAt: 0, markets: [] });
  if (!Array.isArray(value.markets) || value.markets.length > 2000 || !Number.isFinite(value.updatedAt)) throw new Error('Market catalog unavailable');
  return value;
}
export function buildCatalog(contracts, tickers, now = Date.now()) {
  if (!Array.isArray(contracts) || !Array.isArray(tickers)) throw new Error('Invalid public market data');
  const quotes = new Map(tickers.map(t => [t.symbol, t]));
  const result = contracts.filter(c => c.quoteCoin === 'USDT' && c.symbolType === 'perpetual' && c.symbolStatus === 'normal' &&
    c.isRwa !== 'YES' && c.supportMarginCoins?.includes('USDT') && toSymbolId(c.baseCoin + '/USDT:USDT') === c.symbol).flatMap(c => {
    const t = quotes.get(c.symbol), price = Number(t?.lastPr), volume = Number(t?.quoteVolume), quoteTime = Number(t?.ts);
    if (!(price > 0) || !Number.isFinite(price) || !Number.isFinite(volume) || volume < 0 || !Number.isFinite(quoteTime) || now - quoteTime > 120000 || quoteTime > now + 5000) return [];
    return [{ symbol: c.baseCoin + '/USDT:USDT', id: c.symbol, base: c.baseCoin, volume, price,
      change: Number(t.change24h) * 100, quoteTime,
      rules: { amountStep: Number(c.sizeMultiplier), contractSize: 1, minAmount: Number(c.minTradeNum), minCost: Number(c.minTradeUSDT) } }];
  }).sort((a,b) => b.volume - a.volume || a.symbol.localeCompare(b.symbol));
  return { updatedAt: now, markets: result };
}
