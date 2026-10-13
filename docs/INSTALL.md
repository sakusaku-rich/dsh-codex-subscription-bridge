# Release and source installation, update, and removal

## Support and prerequisites

Two installation paths prepare the same isolated, signed-out profile: a one-command install from a published release, and the source-checkout install used for development and recovery. Both are experimental prototype surfaces. A source checkout is built from a reviewed full commit SHA; a release install consumes a released, integrity-verified artifact. Do not install from a moving branch head.

No release has been published yet, so the one-command path below cannot run until the first tagged release exists. Until then, use the source-checkout path. The release and version policy is tracked separately.

| Surface / OS | Status |
| --- | --- |
| macOS CLI/SDK provider (text, tool passthrough, images) | Synthetic packaged integration verified |
| macOS Web profile | Setup/startup verified; full real conversation pending |
| macOS Desktop 0.2.0-rc.2 | Electron 44.0.0 / Node 24.18.1 synthetic host/profile verified; UI/service pending |
| Linux / Windows / other OS | Not supported; rejected before authentication |

The test machine is Apple Silicon on macOS 26.6.2. Intel macOS is not independently verified. Use Node 22.23.3 (the checkout includes `.node-version` and `.nvmrc`). The supported standalone Node major is 22. Desktop uses its tested Electron host; the exact Node/Electron pair is required. Do not modify the Desktop binary. Follow [the Desktop guide](DESKTOP_VERIFICATION.md) for its separate verification profile.

The plugin uses a dedicated plaintext OAuth store; no Codex installation or token import is required. Device-code login must be enabled by the account/workspace. Browser-PKCE fallback and keyring storage are not included. A successful model listing does not establish successful generation or entitlement to every model.

## Install from a published release

Download the published `install.sh` release asset, read it, then run it with the release tag and a new destination:

```sh
curl -fsSLO https://github.com/sakusaku-rich/dsh-codex-subscription-bridge/releases/download/v0.1.0/install.sh
less install.sh
sh install.sh --tag v0.1.0 --directory "$PWD/artifacts/subscription-web"
```

`--surface` selects the verified host and defaults to `web`:

| Surface | Profile | Launcher | Host |
| --- | --- | --- | --- |
| `web` (default) | `subscription-web` | `start.sh` | The pinned standalone Node 22.23.3 runtime fetched during preparation. |
| `desktop` | `desktop` | `desktop.sh` | The installed DeepSeek Harness Desktop 0.2.0-rc.2, used with its exact Electron 44.0.0 / Node 24.18.1 pair. |

For a Desktop profile, prepare with `--surface desktop` and start it with the generated `desktop.sh`:

```sh
sh install.sh --tag v0.1.0 --directory "$PWD/artifacts/desktop-profile" --surface desktop
```

The Desktop surface is refused unless the installed application matches the verified host pair exactly; it is never worked around. Desktop's runtime resolver supplies the host peers from the application's own tree, so a Desktop profile deliberately does not contain a standalone runtime copy and does not build one. Follow [the Desktop guide](DESKTOP_VERIFICATION.md) for what the Desktop profile does and does not isolate, and for the owner-operated sign-in steps.

The command performs three visible steps and never pipes a download into a shell:

1. Download the release installer bundle and its `SHA256SUMS` into a private temporary directory.
2. Verify the bundle's SHA-256 against the published manifest and print both digests so you can compare them against the release page, then unpack it. The plugin package carried inside the bundle is verified against the same manifest before it is used.
3. Prepare the isolated profile from the verified plugin package.

Pinning is explicit: `--tag` selects a released tag, and every artifact is verified before it is used. `curl -fsSL` without a pipe writes the asset to disk so it can be inspected; nothing is executed before the checksum matches. If an artifact is missing from `SHA256SUMS`, or its digest differs, the installer refuses and creates nothing. The bundle is unpacked only after its own members have been checked for absolute paths and parent traversal.

Preparation needs network access once, to fetch the pinned Harness `0.2.0-rc.2` runtime from the npm registry. Every install runs with lifecycle scripts disabled (`--ignore-scripts`), and the resolved Harness and security-fixed leaf versions are asserted after resolution. The verified plugin package is then installed from the local file with `--offline`.

### What the release publishes

A release carries four assets. The installer bundle is separate from the published npm package so the package stays minimal and ships no development tooling:

