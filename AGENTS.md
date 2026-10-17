# Development instructions

## Language

Use English for repository content: source code, comments, documentation, tests, diagnostics, commit messages, issues, and pull requests. Do not add translated copies unless the owner explicitly requests them. Conversations with the owner may use their preferred language.

## Scope

Read [docs/SCOPE.md](docs/SCOPE.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), and [SECURITY.md](SECURITY.md) before implementation. The owner authorized direct Codex subscription HTTPS access with dedicated OAuth. Keep the feature set to what `docs/SCOPE.md` lists; that document is the single description of what this bridge does and does not do.

## Credential and transport handling

Follow [the security requirements](SECURITY.md#required-controls); they are the canonical list. The rules an agent must not forget while changing this repository:

- Never import, read, change, or log Codex credential files.
- Never accept raw credentials, custom endpoints, or a paid API route.
- Never execute tools in the bridge; forward only validated tool definitions, executed tool-call history, user image blocks, and bounded opaque compaction windows.
- Do not resume server IDs or persist server-resident conversations. Store a compaction window only in Harness replay metadata under the controls in [docs/COMPACTION.md](docs/COMPACTION.md).

## Git workflow

Fetch current remote references and use a task-specific worktree based on remote main. Do not edit files on the default branch. Split independent changes into reviewable commits and use English Conventional Commit messages.

Do not create pull requests, publish packages, change account authentication, or install into a normal Harness profile without the owner's explicit instruction.

## Verification

Use synthetic credentials and in-memory HTTPS fixtures in normal tests. Never make paid model calls or use the owner's existing authentication in automated tests. Pin supported Harness and dependency versions before implementing their integration. Keep source, packaged artifacts, and documented behavior consistent, and state what is verified and what is not as [the security requirements](SECURITY.md#verification-boundary) require.
