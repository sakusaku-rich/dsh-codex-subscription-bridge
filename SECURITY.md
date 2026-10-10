# Security requirements

This document defines requirements for implementation. It does not claim that a
working bridge exists or that vulnerabilities have been eliminated.

## Trust model

The plugin and the Codex app-server run under the local OS user. File permissions
alone cannot protect that user's credentials from another process with the same
authority. The bridge must not add an additional credential store or a token
export surface.

The Codex executable, Harness host, OS, and selected dependency versions remain
part of the trusted runtime. Existing account access is reused through Codex's
managed authentication; the plugin must not copy authentication files.

## Required controls

1. Validate an absolute executable path and use a fixed argument vector with
   shell execution disabled. Do not search project directories for executables.
2. Use a child environment allowlist and avoid inheriting unrelated project or
   cloud secrets. Environment minimization does not provide filesystem isolation.
3. Verify ChatGPT-managed account authentication before providing models or
   starting a conversation. Fail explicitly on other authentication modes.
4. Validate every incoming JSON-RPC message and enforce aggregate resource
   bounds. Malformed input must terminate the connection safely.
5. Return fixed errors and safe classifications. Never surface raw stderr,
   response bodies, authorization URLs, or token-shaped fields in diagnostics.
6. Keep each Harness conversation isolated. Forked or imported histories must
   not reuse another conversation's live Codex thread.
7. Apply supported authority restrictions before each request. Unsupported or
   unverifiable permission mappings must fail closed.
8. Prevent native Codex tools from gaining unintended filesystem, shell, network,
   MCP, or application access. Approval handling alone is not evidence that all
   tools are disabled, and read-only mode alone does not restrict file reads.
9. Await cancellation and bounded shutdown; stop accepting events from retired
   requests and terminate child processes that do not exit.

## Verification boundary

Normal tests use synthetic values and fake processes. A real-account test is a
separate, explicitly authorized activity in an isolated Harness profile. Before
normal installation, verify the exact supported version pair, model requests,
cancellation, conversation forks, permission enforcement, process cleanup, and
credential-safe diagnostics.

No finite review or test suite establishes the absence of unknown
vulnerabilities. Document the reviewed versions, checks, and remaining limits.

## Reporting

Do not post credentials or sensitive reproduction details in a public issue.
This private repository currently has no published security contact. Agree on a
private reporting channel with the owner before any public distribution.
