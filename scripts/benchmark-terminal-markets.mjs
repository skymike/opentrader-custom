// Read-only public Bitget benchmark. No account keys, settings or order APIs.
import { createMarketFeed } from '../packages/exchanges/terminal-market-feed.mjs';
const feed = createMarketFeed();
const seed = await feed.snapshot([]);
const results = [];
for (const count of [10, 25]) {
  const pairs = seed.catalog.markets.slice(0, count).map(m => ({ symbol: m.symbol, watch: true, trade: false }));
  for (const phase of ['warmup', 'cached']) {
    const cpu = process.cpuUsage(), started = performance.now();
    const result = await feed.snapshot(pairs);
    const usage = process.cpuUsage(cpu);
    results.push({ count, phase, connected: result.markets.filter(m => m.status === 'connected').length,
      elapsedMs: Math.round(performance.now() - started), cpuMs: Math.round((usage.user + usage.system) / 1000),
      rssMiB: Math.round(process.memoryUsage().rss / 1048576), ...result.stats });
  }
}
console.log(JSON.stringify({ publicOnly: true, top10: seed.catalog.markets.slice(0, 10).map(m => m.symbol), results }));
