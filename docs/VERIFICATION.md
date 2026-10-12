# Direct connection verification

## Reproducible checks

Use Node 22.23.3 on macOS and the committed lockfiles:

```sh
npm ci --ignore-scripts
npm ci --ignore-scripts --prefix verification/runtime
npm run verify
npm run test:install
DSH_VERIFY_CLI="$PWD/verification/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js" npm run test:profile
npm audit --audit-level=low
npm audit --audit-level=low --prefix verification/runtime
```

The root suite uses the small pinned Cordis/LLM peer dependency tree. The separate installation and profile checks require the full locked Harness 0.2.0-rc.2 runtime. All automated authentication and service fixtures are synthetic and disposable. Tests never import existing Codex credentials or send real model requests.

## Covered controls

- Private dedicated OAuth storage: ownership, 0700/0600 modes, size/schema bounds, symlink and non-regular-file rejection, atomic durable replacement. FIFO tests demonstrate nonblocking refusal and lock release, including retry when a losing acquirer releases the lock after EEXIST but before its metadata check.
- Device login, logout, process-shared serialization, account continuity, grant quarantine and quota handling using synthetic HTTP responses and stores.
- Durable refresh intent prevents automatic replay after ambiguous remote outcomes, cancellation, persistence failure, and process restart. A definite HTTP 429 rejection allows retry; uncertain outcomes require a fresh login.
- Fixed HTTPS origins, redirect refusal, bounded JSON, safe fixed error codes and diagnostic labels, and cancellation after response headers.
- Live-catalog validation, hidden-model exclusion, compatibility fallback, auth-aware caching and fresh admission for each turn.
- Bounded text history up to the 1024-message cap with validated tool definitions and executed tool-call history, user message images as `input_image` data URLs, offload-budget refusal with `IMAGE_OFFLOAD_REQUIRED`, rejection of other-role images, and `stop` rejection. `temperature` is validated to 0–2 and forwarded; `maxTokens` is validated and accepted as an advisory budget without forwarding. Synthetic 429 responses cover usage-limit bodies with and without `resets_at`, past and clamped resets, non-usage codes, oversized and unreadable bodies, and the bounded reset hint.
- Incremental bounded SSE framing, split UTF-8, CRLF/multiline data, empty text deltas, non-SSE MIME compatibility, completed-item and idempotent completed `function_call` reconciliation, and refusal of malformed, contradictory, non-function execution-bearing or incomplete responses.
- Four-operation admission including cancellation cleanup, pre-aborted refusal, paused-reader cancellation, event-loop yields, timeouts and bounded shutdown.
- The sign-in panel in a browser with synthetic OAuth responses: panel display, one-time code and fixed link, local diagnosis, cancellation, restarted login, automatic completion after simulated approval, confirmed local logout, and rejection of unknown fields and oversized payloads, with the settings API unchanged.
- Public adapter registration/disposal, actual npm tarball composition, MIT license inclusion, missing-auth errors, and synthetic CLI/SDK conversation.
- Fresh isolated Web-profile preparation, quoted paths, overwrite refusal and read-only doctor behavior for missing, insecure, locked and uncertain stores.
- The installed Desktop host pair: the packaged synthetic CLI/SDK conversation and shutdown on the Electron executable, and a disposable profile conversation driven through Desktop's ASAR resolver with actual host peers.

The source installer creates a new directory with an empty private HOME. It records the package integrity, commit, Node and Harness versions and disables installation scripts. Verification does not modify a normal Harness profile.

## Runtime and platform evidence

Local verification used macOS 26.6.2 / Apple Silicon and official Node 22.23.3 (Undici 6.28.1, OpenSSL 3.5.8). The macOS arm64 Node archive SHA-256 was checked: `23b25245dcfb9af7262f8ff142e9e2e0af025368117329e7a7458a51e5922f53`. The public adapter and auth CLI refuse older/unverified Node versions and unsupported OSes before credential access. Intel macOS remains unverified; other OSes are unsupported by the initial platform contract.

The installed DeepSeek Harness Desktop 0.2.0-rc.2 (build `5e9e301dd9dc8923b2762f76dacfc5751f6ca851`, Electron 44.0.0 / Node 24.18.1, host Cordis 4.0.4 / LLM 0.2.0-rc.2) ran the root suite on both standalone Node 22.23.3 and the Electron executable, and all three npm audits (plugin, Harness runtime, Electron test package) reported zero known vulnerabilities. Electron's own OS preferences and updater state are outside the dedicated Harness-home isolation.

A generated standalone Web profile reached an authenticated localhost HTML page with HTTP 303/200 and was stopped without OAuth login or a model request. This checks startup and HTTP readiness, not a complete real Web conversation.

The current root suite counts 79 tests. A local Node 22.23.2 run produces four known environment-only version-gate failures; hosted CI on Node 22.23.3 passes the full suite and is the authoritative check.

## Real-account evidence and limits

The owner confirmed dedicated device login and model selection. Two separately authorized short diagnostic requests confirmed an authenticated catalog including `gpt-6.1-sol` and an HTTP 200 response with a 6992-byte SSE-framed body under a non-SSE MIME header. No credentials, account IDs, prompt text or response text were printed or saved. The exact media type was not retained.

Real successful generation through the adapter, real refresh and revocation, interruption recovery, entitlement to models beyond those confirmed, latency and a complete Web conversation remain unverified. Real tool-call and image turns, upstream acceptance of forwarded `temperature`, `input_image` acceptance, `strict: false` requirements, vision-token accounting, reasoning efforts beyond `low`/`high`, and the presence of `resets_at` or `plan_type` in real 429 bodies remain unverified. Full real GUI, login, refresh and revocation behavior on the installed Desktop runtime remains owner-operated verification. Each further account operation requires separate explicit authorization. The prepared real-account smoke command is not part of CI and has not been run for this transport; authorized real-account E2E verification remains a release preparation task.

## Continuous integration

[CI](../.github/workflows/ci.yml) runs on pushes to the default branch, manual dispatch and pull requests that are not drafts; marking a draft ready for review starts its first run. CI uses `macos-15` and `.node-version`. Official checkout v7.0.1 and setup-node v7.1.0 are pinned to commit SHAs. Token access is read-only, checkout credentials are not persisted, and no cache or repository secrets are configured. The job has a 20-minute deadline, disables install scripts, audits both locked trees, runs all reproducible checks above, and requires tracked files to remain unchanged. It does not publish packages or perform account operations.

CI adds a locked Electron 44.0.0 test package and an explicit checksum-verifying binary download before synthetic host checks; it does not install Harness Desktop or run real login. The installed-ASAR composition lane is verified locally rather than claimed as a CI check. The packaged tarball excludes `.github`, so the workflow link above resolves only inside a full checkout. Audit results only cover known advisories; no finite audit or test suite establishes absence of unknown vulnerabilities.
