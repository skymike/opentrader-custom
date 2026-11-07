# Multi-market terminal implementation plan

> Execute inline with the executing-plans workflow; one independent review before deployment.

**Goal:** Add Top 10 by Bitget USDT perpetual volume and manual pairs, separate Watch/Trade, and deploy efficient scanning without changing existing trading selections.

**Architecture:** A bounded public catalog and shared ticker/candle cache feed the monitor. A persisted market selection in the trading volume is read by both workers. The execution worker filters public signals before making private preflight requests; account refresh is once per cycle, never once per watched pair. Fresh preflight and position protection remain authoritative.

**Spec:** User's approved Top 10/manual-selection request and preceding efficiency proposal in this chat.

**Constraints:** Maximum 25 selected pairs initially; only active USDT perpetual contracts. Top 10 ranked by quote-currency 24h volume, never price or base volume. New pairs watch-only. BTC/SOL retain legacy trade selection. A Trade-list change disarms entries and invalidates approvals. Existing positions always reconcile even if their pair is removed. No credentials exposed. LFM stays on proud-server and its bounded input is not multiplied per pair. Preserve concurrent chart work.

## Tasks

- [x] Catalog/store/API: add `terminal-markets.mjs` and `terminal-markets-api.mjs`, with tests for volume ranking, unsupported contracts, Watch/Trade separation, stale writes, disarm and limits. Read-only catalog snapshot in the monitor volume; mutations serialized with existing trading lock.
- [x] Efficient market worker: add `terminal-market-feed.mjs`; cache contracts hourly and bounded candle windows per closed hour, fetch one bulk ticker response per 30s cycle, two concurrent candle tasks. Test warmup, no repeated candles within hour, missing candles/stale feeds, bounded work at 10/25 pairs. Persist reusable cache; keep old strategy indicator calculation unchanged.
- [x] Execution: dynamic validated USDT symbol IDs, select only configured Trade pairs, cheaply scan before private requests, one account snapshot per cycle, full fresh per-signal preflight and unchanged position reconciliation. Test Watch never submits, non-BTC pairs work, removed pair protection continues, unchanged hourly risk/approval safeguards.
- [ ] UI/release: searchable Markets dialog and Top 10 button with separate controls and signal/status table. Connect chart selection if available, render dynamic market counts, preserve chart/user edits. Browser verification, bounded request/latency benchmark, full focused tests, GitHub release/deploy, initialize Top 10 watch-only and audit live state/settings/credential hashes.

## Review focus

- Invalid/missing configuration fails closed for entries but does not stop position reconciliation.
- Changes during scanning cannot grant trading eligibility from stale market snapshots.
- No repeated private account calls across non-signalling watch pairs.
- Hourly candle caching never treats an incomplete/gapped candle as a valid new signal.
- New pairs and refreshed volume rankings never silently enable trading.

## Ledger

- Initial checkout contains concurrent chart/analysis work. Baseline diff saved outside repository; preserve it and integrate without resetting files.
- Deployment/push are explicitly authorized by the user; no additional approval gate is needed.
