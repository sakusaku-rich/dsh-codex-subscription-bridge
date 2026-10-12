# Security requirements

## Trust and credential ownership

The direct adapter holds a dedicated ChatGPT OAuth login. It never reads, imports, updates, or deletes Codex credentials.

The plugin, Harness, Node runtime, OS, and processes running as the same OS user remain trusted. Desktop admission does not patch or audit all Electron/Chromium or other Harness features. Dedicated file permissions are not encryption or protection against that same user. The initial store is plaintext; keyring is not included.

## Required controls

- Use fixed HTTPS destinations and reject redirects and endpoint overrides.
- Use pinned bundled Undici with an owned dispatcher, independent of host fetch.
- Accept only a dedicated OAuth grant; reject raw keys and configuration tokens.
- Keep tokens out of diagnostics, profile YAML, package output, and logs.
- Reveal a one-time sign-in code only after explicit login, to its initiating UI or the explicitly invoked CLI; never return access/refresh tokens to the client.
- Use authenticated Connection routes for UI actions, preserve the Gateway, disable response caching, bound payloads, and join login work during disposal.
- Validate private file ownership, modes, symlinks, shape, and size.
- Serialize credential update, login and logout with a process-shared lock.
- Persist rotated credentials atomically; quarantine terminal invalid grants.
- Reread authentication on metadata cache hits and before model dispatch.
- Bound requests, input/output, frames, queues, and waiting periods.
- Cancel network readers on abort, timeout, shutdown and generator retirement.
- Send only validated text, tool definitions, executed tool-call history, user image data URLs, and validated `temperature`; never execute tools in the bridge; use no resumed server IDs and `store: false`.
- Reject malformed, non-function execution items, failed, or incomplete streams.
- Classify HTTP 429 bodies within a bounded read: a recognized plan usage limit becomes terminal `QUOTA` whose only upstream-derived part is a reset hint computed from a validated integer (at most one week); upstream text, `plan_type`, and unrecognized bodies never reach error messages, which fall back to fixed `QUOTA`/`RATE_LIMIT` wording.

## Verification boundary

All normal tests use disposable stores and in-memory HTTPS fixtures. No real OAuth flow, refresh, subscription request, or normal-profile installation is included. Each real account activity requires explicit authorization.

The owner confirmed dedicated login and model selection; authorized diagnostics received a real SSE-framed response. Successful generation through the current adapter, real tool-call and image turns against the subscription backend, real refresh/revocation and complete Web behavior remain unverified. No finite audit proves absence of unknown vulnerabilities. See [design and limits](docs/DIRECT.md).

## Reporting a problem

Report every problem, including vulnerabilities, as a GitHub Issue in this repository. Issues are the single reporting channel for this project; no private vulnerability reporting address or email exists.

Never include credentials, device codes, authentication files, or raw authenticated responses in issues or pull requests. Share only sanitized reproduction steps, fixed diagnostic labels, and runtime/version information.

For an exploitable vulnerability without a released fix, keep the issue to the minimum detail needed to reproduce it, and say that the report describes an unpatched issue so it can be prioritized. Once a fixed release is published, full detail is welcome.

Pull requests that fix a reported problem directly are welcome. Reports are confirmed, fixed, released, and only then discussed in public detail; please do not publish unpatched issues elsewhere before that fix is available.

## Supported versions

| Version | Supported |
| --- | --- |
| `0.0.x` prototype on `main` | yes |
| Older or published releases | none exist |

## Scope

In scope: this repository's plugin source, authentication CLI, bundled client, and the dedicated credential store under `~/.dsh-codex-subscription-bridge`.

Out of scope: DeepSeek Harness itself, the OpenAI/ChatGPT/Codex services and their infrastructure, the bundled dependency versions as shipped by their own projects, and any host outside the documented installation surfaces. Report problems in those systems to the corresponding projects.
