# Direct subscription connection

How this provider talks to the Codex subscription backend, and the guarantees that come with it. [Initial scope](SCOPE.md) owns what the bridge does and does not do. [Compaction design and limits](COMPACTION.md) owns the compaction contract. [The security requirements](../SECURITY.md) own the controls. [The installation guide](INSTALL.md) owns prerequisites and procedures.

## Public surface

The provider registers as `codex-subscription` and accepts no configuration. Any key fails with `CONFIG_INVALID`. No token, endpoint or `.env` credential location is accepted. It declares `maxRetries: 0`, so a failed turn is reported rather than retried silently. The only internal retry is the single bounded full-history resend after an explicit `context_management` parameter rejection, and only while nothing has been delivered to the host. Models come from the account's live catalog with each entry's disclosed context window and reasoning levels. Every model declares `inputModalities: ['text', 'image']`.

## Request flow

A turn projects offloaded images, validates the Harness input into Responses items under retained limits, resolves the selected model through the live catalog, and takes the dedicated token. The catalog is cached in memory for 60 seconds, scoped by credential fingerprint, and revalidated on each lookup and each turn.

When the model discloses a usable context window the request always carries `context_management`. When a proven compaction window covers the history up to an assistant turn, the request replays that window and sends only what this turn appends on top of it. Otherwise the bounded full history is sent.

The request goes to `POST https://chatgpt.com/backend-api/codex/responses` with `store: false`. The SSE response is validated incrementally. Completed message and `function_call` items reconcile against streamed ones. The compaction window plus any compaction marker are published as replay metadata before the turn settles.

## Decision

The provider uses a direct subscription connection. A dedicated device-code OAuth login owns its own token lifecycle, and Codex credentials are never imported. [Initial scope](SCOPE.md) lists the features this covers.

The dedicated login implements OAuth, refresh, and store locking rather than requiring a Codex process for ordinary turns. Importing existing refresh tokens creates a shared rotation family, even when copies live in different files. Dedicated login avoids that coupling.

## Transport

Only `https://auth.openai.com` OAuth/device endpoints and `https://chatgpt.com/backend-api/codex` model/Responses endpoints are used. Redirects are rejected. No custom host, raw token, proxy endpoint, arbitrary request override, shell, or Codex process is accepted in public configuration. The client identifies itself as `dsh-codex-subscription-bridge`, not the official CLI. Account/residency headers are derived from the OAuth token. JWT claims are routing and expiry hints, not signature-verification evidence.

Model catalog compatibility queries use `99.0.0` then `0.0.0` on an empty catalog. These are not claims about an installed CLI version. This provider does not supplement live catalogs with synthetic newer slugs, offline defaults, or large-context aliases.

Each visible entry additionally projects the backend-disclosed `context_window` as the model's `contextWindow` when it is a positive safe integer. It also projects `effective_context_window_percent` as the model's compaction percent when it is a usable percent. A malformed disclosed value fails closed, and an absent value stays omitted. Host context accounting and the compaction threshold therefore use only the backend's own disclosure. The shipped ratio is the fallback for an undisclosed percent.

Every entry also projects the backend-disclosed `supported_reasoning_levels` as the model's reasoning efforts, together with `default_reasoning_level` when it names one of them. The host then offers exactly the levels that model advertises.

Malformed, oversized or duplicate disclosure is omitted rather than guessed. The selected id is forwarded verbatim because the backend, not this bridge, owns the scale.

Text is converted to Responses input. System/developer instructions are separated. `store` is false because the backend requires it and rejects `previous_response_id`, so the backend holds no conversation and the bridge replays what it can prove. Harness tool definitions are validated (names, sizes, JSON object parameters) and forwarded as `function` tools with `strict: false`. The bridge never executes tools. Assistant tool calls are forwarded as `function_call` items and tool results as `function_call_output` items keyed by `call_id`.

Image blocks in user messages are read through the attachment service and sent as `input_image` base64 data URLs. Non-image file attachments never reach the bridge. The Harness runtime projects file blocks to text before every adapter dispatch, so the bridge has no file-attachment support and rejects any file block defensively. Reasoning blocks in replayed history are dropped, following the Harness host convention. Developer-role tool registry blocks are skipped defensively.

SSE accepts bounded text, reasoning/lifecycle metadata, and completed `function_call` items. Non-function execution items, refusals, malformed messages, failed/incomplete responses, and EOF without completion fail closed.

Events the bridge does not consume are ignored rather than failing a turn, because failing a turn for one discards an answer that was already delivered. The consumed set is closed and explicit — `response.output_text.delta`/`.done`, `response.output_item.added`/`.done`, and `response.completed`. Each consumed event is still validated strictly, so those branches remain the only paths that can project text, tool calls or usage. An unrecognized event contributes nothing even when it carries content-shaped fields. `error`, `response.failed`, `response.incomplete` and the refusal events stay fatal, and EOF without completion still fails as `SSE_INCOMPLETE`.

