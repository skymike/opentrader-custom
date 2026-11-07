# Bot chart actions and AI analysis

Approved 2026-11-07: implement both strategy explanations and independent market analysis; deploy and verify live.

- [ ] Record confirmed fill averages, first-observed fill/close times without altering execution decisions. Never infer historical fills or exit prices.
- [ ] Add chart markers filtered by market and Demo/Live, pending proposal and active entry/SL/TP lines, click-to-inspect detail, logout/stale handling.
- [ ] Extend local AI with validated public hourly market facts, deterministic trend/momentum/band analysis and conditional scenarios. Keep analysis separate from execution, remove incorrect zero-order claim, add queued manual refresh.
- [ ] Run focused unit and browser tests, independent review, build/package existing deployment, back up and deploy, verify public chart and authenticated endpoints without orders.

Execution: inline, preserving unrelated edits. No change to trading settings or permissions. AI cannot submit trades. Analysis uses completed 1h candles independent of visible chart timeframe.
