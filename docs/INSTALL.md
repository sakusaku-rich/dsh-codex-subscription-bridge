# Release and source installation, update, and removal

## Support and prerequisites

Two installation paths prepare the same isolated, signed-out profile: a one-command install from a published release, and the source-checkout install used for development and recovery. Both are experimental prototype surfaces. A source checkout is built from a reviewed full commit SHA; a release install consumes a released, integrity-verified artifact. Do not install from a moving branch head.

The one-command path below installs a published release; replace `v0.0.4` in the examples with the release you reviewed. Use the source-checkout path when you need a commit that no release carries yet.

| Surface / OS | Status |
| --- | --- |
| macOS CLI/SDK provider (text, tool passthrough, images) | Synthetic packaged integration verified |
| macOS Web profile | Setup/startup verified; full real conversation pending |
| macOS Desktop 0.2.0-rc.2 | Electron 44.0.0 / Node 24.18.1 synthetic host/profile verified, and owner-operated real GUI, sign-in and service use verified |
| Linux / Windows / other OS | Not supported; rejected before authentication |

The test machine is Apple Silicon on macOS 26.6.2. Intel macOS is not independently verified. Use Node 22.23.3, the verified baseline (Undici 6.28.1, OpenSSL 3.5.8): the root and verification-runtime manifests and lockfiles require Node 22 >= 22.23.3 (the root engine also admits the Desktop 24.18.1 pair), and `.node-version` and `.nvmrc` pin 22.23.3 exactly, and the public adapter and authentication CLI reject older or unverified runtimes. Installing does not migrate a global Node installation or an existing account store. [Official release](https://nodejs.org/en/blog/release/v22.23.3). The supported standalone Node major is 22. Desktop uses its tested Electron host; the exact Node/Electron pair is required. Do not modify the Desktop binary. Follow [the Desktop guide](DESKTOP_VERIFICATION.md) for its separate verification profile.

The plugin uses a dedicated plaintext OAuth store; no Codex installation or token import is required. Device-code login must be enabled by the account/workspace. Browser-PKCE fallback and keyring storage are not included. A successful model listing does not establish successful generation or entitlement to every model.

## Install from a published release

Download the published `install.sh` release asset and read it before running it. One installer serves both modes: `--profile` adds the bridge to a Desktop profile you already use, and `--directory` prepares a new isolated profile. Exactly one of the two is required.

```sh
curl -fsSLO https://github.com/sakusaku-rich/dsh-codex-subscription-bridge/releases/download/v0.0.4/install.sh
```

### Into an existing Desktop profile

Install into a Desktop profile you already use:

```sh
sh install.sh --tag v0.0.4 --profile "$HOME/.dsh/profiles/desktop" --surface desktop
```

`--profile` needs `v0.0.2` or later. The `v0.0.1` installer bundle predates the script this mode runs, so it fails rather than falling back. It is Desktop-only and refuses a Web surface, because the standalone Web launch needs a runtime that only an isolated directory owns.

It differs from the isolated path in ways worth knowing before you run it:

- **It modifies a profile you are using.** The bridge is added to that profile's dependency and bundle lists. Existing plugins and `cordis.patch.yml` are left untouched.
- **The application's own pnpm is used.** The profile is a pnpm project, so the pnpm bundled with the installed Desktop is resolved and version-checked. The system `pnpm` is never consulted, so a different major cannot rewrite the lockfile in an incompatible format.
- **`package.json` and the lockfile are backed up first.** The copy is written to `.bridge-backup-<timestamp>/` inside the profile, and the run prints that path. If the install fails, those files are restored automatically and the run says so.
- **An install is refused when the bridge is already listed**, rather than repointing an existing entry.
- **There is no `manifest.json` for this mode.** The isolated path records the release tag and verified digest there; a shared profile keeps the application's own layout, so the same record is written to the backup directory as `installed.json`.

Restart the application to load the bridge. To undo the install, copy `package.json` and `pnpm-lock.yaml` from the backup directory back over the profile and run the same pnpm install again, and delete the opt-in entry below from `cordis.patch.yml` if you added it, as the opt-in section explains.

Because this mode changes a working environment, it is the less reversible of the two paths. The backup makes a failed install self-correcting, and an undo exact, but the isolated install remains the safer choice when you do not specifically need the existing profile's settings and plugins.

### Into a new isolated profile

With the same `install.sh`, prepare a new profile in a directory that does not exist yet:

```sh
mkdir -p artifacts
sh install.sh --tag v0.0.4 --directory "$PWD/artifacts/subscription-web"
```

`--surface` selects the verified host and defaults to `web`:

| Surface | Profile | Launcher | Host |
| --- | --- | --- | --- |
| `web` (default) | `subscription-web` | `start.sh` | The pinned standalone Node 22.23.3 runtime fetched during preparation. |
| `desktop` | `desktop` | `desktop.sh` | The installed DeepSeek Harness Desktop 0.2.0-rc.2, used with its exact Electron 44.0.0 / Node 24.18.1 pair. |

For a Desktop profile, prepare with `--surface desktop` and start it with the generated `desktop.sh`:

```sh
sh install.sh --tag v0.0.4 --directory "$PWD/artifacts/desktop-profile" --surface desktop
```

The Desktop surface is refused unless the installed application matches the verified host pair exactly; it is never worked around. Desktop's runtime resolver supplies the host peers from the application's own tree, so a Desktop profile deliberately does not contain a standalone runtime copy and does not build one. Follow [the Desktop guide](DESKTOP_VERIFICATION.md) for what the Desktop profile does and does not isolate, and for the owner-operated sign-in steps.

The command performs three visible steps and never pipes a download into a shell:

1. Download the release installer bundle and its `SHA256SUMS` into a private temporary directory.
2. Verify the bundle's SHA-256 against the published manifest and print both digests so you can compare them against the release page, then unpack it. The plugin package carried inside the bundle is verified against the same manifest before it is used.
3. Prepare the isolated profile from the verified plugin package.

Pinning is explicit: `--tag` selects a released tag, and every artifact is verified before it is used. `curl -fsSL` without a pipe writes the asset to disk so it can be inspected; nothing is executed before the checksum matches. If an artifact is missing from `SHA256SUMS`, or its digest differs, the installer refuses and creates nothing. The bundle is unpacked only after its own members have been checked for absolute paths and parent traversal.

Downloads run over `https` only. GitHub answers a release-asset request with one redirect to its asset host, so the installer follows redirects hop by hop and validates every hop against a fixed two-host allowlist (`github.com` and `release-assets.githubusercontent.com`). A redirect anywhere else is refused before the response body is read, and the digest check applies to whatever was finally downloaded.

When you override `DSH_INSTALL_SOURCE` with a `file://` mirror, that directory must hold **both** the installer bundle and the plugin package, along with `SHA256SUMS`. Supplying only the plugin package fails with `ENOENT` for the bundle.

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

## Consolidate on server-side compaction (opt-in)

By default Harness condenses history locally while the bridge also requests Codex server-side compaction, so both can summarize. To let Codex own condensation for this provider, enable the agent preset this package ships.

The pinned Harness keeps the compaction backend *inside its standard, ptc and cordis agent presets* (`preset-minimal` has no compaction group), each as an isolated `compaction` group, and disables the top-level `compaction-basic` and `command-compact` rows; the preset registry default resolves to `standard`. A preset is a complete declaration, so the only way to replace one child is to restate the whole composition: this package ships `presets/codex-subscription.patch.yml`, a mirror of the shipped standard preset whose `compaction` group runs `dsh-codex-subscription-bridge/compaction` instead. See [the composition evidence](VERIFICATION.md#preset-owned-compaction-2026-10-16).

**The preset is inserted disabled, so installing this package changes nothing.** Enable it by adding one entry to the profile's `cordis.patch.yml` (for example `~/.dsh/profiles/desktop/cordis.patch.yml`), then restart Harness:

```yaml
- id: preset-codex-subscription
  disabled: false
```

The Plugins page lists the row, but its switch is locked for a row the Host can only address through the profile patch (hovering the switch states the Host's reason), so this entry is the enable step rather than a toggle. The profile patch is applied after every bundle, which is why an override this small reaches a row a bundle declares.

Then optionally set it as the new-task default in **Settings → Agent presets**; otherwise select "Codex subscription" in the preset chip when starting a session.

Removing the package does not remove that entry, because the installer never writes `cordis.patch.yml`; delete the line when you uninstall, or the loader reports an unmatched patch entry on every start. An isolated profile needs no cleanup — the whole directory goes away.

The replacement extends the host's stock engine and delegates every provider except `codex-subscription`, whose routes then rely on the encrypted server-side window. Every other preset keeps the stock engine, so other providers are unaffected.

Before relying on it, confirm all three behaviors after the restart:

- A conversation on a subscription model raises no new `compaction/start` event.
- A conversation on any other provider still condenses as before.
- `/compact` still works (the replacement provides the same `compaction` service); disabling compaction entirely is not the intent.

Know the failure modes before enabling it:

- **It depends on a host-internal class.** The module subclasses `@deepseek-ai/dsh-compaction-basic`, which the Harness bundle provides. If a harness upgrade removes or renames that package, the preset fails its activation audit and **only that preset stops composing**; `preset-standard` and the other shipped presets keep working, and the Plugins page shows the row as failed to load. Disable the row to restore the stock behavior.
- **It mirrors a pinned composition.** The preset copies the shipped standard list, so a Harness release that adds, removes or reconfigures a child leaves this copy stale until it is regenerated with `npm run preset:sync` (the profile verification path runs `npm run preset:check` and fails on drift). A release that changes the `compaction` group's shape is the dangerous case: the swap stops applying and double summarization silently returns, which the drift check is what catches.
- **A harness upgrade can also soften it.** If the reconciled method changes shape, the override stops applying and the replacement behaves exactly like the stock engine: nothing breaks, but server-side consolidation no longer happens.
- **Nothing bounds the local transcript.** The encrypted window is opaque and belongs to one account, model, instructions, tools and input prefix; switching models, resuming the same conversation after 24 hours, or editing history refuses it. The bridge then resends the bounded local history; if that exceeds its window-derived text or tool-history wire bounds, or the 1024-item bound, the turn fails with `COMPACTION_UNAVAILABLE` and asks for a new conversation. See [the compaction contract](COMPACTION.md).
- **The context indicator keeps growing.** Harness prices the retained local surface, not the compacted request, so usage display does not reflect the server-side window.

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

Open Settings → ChatGPT subscription → Log in. The panel shows a temporary one-time sign-in code that you can click to copy, and a fixed `https://auth.openai.com/codex/device` link; paste or enter the code on that page and approve it in your browser. Harness polls for completion and updates the panel, then model observers refresh.

The code is not an access token and disappears after cancellation, completion, or failure. Do not share it, and do not put it in logs or an issue. **Cancel login** stops a pending login, **Refresh status** reads only local state, and **Log out** removes only this plugin's local grant after confirmation without revoking provider sessions.

The generated auth helper remains optional for developer/recovery diagnosis; doctor does not contact OpenAI or create a missing store. Never paste codes or credentials into an issue.

The helper exposes `login`, `status`, `doctor`, and `logout`. From a source checkout it is `node src/auth-cli.js <command>`; the packaged command is `dsh-codex-subscription-auth`. Run it with the same inherited HOME as Harness. A Web profile also gets its own `auth.sh`, which passes that profile's HOME explicitly; a Desktop profile has no helper, because the plugin imports host peers that only the application resolves, so sign-in, status and logout happen in the settings panel there. `doctor` does not contact OpenAI, and `logout` removes only this plugin's local login: it does not revoke tokens server-side or change Codex's login. For diagnosis and recovery see [the troubleshooting guide](TROUBLESHOOTING.md).

Credentials are stored in `~/.dsh-codex-subscription-bridge/auth.json` with a 0700 directory and 0600 file; a dedicated Desktop launch with `DSH_HOME` stores the grant under `$DSH_HOME/.dsh-codex-subscription-bridge/auth.json` instead. This is plaintext storage protected by filesystem permissions, not a keyring. Never upload, paste, commit, or copy that file into an issue.

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
