# dsh-codex-subscription-bridge

A development prototype for connecting DeepSeek Harness to an existing managed
Codex ChatGPT subscription login through local app-server stdio.

## Status

**Live access is disabled. This is not an install-ready MVP.** The packaged
Harness adapter returns `AUTHORITY_UNVERIFIED` before spawning Codex or accessing
an account. There is no configuration switch to bypass this restriction.

Implemented and exercised with synthetic servers:

- Managed ChatGPT authentication admission; API-key and external-token rejection.
- Bounded model discovery and text streaming.
- Fresh ephemeral request threads, reconstructed text history, and no inherited
  thread IDs or replay state.
- Cancellation, deadlines, isolated concurrent requests, and bounded shutdown.
- Fixed error messages, discarded upstream diagnostics, and bounded protocol input.
- Harness provider registration and packaged service-fixture composition.

An isolated-launcher candidate now exists, with a private HOME/cwd and an
authoritative configuration lock. It is not wired to the public adapter.
The sandbox protocol correction was approved and the credential-free
real-binary adapter test now passes. All 40 tests pass with the pinned executable
selected. Real-account access and full Harness bundle-loader composition remain
unverified.

Native-tool and inherited-configuration isolation is still unresolved. Empty
workspace environments remove environment-dependent tools in the examined
Codex source, but do not establish that inherited MCP, plugins, hooks, provider
endpoints, and extensions are inert. See [the release blocker](docs/AUTHORITY.md).
Rejecting a tool event after it arrives cannot prevent an operation already
executed by Codex; the live gate is the actual safeguard in this prototype.

## Development

Use Node.js 22.23.2. The exact Harness LLM interface is `0.2.0-rc.2` with Cordis
`4.0.4`; the Codex protocol candidate is CLI `0.144.6`. This is a development
baseline, not a certified supported version pair. All transitive development
packages are fixed by `package-lock.json`. The bridge adds no credential or HTTP
client library; it uses the host's existing LLM and Cordis peers.

```sh
npm ci --ignore-scripts
npm run verify
```

No build step or lifecycle script is needed. Tests launch self-authored Node
child processes using synthetic data. The package test uses a temporary npm
cache, installs the local tarball offline without peer auto-installation, and
supplies the exact existing host peers to an isolated Cordis/LLM service fixture.
It does not run the complete Harness GUI, bundle loader, or a normal profile.

The development provider is `codex-subscription`, displayed as
`Codex (ChatGPT subscription)`. It accepts no configuration fields. Model
listing and valid text requests intentionally fail with `AUTHORITY_UNVERIFIED`.
Do not remove the gate merely to try the plugin with a real account.

## Scope and verification limits

Codex must own login, storage, and refresh. The bridge must not read or copy
credential files, implement OAuth, or silently fall back to API-key billing.
Search, images, usage limits, remote control, and Harness tool forwarding are
outside this MVP. Tool-bearing requests and unsupported generation overrides
are rejected rather than silently changed.

Synthetic tests do not establish live protocol compatibility, account refresh,
revocation, subscription eligibility, native-tool confinement, or absence of
all vulnerabilities. Actual Codex execution, startup configuration isolation,
trusted executable/version admission, and history reconstruction must be
verified before live access can be enabled.

This private repository has no selected distribution license. No PR or public
package has been created. All repository content is in English.

- [MVP requirements](docs/MVP.md)
- [Authority investigation](docs/AUTHORITY.md)
- [Security requirements](SECURITY.md)
- [Development instructions](AGENTS.md)

This independent project is not affiliated with OpenAI or DeepSeek.
