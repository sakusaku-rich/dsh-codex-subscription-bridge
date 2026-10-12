# Development instructions

## Language

Use English for repository content: source code, comments, documentation, tests, diagnostics, commit messages, issues, and pull requests. Do not add translated copies unless the owner explicitly requests them. Conversations with the owner may use their preferred language.

## Scope

Read [docs/SCOPE.md](docs/SCOPE.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), and [SECURITY.md](SECURITY.md) before implementation. The owner authorized direct Codex subscription HTTPS access with dedicated OAuth. Keep the initial feature set limited to model selection, streamed text conversations with validated tool passthrough and user image input, and cancellation.

## Credential and transport handling

- Only the dedicated authentication module owns OAuth storage and refresh.
- Never import, read, change, or log Codex credential files.
- Never accept raw credentials or custom endpoints in plugin configuration.
- Reject API-key authentication and never switch to paid API routes.
- Use fixed HTTPS destinations, reject redirects, and return safe fixed errors.
- Serialize refresh/login/logout and enforce private file ownership/modes.
- Bound network operations and text/protocol sizes; cancel paused readers.
- Never execute tools in the bridge; forward only validated tool definitions, executed tool-call history, and user image blocks.
- Do not resume server IDs or persist server conversations.

## Git workflow

Fetch current remote references and use a task-specific worktree based on remote main. Do not edit files on the default branch. Split independent changes into reviewable commits and use English Conventional Commit messages.

Do not create pull requests, publish packages, change account authentication, or install into a normal Harness profile without the owner's explicit instruction.

## Verification

Use synthetic credentials and in-memory HTTPS fixtures in normal tests. Never make paid model calls or use the owner's existing authentication in automated tests. Pin supported Harness and dependency versions before implementing their integration. Keep source, packaged artifacts, and documented behavior consistent. Report unverified behavior and remaining security risks explicitly.
