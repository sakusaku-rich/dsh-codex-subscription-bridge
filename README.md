# dsh-codex-subscription-bridge

A minimal DeepSeek Harness provider that connects directly to the Codex subscription backend using a dedicated ChatGPT OAuth login. It forwards Harness tool definitions and executed tool-call history, and sends user message images as base64 `input_image` data URLs. The bridge never executes tools itself; execution stays in the Harness host.

"OpenAI", "ChatGPT", and "Codex" are trademarks of OpenAI. This project is an independent tool and is not affiliated with, endorsed by, or sponsored by OpenAI or DeepSeek. Connecting a ChatGPT subscription through this adapter is an account operation governed by the applicable terms of service; using it may violate those terms and put the account at risk.

## Status

The direct implementation passes synthetic authentication, refresh, streaming, cancellation, tool-call passthrough, image input, and packaged Harness CLI/SDK verification. The owner confirmed dedicated login and model selection. Authorized diagnostics confirmed an authenticated catalog advertising `gpt-6.1-sol` and an HTTP 200 SSE-framed response with a non-SSE MIME header. Successful generation through the corrected adapter, real tool-call and image turns against the subscription backend, real refresh/revocation, latency, and full Web UI operation remain unverified. Do not treat this prototype as a completed security audit.

The adapter uses dedicated OAuth and HTTPS. Normal-profile installation has not been performed; install only into the isolated profile described in [the installation guide](docs/INSTALL.md).

