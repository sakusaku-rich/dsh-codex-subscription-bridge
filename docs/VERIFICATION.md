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

The prototype does not satisfy all MVP acceptance criteria. Effective native
authority, inherited startup configuration, exact production executable/version
admission, real history semantics, full Harness profile composition, account
refresh, and revocation remain unverified. The production gate prevents use
until the pre-dispatch safety prerequisite is resolved.

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
and is not counted as a verified isolation control. The public production gate
remains closed. Full Harness bundle-loader composition and separately authorized
real-account testing remain outstanding.
