import { buildCatalog, MAX_MARKETS, toSymbolId } from './terminal-markets.mjs';
import { summarizeCandles } from './terminal-candles.mjs';
const HOUR = 3600000;

export function createMarketFeed({ fetcher = fetch, clock = Date.now, cache = {} } = {}) {
  let contracts, contractsAt = 0;
  const histories = new Map(Object.entries(cache.histories ?? {}).slice(0, MAX_MARKETS));
  async function request(endpoint, params, stats) {
    stats.requests++; stats[endpoint] = (stats[endpoint] ?? 0) + 1;
    const response = await fetcher('https://api.bitget.com/api/v2/mix/market/' + endpoint + '?' + new URLSearchParams({ productType: 'USDT-FUTURES', ...params }),
      { signal: AbortSignal.timeout(8000), redirect: 'error' });
    const value = await response.json();
    if (!response.ok || value.code !== '00000' || !Array.isArray(value.data)) throw new Error('Public market data unavailable');
    return value.data;
  }
  return {
    cache: () => ({ version: 1, histories: Object.fromEntries(histories) }),
    async snapshot(pairs) {
      const now = clock(), hour = Math.floor(now / HOUR) * HOUR, started = Date.now();
      const stats = { requests: 0, candles: 0, tickers: 0, contracts: 0 };
      if (!contracts || now - contractsAt >= HOUR) { contracts = await request('contracts', {}, stats); contractsAt = now; }
      const catalog = buildCatalog(contracts, await request('tickers', {}, stats), now);
      const selected = pairs.filter(p => p.watch).slice(0,MAX_MARKETS);
      const keep = new Set(selected.map(p => p.symbol));
      for (const key of histories.keys()) if (!keep.has(key)) histories.delete(key);
      const markets = new Array(selected.length); let cursor = 0;
      async function worker() {
        while (cursor < selected.length) {
          const index = cursor++, pair = selected[index], item = catalog.markets.find(m => m.symbol === pair.symbol);
          try {
            if (!item || Date.now() - started > 20000) throw new Error('Pair unavailable or scan budget reached');
            let entry = histories.get(pair.symbol);
            if (entry && (!Array.isArray(entry.rows) || !Number.isFinite(entry.hour))) entry = undefined;
            if (entry) { try { summarizeCandles(entry.rows, entry.hour); } catch { entry = undefined; } }
            // A cached open candle is never treated as final until refreshed after the hour closes.
            if (!entry || entry.hour !== hour) {
              const gap = entry && Number.isFinite(entry.hour) ? Math.ceil((hour-entry.hour)/HOUR) : 201;
              const limit = entry && gap > 0 && gap < 198 ? gap + 2 : 201;
              const fresh = await request('candles', { symbol: toSymbolId(pair.symbol), granularity: '1H', limit: String(limit) }, stats);
              const rows = new Map();
              // Only previously closed candles may be reused. The prior open candle must come from this fresh response.
              const closed = entry?.rows.filter(row => Number(row[0]) < entry.hour) ?? [];
              for (const r of [...closed, ...fresh]) if (Array.isArray(r) && r.length >= 6) {
                const row = r.map(Number); if (Number.isFinite(row[0]) && row[0] <= hour) rows.set(row[0], row);
              }
              const merged = [...rows.values()].sort((a,b)=>a[0]-b[0]).slice(-201);
              summarizeCandles(merged, now); // Do not cache incomplete or gapped histories as ready.
              entry = { hour, rows: merged }; histories.set(pair.symbol, entry);
            }
            markets[index] = { ...item, ...summarizeCandles(entry.rows, now), status: 'connected', watch: true, trade: pair.trade };
          } catch { markets[index] = { symbol: pair.symbol, status: 'unavailable', watch: true, trade: pair.trade }; }
        }
      }
      await Promise.all([worker(), worker()]);
      stats.elapsedMs = Date.now() - started;
      return { catalog, markets, stats };
    },
  };
}