| Asset | Role |
| --- | --- |
| `install.sh` | The reviewed one-command installer. |
| `dsh-codex-subscription-bridge-installer-<version>.tgz` | The bundle: `install.sh`, the prepare script, the shared guards and the plugin package. |
| `dsh-codex-subscription-bridge-<version>.tgz` | The published plugin package, the artifact that is installed. |
| `SHA256SUMS` | The digests of the two archives above. |

`npm run prepare:release -- --tag v<version> --directory <new absolute directory>` builds and checksums these assets. It refuses a tag that does not match `package.json`, refuses to include development tooling in the published package, and refuses an existing output directory.

For both install paths the parent directory must exist and the destination must not. The sections below on what preparation creates, how to start and sign in, how to update, and how to remove apply to both paths.

## Prepare an isolated profile from a source checkout

From the reviewed checkout, with the required Node active:

```sh
node --version
npm ci --ignore-scripts
npm ci --ignore-scripts --prefix verification/runtime
mkdir -p artifacts
npm run prepare:profile -- --directory "$PWD/artifacts/subscription-web"
```

The parent directory must exist; the destination must not exist. Setup refuses an existing destination rather than modifying a normal profile. It checks the pinned Harness/peer/security-fixed leaf versions, packs the local plugin, installs that artifact offline with lifecycle scripts disabled, and creates a fresh HOME, Harness home and workspace. No existing credentials/settings are copied.

The profile depends on the pinned runtime and the Node executable used during setup. Keep both available. Do not delete or relocate them while this profile is in use. `manifest.json` records the artifact integrity and runtime. A release install also records the release tag and the verified `sha256`, and sets `workingTreeMayContainChanges` to `false`; a source install records the commit instead and sets that flag to `true`, because working-tree changes may be included. Build from a clean reviewed checkout for distribution.

## Start and sign in inside Harness

```sh
sh artifacts/subscription-web/start.sh
```

Open Settings → ChatGPT subscription → Log in, then click the displayed one-time sign-in code to copy it and paste it on the linked OpenAI page. The panel updates after approval. The generated auth helper remains optional for developer/recovery diagnosis; doctor does not contact OpenAI or create a missing store. Never paste codes or credentials into an issue.

The Web server binds only to 127.0.0.1 and picks an available port. Open the local bootstrap URL printed in your terminal. Treat its login token as private and do not expose the listener remotely. Select `Codex (ChatGPT subscription)` and an advertised model, then start a conversation. What the provider sends and enforces, including option handling and error labels, is described in [the provider behavior summary](../README.md#what-the-provider-sends-and-enforces) and [the architecture and limits](ARCHITECTURE.md). Sending a prompt consumes subscription allowance.

The installation, local diagnosis and profile composition are tested with synthetic fixtures; real-account evidence and current limits are recorded in [the verification record](VERIFICATION.md#real-account-evidence-and-limits). Verify the real first response on this profile manually before relying on it.

Stop the server with Ctrl-C and let shutdown complete before recovery/removal. For authentication problems, see [troubleshooting](TROUBLESHOOTING.md).

## Update without mutating a running installation

Stop the old profile. For a release install, download and read the new release's `install.sh`, then run it with the new tag and a different destination (for example `artifacts/subscription-web-next`). For a source install, obtain/review a new pinned commit, use its required Node, then prepare a different new directory the same way. Inspect the new manifest and diagnose it, log in explicitly there, and verify the new profile before removing the old one.

Do not copy old auth.json or share a refresh-token copy across installations. The old and new profile use separate credential stores. This procedure does not promise that provider-side session policy leaves every other login unchanged. There is no automatic update channel; review the release notes or the commit history between your installed version and the new one, then follow the same reviewed procedure for updates.

## Remove this dedicated installation

1. Stop every process using this profile and wait for shutdown.
2. Run `sh artifacts/subscription-web/auth.sh logout` if the store is healthy. This removes only the local dedicated login, not provider-side authorization.
3. Review the path and remove only the dedicated profile directory with your file manager. It contains the private HOME, history, workspace, cache, plugin artifact and helpers. Retain any workspace files you need first.
4. Do not remove a shared checkout/runtime used by other profiles.

No normal Harness profile or Codex authentication store is modified by this guide. Uninstalling is not a guarantee of server-side revocation or forensic erasure.
