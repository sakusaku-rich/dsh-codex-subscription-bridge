# MVP requirements

## Purpose

Use an existing Codex ChatGPT subscription login as a model provider in DeepSeek
Harness without creating another holder of OpenAI credentials.

## User-facing behavior

- An authenticated ChatGPT account exposes its available Codex models in the
  Harness model selector.
- A text request streams assistant text and a terminal outcome.
- Cancellation stops the active request and releases its resources.
- Missing authentication, API-key authentication, incompatible versions, and
  unsupported requests produce clear, credential-safe failures.

All repository content and initial product strings use English.

## Excluded features

The initial version excludes custom OAuth, token import/export, API-key fallback,
search integration, images, quota controls, remote access, and forwarding Harness
tools to Codex. These exclusions do not automatically remove native Codex tools;
their effective restrictions must be established before implementation is
accepted.

## Implementation prerequisites

- Pin one supported Harness version and one supported Codex CLI version.
- Verify their actual provider and app-server schemas rather than relying on an
  unversioned example or another community plugin.
- Use a trusted absolute Codex executable path and local stdio transport.
- Determine how the supported Codex version constrains native tools, private
  file reads, and network access. Reject the integration if the intended
  restrictions cannot be enforced.
- Select an explicit conversation lifecycle. Prefer fresh ephemeral request
  threads if their history reconstruction is verified; any reuse must remain
  owned by one Harness conversation and preserve its current authority.
- Choose a minimal dependency graph, pin it, and retain a lockfile. Review
  install-time scripts before allowing any execution.

## Acceptance criteria

The implementation must pass synthetic tests for:

1. ChatGPT authentication admission and API-key mode rejection.
2. Valid model discovery, malformed discovery responses, and catalog failure.
3. Streaming completion, failure, cancellation, and bounded timeouts.
4. Concurrent conversations and fork/import isolation.
5. Permission changes between requests and unsupported policy rejection.
6. Token-bearing stderr, RPC errors, malformed JSON, and oversized messages.
7. Child-environment minimization and executable-path validation.
8. Repeated shutdown and a child that ignores termination.
9. Packaged artifact composition in an isolated Harness profile.

Then, with explicit owner authorization, verify real model access and effective
authority using the exact supported version pair. Account maintenance performed
by Codex during that test must be disclosed; do not claim authentication refresh
or revocation is verified merely because a single request succeeds.

## Reference

[Official Codex app-server documentation](https://learn.chatgpt.com/docs/app-server)
describes the protocol, managed ChatGPT authentication, threads, turns, and
permission settings. The implementation must additionally verify the schema and
behavior of the pinned executable.