For an isolated source-checkout installation, update, and removal, follow [the installation guide](docs/INSTALL.md). See the [support matrix](docs/INSTALL.md#support-and-prerequisites) and [local recovery guide](docs/RECOVERY.md). For Desktop, use the [dedicated Desktop verification guide](docs/DESKTOP.md). No public npm release exists yet.

## Authentication

Node.js 22.23.3 and a POSIX filesystem with private ownership/permissions are the standalone baseline. macOS Desktop 0.2.0-rc.2 with Electron 44.0.0 / Node 24.18.1 is also admitted after synthetic verification; other OSes are rejected before authentication. Full Desktop UI/service behavior remains for manual verification. No Codex CLI installation is required by the adapter. `.node-version` and `.nvmrc` pin 22.23.3 for development. The public adapter and authentication CLI refuse older or unverified runtimes before accessing credentials.

In Desktop or standalone Web, open **Settings → ChatGPT subscription → Log in**. The page shows a **one-time sign-in code** that you can click to copy and a fixed OpenAI sign-in link. Paste or enter that code in your browser; the page updates after approval. Cancel login, refresh local status, and log out from the same page. Access/refresh tokens remain in the backend and are never sent to the settings page. See [authentication UI](docs/AUTH_UI.md).

The CLI remains an optional developer/recovery path. From the repository:

```sh
node src/auth-cli.js login
node src/auth-cli.js status
node src/auth-cli.js doctor
node src/auth-cli.js logout
```

The packaged command is `dsh-codex-subscription-auth`. `login` prints the fixed OpenAI device-login URL and a one-time code, then waits for browser approval. Device-code access must be enabled for the account/workspace. This initial version does not implement browser PKCE fallback or import existing tokens. Login is an explicit account operation; automated verification never runs a real login or submits real model requests.

Credentials are stored in `~/.dsh-codex-subscription-bridge/auth.json`, with a 0700 directory and 0600 file. A dedicated Desktop launch with `DSH_HOME` stores the grant under `$DSH_HOME/.dsh-codex-subscription-bridge/auth.json` instead; use its generated `auth.sh` to select that same store. This is plaintext storage protected by filesystem permissions, not a keyring. Processes with the same user authority remain trusted. Never upload, paste, commit, or copy the file into an issue.

`status` checks local credential structure without refreshing or contacting the service. `logout` removes this plugin's local login; it does not revoke tokens server-side or change Codex's login. Launch the authentication command and Harness with the same inherited HOME (and DSH_HOME for Desktop). Project `.env` authentication locations are not accepted. No tokens or custom endpoints are plugin configuration.

## Harness configuration

Use the bundle in an authorized profile. The adapter has no configuration keys:

```yaml
- id: llm-codex-subscription
  config: {}
```

Any configuration key fails with `CONFIG_INVALID`. The route is `codex-subscription`, displayed as `Codex (ChatGPT subscription)`. Catalog models advertise `text,image` input modalities.

The provider fetches visible subscription models directly. A 60-second in-memory catalog cache reduces repeated requests; authentication is reread on cache hits. Each conversation request freshly verifies the catalog and its credentials. Compatibility selectors are pinned by design; synthetic model aliases and unadvertised models are not added. Visibility does not prove entitlement to a successful request.

Only bounded text history is sent, with `store: false` and no conversation IDs resumed or chained. Harness tool definitions are validated and forwarded as strict function tools; executed tool-call history is forwarded as `function_call`/`function_call_output` items. The bridge never executes tools; execution stays in the Harness host. Image blocks in user messages are read through the attachment service and sent as `input_image` data URLs, and image blocks in other roles are rejected. Non-image file attachments never reach the bridge: the Harness runtime projects file blocks to text before every adapter dispatch, so no file-attachment handling is required here. `temperature` (finite, 0–2) is validated and forwarded; `maxTokens` (safe integer, 1–1,000,000) is validated and accepted as an advisory budget but deliberately not forwarded, matching the subscription route's own adapter precedent; `stop` sequences are rejected with a fixed `UNSUPPORTED_OPTION` error labeled `STOP`. Reasoning effort maps to `low` or `high` only. Oversized image requests fail with `IMAGE_OFFLOAD_REQUIRED` so the Harness host can offload its oldest images and retry. HTTP 429 responses are classified from a bounded error body: a recognized plan usage limit becomes terminal `QUOTA`, optionally with a "Try again in about N minutes." hint derived only from a validated reset integer, while any other or unreadable 429 stays transient `RATE_LIMIT`. Search, quota display, and remote access remain outside the initial scope.

## Development

Harness 0.2.0-rc.2 and Cordis 4.0.4 remain pinned. HTTP uses bundled MIT-licensed Undici 7.29.1 with its own dispatcher, independent of the host fetch/dispatcher. No dependency lifecycle scripts are required for the shipped plugin.

```sh
npm ci --ignore-scripts
npm run verify
npm ci --ignore-scripts --prefix verification/runtime
npm run test:install
npm run test:auth-ui
DSH_VERIFY_CLI="$PWD/verification/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js" npm run test:profile
```

A real-account check is separate and requires authorization. The prepared `scripts/smoke-account.mjs --allow-real-account` command sends one fixed short prompt using the dedicated login. It may consume subscription quota and refresh this plugin's stored tokens. It has not been run for the direct implementation.

See [direct connection design](docs/DIRECT.md), [security requirements](SECURITY.md), [verification record](docs/VERIFICATION.md), and [Harness runtime](docs/HARNESS.md).

## Continuous integration

[CI](.github/workflows/ci.yml) runs on pushes, pull requests, and manual dispatches using a GitHub-hosted macOS runner and the exact `.node-version`. It installs both lockfiles with lifecycle scripts disabled, audits both dependency trees, and runs the source, package, isolated installation, and synthetic Harness CLI/SDK checks above, plus pinned Electron 44.0.0 host verification. The test binary is downloaded by Electron's explicit checksum-verifying installer; dependency lifecycle scripts otherwise remain disabled. No subscription credentials or real-account smoke calls are used.

Actions are pinned to commit SHAs; checkout credentials are not persisted, and the workflow token has read-only repository access. CI does not publish packages or replace the separate authorized real-account verification. Dependency audits check known advisories and do not establish that the software is vulnerability-free.

## Contributing

Pull requests are always welcome, including bug fixes, tests, documentation, and security improvements. Report problems, including vulnerabilities, as GitHub Issues; see [the security requirements](SECURITY.md). Keep changes focused, use English for repository content, and include relevant verification results. Please read [AGENTS.md](AGENTS.md) and [the security requirements](SECURITY.md) before contributing.

Never include credentials, device codes, authentication files, or raw authenticated responses in issues or pull requests.

## License

Licensed under the [MIT License](LICENSE). Copyright (c) 2026 sakusaku-rich. Dependencies retain their own licenses. This license applies to this project and does not grant rights to OpenAI services or override their terms.
