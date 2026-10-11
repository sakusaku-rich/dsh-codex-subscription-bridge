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

The root suite uses the small pinned Cordis/LLM peer dependency tree. The separate
installation and profile checks require the full locked Harness 0.2.0-rc.2 runtime.
All automated authentication and service fixtures are synthetic and disposable.
Tests never import existing Codex/Hermes credentials or send real model requests.

## Covered controls

- Private dedicated OAuth storage: ownership, 0700/0600 modes, size/schema
  bounds, symlink and non-regular-file rejection, atomic durable replacement.
  FIFO tests demonstrate nonblocking refusal and lock release.
- Device login, logout, process-shared serialization, account continuity, grant
  quarantine and quota handling using synthetic HTTP responses and stores.
- Durable refresh intent prevents automatic replay after ambiguous remote
  outcomes, cancellation, persistence failure, and process restart. A definite
  HTTP 429 rejection allows retry; uncertain outcomes require a fresh login.
- Fixed HTTPS origins, redirect refusal, bounded JSON, safe fixed error codes
  and diagnostic labels, and cancellation after response headers.
- Live-catalog validation, hidden-model exclusion, compatibility fallback,
  auth-aware caching and fresh admission for each turn.
- Bounded text history, ignored tool declarations and replay metadata, and
  rejection of execution history, images and generation overrides.
- Incremental bounded SSE framing, split UTF-8, CRLF/multiline data, empty text
  deltas, non-SSE MIME compatibility, completed-item reconciliation, and refusal
  of malformed, contradictory, execution-bearing or incomplete responses.
- Four-operation admission including cancellation cleanup, pre-aborted refusal,
  paused-reader cancellation, event-loop yields, timeouts and bounded shutdown.
- Public adapter registration/disposal, actual npm tarball composition, MIT
  license inclusion, missing-auth errors, and synthetic CLI/SDK conversation.
- Fresh isolated Web-profile preparation, quoted paths, overwrite refusal and
  read-only doctor behavior for missing, insecure, locked and uncertain stores.

The source installer creates a new directory with an empty private HOME. It
records the package integrity, commit, Node and Harness versions and disables
installation scripts. Verification does not modify a normal Harness profile.

## Runtime and platform evidence

Local verification used macOS 26.6.2 / Apple Silicon and official Node 22.23.3
(Undici 6.28.1, OpenSSL 3.5.8). The macOS arm64 Node archive SHA-256 was checked:
`23b25245dcfb9af7262f8ff142e9e2e0af025368117329e7a7458a51e5922f53`.
The public adapter and auth CLI refuse older/unverified Node versions and
unsupported OSes before credential access. Intel macOS and Desktop remain
unverified; other OSes are unsupported by the initial platform contract.

A generated standalone Web profile reached an authenticated localhost HTML page
with HTTP 303/200 and was stopped without OAuth login or a model request. This
checks startup and HTTP readiness, not a complete real Web conversation.

## Real-account evidence and limits

The owner confirmed dedicated device login and model selection. Two separately
authorized short diagnostic requests confirmed an authenticated catalog including
`gpt-6.1-sol` and an HTTP 200 response with a 6992-byte SSE-framed body under a
non-SSE MIME header. No credentials, account IDs, prompt text or response text
were printed or saved. The exact media type was not retained.

The parser now validates bounded SSE events and explicit successful completion
rather than requiring a particular MIME header. Synthetic tests cover the
corrected path. Successful real generation through the corrected adapter,
real refresh/revocation, interruption recovery, entitlement to other models,
latency and complete Web conversation remain unverified. Each further account
operation requires separate explicit authorization. The prepared real-account
smoke command is not part of CI and has not been run for this transport.

## Continuous integration

[CI](../.github/workflows/ci.yml) runs on pushes, pull requests and manual dispatch
using `macos-15` and `.node-version`. Official checkout v7.0.1 and setup-node
v7.1.0 are pinned to commit SHAs. Token access is read-only, checkout credentials
are not persisted, and no cache or repository secrets are configured. The job
has a 20-minute deadline, disables install scripts, audits both locked trees,
runs all reproducible checks above, and requires tracked files to remain unchanged.
It does not publish packages or perform account operations.

The initial [hosted CI run](https://github.com/sakusaku-rich/dsh-codex-subscription-bridge/actions/runs/38133918042)
succeeded before the current source cleanup. Current cleanup results are recorded
below after revalidation. The project is MIT-licensed and remains private.
A private security-reporting channel and authorized real-account E2E verification
remain release preparation tasks. Audit results only cover known advisories;
no finite audit or test suite establishes absence of unknown vulnerabilities.

## Current source verification (2026-10-11)

After removing obsolete transport-specific files, the root suite passed 53 tests
with zero failures and zero skips. The separate isolated installer test and
packaged Harness CLI/SDK synthetic conversation passed. Both locked dependency
audits reported zero known vulnerabilities. Source/reference searches found no
remaining obsolete transport imports, configuration assets or instructions.
Shared input controls remain covered by transport-independent text tests.
No real account operations were performed.

## JSON ingestion and lock contention corrections (2026-10-11)

JSON response bodies now use a fixed buffer bounded by their payload limit
instead of retaining a Buffer for every chunk. Empty chunks add no retained
payload; bounded read/byte batches yield to the event loop and recheck abort.
Synthetic indefinitely ready empty/one-byte streams are cancelled by caller
abort and deadline timers. Split UTF-8 and exact/over-limit payloads remain covered.

A legitimate owner can release auth.lock after another process receives EEXIST
but before its metadata check. ENOENT now retries acquisition within the original
30-second deadline. Permission/type/symlink checks, cancellation and no-stealing
semantics remain enforced. A subprocess fixture deterministically imposes that
interleaving and checks release, insecure replacement, symlink, abort and deadline.

Root verification passed 56 tests without failures or skips. The isolated
installer test and packaged Harness CLI/SDK synthetic conversation passed.
No real account operation was performed. Private security reporting and
authorized real-account E2E verification remain separate release requirements.
