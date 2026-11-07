# Bitget account API selection and demo acceptance

User authorized implementation and real virtual-fund demo order tests. Existing delegated design choices remain in effect.

1. Add per-connection v2/v3 and demo/live routing, preserving old V2 defaults. Add Unified normalization/signing tests before adapter changes. Normalize both APIs into the existing execution state machine; persist API selection on orders and block switches while exposure is unresolved.
2. Add selectors to custom execution and monitoring forms. Add an original-dashboard account API settings panel, persisted separately by account ID, and wire the selection into CCXT. Upgrade/pin CCXT 4.5.92 because installed 4.4.91 lacks Unified private methods. Isolate cached markets by API version. Do not alter unrelated README/UTA script/snapshot changes.
3. Provide explicit connection validation and demo-only acceptance controls. Synthetic test signals must be labelled, bounded, single-use, unavailable to live mode, and use normal approval/automatic execution and close reconciliation. Test that live cannot request acceptance signals.
4. Build, run focused and repository tests, browser smoke, independent review, deploy with entries stopped. User will enter demo credentials in UI (confirmed asynchronously).
5. Verify Unified demo metadata and configure demo-only 1x isolated/one-way if necessary. Run small approval and automatic open/close cycles, record exchange order IDs/fills and verify zero remaining test exposure. Do not submit live orders. Report any exchange-side limitation honestly.

Implementation uses Node ESM/Fastify/static UI and existing Docker service. Original dashboard needs outbound exchange access; add a dedicated egress network without publishing ports, preserving its existing private ingress network.
