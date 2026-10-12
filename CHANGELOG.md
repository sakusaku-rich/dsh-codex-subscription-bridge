# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Direct Codex subscription provider for DeepSeek Harness with dedicated ChatGPT OAuth device login, streamed text conversations, and cancellation.
- Settings UI section with a click-to-copy one-time sign-in code display, login, cancel, refresh, and logout actions.
- Authentication CLI (`dsh-codex-subscription-auth`) with `login`, `status`, `doctor`, and `logout` commands.

### Security

- Device polling honors RFC 8628 `slow_down` backoff and treats `expired_token`/`access_denied` as terminal results.
- Credential reads complete sequential short reads before enforcing the store size limit.
- The fixed-destination URL fence is re-asserted after WHATWG URL normalization so dot-segment input cannot leave the fixed path prefix.

[Unreleased]: https://github.com/sakusaku-rich/dsh-codex-subscription-bridge/compare/v0.0.0...HEAD
