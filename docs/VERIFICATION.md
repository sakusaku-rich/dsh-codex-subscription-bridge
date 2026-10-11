> Direct migration: the public adapter now uses dedicated OAuth and HTTPS.
> App-server results below are historical and do not validate the new transport.
> See [direct design](DIRECT.md) and the current README.

# Prototype verification

Verified on 2026-10-11 with Node.js 22.23.2 on macOS:

- `npm run verify`: JavaScript syntax checks and 35 passing tests.
- Real pinned Cordis 4.0.4 / Harness LLM 0.2.0-rc.2 provider registration,
  normalized refusal messages, and disposal.
- Local npm tarball installation without scripts or network in a temporary
  service fixture; host peers are supplied from the pinned development tree.
- Synthetic managed-account admission and rejection of other authentication modes.
- Model discovery validation, streaming, forks/concurrency, unsupported input,
  cancellation, consumer-paused deadlines, and early stream disposal.
- Real self-authored mock child processes for RPC errors, malformed JSON, invalid
  UTF-8, oversized stdout/stderr, request timeout, and termination resistance.
- Protocol queue/message/nesting bounds, environment filtering, executable path
  validation, and repeatable shutdown.
- `npm audit`: zero reported known vulnerabilities across 11 development/host
  peer packages at the time of the query. This is not a vulnerability-free claim.
- Locked dependency manifests: no preinstall, install, postinstall, or prepare
  hooks found. Installation was performed with `--ignore-scripts`.

No Codex account credentials were read by the bridge or tests. No authentication
was changed, app-server account session started, model requested, normal Harness
profile installed, PR opened, or package published.

At that first-stage snapshot, the prototype did not satisfy all MVP acceptance criteria. Effective native
authority, inherited startup configuration, exact production executable/version
admission, real history semantics, full Harness profile composition, account
refresh, and revocation remain unverified. At that first-stage snapshot, the production gate prevented use pending
pre-dispatch isolation verification.

All protocol response values, account identities, conversation text, stderr,
and token-like examples used by tests are synthetic. Tests do not copy code
from a community plugin or require a real login.

## Second-stage results

The normal suite now has 38 passing tests and two opt-in real-binary tests
skipped when `CODEX_ISOLATION_EXECUTABLE` is absent. Additional passing coverage
checks the private lock runtime, exact version rejection, and descendant cleanup.

The first opt-in run with the local 0.144.6 executable produced one passing
and one failing test. The combined adapter test exposed an unsupported sandbox
shape accepted by the earlier mocks. Automatic approval review initially rejected
its correction because `readOnly` can permit broad file reads. The owner then
explicitly authorized correction and revalidation without existing credentials.

The corrected request sends `sandboxPolicy: { type: "readOnly", networkAccess:
false }`, matching the pinned executable's generated schema. It does not claim
that read-only mode confines reads; tool restrictions and configuration
replacement remain distinct controls.

The authorized command was:

```sh
CODEX_ISOLATION_EXECUTABLE=/absolute/path/to/codex npm run verify
```

Result: **40 tests passed, zero failed, zero skipped.** The complete bridge path
against the real executable and a localhost mock provider now verifies text
history injection, text deltas and successful finish, rejection of forced
`exec_command`, an absent command execution marker, and no private sentinel in
model requests. Only `update_plan` was advertised. The real-binary account check
used an empty synthetic authentication directory; the conversation test replaces
account admission with a synthetic managed-account response. No real ChatGPT
login, account refresh, or subscription model access was tested.

A separate restrictive macOS Seatbelt attempt did not start Codex successfully
and is not counted as a verified isolation control. At that second-stage snapshot, the public production gate remained closed.
The next stage below completed loader composition and wired the configured
launcher. Real-account testing remains separately authorized.

## Packaged profile and configured launcher stage

The current configured adapter is connected to the isolated launcher. Both an
absolute executable and a credential store are required; missing configuration
returns `CONFIG_REQUIRED` without account access. The declared route is text-only.

The completed tests now include:

- Exact public Harness profile composition and the CLI/SDK initialization path.
- Packaged provider registration, model discovery, and a configured SDK text turn
  through a synthetic Codex executable, followed by clean shutdown.
- An adversarial project dotenv authentication path ignored through the original
  launcher snapshot; API keys excluded from the child environment.
- Precise managed-auth mode admission using a token-free status request.
- Real Codex refusal of a synthetic API-key file without changing that file.
- Multiple assistant text items, discarded Harness declarations, and rejection
  of actual tool execution history.
