# Security requirements

## Trust and credential ownership

The direct adapter holds a dedicated ChatGPT OAuth login. It never reads, imports,
updates, or deletes Codex/Hermes credentials.

The plugin, Harness, Node runtime, OS, and processes running as the same OS user
remain trusted. Dedicated file permissions are not encryption or protection
against that same user. The initial store is plaintext; keyring is not included.

## Required controls

- Use fixed HTTPS destinations and reject redirects and endpoint overrides.
- Accept only a dedicated OAuth grant; reject raw keys and configuration tokens.
- Keep tokens out of diagnostics, profile YAML, package output, and logs.
- Print a one-time device code only in the explicitly invoked login command.
- Validate private file ownership, modes, symlinks, shape, and size.
- Serialize credential update, login and logout with a process-shared lock.
- Persist rotated credentials atomically; quarantine terminal invalid grants.
- Reread authentication on metadata cache hits and before model dispatch.
- Bound requests, input/output, frames, queues, and waiting periods.
- Cancel network readers on abort, timeout, shutdown and generator retirement.
- Send text only, no tools, no resumed server IDs, and `store: false`.
- Reject malformed, execution-bearing, failed, or incomplete streams.

## Verification boundary

All normal tests use disposable stores and in-memory HTTPS fixtures. No real
OAuth flow, refresh, subscription request, or normal-profile installation is
included. Each real account activity requires explicit authorization.

The owner confirmed dedicated login and model selection; authorized diagnostics
received a real SSE-framed response. Successful generation through the current
adapter, real refresh/revocation and complete Web behavior remain unverified.
No finite audit proves absence of unknown vulnerabilities. See [design and limits](docs/DIRECT.md).

## Reporting

Never include credentials, device codes, or raw authenticated responses in a
public issue. Agree on a private reporting channel before distribution.
