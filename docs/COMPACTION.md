# Subscription server-side compaction

## Decision and research

The bridge implements inline server-side compaction on its existing fixed
subscription Responses endpoint. Harness local summarization stays in place by
default; an opt-in profile composition replaces it for this provider alone, so
Codex can own condensation without changing the stock installation.

The baseline `ea7abda40362be71080d36b527283304159b2958` did not send
`context_management`, rejected compaction output items, and did not emit replay
metadata. Its existing compaction evidence was for Harness text summarization.

[OpenAI's compaction guide](https://developers.openai.com/api/docs/guides/compaction)
describes inline `context_management`, encrypted output items, and stateless
input-array chaining with `store: false`. That public API documentation is not a
guarantee of subscription-route availability. The
[reference plugin v2.5.9](https://github.com/WSL043/dsh-codex-subscription/blob/v2.5.9/src/subscription-compaction.js)
uses this mechanism on `/backend-api/codex/responses`. A real subscription
session has since confirmed both halves: the route issued an encrypted compaction
item once the request passed the 32,768-token threshold, and the next request
that echoed it back was priced at 11,787 input tokens instead of the 38,612 the
same transcript had just cost. See [the verification record](VERIFICATION.md).

[Reference issue #152](https://github.com/WSL043/dsh-codex-subscription/issues/152)
was closed without eliminating duplicate summaries. Its maintainer reported that
suppressing local pressure compaction let the retained transcript grow beyond
the model window, making model-switch recovery fail. Those experiments are the
maintainer's evidence, not measurements from this implementation.

Harness 0.2.0-rc.2 has the necessary
[replay envelope](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/llm/llm/src/assembler.ts),
but its [token meter](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/llm/token-meter/src/index.ts)
can prefer the full history estimate over a smaller provider usage report.
Therefore cloud checkpoints and local summaries can both run by default: the
meter prices the retained local surface, so the host still reaches its own
threshold even when the wire request is compacted. This implementation does not
patch the meter, change another provider, or inflate the model's disclosed window.
The opt-in backend below replaces the host's automatic condensation for its own
routes only; eliminating duplicate summarization in the default composition would
need host recovery work, such as bounded chunked summarization.

## Enablement and request shape

Server-side compaction is always requested; the adapter has no configuration
keys. Route compatibility cannot be checked locally, so the request is issued
unconditionally and an explicit unsupported-parameter rejection falls back once
to the original bounded request (see below).

With a disclosed context window of at least 2048 tokens, the request includes
`context_management: [{ type: 'compaction',
compact_threshold: min(32768, floor(contextWindow / 2)) }]`. The conservative
32768-token ceiling leaves room under the independent text byte budget; it does
not guarantee that every input fits. There is no tokenizer-based size guarantee.
Without a usable disclosed window, ordinary bounded requests continue without
cloud compaction. No user-supplied threshold, destination, credentials, API-key
route, `previous_response_id`, or standalone compact endpoint is introduced.

## Replacing local condensation (opt-in)

A profile can replace the stock `compaction-basic` row with the module this
package exports as `dsh-codex-subscription-bridge/compaction`. The replacement
extends the host engine and returns without condensing whenever the durable
routed request belongs to `codex-subscription`; every other provider is delegated
to the stock implementation unchanged, so the composition is route-scoped in
behavior even though the row is profile-wide. [The installation guide](INSTALL.md)
records the patch shape, the post-mount checks and the failure modes.

The pinned Harness does not let this composition take effect. Its
`@deepseek-ai/dsh-web-app` bundle disables the top-level `compaction-basic` and
`command-compact` rows and declares the backend inside each agent preset instead,
in an isolated `compaction` group, and a profile patch cannot reach an entry
nested in a preset's `plugins` list. The module and its tests stay, but shipping
the opt-in needs a preset-level definition whose `plugins` list is version-coupled
to the Harness release. [The verification record](VERIFICATION.md) has the
evidence, including the `insert:` syntax a new profile row requires.

This is deliberately not the default bundle behavior. The module subclasses a
host-internal class, which is a compatibility dependency the bridge otherwise
avoids: if that package disappears the replacement fails to load and no backend
is mounted, and if the reconciled method changes shape the override silently
degrades to the stock behavior instead of breaking. Operators who mount it accept
that coupling; the default installation keeps the stock backend and the duplicate
summarization described above.

While the replacement is mounted, no local summary bounds the transcript, so the
refusal and wire-budget behavior below is the only remaining recovery path.

## State and validation

- Only successfully completed responses can publish replay metadata. Cancelled,
  failed, malformed and incomplete responses cannot publish a checkpoint.
- The latest compaction item and subsequent allowlisted output items form the
  next wire window. Subsequent text, reasoning metadata and function calls are
  retained; tools are never executed by this bridge.
- The streamed completed items are the authoritative output order. The live
  route omits items from `response.completed.response.output` — observed as a
  missing index once a real compaction was issued — so positional agreement with
  that array is not required. A terminal compaction item that exists and
  disagrees with the streamed one is still treated as a contradiction.
- An unprovable window is never published, and never fails the turn: the answer
  has already been delivered by then, so the first refusal label is logged and
  the bounded local history is resent instead. Refusals name their own stage
  (`ITEM_*`, `MSG_*`, `SUM_*`, `WINDOW_*`, `INDEX_GAP`, `NO_ORDER`,
  `OBSERVE_DUPLICATE`, `COMPACTION_MISMATCH`, `CONTENT_MISMATCH`) from a
  bridge-owned vocabulary, so no response value reaches the log.
- Harness stores the bounded opaque window in the assistant message's
  `source.replayState.response.subscriptionCompactionV1`. The normal transcript
  stays intact. No separate bridge checkpoint file or process-global cache exists.
- Reuse binds to a hash of dedicated account routing headers and available
  subject/user claims, model, developer
  instructions and tool definitions, plus exact normalized input-prefix and
  assistant-content hashes. The newest checkpoint must match; older checkpoints
  are not searched as a fallback. Refresh with unchanged account routing does not
  itself invalidate it. Account/model changes, edits, local summarization, image
  offload changes and changed tools/instructions can invalidate it.
- Checkpoints expire after 24 hours, a conservative local policy, not a claimed
  backend expiration guarantee. Future timestamps and malformed/digest-mismatched
  metadata are rejected for reuse. Hashes detect inconsistency, not malicious
  forgery by trusted same-user code. Opaque content is never decoded or logged.

## Bounds and fallback

Checkpoint wire items are capped at 512 KiB and 128 items. Existing SSE frame,
aggregate response, timeout, admission and cancellation bounds still apply.
The retained-history first pass allows at most 4096 messages, 4 MiB of text and
16 MiB of tool call/result text, so a checkpoint can replace an oversized covered
prefix. The actual compacted wire request still has the original 256 KiB text,
2 MiB tool-history and 1024-item bounds, plus the separate checkpoint budget, and
the ordinary limits are reapplied whenever no checkpoint is selected. Covered
images are not read or resent; uncovered images use the existing attachment and
offload budgets.

If no valid checkpoint exists, the original full-history limits are reapplied.
The newest persisted checkpoint is inspected on its own, and a refusal is named
in the host log (`SHAPE`, `METADATA`, `EXPIRED`, `SCOPE`, `PREFIX`, `CONTENT`,
`DIGEST` or `INVALID`) so a model switch, expiry or edited history stays
distinguishable without logging opaque state. When a refusal leaves the full local
history past the wire bounds, the turn fails with `COMPACTION_UNAVAILABLE` and
asks for a new conversation rather than reporting the generic shape error.
An HTTP 400/422 with a bounded structured error naming `context_management` and
`unsupported_parameter` or `unknown_parameter` permits exactly one retry with
ordinary, fully validated history and without the compaction parameter. There is no
retry after partial output, arbitrary 400 errors, quota/authentication failures,
network ambiguity or stream failure. An unrecognized checkpoint rejection is a
safe fixed failure, not an automatic retry with potentially oversized history.

Fallback cannot guarantee recovery when retained history already exceeds local
wire bounds or the model window. The bridge refuses rather than silently
truncating, raising limits, or sending an oversized fallback. Keep Harness local
summarization enabled. Even that does not guarantee it runs before this bridge's
byte limits, because the host measures tokens, not UTF-8 bytes. Long-lived
checkpoint-independent recovery remains an explicitly unresolved limitation.

## Verification and remaining work

Synthetic tests cover public Harness runtime dispatch, its actual block
assembler, JSON persistence/replay, repeated turns, post-compaction tool results,
history/account/model/instruction/tool invalidation, age checks, malformed and
oversized items, terminal contradictions, missing tail items, cancellation,
covered images, wire budgets, and the narrowly scoped parameter-rejection retry.
`test/compaction-backend.test.mjs` pins the host engine class and checks that the
opt-in backend skips only this provider, delegates every other route, survives a
missing route or session, and names each refusal label. The packaged module is
included in the normal tarball composition checks.

Automated tests make no real authentication or subscription calls. A manually
driven Desktop session confirmed real checkpoint issuance and reuse on a
dedicated login; checkpoint expiry, model switches, cancellation during
compaction, backend rejection shapes, supported models, latency, quota impact and
long-run interaction with normal host thresholds remain unverified. The opt-in
profile composition itself was exercised only at the module boundary against the
pinned `@deepseek-ai/dsh-compaction-basic`; the disable-and-insert patch was not
mounted in a running Harness.

After separate authorization, use an isolated profile and dedicated login for a
bounded service experiment: verify issuance then reuse, cancellation, a local
summary and model switch, with a fixed request/token budget and a stop condition.
Record only sanitized counters and size measurements, never opaque checkpoints,
credentials, account identifiers or raw authenticated responses. Because the
compaction request is now always issued, that evidence should also decide whether
reliance on the always-on default is justified, rather than synthetic success
alone.
