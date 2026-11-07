# Watch and Trade pairs

Open **Markets** in the agent terminal at https://trade.amsstay.com/terminal/index.html.

- **Add Top 10 by volume** adds the ten available crypto USDT perpetual contracts with the highest Bitget 24-hour quote volume. Existing selections are preserved. Press again to add the current leaders; rankings do not silently change your Trade list.
- Search by coin, `XRPUSDT`, or `XRP/USDT`, then choose **Add to Watch**. Up to 25 pairs can be saved.
- **Watch** enables market prices, hourly Bollinger 20/2 and RSI14 scanning, and chart selection.
- **Trade** makes the pair eligible for the existing execution strategy. It also enables Watch. Changing the Trade list stops new entries and invalidates pending approvals. Review **Risk & execution settings**, then explicitly re-enable entries when ready.
- Turning Watch off also turns Trade off. Removing a pair does not close an existing position or stop its protection/reconciliation.
- Newly added pairs are always watch-only. The legacy BTC and SOL Trade selections are retained during upgrade. Demo/live mode, account keys and risk limits are preserved.

Only active Bitget crypto USDT perpetual contracts are offered. Spot, USDC and real-world-asset contracts are excluded. A selected pair still needs valid exchange quantity limits and the existing one-way, isolated-margin, 1x-leverage setup before execution can pass. An unavailable or stale pair cannot create a strategy entry.

## Resource use

The monitor shares one public ticker response every 30 seconds. It fetches contract metadata hourly, caches 201 hourly candles per watched pair, and refreshes only the newly closed candles after warmup. At most two candle requests run concurrently, with a 20-second scheduling budget and individual timeouts. Cache persists across restarts; missing final candle data is never replaced by a cached open candle.

Private per-pair checks run only for eligible signals on Trade pairs, with at most two full preflights per execution cycle. Approvals take priority; other signals rotate. Account display refreshes have constant cost. Every actual entry is rechecked against fresh private account/market data. Existing position reconciliation retains priority.

The monitor is limited to 0.5 CPU and 256 MB. Chart data is fetched only for the selected chart in the browser. LFM stays on proud-server with bounded BTC/SOL commentary input; adding pairs does not create per-pair model calls. All watched pairs still receive deterministic strategy scans.

## Verification on nl-server, 2026-11-07

Public-only benchmark in a separate container limited to 0.5 CPU / 256 MB:

| Scan | Connected | Requests | Time | Process memory |
| --- | ---: | ---: | ---: | ---: |
| 10 pairs, initial candles | 10 | 11 | 1.67 s | 74 MB |
| 10 pairs, cached | 10 | 1 | 0.306 s | 73 MB |
| 25 pairs, adding 15 to the warm cache | 25 | 16 | 2.51 s | 76 MB |
| 25 pairs, cached | 25 | 1 | 0.313 s | 78 MB |

Dashboard internal response median: 5 ms before, 4 ms during, 5 ms after. During-load p95: 6 ms over 80 requests. These are short observations, not a guarantee under exchange/network outages or unrelated server load.

Automated coverage includes quote-volume ranking, watch-only additions, stale edit rejection, trade-change disarming, removed-pair reconciliation, bounded/fair private preflight, hourly cache reuse and missing-final-candle recovery. Browser checks cover actual settings routes, pair CRUD, chart switching, both themes, mobile controls and sign-out clearing. No exchange orders were placed by these tests.

## Deployment

GitHub workflow `terminal.yml` tests and packages the release. `scripts/deploy-terminal.py` deploys that artifact over the existing installation, preserving private account/settings volumes. The monitor receives read-only access to the trading volume for `markets.json`; only the authenticated dashboard writes selections. Catalog and candle cache live in the existing terminal-state volume. Deployment does not move LFM or recreate account credentials.

Run the public-only benchmark with `node scripts/benchmark-terminal-markets.mjs` in an isolated resource-limited environment. It uses no account credentials and has no order code.
