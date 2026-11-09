# OpenTrader Agent Terminal

A self-hosted Bitget trading workspace built on [OpenTrader](https://github.com/Open-Trader/opentrader). The original dashboard at `/` still manages OpenTrader bots and backtests. Open `/terminal/index.html` on the same service for the agent terminal and sign in with the OpenTrader administrator password.

## What the terminal does

- **Markets and charts.** Watch up to 25 active Bitget crypto USDT perpetual pairs, search by symbol, or add the top 10 by 24-hour quote volume. New pairs start as Watch only. The separate Trade list controls which pairs the execution strategy can use. Charts show public candles, volume, Bollinger Bands, RSI and recorded bot actions. The chart timeframe is independent of the strategy's hourly scan.
- **Workspace.** Switch between light and dark themes, inspect approvals, managed positions, history and agent decisions, and rearrange or resize panels with the desktop Layout editor. Layout preferences are saved in the browser. The daily Bitcoin Fear & Greed panel displays Alternative.me data as market context.
- **Read-only monitoring.** Save named Classic V2 or Unified V3 Bitget connections for Demo or Live and select which one to monitor. The monitor shows balances, positions and deterministic strategy checks. Execution keys are stored separately.
- **Trade execution.** Compact **Bot / Manual** tabs share Classic V2 and Unified V3 execution connections for Demo or Live. Manual controls support open/close, long/short, limit/market orders and TP/SL. Bot controls support approval or automatic entry, direction, order type and TP/SL. Both allow 1–20× leverage, defaulting to 1×. The worker reconciles submissions, verifies protection and manages reduce-only exits. Bot execution starts disarmed in Demo approval mode.
- **AI commentary.** Optional local LFM inference explains the selected market and recorded agent decisions on request. The Scanner, Risk Check, Sizer, Executor, Logger and Equity modules use code and recorded data. Model output and the sentiment panel have no authority to place orders.

## Build and open the terminal

Use Node.js 22.12 and pnpm 10.12.1. Build from this repository to get the custom terminal. The upstream npm package is a separate distribution.

```sh
pnpm install --lockfile --frozen-lockfile
pnpm --filter @opentrader/prisma exec prisma generate --schema src/schema.prisma
pnpm --filter opentrader exec tsup
```

Follow the [developer setup](CONTRIBUTING.md) for environment variables, database migrations and seeding. Set your own `ADMIN_PASSWORD` and use `TERMINAL_ORIGIN` to match the origin serving the terminal, including its scheme and any non-default port. The app and worker processes must share their configured state paths. The original dashboard, market monitor, execution worker and optional commentary worker have separate roles.

The [Build Classic Terminal workflow](.github/workflows/terminal.yml) runs focused tests and packages the app and workers as the `classic-terminal-release` artifact. The [deployment script](scripts/deploy-terminal.py) is an upgrade path for the existing container installation. See the [deployment notes](docs/classic-terminal.md#github-deployment-and-verification) for its prerequisites and rollback behavior.

## Start in Demo

1. Open the terminal and use **Markets** to choose what to Watch. Set Trade only for pairs you intend to make eligible for execution.
2. Under **Execution account connections**, save a Bitget Demo key, choose Classic V2 or Unified V3 to match the account, and check the connection. Set eligible pairs to one-way mode and isolated margin in Bitget. Leverage defaults to 1×; the execution path sets and verifies the selected leverage before submitting a new opening order. Exchange limits may be lower than the terminal's 20× cap.
3. Save **Demo** and **Approve each trade**, review the limits, and enable new entries when ready. Approval proposals expire after 60 seconds. Automatic mode uses the same preflight checks and submits qualifying entries without a click.
4. Use **Stop new entries** to stop opening positions. Existing positions continue to be reconciled. **Close managed position** requests an exit, whose outcome should be checked in the terminal and in Bitget.

The strategy evaluates fresh, completed hourly candles for a new Bollinger Band crossing with RSI below 30 for longs or above 70 for shorts. Defaults include a 100 USDT maximum order notional, a 2% combined stop-risk budget, a 3% daily equity-loss cutoff, and one concurrent position. The concurrency setting accepts one to five and starts at one. Bot orders default to **Limit · IOC**: any unfilled remainder is cancelled. Market orders are also available. Direction defaults to both long and short; stop loss defaults to 2% and take profit to 4%, with each configurable from 0.1% to 50% of price. Live uses real funds and requires typing `ENABLE LIVE TRADING` when arming. See the [execution and recovery guide](docs/terminal-execution.md) for account setup, stops, halts and reconciliation.

## Manual futures

1. Select a watched pair in the chart, then open the **Manual** tab beside **Bot**. The Watch/Trade list controls bot eligibility; a manual order is a separate operator action.
2. Choose the Demo or Live execution account, Open or Close, position side and order type. Enter quantity in the base asset (for example BTC), not USDT. For a limit order, enter its USDT price.
3. For an opening order, choose leverage and TP/SL percentages. Review the estimated notional and margin; leverage changes margin requirements, not the maximum notional or combined risk budget. TP/SL percentages describe price moves, not leveraged returns.
4. Click **Review demo order** or its Live equivalent. Check the account, pair, side, size and protection prices, then confirm within 60 seconds. Live confirmation requires typing `PLACE LIVE ORDER`. Editing the form does not place an order or change exchange leverage.
5. Monitor the order status and filled quantity. Manual limit orders are good-till-cancelled; **Cancel remaining limit** cancels only the unfilled remainder. Filled exposure remains managed. **Close** uses reduce-only orders bounded by the selected position, so it cannot open an opposite position.

Manual opens require a fresh worker, an unpaused terminal, available margin, valid exchange increments and sufficient shared risk budget. Unmanaged or uncertain exposure blocks new openings. Mandatory TP/SL protection is checked after fills; unverified protection triggers cancellation of any resting remainder before a reduce-only exit attempt. An uncertain submission is reconciled by its durable order ID rather than automatically submitted again.

**Stop new entries** controls the bot. Manual openings remain separate; the shared **Pause agents** control also blocks manual openings. Reconciliation and protective exits continue while paused. One-way isolated mode is supported; hedge and cross-margin modes are not supported by these controls. Manual account snapshots load on demand, and AI remains outside order execution.

## Futures release verification

Release [`d34432a`](https://github.com/skymike/opentrader-custom/commit/d34432ac6c3c064d64438f555bb0bfccb45700b5) was deployed to `nl-server` on 9 November 2026 from the passing [GitHub artifact build](https://github.com/skymike/opentrader-custom/actions/runs/42616931656). LFM remains on `proud-server`.

- All 66 terminal regression tests passed, including mocked V2/V3 order payloads, leverage validation, idempotency, partial fills, cancellation and exposure checks.
- Browser fixtures verified manual review/confirmation, live acknowledgement, pair changes, cancellation, mobile layout and normal dashboard startup. All order requests in browser tests were mocked.
- Post-deployment read-only checks verified the Demo account context, authentication boundary and worker health. Existing BTC/SOL Demo positions remained protected, and saved settings and credential files were unchanged.

No new exchange orders were placed to validate this release. The new manual futures paths have not yet been verified with real exchange fills; test results do not establish trading profitability. See the [implementation and deployment record](docs/superpowers/plans/2026-11-09-futures-controls.md).

Controlled Unified V3 Demo tests verified approval and automatic entries, protective orders and reduce-only closes. Those tests used synthetic signals. Natural strategy performance, Classic V2 exchange fills and live fills remain unverified by that acceptance run. See the [Demo acceptance record](docs/demo-acceptance-2026-11-07.md).

## Code and operating guides

| Area | Source | Guide |
| --- | --- | --- |
| Browser terminal, charts, layout and account controls | [Terminal UI](app/frontend/terminal) | [Terminal overview](docs/classic-terminal.md) |
| Authenticated terminal routes and Bitget connections | [App routes](packages/bot/src/terminal.ts), [connection store and API](packages/exchanges/terminal-connections.mjs) | [Account connections](docs/classic-terminal.md#connect-your-account) |
| Public market feed, scanner and read-only proposals | [Market feed](packages/exchanges/terminal-market-feed.mjs), [monitor](packages/exchanges/classic-monitor.mjs), [agent checks](packages/exchanges/classic-agents.mjs) | [Watch and Trade pairs](docs/terminal-markets.md) |
| Approval, sizing, execution and reconciliation | [Trading API](packages/exchanges/terminal-trading-api.mjs), [execution worker](packages/exchanges/terminal-trader.mjs), [execution engine](packages/exchanges/terminal-execution.mjs) | [Demo and Live execution](docs/terminal-execution.md) |
| Manual futures preview, confirmation and cancellation | [Manual API](packages/exchanges/terminal-manual.mjs), [manual panel](app/frontend/terminal/manual-futures.js) | [Manual futures](#manual-futures) |
| Bitget Classic and Unified transport | [Classic V2](packages/exchanges/terminal-bitget.mjs), [Unified V3](packages/exchanges/terminal-bitget-v3.mjs) | [API selection](docs/terminal-execution.md#api-selection-in-both-panels) |
| Optional local model commentary | [Assistant worker](packages/exchanges/terminal-assistant.mjs) | [Local AI setup](docs/local-ai-commentary.md) |

Keep exchange keys, admin credentials, local state, databases and deployment backups outside Git. Saved terminal credentials stay on the server. File permissions protect the files at rest on the host, and the files themselves are unencrypted.

## Bollinger Bands / RSI backtest

Run this from the repository root with the locally built CLI:

```sh
opentrader backtest bbRsi -c config.bb-rsi.sample.json5 -e BITGET -t 1h --from 2025-01-01 --to 2025-02-01
```

The simulation uses hourly perpetual candles, next-open fills, a 2% stop,
a 4% target, and stop priority when both levels trade within a bar. It
excludes fees, funding, and execution slippage. Equity reports realized P&L,
and any open position at the end appears separately.

Use the terminal's saved-connection checks to verify Demo account access without placing orders. Keep Demo and Live execution credentials separate.

## License

Based on [OpenTrader](https://github.com/Open-Trader/opentrader). See the [Apache 2.0 license](LICENSE) for terms and warranty information.
