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
