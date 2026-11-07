# Integrated Terminal Implementation Plan

> Execute inline using executing-plans; user requested just go ahead.

Goal: implement the approved single-screen terminal with integrated live chart.
Architecture: retain existing DOM IDs and trading controllers; reorganize markup with a layout module. Host chart library locally, keep chart feed independent of account credentials and trading state.
Tech stack: vanilla JS, CSS grid, Lightweight Charts 5.0.7, public Bitget REST/WebSocket.
Spec: ../specs/2026-11-07-terminal-chart-design.md

Constraints: preserve execution safeguards and monitoring/execution separation; no test orders or credential changes.
Review focus: stale feed, out-of-order candles, market/timeframe switches, small windows, settings access after layout changes.

- [x] Add candle normalization and indicator tests, verify failure, implement helpers.
- [x] Add local chart vendor and live chart module, reconnect/fallback and clear stale states.
- [x] Reorganize terminal into chart/sidebar/bottom tabs and settings dialog; retain controller IDs.
- [x] Verify browser layout at 1440x900, 1366x768 and mobile; exercise tabs, theme, timeframe, login and settings with fixtures.
- [x] Run affected terminal tests and document deployment status.

Verification: 22 focused chart/trading tests passed; automatic connection-check test passed. Browser checks passed at 1366x768, 1440x900, 1920x1080 and 390x844, including sign-in, risk dialog save, theme, tabs, symbol/timeframe selection and logout. Public Bitget feed returned 200 candles and rendered in local terminal. Independent review findings on reconnect history and laptop agent visibility addressed. Changes remain local; no production deployment or orders.
