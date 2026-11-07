# Bitget account terminal

The original dashboard at `/` and terminal at `/terminal/index.html` share the existing service and administrator password.

The **Trade execution** panel now supports approval and automatic modes for demo and live Classic V2 or Unified V3 futures accounts. It is separate from the original read-only monitor described below. See [execution setup and recovery](terminal-execution.md). Demo/approval is the default and new entries start disabled. Unified V3 demo fills and closes were verified separately in [exchange acceptance tests](demo-acceptance-2026-11-07.md).

The agent terminal also offers optional **Settings > AI commentary**: local LFM explanations and activity summaries, generated in the background. Risk Check, Sizer and Executor continue to run exclusively in code. See [local AI setup, limits and operations](local-ai-commentary.md).

## Connect your account

1. Sign in to the agent terminal with your OpenTrader administrator password.
2. Open **Settings > Bitget connection**. The original dashboard also has a **Terminal & settings** menu linking here.
3. Select **Add connection**, give it a name, choose Classic V2 or Unified V3 and Demo or Live, then enter your API key, API secret and API passphrase.
4. Select the permission your key has: **Read-only** or **Read-write**, then save.
5. Account checks normally complete within 90 seconds. Balances and positions are for the selected USDT futures account.

The selector records the permission you declare. It cannot change permissions on Bitget, verify all granted permissions, or enable trading. Read-only is sufficient. API errors show a connection failure instead of claiming a successful connection.

Saved monitoring connections appear as a list with API, environment and permission labels, a masked key hint, and **Edit** / **Remove** controls. Existing saved connections appear automatically. Up to 20 named monitoring connections can be stored. The first is selected automatically; adding another does not switch the displayed account. Use **Use for monitoring** to select it. Switching accounts clears the previous account snapshot until the next monitor check.

Use **Test connection** on any saved monitoring or execution key to check its account and position read access. Each row shows Testing, Connected, or Connection error with the time of the last test. Results are kept for the current signed-in page session and reset after editing the key or reloading; they are a point-in-time check, not continuous health monitoring. Tests never submit orders, select an account, change trading settings, or prove order permission. Errors show safe guidance and, when available, Bitget's error code without revealing credentials.

Trade execution shows its account, mode, order limit and entry control first. Risk settings, execution key forms, recent history and optional demo test tools expand on demand. Open managed positions and pending approvals remain visible. Saving edited settings stops new entries, and enabling live entries still requires the explicit live-trading acknowledgement.

To replace credentials, enter all three again. To change the name or labels, leave all three blank. Removing the selected connection hides its account data and leaves monitoring disconnected; other saved keys remain available. Secrets and full API keys are never returned to the browser. Use Bitget's API settings to change actual permissions or revoke a key.

The same dialog lists saved **Execution keys** separately, with Demo/Live and V2/V3 labels. Edit opens the execution key form. Removal uses the existing execution protections: keys with managed orders or positions cannot be removed, and successful removal stops new entries. Monitoring selection never enables execution. The original dashboard's account database remains separate.

## Six working modules

- Scanner calculates Bollinger 20/2 and Wilder RSI14 on completed, contiguous hourly candles. Long requires a new lower-band crossing with RSI below 30; short requires an upper-band crossing with RSI above 70. This matches the existing BB/RSI backtest's signal rules.
- Risk Check requires fresh data, connected positive equity and available balance, no existing positions needing risk review, and no more than 1% price movement from the signal close.
- Sizer applies a combined 2% equity risk ceiling across proposals, a 2% stop and 4% target. It rounds contract quantity down to exchange rules, respects minimum sizes, reserves 1% of remaining cash and assumes no leverage.
- Executor validates the proposal's direction, prices, quantity and freshness, then reports ready-for-review or a blocking reason. It is a preflight executor with **no order submission transport**. Neither key-permission selection sends orders.
- Logger records connection and agent-decision changes, keeping the latest 100 events.
- Equity reads account balance and open positions and keeps up to 480 equity samples. Changing credentials resets the account history.

The UI shows each market's signal, risk result, sizing result and executor reason. Estimated risk excludes fees, slippage and gaps. Proposal prices are indicative, not exchange-ready submitted stop orders. No backtest result is presented as a live fill.

**Pause agents** persists on the server and blocks new proposals. Monitoring continues. It does not cancel orders or close existing exchange positions. The UI hides proposals immediately; the worker applies changes on its next cycle. Resume restores evaluation. Malformed control data fails closed.

## Security and storage

The browser holds the admin password in memory only. Sign out or reload to clear it. Theme preference alone is saved in local storage. The light/dark button is available in the top menu.

Authenticated connection settings are written atomically with mode 600 to `/credentials/bitget.json` in the dedicated `opentrader-terminal-credentials` Docker volume. OpenTrader mounts it read-write, while the internet-connected monitor mounts it read-only. This file is protected by host permissions, not encrypted at rest. Credentials are excluded from GitHub, response bodies and application logs.

The original OpenTrader container retains its private network and has a separate egress network for exchange access, with no published ports. Its Bitget API settings select V2 or V3 per account. The monitor has internet access and no published ports; its account operations remain read-only. Demo requests use the paptrading header, and live requests do not.

The monitor reloads settings each cycle without a container restart. Legacy environment credentials are supported only when there is no settings file; a removed-connection record prevents them from being reused. State snapshots are atomic. Snapshots older than 150 seconds are labelled stale. Disconnected or changed-account states hide prior balances and proposals.

## GitHub deployment and verification

The Build Classic Terminal workflow on `terminal/classic-dashboard` runs account security, agent and indicator tests, builds OpenTrader with pinned Node/pnpm versions, and creates `classic-terminal-release`.

Deploy its `terminal-release.tar.gz` using `python3 deploy-terminal.py <archive> <full-commit-sha>` on the existing server. The script builds on the deployed image, preserves the database and private network, checks public markets in an isolated temporary volume, and retains stopped predecessor containers for rollback. Monitor settings and its legacy environment are preserved on upgrade.

Focused tests:

    node --experimental-strip-types --test packages/bot/src/terminal.node-test.mjs packages/exchanges/classic-monitor.node-test.mjs packages/exchanges/classic-agents.node-test.mjs

Deployment reuses the private admin password at `~/.config/opentrader-terminal/admin-password.txt` with mode 600. Both views require it.

## Limitations

The original monitoring modules do not place orders or simulate fills. The separate execution panel and worker provide order submission and exits. The monitoring account key has not been verified until the user saves valid credentials and the monitor reports Connected. Existing positions block monitoring proposals because their protective orders are not inspected there. Agent modules are deterministic strategy code, not LLM agents. The original dashboard's account database is separate from the terminal connection. aggr.trade opens as an external link; no aggr data is ingested.
