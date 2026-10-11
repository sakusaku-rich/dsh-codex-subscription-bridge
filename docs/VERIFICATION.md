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

Running the opt-in suite with the local 0.144.6 executable produced one passing
and one failing test. Configuration replacement/version-drift rejection passed.
The combined history/tool-rejection/streaming test fails at an upstream request
because the prototype sends an unsupported sandbox shape. This failure is
retained as a visible regression; it is not counted as successful validation.

An earlier standalone credential-free experiment against a localhost mock
provider demonstrated forced `exec_command` rejection and text streaming, with
only `update_plan` advertised. That experiment did not use the complete bridge
adapter and is not a substitute for the failing integration test.

Automatic approval review rejected correcting the sandbox shape and rerunning
the test, citing potential broad file reads in `readOnly`. Owner approval is
pending. A stricter OS sandbox alternative did not start Codex successfully.
No real account or external model endpoint was used. Live access stays disabled.