This deliberately does not try to enumerate the backend's notification vocabulary. The reference implementation the verified Harness bundles (`@earendil-works/pi-ai`) dispatches the same consumed set and has no catch-all that fails an unknown event. An allowlist that aborts on anything unrecognized is therefore stricter than the host it feeds; the incidents that established this are recorded in [verification](VERIFICATION.md#notification-events-fail-turns-2026-10-17).

Completed message items also reconcile text when terminal output is null, without duplicating earlier completion events. A completed `function_call` item is reconciled idempotently against streamed tool calls. Matching name and arguments replay is accepted. Anything else fails with a fixed protocol error. Replay metadata is the one exception to failing closed. Because the answer has already been delivered by the time a checkpoint is built, an unprovable compaction window is withheld and logged instead of failing the turn. The streamed completed items — not the terminal array, which the live backend trims — define the output order.

Terminal usage maps Responses' inclusive `input_tokens` to Harness' disjoint prompt buckets: `inputTokens` excludes disclosed `input_tokens_details.cached_tokens`, and `cacheReadTokens` carries that cached count. An absent cached count stays absent and leaves input unchanged; a disclosed count must be a nonnegative safe integer no larger than inclusive input. Output, reasoning and total counts retain their upstream values. This prevents double-counting cached input in host cache-hit and context-pressure accounting.

## Server-side compaction

Server-side compaction is always requested when the selected model discloses a usable context window. The request carries `context_management` with a threshold of `floor(contextWindow × effectivePercent / 100)`. `effectivePercent` is the catalog-disclosed per-model value, an integer from 1 to 100, so it is divided by 100 to get the ratio. The shipped 95% is the fallback for an undisclosed model. The request byte bound is derived from the same window and percent, so the model catalog lookup runs before validation.

The backend requires `store: false` and rejects `previous_response_id`, so no server-side conversation is stored or chained and every turn's input is bounded by the bridge.

The compaction window lives in Harness replay metadata as the bounded wire items the backend returned for one turn. A turn reuses only a window it can prove. A window that cannot be proven is refused rather than trusted and named in the host log. The turn then sends the full bounded history, trimming the oldest items to fit when it exceeds the wire bounds. A tool call and its executed result are dropped as one unit. An image occurrence is never dropped because the host owns the attachment store. A history with nothing left to trim fails with `INPUT_UNSUPPORTED`; only the full-history path after an explicit window refusal reports that failure as `COMPACTION_UNAVAILABLE`. An explicit unsupported-parameter rejection retries once with the bounded full history.