- Explicit file/keyring storage selection; automatic fallback is refused.

The credential-free real-binary suite and packaged profile check pass. The
patched verification runtime's npm audit reports zero known vulnerabilities;
see HARNESS.md for the initial advisory findings and applicability limits.

No real-account model request, keyring access, refresh/revocation check,
Desktop/Web GUI check, normal profile installation, or PR was performed.
The bounded real-account smoke script is prepared but has not been executed.

Final stage result: 51 tests passed with the real executable enabled; the default
run passes 48 tests and skips three opt-in real-binary tests. The packaged-profile
check also passes against the security-fixed locked runtime.

## Owner-authorized real-account smoke check

On 2026-10-11 the owner explicitly authorized file-backed account discovery and
one short model request. `scripts/smoke-account.mjs` ran against the trusted local
Codex CLI 0.144.6 through the public adapter, with `credentialStore: file`.

Result: passed, model `gpt-5.6-sol`, expected fixed reply matched, exit code 0.
The selected model was the first advertised catalog entry. This demonstrates
managed ChatGPT-mode admission, real model access, streamed text completion,
and bridge cleanup for this single request. No additional model request followed.

The bridge did not read, copy, import, or display authentication files or token
values. Authentication was handled by Codex. Subscription quota may have been
consumed and Codex may have updated its own cached authentication; whether an
auth refresh or persistent credential update occurred was not measured. This
result does not establish refresh/revocation behavior, entitlement to other
models, long-session behavior, or general vulnerability absence.

No normal Harness profile was installed or modified. Desktop/Web GUI behavior
and real keyring access remain unverified. No PR or public package was created.

## Direct migration verification — 2026-10-11

The public adapter now uses dedicated device-code OAuth and direct HTTPS. Normal
verification passed 67 tests; three opt-in real-Codex tests were skipped because
they concern the historical transport. Seventeen new direct tests cover private
storage, API-key/symlink rejection, refresh serialization including separate
Node processes, grant quarantine versus quota preservation, logout, destination
and redirect constraints, bounded JSON/SSE, auth-aware catalog caching, catalog
compatibility fallback, text streaming, unsupported execution items, EOF/failure,
cancellation, paused-reader timeout cleanup, dedicated synthetic device login,
and cancellation without overwriting an existing grant.

The actual npm tarball passed pinned Harness profile composition, public CLI/SDK
registration, missing-auth refusal, synthetic direct conversation, and shutdown.
Its file list excludes legacy app-server/process/isolation code and assets. No
new dependency or install hook was added. Root npm audit reported zero known
vulnerabilities; this is not a security guarantee.

No real direct OAuth login, token refresh, catalog request, model request, latency
measurement, or direct Web conversation has been performed. The earlier managed
app-server account smoke check must not be counted as direct-transport evidence.


## Non-SSE MIME compatibility correction — 2026-10-11

The owner reported successful dedicated device login and model selection, then
`PROTOCOL_INVALID` on conversation dispatch. Two separately authorized fixed
short requests investigated the failure without printing or storing credentials,
account IDs, prompts, or response text. The first isolated rejection at the
Content-Type guard after HTTP 200. The second confirmed a 6992-byte SSE-framed
body while the normalized media type was outside the diagnostic's known MIME
set. The exact MIME value was not retained; do not claim a particular header.
The authenticated catalog advertised `gpt-6.1-sol`.

The adapter now relies on bounded SSE frames, validated events, and explicit
successful completion rather than rejecting by MIME. Two regression tests
exercise missing/non-SSE headers and rejection of HTML, JSON errors, truncated
frames and unknown events. The packaged Harness SDK fixture uses an
`application/octet-stream` header to exercise the public adapter.

Verification passed 69 tests, with three historical Codex tests skipped, and
packaged Harness profile/CLI/SDK verification passed. The correction was applied
to the existing temporary Web profile without changing its dedicated login.
No further real request was sent after those two authorizations. Successful
real generation through the corrected parser remains for the owner's UI check.

## Refresh uncertainty, empty deltas, and safe diagnostics — 2026-10-11

Three independent corrections were implemented:

- Refresh dispatch first persists `refresh_pending` atomically. Lost replies,
  malformed success bodies, failed persistence, server errors, and process
  restarts cannot automatically resend a potentially consumed grant. A definite
  HTTP 429 restores the prior grant; successful persistence or a fresh login
  clears intent. The new recovery cases use only disposable synthetic stores.
- Empty string text deltas are accepted as no-op updates. Non-string and
  oversized deltas remain rejected, without duplicate block starts or endings.
