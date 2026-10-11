# dsh-codex-subscription-bridge

A minimal text provider for DeepSeek Harness using an existing managed Codex
ChatGPT subscription login through the official local app-server.

## Status

The configured backend and packaged Harness SDK profile passed synthetic
verification. An owner-authorized file-backed ChatGPT subscription smoke check
also passed on 2026-10-11 with `gpt-5.6-sol`. Normal profile installation and
Desktop/Web GUI verification have not been performed.

The adapter connects only when a trusted absolute `executable` and an explicit
`credentialStore` (`file` or `keyring`) are configured. Otherwise it returns
`CONFIG_REQUIRED` without launching Codex. It accepts no tokens, custom OAuth,
API-key fallback, arbitrary command arguments, or permission overrides.

Implemented and verified:

- Managed ChatGPT-mode admission with token-free mode inspection.
- API-key and external-token mode rejection before model dispatch.
- Model discovery, streamed text, cancellation, and bounded process cleanup.
- Fresh ephemeral request threads with reconstructed text history.
- Authoritative configuration replacement, private HOME/cwd/state/log paths,
  no workspace environments, and no forwarded Harness tools.
- Packaged profile composition, public Harness CLI/SDK conversation, and shutdown.
- Protection against project `.env` replacing the authentication location.

Harness attaches tool declarations to ordinary requests. The bridge deliberately
discards these declarations and their bookkeeping; it never sends them to Codex
or returns Harness tool calls. Actual tool execution history, direct image/file
blocks, and unsupported generation overrides are rejected. Start a fresh text
conversation when switching from an agent session containing tool executions.

Codex retains the harmless internal `update_plan` tool in the verified policy.
Read-only mode alone does not confine filesystem reads. Codex, the host, OS,
and dependencies remain trusted; this is not a general-purpose OS sandbox.

## Configuration

For an already installed bundle, the profile patch uses:

```yaml
- id: llm-codex-subscription
  config:
    executable: /absolute/path/to/trusted/codex
    credentialStore: file
```

Choose the same credential storage mode as the existing Codex login. Select
`keyring` explicitly for keyring-backed credentials. There is no `auto` migration
fallback, no credential copying, and no new login flow. Real keyring access is
not yet verified. Configuring these fields enables account discovery and model
requests; do not configure a normal profile until its installation is authorized.

The route is `codex-subscription`, displayed as
`Codex (ChatGPT subscription, text only)`. Discovery is bounded and uses the
pinned CLI's catalog; actual model entitlement and subscription limits remain
subject to the account and upstream service.

## Development and verification

The verified baseline is macOS, Node.js 22.23.2, Codex CLI 0.144.6, Harness
0.2.0-rc.2, and Cordis 4.0.4. Other Codex versions and platforms fail launcher admission; other Node/Harness
versions are unsupported. The bridge
adds no HTTP or credential library and communicates only through local stdio.
Its host peers and development dependencies are locked in `package-lock.json`.

```sh
npm ci --ignore-scripts
npm run verify
```

To include the credential-free real-binary tests:

```sh
CODEX_ISOLATION_EXECUTABLE=/absolute/path/to/codex npm run verify
```

For the complete packaged Harness profile check:

```sh
npm ci --ignore-scripts --prefix verification/runtime
DSH_VERIFY_CLI="$PWD/verification/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js" npm run test:profile
```

The verification runtime pins security-fixed dependencies separately from the
plugin. It does not update an existing Harness installation. See
[Harness verification and dependency findings](docs/HARNESS.md).

A separately authorized real-account smoke check is prepared in
`scripts/smoke-account.mjs`. It reads the catalog and requests one short fixed
reply. It may consume subscription quota and Codex may refresh its own stored
credentials. One explicitly authorized file-backed run passed; no additional
model requests were performed.

## Limits and project documents

Search, images, quota display, remote access, and Harness tool forwarding are
outside this MVP. Refresh/revocation behavior, entitlement to other models, long conversations,
and Desktop/Web UI behavior remain unverified. No finite audit or test suite
proves the absence of unknown vulnerabilities.

This private repository has no selected distribution license. No PR or public
package has been created. Repository content is in English.

- [MVP requirements](docs/MVP.md)
- [Authority isolation](docs/AUTHORITY.md)
- [Verification record](docs/VERIFICATION.md)
- [Harness verification](docs/HARNESS.md)
- [Security requirements](SECURITY.md)
- [Development instructions](AGENTS.md)

This independent project is not affiliated with OpenAI or DeepSeek.
