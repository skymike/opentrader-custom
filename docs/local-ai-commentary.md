# Local explanations and activity summaries

The agent terminal includes **Your activity, explained** with LFM2.5-1.2B-Instruct Q4_K_M. Open it through **Settings → AI commentary**. Its on/off button saves a server-wide preference. Signing out clears displayed commentary. Both light and dark themes are supported.

AI only rewrites recorded facts into short explanations. Scanner, Risk Check, Sizer, Executor, Logger and Equity remain deterministic code. No model output is read by those modules. There is no model tool interface, order transport or decision override. The existing Executor is still preflight-only.

## Performance and failure behavior

- The dashboard reads a small cached file through an authenticated API. Browser requests never trigger or wait for inference.
- A separate worker permits one generation cycle at a time, at most every five minutes. Each cycle makes at most three short, sequential requests; each has a 12-second timeout and a 90-token output limit.
- Unchanged facts reuse commentary for up to 15 minutes. A changed account, pause state, decision, activity count or AI setting invalidates previous commentary. The UI immediately clears commentary when account/control settings change and labels waiting/unavailable states.
- The worker checks every 10 seconds. Stale source data (over 150 seconds), an absent worker heartbeat (over 45 seconds), incomplete output or a model outage hides AI text. Recorded code reasons remain available. Failures back off for five minutes.
- On nl-server, the model has two CPU threads pinned to cores 2–3, a two-core CPU quota, low scheduling/IO priority, a 3 GiB memory ceiling and no swap. The worker is capped at 0.25 CPU and 128 MiB RAM. Turning commentary off stops new generation; the idle model stays loaded for fast restart.

These limits reduce contention; they do not guarantee zero impact under every future host workload. Verify dashboard API latency during inference after changes to hardware, context length or service limits.

## Data boundary and accuracy

Prompts contain an allowlisted account connection status, market names/status, paused status, the number of recorded updates in the last 15 minutes, and exact recognized code reasons. No API keys, credentials, balances, position sizes, raw log text or arbitrary instructions are sent. No external AI provider is used. The worker has a read-only monitoring snapshot mount and a separate commentary volume; it has no credentials mount. The model listens only on host loopback.

Generated text is displayed as plain text, with the corresponding authoritative code reason alongside it. This small model can still misstate facts; wording checks cannot prove semantic accuracy. It failed the longer trading-review benchmark, so it must not be used to approve trades. A summary of recorded events is not a claim of executed trades or profitability.

## Deploy using the existing GitHub release

The Build Classic Terminal workflow includes the worker, tests and setup scripts. On the existing nl-server only:

1. Run `python3 setup-terminal-ai.py` from the downloaded GitHub artifact. This verifies the benchmarked LFM weights, copies the existing native runner/model into `~/.local/share/opentrader-ai`, and enables the resource-limited `opentrader-lfm.service` user service.
2. Enable user service persistence with `loginctl enable-linger skymike` (administrator privileges may be needed).
3. Deploy the release using `python3 deploy-terminal.py terminal-release.tar.gz <full-commit-sha> --enable-ai`. This initializes commentary as enabled only if no saved preference exists. Later deployments preserve that preference and replace the worker using the same release image.

The installer intentionally targets the measured i5-3470 host and its verified files in `~/ai-benchmark-20261107`; it is not a generic model installer. Model checksum: `b1b3de114215d9507409a662a501a631095a479a419584e8a2ded6304b19b4f5`. The native runner is the benchmarked llama.cpp build from commit `cd959bae99ff4bed22bef2604f45241c09bbb8c8`.

Storage: `opentrader-terminal-assistant` Docker volume contains private `settings.json` and `commentary.json`. The app and commentary worker mount it; the market monitor does not. Existing account credential storage is unchanged. The worker uses host networking solely to reach the loopback model endpoint and exposes no HTTP listener.

Operations: `systemctl --user status opentrader-lfm`, `docker logs opentrader-terminal-assistant`. Logs use generic errors without prompts. Stop inference with `systemctl --user stop opentrader-lfm`; stop the worker with `docker stop opentrader-terminal-assistant`. The dashboard and trading modules work independently. Deployment retains stopped previous app, monitor and worker containers for rollback.

Verification: run the four `*.node-test.mjs` files listed in `.github/workflows/terminal.yml`, the repository Vitest suite, the production build, and a post-deployment comparison of authenticated state/API latency with the worker idle versus generating.
