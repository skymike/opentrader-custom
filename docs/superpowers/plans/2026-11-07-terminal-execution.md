# Terminal execution implementation plan

> Execution: native in this chat; user explicitly delegated design choices and authorized proceeding with both modes. Existing unrelated README and UTA demo changes must remain untouched.

**Goal:** BTC/SOL hourly BB/RSI approval and automatic trading, demo by default, explicit live capability.

**Architecture:** Keep the existing public market/read-only monitor. Add a separate execution worker, private per-environment credentials, durable journal and authenticated command queue. One worker manages both environments, including exits while entries are paused. Never retry an uncertain submission; reconcile by deterministic client order ID. Entry uses isolated, one-way, 1x accounts and IOC limit orders with preset stop/target. No automatic account-mode mutations.

**Tech stack:** Existing Node ESM, Fastify, static browser UI, Docker. Bitget Classic V2 REST; signed requests with demo header only for demo.

## Constraints and review focus
- Default demo/approval/disarmed. Live requires explicit acknowledgement and separately entered live credentials. Switching environment/mode invalidates approvals and disarms.
- Default maximum order notional 100 USDT, maximum strategy risk 2% equity, daily equity-loss stop 3%, one managed position at a time. Limits configurable within hard bounds; daily loss includes deposits/withdrawals and is conservative.
- Stale/malformed data, unsupported account mode, existing external positions/orders, uncertainty, missing protection, credential changes with outstanding exposure: block entries.
- Persist intent before network. A crash or timeout must never resubmit an entry. Reconcile partial fills and IOC cancellation; protective failures trigger a reduce-only close and halt entries.
- Approvals bind exact proposal, settings revision and expiry. Commands authenticate and reject cross-origin writes. No secrets in responses/logs.
- Review focus: concurrent requests, ambiguous fills, shutdown/restart, protection ownership, environment isolation.

## Tasks
1. Trading configuration/store and REST adapter (`terminal-trading-store.mjs`, `terminal-bitget.mjs`). Test default isolation, validation, signing, demo headers, routing and redacted errors before implementation.
2. Execution state machine (`terminal-execution.mjs`) and worker (`terminal-trader.mjs`). Test approval vs auto, duplicate prevention, stale data, pause, risk limits, crash/timeout recovery and exits before implementation.
3. Authenticated trading routes (`terminal-trading-api.mjs`) registered by `terminal.ts`; trading UI (`trading.js` and HTML/CSS). Test permissions, live acknowledgement, credential redaction and command expiry. Keep monitoring clearly separate.
4. Package/deployment integration and operator documentation. Run focused Node tests, repository Vitest suite, build and UI smoke check. Review whole change independently and fix important findings. Deploy only if an authorized existing route is available; never place live test orders.

## Progress
- Planning: inspected existing scanner, monitor, Fastify routes and deployment; verified Bitget Classic demo/header, account and order documentation.
- Tasks 1–3 implemented and focused tests pass. Native execution followed user's explicit delegation without further design approvals.
- Independent review: fixed documented net-side protective order mapping, conditional-order entry guards, and malformed exposure handling; regression tests each observed failing then passing.
- Additional checks: missing monitor timestamps fail closed; close requests persist through partial-fill cancellation; graceful shutdown preserves lock cleanup.
- Browser smoke passed desktop/mobile with dummy credentials; no exchange worker ran in that test.
- Build passed. Full repository suite: 106 passed, two pre-existing database-backed suites could not initialize without DATABASE_URL/TEST fixture. These integrations are not used by the new execution worker; no real credentials were attached to the test suite.
