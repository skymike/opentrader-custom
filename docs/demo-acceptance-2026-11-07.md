# Unified demo acceptance — 2026-11-07

Release: `bb0d4dd538a666de709d9f480a16847a264d2d2e`. Bitget Unified V3, explicit demo header, user-funded 1,000 virtual USDT. No live key configured or live trade submitted.

The same saved demo credentials were connected server-side to the custom terminal and original OpenTrader account `Bitget Demo` (ID 3). The original dashboard's authenticated `exchange.getAssets` route returned the demo USDT balance. BTCUSDT and SOLUSDT were configured one-way, isolated margin, 1x leverage while flat.

| Test | Entry order | Quantity | Entry fill price | Close order | Close fill price |
|---|---|---|---|---|---|
| BTC approval | 1502967541569839104 | 0.0002 BTC | 75897.8 | 1502967591616274432 | 75893.6 |
| SOL automatic | 1502967702849216512 | 0.2 SOL | 90.881 | 1502967753235390464 | 90.864 |

Approval mode produced a proposal without submitting an order until the approval command. Automatic mode submitted without an approval command. Both entries filled in full, had verified market stop-loss/take-profit protection, and closed in full through the terminal's managed close command. Exchange close records reported `reduceOnly: YES`.

An initial BTC diagnostic entry (1502966590737899520, 0.0002 BTC) exposed a Unified one-way protective-order direction mismatch. The fail-closed path immediately closed it (1502966616260239360) and halted entries. Exchange history proved the protection existed but used the closing order side. The normalization was corrected, regression-tested, deployed and retested successfully. Empty Unified position lists and zero-balance accounts were also corrected using observed responses.

Final exchange state: zero positions, zero pending regular/strategy orders, 999.93731843 virtual USDT equity and available balance. All three test entries closed. No active halt. Worker healthy. Settings left Demo / Approval / new entries stopped, max order notional 20 USDT.

The tests used the terminal's single-use synthetic demo signal capped at 20 USDT and normal sizing, approval, persistence, reconciliation and close paths. They establish execution plumbing, not profitability or future reliability. Classic V2 exchange execution and real-money execution were not tested. Focused regression tests and the release build passed; the broader repository still has two pre-existing integration suites requiring a test database/account fixture.
