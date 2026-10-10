# Development instructions

## Language

Use English for repository content: source code, comments, documentation, tests,
diagnostics, commit messages, issues, and pull requests. Do not add translated
copies unless the owner explicitly requests them. Conversations with the owner
may use their preferred language.

## Scope

Read [docs/MVP.md](docs/MVP.md) and [SECURITY.md](SECURITY.md) before implementation.
The project connects DeepSeek Harness to an existing Codex ChatGPT subscription
login through the official local Codex app-server. Keep the initial feature set
limited to model selection, streamed text conversations, and cancellation.

## Credential handling

- Codex owns login, credential storage, and token refresh.
- Never read, copy, import, modify, or log Codex credential files or token values.
- Never implement custom OAuth or accept raw credentials as plugin configuration.
- Reject API-key authentication; do not silently switch to a paid API route.
- Use only local stdio JSON-RPC. Do not expose a network listener for the bridge.
- Discard upstream diagnostic bodies; use fixed messages and safe error codes.

## Process and authority

- Require a trusted absolute Codex executable path. Never launch a shell.
- Minimize the child environment and validate protocol messages at runtime.
- Bound messages, queues, request lifetimes, turns, and process shutdown.
- Do not assume that a read-only sandbox prevents private file reads.
- Prove native Codex tool restrictions before accepting real conversation input.
- Do not resume a thread ID obtained from inherited Harness history.
- Resolve effective permissions for every request; reject unsupported policies.

## Git workflow

Fetch current remote references and use a task-specific worktree based on remote
main. Do not edit files on the default branch. Split independent changes into
reviewable commits and use English Conventional Commit messages.

Do not create pull requests, publish packages, change account authentication, or
install into a normal Harness profile without the owner's explicit instruction.

## Verification

Use synthetic credentials and fake app-server processes in normal tests. Never
make paid model calls or use the owner's existing authentication in automated
tests. Pin supported Harness, Codex, and dependency versions before implementing
their integration. Keep source, packaged artifacts, and documented behavior
consistent. Report unverified behavior and remaining security risks explicitly.
