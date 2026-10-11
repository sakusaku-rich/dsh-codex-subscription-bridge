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
unverified. Previous app-server smoke results do not validate this
transport. Do not treat this prototype as a completed security audit.

The public adapter no longer launches Codex or reads its credential store. The
old app-server implementation and tests remain development references and are
excluded from the shipped package. Normal-profile installation, public
publication, and PR creation have not been performed.

## Authentication

Node.js 22.23.2 and a POSIX filesystem with private ownership/permissions are the
current baseline. macOS is tested; other platforms remain unverified. No Codex
CLI installation is required by the new adapter.

From the repository:

```sh
node src/auth-cli.js login
node src/auth-cli.js status
node src/auth-cli.js logout
```

The packaged command is `dsh-codex-subscription-auth`. `login` prints the fixed
OpenAI device-login URL and a one-time code, then waits for browser approval.
Device-code access must be enabled for the account/workspace. This initial
version does not implement browser PKCE fallback or import Codex/Hermes tokens.
Login is an explicit account operation; automated verification never runs a
real login or submits real model requests.

Credentials are stored in `~/.dsh-codex-subscription-bridge/auth.json`, with a
0700 directory and 0600 file. This is plaintext storage protected by filesystem
permissions, not a keyring. Processes with the same user authority remain
trusted. Never upload, paste, commit, or copy the file into an issue.

`status` checks local credential structure without refreshing or contacting the
service. `logout` removes this plugin's local login; it does not revoke tokens
server-side or change Codex's login. Launch the authentication command and
Harness with the same inherited HOME. Project `.env` authentication locations
are not accepted. No tokens or custom endpoints are plugin configuration.

## Harness configuration

Use the bundle in an authorized profile. The adapter has no configuration keys:

```yaml
- id: llm-codex-subscription
  config: {}
```

Remove the old `executable` and `credentialStore` fields: they now fail with
`CONFIG_INVALID`. The route remains `codex-subscription`, displayed as
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
outside the initial migration.

## Development

Harness 0.2.0-rc.2 and Cordis 4.0.4 remain pinned. No new dependency or installation
script was added. Native Node HTTPS/fetch handles the fixed service destinations.

```sh
npm ci --ignore-scripts
npm run verify
npm ci --ignore-scripts --prefix verification/runtime
DSH_VERIFY_CLI="$PWD/verification/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js" npm run test:profile
```

A real-account check is separate and requires authorization. The prepared
`scripts/smoke-account.mjs --allow-real-account` command sends one fixed short
prompt using the dedicated login. It may consume subscription quota and refresh
this plugin's stored tokens. It has not been run for the direct implementation.

See [direct connection design](docs/DIRECT.md), [security requirements](SECURITY.md),
[verification record](docs/VERIFICATION.md), and [Harness runtime](docs/HARNESS.md).
The repository is private and has no selected distribution license. This project
is independent of OpenAI, DeepSeek, and Nous Research.
