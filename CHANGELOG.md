# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Direct Codex subscription provider for DeepSeek Harness with dedicated ChatGPT OAuth device login, streamed text conversations, and cancellation.
- Harness tool definitions and executed tool-call history are validated and forwarded to the Responses API as `function` tools and `function_call`/`function_call_output` items; the bridge never executes tools itself.
- User message image blocks are read through the attachment service and sent as `input_image` base64 data URLs, with aggregate offload budgets that report `IMAGE_OFFLOAD_REQUIRED` so the Harness host can offload its oldest images and retry.
- Reasoning effort maps to Responses `reasoning.effort` `low` or `high`.
- `temperature` (finite, 0–2) is validated and forwarded; `maxTokens` (safe integer, 1–1,000,000) is validated and accepted as an advisory budget without forwarding, matching the subscription route adapter's own precedent; `stop` sequences are rejected with fixed `UNSUPPORTED_OPTION` labeling.
- The input message cap matches the runtime projection limit at 1024 messages.
- HTTP 429 responses are classified from a bounded error body: recognized plan usage limits become terminal `QUOTA` with an optional "Try again in about N minutes." hint derived only from a validated reset integer (clamped to one week); other or unreadable 429 bodies stay transient `RATE_LIMIT`.
- Settings UI section with a click-to-copy one-time sign-in code display, login, cancel, refresh, and logout actions.
- Authentication CLI (`dsh-codex-subscription-auth`) with `login`, `status`, `doctor`, and `logout` commands.

### Security

- Device polling honors RFC 8628 `slow_down` backoff and treats `expired_token`/`access_denied` as terminal results.
- Credential reads complete sequential short reads before enforcing the store size limit.
- The fixed-destination URL fence is re-asserted after WHATWG URL normalization so dot-segment input cannot leave the fixed path prefix.
- Forwarded tools and images are conservatively validated with fixed error labels (`TOOL_INPUT`, `LIMIT_EXCEEDED`, `IMAGE_PREPARE`, `IMAGE_OFFLOAD`), bounded sizes, and no tool execution in the bridge; server conversation IDs remain unresumed and `store: false`.

[Unreleased]: https://github.com/sakusaku-rich/dsh-codex-subscription-bridge/compare/v0.0.0...HEAD
