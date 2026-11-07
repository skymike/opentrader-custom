# Private explanations and activity summaries

The agent terminal includes **Your activity, explained** with LFM2.5-1.2B-Instruct Q4_K_M. Open it through **Settings → AI commentary**. Its on/off button saves a server-wide preference. Signing out clears displayed commentary. Both light and dark themes are supported.

AI only rewrites recorded facts into short explanations. Scanner, Risk Check, Sizer, Executor, Logger and Equity remain deterministic code. No model output is read by those modules. There is no model tool interface, order transport or decision override. The existing Executor is still preflight-only.

## Performance and failure behavior

- The dashboard reads a small cached file through an authenticated API. Browser requests never trigger or wait for inference.
- A separate worker permits one generation cycle at a time, at most every five minutes. Each cycle makes at most three short, sequential requests; each has a 12-second timeout and a 90-token output limit.
- Unchanged facts reuse commentary for up to 15 minutes. A changed account, pause state, decision, activity count or AI setting invalidates previous commentary. The UI immediately clears commentary when account/control settings change and labels waiting/unavailable states.
- The worker checks every 10 seconds. Stale source data (over 150 seconds), an absent worker heartbeat (over 45 seconds), incomplete output or a model outage hides AI text. Recorded code reasons remain available. Failures back off for five minutes.
- After the verified migration, LFM runs on proud-server with two CPU threads pinned to cores 2–3, a two-core CPU quota, low scheduling/IO priority, a 1.5 GiB memory ceiling and no swap. The dashboard and its cached-summary worker remain on nl-server. The worker is capped at 0.25 CPU and 128 MiB RAM; the encrypted forwarding process is capped at 0.1 CPU and 64 MiB RAM. Turning commentary off stops new generation; the idle model stays loaded on proud-server.

These limits reduce contention; they do not guarantee zero impact under every future host workload. Verify dashboard API latency during inference after changes to hardware, context length or service limits.

## Data boundary and accuracy

Prompts contain an allowlisted account connection status, market names/status, paused status, the number of recorded updates in the last 15 minutes, and exact recognized code reasons. No API keys, credentials, balances, position sizes, raw log text or arbitrary instructions are sent. No external AI provider is used. The worker has a read-only monitoring snapshot mount and a separate commentary volume; it has no credentials mount.

The model listens only on proud-server loopback port 18090. A dedicated SSH connection maps nl-server loopback port 18089 to it. The host key is pinned from an already trusted administrative connection; the private client key stays on nl-server. Its account can only forward to the model port, cannot open a shell, cannot forward remote ports or Unix sockets, and cannot use passwords or agent forwarding. No public model HTTP port is opened. The model itself runs as an unprivileged system user with a read-only system filesystem and no access to administrator homes.

Generated text is displayed as plain text, with the corresponding authoritative code reason alongside it. This small model can still misstate facts; wording checks cannot prove semantic accuracy. It failed the longer trading-review benchmark, so it must not be used to approve trades. A summary of recorded events is not a claim of executed trades or profitability.

## Deploy using the existing GitHub release

The Build Classic Terminal workflow includes the worker, tests and migration scripts. Continue deploying the dashboard artifact to **nl-server** with the existing `deploy-terminal.py` workflow. It preserves the enabled preference and replaces the lightweight worker; the private SSH link survives app upgrades. Do not reinstall local inference on nl-server.

The one-time `migrate-terminal-ai.py` sequence is deliberately explicit:

1. Run the guarded LFM coexistence test on proud-server. `install-proud` refuses to proceed unless `/root/proud-lfm-benchmark-20261107/summary.json` records a pass. Verify that baseline/stress/normal/recovery measurements cover the existing services and show no material degradation or swap growth.
2. Copy proud-server's public Ed25519 host key through the trusted administrative SSH connection. On nl-server run `prepare-link --host-key <public-host-key-file>`. Copy only its generated public client key to proud-server; the private key never leaves nl-server.
3. On proud-server run `install-proud --public-key <public-client-key-file>`. This verifies model/archive checksums, installs the tested runner including shared libraries, validates the narrowly scoped SSH policy before reloading SSH, and starts the limited loopback model service.
4. On nl-server run `switch-link`. This stops local inference and starts the persistent private link. Failure restores the local model. Restarting the commentary worker forces a new generation through proud-server.
5. Verify the dashboard and fresh commentary, service responsiveness on proud-server, tunnel reconnection, and authentication boundaries. Only then run `cleanup-nl`. It requires a fresh result created after cutover and removes the old LFM service, production runner/weights and benchmark LFM weight copy. Other benchmark files/models are retained.

These scripts intentionally target the existing two hosts, not arbitrary servers. Model checksum: `b1b3de114215d9507409a662a501a631095a479a419584e8a2ded6304b19b4f5`. Proud-server uses the tested official llama.cpp b12110 CPU runner archive, SHA256 `368227edcc229be5f9bed16a2223d79b5e41d0ac2e19bcf5825e82291c060e55`. `setup-terminal-ai.py` is the legacy local installer and refuses to compete with an active forwarding service.

Storage: `opentrader-terminal-assistant` Docker volume contains private `settings.json` and `commentary.json`. The app and commentary worker mount it; the market monitor does not. Existing account credential storage is unchanged. The worker uses host networking solely to reach the loopback model endpoint and exposes no HTTP listener.

Operations on **proud-server**: `systemctl status opentrader-lfm`; stop inference with `systemctl stop opentrader-lfm`. Files live in `/opt/opentrader-lfm`; the systemd service starts after reboot. Operations on **nl-server**: `systemctl --user status opentrader-lfm-link`, `docker logs opentrader-terminal-assistant`. The user service persists through logout/reboot using existing user lingering. SSH automatically reconnects after failure; the worker backs off and shows unavailable commentary while the link is down. Dashboard monitoring and trading code continue independently. Deployment retains stopped previous app, monitor and worker containers for rollback.

Verification: run the four `*.node-test.mjs` files listed in `.github/workflows/terminal.yml`, the repository Vitest suite, the production build, and a post-deployment comparison of authenticated state/API latency with the worker idle versus generating.
