# Source installation, update, and removal

## Support and prerequisites

This is an experimental source-checkout installation, not a published npm release. Clone the repository from GitHub and select a reviewed full commit SHA on the implementation branch. Do not assume the default branch or an unreviewed moving branch is an installable release.

| Surface / OS | Status |
| --- | --- |
| macOS CLI/SDK provider (text, tool passthrough, images) | Synthetic packaged integration verified |
| macOS Web profile | Setup/startup verified; full real conversation pending |
| macOS Desktop 0.2.0-rc.2 | Electron 44.0.0 / Node 24.18.1 synthetic host/profile verified; UI/service pending |
| Linux / Windows / other OS | Not supported; rejected before authentication |

The test machine is Apple Silicon on macOS 26.6.2. Intel macOS is not independently verified. Use Node 22.23.3 (the checkout includes `.node-version` and `.nvmrc`). The supported standalone Node major is 22. Desktop uses its tested Electron host; the exact Node/Electron pair is required. Do not modify the Desktop binary. Follow [the Desktop guide](DESKTOP.md) for its separate verification profile.

The plugin uses a dedicated plaintext OAuth store; no Codex installation or token import is required. Device-code login must be enabled by the account/workspace. Browser-PKCE fallback and keyring storage are not included. A successful model listing does not establish successful generation or entitlement to every model.

## Prepare an isolated profile

From the reviewed checkout, with the required Node active:

```sh
node --version
npm ci --ignore-scripts
npm ci --ignore-scripts --prefix verification/runtime
mkdir -p artifacts
npm run prepare:profile -- --directory "$PWD/artifacts/subscription-web"
```

The parent directory must exist; the destination must not exist. Setup refuses an existing destination rather than modifying a normal profile. It checks the pinned Harness/peer/security-fixed leaf versions, packs the local plugin, installs that artifact offline with lifecycle scripts disabled, and creates a fresh HOME, Harness home and workspace. No existing credentials/settings are copied.

The profile depends on this checkout's pinned verification runtime and the Node executable used during setup. Keep both available. Do not delete or relocate them while this profile is in use. `manifest.json` records the artifact integrity, commit and runtime; working-tree changes may be included, so build from a clean reviewed checkout for distribution.

## Start and sign in inside Harness

```sh
sh artifacts/subscription-web/start.sh
```

Open Settings → ChatGPT subscription → Log in, then click the displayed one-time sign-in code to copy it and paste it on the linked OpenAI page. The panel updates after approval; see [the authentication UI](AUTH_UI.md). The generated auth helper remains optional for developer/recovery diagnosis; doctor does not contact OpenAI or create a missing store. Never paste codes or credentials into an issue.

The Web server binds only to 127.0.0.1 and picks an available port. Open the local bootstrap URL printed in your terminal. Treat its login token as private and do not expose the listener remotely. Select `Codex (ChatGPT subscription)` and an advertised model, then start a conversation. What the provider sends and enforces, including option handling and error labels, is described in [the provider behavior summary](../README.md#what-the-provider-sends-and-enforces) and [the design and limits](DIRECT.md). Sending a prompt consumes subscription allowance.

The installation, local diagnosis and profile composition are tested with synthetic fixtures; real-account evidence and current limits are recorded in [the verification record](VERIFICATION.md#real-account-evidence-and-limits). Verify the real first response on this profile manually before relying on it.

Stop the server with Ctrl-C and let shutdown complete before recovery/removal. For authentication problems, see [recovery](RECOVERY.md).

## Update without mutating a running installation

Stop the old profile. Obtain/review a new pinned commit, use its required Node and locked runtime, then prepare a different new directory (for example `artifacts/subscription-web-next`). Inspect its manifest and diagnose it. Log in explicitly there and verify the new profile before removing the old one.

Do not copy old auth.json or share a refresh-token copy across installations. The old and new profile use separate credential stores. This procedure does not promise that provider-side session policy leaves every other login unchanged. There is no automatic update channel; review the commit history between your installed commit and the new one, then follow the same reviewed-commit procedure for updates.

## Remove this dedicated installation

1. Stop every process using this profile and wait for shutdown.
2. Run `sh artifacts/subscription-web/auth.sh logout` if the store is healthy. This removes only the local dedicated login, not provider-side authorization.
3. Review the path and remove only the dedicated profile directory with your file manager. It contains the private HOME, history, workspace, cache, plugin artifact and helpers. Retain any workspace files you need first.
4. Do not remove a shared checkout/runtime used by other profiles.

No normal Harness profile or Codex authentication store is modified by this guide. Uninstalling is not a guarantee of server-side revocation or forensic erasure.
