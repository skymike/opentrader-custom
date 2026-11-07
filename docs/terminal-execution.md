# Demo and live execution

Open `/terminal/index.html`, sign in, and use **Trade execution**. The read-only account below this panel is a separate connection; its balances do not represent the selected execution account.

1. In Bitget demo mode, create a futures demo API key with read and trade permissions. Enter it under **Execution account connections → Bitget demo key**. Do not send keys through chat. Configure BTCUSDT and SOLUSDT as one-way, isolated margin, 1x leverage in Bitget. The terminal checks these settings rather than changing the account automatically. Select **Classic V2** for a Classic account or **Unified V3** for a Unified Trading Account. The API choice is stored separately for demo and live. Use **Check connection** after saving.
2. Choose **Demo**, then **Approve each trade** or **Automatic**. Save settings, then enable new entries. Demo uses Bitget virtual funds and the `paptrading: 1` header; it is not a local fill simulator.
3. Approval mode displays exact size, limit, stop, target and estimated risk. Approval expires after 60 seconds and is rechecked against current equity, prices and exchange limits. Automatic uses the same checks without an approval click.
4. Live capability requires a separately saved live API key. Selecting Live or changing execution mode stops entries and invalidates proposals. Enabling live requires typing `ENABLE LIVE TRADING`. This is real money. No live orders were submitted during development or deployment verification.

Defaults: max 100 USDT order notional, max 2% equity risk, 3% daily equity-loss cutoff, one managed position across environments. Hourly completed-candle BB20/2 + Wilder RSI14 signals remain unchanged. Stops are 2%, targets 4%; order sizes reserve estimated transaction costs. Gaps, funding and slippage can exceed estimates. Daily cutoff compares account equity to its first observation each UTC day and includes transfers; it blocks new entries, not existing exits.

Entries are IOC limit orders with a 0.2% price bound and preset market stop-loss/take-profit. Unfilled quantity is cancelled. Partial fills are reconciled before closing. The worker verifies protective orders; unavailable or unrecognized protection triggers a reduce-only market close and a halt. It refuses external positions, regular orders and conditional orders before a new entry. Use a dedicated account/subaccount: concurrent manual trading cannot be atomically excluded by the API.

**Stop new entries** and **Pause agents** do not close existing positions. Protection monitoring continues while stopped and after switching environment. **Close managed position** requests a reduce-only close. Pending IOC cancellation is reconciled first. Never assume a queued close has filled; check its status and Bitget. Unknown entry or close responses are not retried blindly. They remain blocking until exchange reconciliation succeeds. A rejected request whose outcome cannot be established may require operator recovery on the exchange.

## Operations

`opentrader-terminal-trader` runs every five seconds, without published ports. It shares the dedicated `opentrader-terminal-trading` volume with the authenticated app. Files are mode 600; this is host access protection, not at-rest encryption. The old monitor retains read-only credentials. Never print/copy credentials or connection files into logs or Git.

The shared `.lock` directory serializes settings changes, commands and submission. Normal SIGTERM waits for the current cycle. A process crash may deliberately leave the lock: the UI then reports service unavailable, and the worker does not submit again. Recovery: stop the app and trader, inspect/reconcile all exchange orders and the durable journal, back up the trading volume privately, remove only its orphan `.lock` after confirming no writer remains, and restart. Do not delete/reset journal entries to clear an uncertain order. Uncertain orders require exchange evidence; request engineering help if reconciliation cannot establish the outcome.

Preset protection may remain after a close depending on exchange behavior. Residual protective orders block subsequent entries until reviewed/cancelled in Bitget; the worker will not cancel unidentified external orders. Resetting a reviewed halt does not reset daily equity-loss limits.

## Verification

Node tests cover signature bytes and environment header isolation, authenticated routes, live confirmation, bounded sizing, stale data, exact approval binding, intent persistence, uncertain submission recovery, partial-fill close requests, protection matching and malformed exposure responses. Browser checks cover login, demo automatic setup, switching to live while disarmed, mobile overflow and logout. The app builds successfully.

The broader repository Vitest run passed 106 tests; existing `order-executor.test.ts` and `trade-executor.test.ts` suites could not initialize because `DATABASE_URL` and their TEST account fixture are not configured. Unified V3 demo exchange acceptance passed on 2026-11-07: BTC approval and SOL automatic entries filled, protective orders were verified, and both managed reduce-only closes filled. These were explicitly labelled synthetic test signals, not evidence of strategy profitability. Live execution and Classic V2 real exchange fills remain unverified. See [demo acceptance evidence](demo-acceptance-2026-11-07.md).

References: [Bitget Classic demo setup](https://www.bitget.com/docs/classic/demo-trading/rest-api), [order APIs](https://www.bitget.com/docs/catalog/classic-contract-trade/classic-contract-trade), [trigger/protection APIs](https://www.bitget.com/docs/catalog/classic-contract-plan/classic-contract-plan), [account modes](https://www.bitget.com/docs/catalog/classic-contract-account/classic-contract-account).

## API selection in both panels

In the original OpenTrader dashboard, open **Terminal & settings > Bitget API · Classic / Unified**, sign in, and choose the API for each account. **Connect terminal demo key to OpenTrader** imports the saved demo credentials server-side without exposing them in the browser. Switching requires stopped bots and no pending exchange exposure. The original dashboard uses CCXT 4.5.92 with explicit Unified routing and separate market caches; the custom terminal uses signed V2 or V3 adapters. The monitor has its own API and environment selectors.

For a controlled exchange test, select Demo, save the desired execution mode, enable entries, and open **Demo trade test**. Request BTC or SOL: this creates a clearly labelled test proposal capped at 20 USDT. Approval mode waits for approval; automatic mode submits it directly. These synthetic acceptance signals test the execution path, not strategy performance. Close the managed position and verify the exchange is flat. A test is single-use; save settings to resume normal strategy scanning. Live mode rejects test requests.
