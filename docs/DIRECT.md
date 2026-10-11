# Direct subscription connection

## Decision and source

The provider uses a Hermes-style direct subscription connection. The dedicated
device-code OAuth login owns its own token lifecycle;
Codex credentials are not imported. Initial features remain model selection,
text conversations, streaming, and cancellation.

Reference: [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent/tree/d4d2ab7b5d104166e7e22a02cafd12f1fe456a31),
commit `d4d2ab7b5d104166e7e22a02cafd12f1fe456a31`.
Reviewed modules: `hermes_cli/auth_codex.py`, `auth_constants.py`,
`codex_models.py`, `agent/codex_headers.py`, `model_metadata.py`, and
`agent/transports/codex.py`. The reference is MIT-licensed. This JavaScript
implementation is independently written; it does not vendor Hermes code.

Hermes implements OAuth, refresh and store locking rather than requiring a Codex
process for ordinary turns. Importing existing refresh tokens creates a shared
rotation family,
even when copies live in different files; dedicated login avoids that coupling.

## Transport

Only `https://auth.openai.com` OAuth/device endpoints and
`https://chatgpt.com/backend-api/codex` model/Responses endpoints are used.
Redirects are rejected. No custom host, raw token, proxy endpoint, arbitrary
request override, shell, or Codex process is accepted in public configuration.
The client identifies itself as `dsh-codex-subscription-bridge`, not Hermes or
the official CLI. Account/residency headers are derived from the OAuth token;
JWT claims are routing and expiry hints, not signature-verification evidence.

Model catalog compatibility queries use `99.0.0` then `0.0.0` on an empty
catalog, following Hermes's pinned selectors. These are not claims about an
installed CLI version. Unlike Hermes, this provider does not supplement live
catalogs with synthetic newer slugs, offline defaults, or large-context aliases.
Do not claim all ChatGPT models are available.

Text is converted to Responses input. System/developer instructions are
separated, tools are omitted, and `store` is false. SSE accepts bounded text and
reasoning/lifecycle metadata; execution items, refusals, malformed messages,
failed/incomplete responses, and EOF without completion fail closed. Completed
message items also reconcile text when terminal output is null, without
duplicating earlier completion events.

## Authentication lifecycle

The private dedicated directory is selected from launcher-inherited HOME,
not project dotenv. Credentials use a versioned ChatGPT-only schema. API keys
are not accepted. Files are bounded to 64 KiB, opened without following symlinks,
checked for ownership and permissions, and replaced atomically through private
exclusive temporary files after fsync. The directory itself cannot be a symlink. Credential entries are checked before
open, opened with `O_NOFOLLOW | O_NONBLOCK`, and checked again on the descriptor,
so a FIFO cannot block before file-type validation.

A private directory lock serializes read-refresh-write, explicit login, and
logout across processes. Waiters reread the store after acquiring the lock.
Refresh begins within 120 seconds of token expiry and checks account continuity.
Before dispatch, a durable `refresh_pending` state prevents replay after
crashes, lost replies, malformed success responses, or persistence failures.
Only a definite HTTP 429 rejection restores the prior grant for later retry.
Successful persistence or explicit new login clears intent. Ambiguous outcomes
require reauthentication instead of replaying the old refresh token.
Terminal invalid-grant errors quarantine the local grant; rate limits do not
destroy it. Raw upstream bodies never become errors.
A crash after remote refresh but before durable local persistence can still
require reauthentication; durable intent prevents automatic replay, but remote
rotation cannot be made locally transactional.

Lock acquisition is bounded to 30 seconds. Login holds its lock while awaiting
approval (at most 15 minutes); concurrent use may return `AUTH_BUSY`. Locks are
not automatically stolen, because doing so can allow concurrent refresh. A
crashed owner can leave `auth.lock`: stop all users of this store before manually
removing that directory. A lock disappearing between an unsuccessful acquisition
and its metadata check triggers another bounded acquisition attempt. Insecure
locks remain rejected. No automatic lock-removal or token-export command exists.

## Bounds and remaining differences

Four concurrent owned operations (including cancellation cleanup), 30-second discovery deadline, 120-second turn
deadline, 15-second JSON request timeout, 1 MiB JSON/event frames, 4 MiB aggregate
SSE, 4096 SSE frames, 128 output text blocks, 128 input messages with at most
64 blocks each, and 256 KiB input/output text are enforced. JSON bodies use one
fixed payload buffer and yield after bounded byte/read work, including empty
fragments, so cancellation and deadline timers can run.
Pre-aborted requests are rejected before store preparation. Cancelled operations
retain their admission slot until owned work and cleanup settle. SSE framing is
incremental, using a fixed frame buffer and bounded byte/read work batches with
event-loop yields for cancellation. Cancellation aborts transport readers even
if a consumer pauses. Shutdown
separately waits for owned authentication/HTTP cleanup and reader cancellation
with a five-second bound; unresponsive cleanup reports TIMEOUT. OAuth body reads
preserve caller cancellation and deadline classification across all auth paths. Successful
catalog metadata is cached in memory for 60 seconds, scoped by credential
fingerprint; credentials are checked again on each lookup and each turn.

The initial login path is device code only. Browser PKCE fallback, keyring,
credential pools, token import, tools, reasoning controls, quota display, and
Hermes's provider overrides are not included. These exclusions keep the implementation
reviewable and avoid copying Hermes's entire runtime.

The owner confirmed dedicated login and model selection; authorized diagnostics
confirmed an authenticated catalog and SSE-framed response. Successful generation
through the current adapter, real token refresh/revocation, rate-limit semantics,
model entitlement, and performance remain unverified. Direct connection is not
evidence of official third-party service support or absence of vulnerabilities.


## Safe diagnostics

Errors retain their existing fixed codes and append only allowlisted stage labels
such as `[SSE_FRAME]`, `[SSE_EVENT_UNSUPPORTED]`, `[SSE_TERMINAL]`, or
`[AUTH_REFRESH_UNCERTAIN]`. Unknown labels, upstream messages, event names,
credentials and identifiers are never copied into diagnostics. Failure payloads
are reconstructed from the allowlists even if an Error message was mutated.
Empty string text deltas are valid no-op text updates; non-string and oversized
deltas remain invalid.


## Security-fixed Node baseline

Node 22.23.3 is the verified baseline (Undici 6.28.1, OpenSSL 3.5.8). Both manifests,
lockfiles, and development version files specify the updated Node requirement.
The public adapter and authentication CLI reject older/unverified runtimes.
The owner's temporary profile uses a dedicated official macOS arm64 binary;
its SHA-256 was checked against the official release value
`23b25245dcfb9af7262f8ff142e9e2e0af025368117329e7a7458a51e5922f53`.
No global Node installation or existing account store was migrated.
[Official release](https://nodejs.org/en/blog/release/v22.23.3).