- Fixed diagnostic stage labels distinguish frame/event/text/terminal/catalog
  and authentication failures. Unknown labels and mutated error messages are
  discarded rather than surfaced. No body, token, identifier, or dynamic event
  name is added to user-visible diagnostics.

Verification passed 74 tests; three historical Codex tests were skipped. The
actual packaged Harness profile and public CLI/SDK synthetic conversation passed.
No real account request, token refresh, or login was run by the agent for these
corrections. Real update interruption and account recovery remain unverified.

## Security audit remediation — 2026-10-11

The project's Node baseline is now 22.23.3 (Undici 6.28.1, OpenSSL 3.5.8), with
matching manifests, lockfiles, version-manager files, and pre-authentication
runtime admission in the public adapter/CLI. The dedicated official macOS arm64
archive was SHA-256 verified. The temporary Web launcher and login helper use
that binary; the global Node installation was not modified.

Credential reads now reject non-regular entries before open, use no-follow and
nonblocking open flags, and recheck descriptor ownership/type/permissions.
A process-isolated FIFO test finishes with AUTH_STORE_INVALID and releases the
store lock rather than blocking. Directory and established symlink cases are
also refused. This is defensive local hardening, not proof of a remote exploit.

HTTP JSON operations preserve caller cancellation after headers as ABORTED;
internal deadlines remain TIMEOUT rather than a JSON parse failure.

On Node 22.23.3, verification passed 77 tests with three historical Codex tests
skipped. The packaged pinned Harness CLI/SDK profile also passed synthetic
conversation and shutdown checks. No real login, refresh or model request was
performed for this remediation. Real-account update/revocation and complete
Web conversation coverage remain unverified.

## Follow-up lifecycle corrections — 2026-10-11

OAuth body reading now receives cancellation/deadline signals across polling,
exchange and refresh. The reader is cancelled on abort and distinguishes caller
ABORTED from deadline TIMEOUT. Durable refresh intent is not cleared on uncertain
cancellation. Synthetic polling/body deadline tests cover the previously missed
path; no real OAuth operation was run.

Completed output items and terminal output use the same bounded text
reconciliation. Item text is recovered even when terminal output is null.
Repeated text/item/terminal completion does not duplicate blocks or text;
contradictions, incomplete item status, unsupported roles/content, and oversized
text fail closed.

The bridge separately tracks owned authentication/HTTP/discovery operations and
reader cancellation. close is idempotent, refuses new work, aborts transports,
and waits for pending ownership cleanup with a five-second deadline. It fails
with TIMEOUT instead of claiming completion if cleanup remains unresponsive.
Synthetic tests demonstrate lock release before close completion and paused
reader cancellation without requiring consumer progress.

Node 22.23.3 verification passed 86 tests; three historical Codex tests were
skipped. Packaged Harness CLI/SDK synthetic conversation and shutdown passed.
Real account recovery, real service event variations and complete Web operation
remain unverified. No account requests were sent for these fixes.

## Admission and incremental SSE work bounds — 2026-10-11

Admission now rejects pre-aborted requests before authentication/filesystem work.
Each controller retains its capacity until owned auth/HTTP work and cancellation
cleanup settle; the pending set remains separate shutdown bookkeeping. A burst
of 32 requests while four cancelled auth operations were still settling was
refused with LIMIT_EXCEEDED and peak auth concurrency stayed at four. The actual
AuthStore pre-aborted reproducer entered filesystem preparation zero times.

SSE framing scans bytes incrementally into a fixed 1 MiB frame buffer plus
four delimiter bytes. It decodes/materializes each frame once, accounts bytes
incrementally, and yields after 4096 processed bytes or 256 reads so ready tiny
or empty fragments cannot indefinitely defer cancellation timers. Existing
UTF-8, multiline data, mixed LF/CRLF, malformed/incomplete payload rejection,
aggregate/frame/count/text bounds, and terminal-state checks are retained.

Illustrative same-host measurements for malformed one-byte fragments improved
from 282/4007 ms (32/128 KiB) to 33/76 ms. A scheduled 10 ms abort was observed at
11 ms with ABORTED, rather than being deferred beyond parsing. Timings are not
portable guarantees and are not asserted as fixed regression-test thresholds.

Node 22.23.3 verification passed 92 tests; three historical Codex tests were
skipped. Packaged Harness CLI/SDK synthetic conversation and shutdown passed.
No real account request was sent. These two corrections do not complete the
remaining public-release live verification, CI, license or reporting-channel
preparation described in the workspace audit.
