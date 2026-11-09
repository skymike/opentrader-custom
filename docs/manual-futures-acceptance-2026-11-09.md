# Manual futures Demo acceptance — 9 November 2026

The user authorized one small manual Demo futures trade, verification of leverage and TP/SL, and closure, explicitly excluding live funds. Tested deployed release `d34432ac6c3c064d64438f555bb0bfccb45700b5` on nl-server through the same authenticated preview/confirm API used by the manual panel. No Live credential was used and no Live order was submitted.

## Execution evidence

| Check | Observed result |
| --- | --- |
| Account | Bitget Unified V3 Demo, one-way isolated |
| Pair | XRP/USDT perpetual; flat before test |
| Size | 9 XRP; preview notional 9.9513 USDT, below existing 20 USDT cap |
| Opening order | Manual market long, filled 9 XRP at average 1.1056 |
| Leverage | Requested 2×; account configuration and actual position both reported 2× |
| Stop loss | 1.0836, active market protection for all 9 XRP |
| Take profit | 1.1499, active market protection for all 9 XRP |
| Protection reconciliation | Exchange protection matched entry; worker reported open/protected, no halt |
| Closing order | Manual reduce-only market close, filled 9 XRP at average 1.1034 |
| Final XRP state | Zero positions and zero pending orders, including protective orders |
| Final leverage | XRP returned to isolated 1× after flat-state verification |
| Journal | Both manual opening and closing entries recorded as closed |

XRP had no symbol-specific configuration initially; the test initialized isolated 1× on this flat Demo symbol before exercising the manual workflow's change to 2×. Existing BTC and SOL bot positions were left open and remained protected. Saved terminal settings, execution connections and monitoring credential files retained their pre-test hashes. The automatic bot's configuration was not changed.

## Scope and limitations

This verifies a real exchange **Demo** market fill, exchange leverage, creation and full-size coverage of TP/SL, and a reduce-only market close. The test used the dashboard API rather than browser clicks; the UI flow had separate mocked browser coverage.

The position was manually closed before either protective trigger fired. Therefore TP/SL trigger execution, manual resting limit orders, Classic V2 exchange fills and Live fills are outside this acceptance result. This controlled plumbing test is not a strategy signal or evidence of profitability. The original bot positions remain open; only the test's XRP exposure was cleared.
