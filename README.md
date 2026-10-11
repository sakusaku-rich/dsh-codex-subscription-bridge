# dsh-codex-subscription-bridge

A minimal DeepSeek Harness text provider that connects directly to the Codex
subscription backend using a dedicated ChatGPT OAuth login.

## Status

The direct implementation passes synthetic authentication, refresh, streaming,
cancellation, and packaged Harness CLI/SDK verification. The owner confirmed
dedicated login and model selection. Authorized diagnostics confirmed an
authenticated catalog advertising `gpt-6.1-sol` and an HTTP 200 SSE-framed
response with a non-SSE MIME header. Successful generation through the corrected
adapter, real refresh/revocation, latency, and full Web UI operation remain
unverified. Do not treat this prototype as a completed security audit.

The adapter uses dedicated OAuth and HTTPS. Normal-profile installation, public
publication, and PR creation have not been performed.

For an isolated source-checkout installation, update, and removal, follow
[the installation guide](docs/INSTALL.md). See the [support matrix](docs/INSTALL.md#support-and-prerequisites)
and [local recovery guide](docs/RECOVERY.md). For Desktop, use the
[dedicated Desktop verification guide](docs/DESKTOP.md). No public npm release exists yet.

## Authentication

Node.js 22.23.3 and a POSIX filesystem with private ownership/permissions are the
standalone baseline. macOS Desktop 0.2.0-rc.2 with Electron 44.0.0 / Node
24.18.1 is also admitted after synthetic verification; other OSes are rejected
before authentication. Full Desktop UI/service behavior remains for manual
verification. No Codex
CLI installation is required by the adapter. `.node-version` and `.nvmrc`
pin 22.23.3 for development. The public adapter and authentication CLI refuse
older or unverified runtimes before accessing credentials.

From the repository:

```sh
node src/auth-cli.js login
node src/auth-cli.js status
node src/auth-cli.js doctor
node src/auth-cli.js logout
```

The packaged command is `dsh-codex-subscription-auth`. `login` prints the fixed
OpenAI device-login URL and a one-time code, then waits for browser approval.
Device-code access must be enabled for the account/workspace. This initial
version does not implement browser PKCE fallback or import Codex/Hermes tokens.
Login is an explicit account operation; automated verification never runs a
real login or submits real model requests.

Credentials are stored in `~/.dsh-codex-subscription-bridge/auth.json`, with a
0700 directory and 0600 file. A dedicated Desktop launch with `DSH_HOME` stores
the grant under `$DSH_HOME/.dsh-codex-subscription-bridge/auth.json` instead; use
its generated `auth.sh` to select that same store. This is plaintext storage protected by filesystem
permissions, not a keyring. Processes with the same user authority remain
trusted. Never upload, paste, commit, or copy the file into an issue.

`status` checks local credential structure without refreshing or contacting the
service. `logout` removes this plugin's local login; it does not revoke tokens
server-side or change Codex's login. Launch the authentication command and
Harness with the same inherited HOME (and DSH_HOME for Desktop). Project `.env` authentication locations
are not accepted. No tokens or custom endpoints are plugin configuration.

## Harness configuration

Use the bundle in an authorized profile. The adapter has no configuration keys:

```yaml
- id: llm-codex-subscription
  config: {}
```

Any configuration key fails with `CONFIG_INVALID`. The route is
`codex-subscription`, displayed as
`Codex (ChatGPT subscription, text only)`.

The provider fetches visible subscription models directly. A 60-second
in-memory catalog cache reduces repeated requests; authentication is reread on
cache hits. Each conversation request freshly verifies the catalog and its
credentials. Compatibility selectors follow the pinned Hermes reference;
synthetic model aliases and unadvertised models are not added. Visibility does
not prove entitlement to a successful request.

Only bounded text history is sent, with `store: false` and no tool definitions.
Harness tool declarations are ignored; executed tool history, images, files,
and generation overrides are rejected. No conversation IDs are resumed or
chained. Search, images, quota display, tool forwarding, and remote access are
outside the initial scope.

## Development

Harness 0.2.0-rc.2 and Cordis 4.0.4 remain pinned. HTTP uses bundled MIT-licensed
Undici 7.29.1 with its own dispatcher, independent of the host fetch/dispatcher.
No dependency lifecycle scripts are required for the shipped plugin.

```sh
npm ci --ignore-scripts
npm run verify
npm ci --ignore-scripts --prefix verification/runtime
npm run test:install
DSH_VERIFY_CLI="$PWD/verification/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js" npm run test:profile
```

A real-account check is separate and requires authorization. The prepared
`scripts/smoke-account.mjs --allow-real-account` command sends one fixed short
prompt using the dedicated login. It may consume subscription quota and refresh
this plugin's stored tokens. It has not been run for the direct implementation.

See [direct connection design](docs/DIRECT.md), [security requirements](SECURITY.md),
[verification record](docs/VERIFICATION.md), and [Harness runtime](docs/HARNESS.md).

## Continuous integration

[CI](.github/workflows/ci.yml) runs on pushes, pull requests, and manual
dispatches using a GitHub-hosted macOS runner and the exact `.node-version`.
It installs both lockfiles with lifecycle scripts disabled, audits both dependency
trees, and runs the source, package, isolated installation, and synthetic Harness
CLI/SDK checks above, plus pinned Electron 44.0.0 host verification. The test
binary is downloaded by Electron's explicit checksum-verifying installer; dependency
lifecycle scripts otherwise remain disabled. No subscription credentials or real-account smoke calls
are used.

Actions are pinned to commit SHAs; checkout credentials are not persisted, and
the workflow token has read-only repository access. CI does not publish packages
or replace the separate authorized real-account verification. Dependency audits
check known advisories and do not establish that the software is vulnerability-free.

## Contributing

Pull requests are always welcome, including bug fixes, tests, documentation,
and security improvements. Keep changes focused, use English for repository
content, and include relevant verification results. Please read [AGENTS.md](AGENTS.md)
and [the security requirements](SECURITY.md) before contributing.

Never include credentials, device codes, authentication files, or raw authenticated
responses in issues or pull requests.

## License

Licensed under the [MIT License](LICENSE). Copyright (c) 2026 sakusaku-rich.
Dependencies retain their own licenses. This license applies to this project
and does not grant rights to OpenAI services or override their terms.

The repository remains private. This project is independent of OpenAI, DeepSeek,
and Nous Research.