Harness local summaries and token accounting are unchanged by default. The opt-in preset that replaces them for this provider is described in [the installation guide](INSTALL.md#consolidate-on-server-side-compaction-opt-in). The client plugin marks the issuing turn in the chat from the assistant message's client-visible replay metadata. [The compaction contract](COMPACTION.md) owns the request shape, binding, wire bounds, refusal labels and remaining limits.

## Authentication lifecycle

The private dedicated directory is selected from launcher-inherited HOME, not project dotenv. Electron Desktop prefers launcher-owned DSH_HOME when set. Desktop preserves it across its login-shell environment merge. Auth helpers use the same Electron and DSH_HOME. No existing credential file is migrated. Credentials use a versioned ChatGPT-only schema. API keys are not accepted.

Files are bounded to 64 KiB. They are opened without following symlinks and checked for ownership and permissions. They are replaced atomically through private exclusive temporary files after fsync. The directory itself cannot be a symlink. Credential entries are checked before open. They are opened with `O_NOFOLLOW | O_NONBLOCK` and checked again on the descriptor. A FIFO therefore cannot block before file-type validation.

A private directory lock serializes read-refresh-write, explicit login, and logout across processes. Waiters reread the store after acquiring the lock. Refresh begins within 120 seconds of token expiry and checks account continuity. Before dispatch, a durable `refresh_pending` state prevents replay after crashes, lost replies, malformed success responses, or persistence failures.

Only a definite HTTP 429 rejection restores the prior grant for later retry. Successful persistence or explicit new login clears intent. Ambiguous outcomes require reauthentication instead of replaying the old refresh token. Terminal invalid-grant errors quarantine the local grant. Rate limits do not destroy it.

Raw upstream bodies never become errors. A crash after remote refresh but before durable local persistence can still require reauthentication. Durable intent prevents automatic replay. Remote rotation cannot be made locally transactional.

Lock acquisition is bounded to 30 seconds. Login holds its lock while awaiting approval (at most 15 minutes). Concurrent use may return `AUTH_BUSY`. Locks are not automatically stolen, because doing so can allow concurrent refresh.

A crashed owner can leave `auth.lock`. Stop all users of this store before manually removing that directory. A lock disappearing between an unsuccessful acquisition and its metadata check triggers another bounded acquisition attempt. Insecure locks remain rejected. No automatic lock-removal or token-export command exists.

The in-app panel reaches its endpoints through the Host's authenticated API carrier: the existing browser-session fence on Web and the trusted IPC carrier on Desktop. The initiating tab alone receives its one-time code. A random tab identifier may be kept in sessionStorage to recover ownership after reload. No device code or tokens are stored there. Other tabs see only that a login is active.

## Bounds and remaining differences

The following bounds are enforced.

| Area | Bound |
| --- | --- |
| Owned operations | 4 concurrent, including cancellation cleanup |
| Deadlines | Discovery 30 seconds, turn 120 seconds, JSON request timeout 15 seconds |
| JSON/event frames | 1 MiB default; a stream that requests compaction raises the event frame to twice the window bound |
| Aggregate SSE | 4 MiB aggregate and 4096 events by default; with compaction requested the aggregate is three times the raised frame plus the default frame, and the event count is derived from the same frame at a 128-byte envelope estimate, capped at 65536 |
| Output text | 128 blocks, 256 KiB |
| Input items | 1024 wire items, at most 64 blocks per non-tool message; the retained transcript is bounded to 4096 items |
| Tool passthrough | 256 definitions, 256 KiB aggregate, 64-character names in `[A-Za-z0-9_-]`, 8 KiB descriptions, 64 KiB JSON object parameters, 256-byte `call_id` values, 2 MiB tool outputs, 128 tool-update entries |
| Images | 4 MiB pixels, 4096-pixel long edge, 1 MiB per encoded image, 20 MiB aggregate base64 with a 10 MiB quantum, 32 MiB attachment sanity check |

Input text and tool-history bytes are bounded by the disclosed window expressed at a conservative 8 bytes per token, with 256 KiB and 2 MiB kept as the floors when no window is disclosed; the response-side tool-call bound stays 2 MiB. With no disclosed window the derived value equals the combined floor, so text and tool history are each bounded by that same 2.25 MiB combined floor. [The compaction contract](COMPACTION.md#bounds) owns the derived budgets.

That bound is a resource limit for one request, not a guard against rejection. The backend compacts a request whose measured count is past the model window. A request past the window in the bridge's byte estimate is therefore sent as it is.

Oversize in tool passthrough fails closed with fixed limit labels. Oversized image requests fail with `IMAGE_OFFLOAD_REQUIRED` carrying an offload count. The Harness host uses that count to mark its oldest images offloaded and retry. Offloaded images are sent as text placeholders with zero visual tokens.

JSON bodies and SSE framing use fixed buffers and yield to the event loop in bounded batches, so cancellation and deadline timers run. Pre-aborted requests are rejected before store preparation. Cancelled operations retain their admission slot until owned work and cleanup settle. Cancellation aborts transport readers even if a consumer pauses.

Shutdown separately waits for owned authentication/HTTP cleanup and reader cancellation with a five-second bound. Unresponsive cleanup reports TIMEOUT. OAuth body reads preserve caller cancellation and deadline classification across all auth paths.

Successful catalog metadata is cached in memory for 60 seconds, scoped by credential fingerprint. Credentials are checked again on each lookup and each turn.

In-app login requests use four exact POST endpoints on Connection's authenticated carrier. The sole Typert Gateway interceptor is preserved. Body parsing is bounded to 4 KiB. Request deadlines are five seconds. Responses are no-store. Admission is bounded to four. Account mutations are serialized.

The initial login path is device code only. Reasoning effort is validated to a bounded id and forwarded verbatim as Responses `reasoning.effort`. The host offers exactly the levels the selected model's backend disclosure advertises.

`temperature` is validated to a finite 0–2 number and forwarded. `maxTokens` is validated to a safe integer 1–1,000,000 and accepted as an advisory budget, but deliberately not forwarded. `stop` sequences are rejected with fixed `UNSUPPORTED_OPTION` labeling.

HTTP 429 responses are classified from a bounded error body. A recognized plan usage limit (`usage_limit_reached`, `usage_not_included`, or a dsh-llm quota match) becomes terminal `QUOTA`. It optionally carries a reset hint derived only from a validated `resets_at` integer (at most one week, clamped). Any other body, an unusable body, or a non-usage code stays transient `RATE_LIMIT`.

The hint is the only message part derived from upstream data. Upstream text is never copied into errors.

Image acceptance on the subscription backend rests on the owner's reported pass, not on a measured record; [the verification record](VERIFICATION.md#real-account-evidence-and-limits) states which passes were reported and which were measured. Vision-token accounting, per-model entitlement, and upstream acceptance of `temperature` on the subscription backend remain unverified.

Real-account evidence and its limits are recorded in [verification](VERIFICATION.md). Direct connection is not evidence of official third-party service support or absence of vulnerabilities.

## Safe diagnostics

Errors retain their existing fixed codes and append only allowlisted stage labels such as `[SSE_FRAME]`, `[SSE_TERMINAL]`, or `[AUTH_REFRESH_UNCERTAIN]`. Unknown labels, upstream messages, event names, credentials and identifiers are never copied into diagnostics. Failure payloads are reconstructed from the allowlists even if an Error message was mutated. Empty string text deltas are valid no-op text updates; non-string and oversized deltas remain invalid.

## Transport dependencies

HTTP uses bundled Undici 7.29.1 and an explicit owned Agent, so the host's older fetch implementation and shared dispatcher are never used. Host dispatcher or proxy overrides are not inherited. These fixed HTTPS destinations must be reachable directly. This does not patch Electron/Chromium or other host features. [Prerequisites and the verified runtime pair](INSTALL.md#support-and-prerequisites).
