# Direct subscription connection

## Decision and source

The owner authorized replacing app-server integration with a Hermes-style direct
provider. The dedicated device-code OAuth login owns its own token lifecycle;
Codex credentials are not imported. Initial features remain model selection,
text conversations, streaming, and cancellation.

Reference: [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent/tree/d4d2ab7b5d104166e7e22a02cafd12f1fe456a31),
commit `d4d2ab7b5d104166e7e22a02cafd12f1fe456a31`.
Reviewed modules: `hermes_cli/auth_codex.py`, `auth_constants.py`,
`codex_models.py`, `agent/codex_headers.py`, `model_metadata.py`, and
`agent/transports/codex.py`. The reference is MIT-licensed. This JavaScript
implementation is independently written; it does not vendor Hermes code.

Hermes implements OAuth, refresh and store locking rather than requiring a Codex
process for ordinary turns. Its optional app-server runtime is a different
integration. Importing existing refresh tokens creates a shared rotation family,
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
failed/incomplete responses, and EOF without completion fail closed.

## Authentication lifecycle

The private dedicated directory is selected from launcher-inherited HOME,
not project dotenv. Credentials use a versioned ChatGPT-only schema. API keys
are not accepted. Files are bounded to 64 KiB, opened without following symlinks,
checked for ownership and permissions, and replaced atomically through private
exclusive temporary files after fsync. The directory itself cannot be a symlink.

A private directory lock serializes read-refresh-write, explicit login, and
logout across processes. Waiters reread the store after acquiring the lock.
Refresh begins within 120 seconds of token expiry and checks account continuity.
Terminal invalid-grant errors quarantine the local grant; rate limits and
transient failures do not destroy it. Raw upstream bodies never become errors.
A crash after remote refresh but before durable local persistence can still
require reauthentication; remote rotation cannot be made locally transactional.

Lock acquisition is bounded to 30 seconds. Login holds its lock while awaiting
approval (at most 15 minutes); concurrent use may return `AUTH_BUSY`. Locks are
not automatically stolen, because doing so can allow concurrent refresh. A
crashed owner can leave `auth.lock`: stop all users of this store before manually
removing that directory. No automatic lock-removal or token-export command exists.

## Bounds and remaining differences

Four concurrent HTTP operations, 30-second discovery deadline, 120-second turn
deadline, 15-second JSON request timeout, 1 MiB JSON/event frames, 4 MiB aggregate
SSE, 4096 SSE frames, 128 text blocks, and 256 KiB input/output text are enforced.
Cancellation aborts transport readers even if a consumer pauses. Successful
catalog metadata is cached in memory for 60 seconds, scoped by credential
fingerprint; credentials are checked again on each lookup and each turn.

The initial login path is device code only. Browser PKCE fallback, keyring,
credential pools, token import, tools, reasoning controls, quota display, and
Hermes's provider overrides are not included. These exclusions keep the migration
reviewable and avoid copying Hermes's entire runtime.

Real endpoint acceptance, dedicated OAuth, token refresh/revocation, rate-limit
semantics, newer model entitlement, and performance are unverified. Direct
connection is not evidence of official third-party service support or absence
of vulnerabilities. Historical app-server authority evidence is not applicable
to this transport.
