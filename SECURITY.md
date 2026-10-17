# Security requirements

## Trust and credential ownership

The direct adapter holds a dedicated ChatGPT OAuth login. It never reads, imports, updates, or deletes Codex credentials.

The plugin, Harness, Node runtime, OS, and processes running as the same OS user remain trusted. Desktop admission does not patch or audit all Electron/Chromium or other Harness features. Dedicated file permissions are not encryption or protection against that same user. The initial store is plaintext; keyring is not included.

## Required controls

- Use fixed HTTPS destinations and reject redirects and endpoint overrides.
- Use pinned bundled Undici with an owned dispatcher, independent of host fetch.
- Accept only a dedicated OAuth grant; reject raw keys and configuration tokens.
- Keep tokens out of diagnostics, profile YAML, package output, logs, and browser storage.
- Reveal a one-time sign-in code only after explicit login, to its initiating UI or the explicitly invoked CLI; never return access/refresh tokens to the client.
- Use authenticated Connection routes for UI actions, preserve the Gateway, disable response caching, bound payloads, and join login work during disposal.
- Validate private file ownership, modes, symlinks, shape, and size.
- Serialize credential update, login and logout with a process-shared lock.
- Persist rotated credentials atomically; quarantine terminal invalid grants.
- Reread authentication on metadata cache hits and before model dispatch.
- Bound requests, input/output, frames, queues, and waiting periods.
- Cancel network readers on abort, timeout, shutdown and generator retirement.
- Send only the selected model id, separated developer instructions, validated text, tool definitions, executed tool-call history, user image data URLs, validated `temperature`, the reasoning effort the model disclosed, and bounded opaque compaction windows; never execute tools in the bridge; use no resumed server IDs and `store: false`.
- Reject malformed, non-function execution items, failed, or incomplete streams. Ignore only the reviewed, content-free notification events listed in the adapter, and never echo an unrecognized upstream event type: the fixed error that reports one carries no field value or type name from the response.
- Treat replay metadata as optional: a compaction window that cannot be proven is withheld and logged instead of failing a turn whose answer was already delivered, and a refusal label comes only from the bridge-owned vocabulary. Reuse still requires every binding check, so an unproven window trims nothing.
- Classify HTTP 429 bodies within a bounded read: a recognized plan usage limit becomes terminal `QUOTA` whose only upstream-derived part is a reset hint computed from a validated integer (at most one week); upstream text, `plan_type`, and unrecognized bodies never reach error messages, which fall back to fixed `QUOTA`/`RATE_LIMIT` wording.

Compaction checkpoints are conversation state, not OAuth credentials. They persist only in Harness assistant replay metadata and inherit the host session storage/export access boundary. Treat them as sensitive opaque content and keep them out of diagnostics: only a refusal label from the fixed bridge-owned vocabulary may reach the host log, never opaque content, prefixes or hashes. Integrity hashes detect inconsistency, not tampering by trusted local code, and disabling host summarization or weakening wire limits is not an acceptable way to recover an invalid checkpoint. [The compaction contract](docs/COMPACTION.md) records binding, expiration and schema rules.

The opt-in compaction backend replaces a stock host plugin, so it couples to a host-internal class and a Harness upgrade can break that preset alone. It ships as a preset row inserted disabled and enabled by an operator through a single id-keyed profile-patch entry (the Plugins page lists the row but refuses to address it), so the default installation never selects it; it delegates every other provider to the stock implementation and neither reads nor changes credentials. [The installation guide](docs/INSTALL.md#consolidate-on-server-side-compaction-opt-in) records the procedure and the failure modes.

## Verification boundary

All normal tests use disposable stores and in-memory HTTPS fixtures. No real OAuth flow, refresh, subscription request, or normal-profile installation is included. Each real account activity requires explicit authorization.

Real-account evidence and its limits are recorded in [verification](docs/VERIFICATION.md). No finite audit proves absence of unknown vulnerabilities. See [architecture and limits](docs/ARCHITECTURE.md).

## Reporting a problem

Report every problem, including vulnerabilities, as a GitHub Issue in this repository. Issues are the reporting channel for this project, which publishes no private-reporting address or security email of its own.

Never include credentials, device codes, authentication files, or raw authenticated responses in issues or pull requests. Share only sanitized reproduction steps, fixed diagnostic labels, and runtime/version information.

For an exploitable vulnerability without a released fix, keep the issue to the minimum detail needed to reproduce it, and say that the report describes an unpatched issue so it can be prioritized. Once a fixed release is published, full detail is welcome.

Pull requests that fix a reported problem directly are welcome. Reports are confirmed, fixed, released, and only then discussed in public detail; please do not publish unpatched issues elsewhere before that fix is available.

## Supported versions

| Version | Supported |
| --- | --- |
| `0.0.x` prototype on `main` | yes |
| `v0.0.1`, `v0.0.2` | no — install the current release |

## Scope

In scope: this repository's plugin source, authentication CLI, bundled client, the installer scripts (`install.sh` and `scripts/`), and the dedicated credential store — `$HOME/.dsh-codex-subscription-bridge` for a standalone CLI or Web profile, `$DSH_HOME/.dsh-codex-subscription-bridge` for a Desktop profile.

Out of scope: DeepSeek Harness itself, the OpenAI/ChatGPT/Codex services and their infrastructure, the bundled dependency versions as shipped by their own projects, and any host outside the documented installation surfaces. Report problems in those systems to the corresponding projects.
