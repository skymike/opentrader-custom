# Futures Controls Implementation Plan

**Goal:** Deploy a compact separate manual futures panel and similar bot controls.
**Spec:** User requests leverage (20x cap, default 1x), open/close, long/short, limit/market and TP/SL. Existing Bitget Classic V2 and Unified V3 connections and demo/live modes must work.
**Architecture:** Reuse authenticated trading routes, serialized storage and durable order journal. Explicit operator review submits manual orders. Worker reconciliation tracks both manual and bot orders. Exchange leverage is set only during an explicitly authorized order workflow and validated before submission. Preserve one-way isolated mode initially and show it clearly.
**Constraints:** No actual exchange orders during development or validation. Preserve existing settings with backwards-compatible defaults. User has authorized deploy. Preserve unrelated dirty work and current deployed customizations. Runtime contracts must be checked against official Bitget docs.

- [x] Backend adapters, manual preview/submit/cancel/reconcile, configurable bot leverage/orderType/SL/TP/direction, meaningful failure/retry tests.
- [x] Compact manual panel and bot settings, explicit demo/live review, integrate selected pair/account and order state, browser checks.
- [x] Independent review, regression tests, build, deploy with rollback and live read-only verification.

Review focus: concurrent requests/idempotence, partial fills and resting limit orders, reduce-only closes, leverage/margin validation, unknown submission outcomes and protections.

Validation: 66 terminal regression tests pass; mocked browser flow passes; independent review fixes covered worker freshness, daily-loss baseline, rules validation and unmanaged exposure. No exchange mutations used in validation.

Deployed GitHub artifact d34432ac6c3c064d64438f555bb0bfccb45700b5 to nl-server. GitHub run 42616931656 passed. Post-deploy: authenticated manual context returned 200 with valid demo account data in 382ms; unauthenticated route returned 401; public dashboard retains login redirect. Existing BTC/SOL demo positions remained protected, saved settings and connection files unchanged, LFM link active. Rollback containers retained. No test orders placed.
