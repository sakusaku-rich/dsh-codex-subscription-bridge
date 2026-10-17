# Desktop verification

## Scope

macOS Desktop 0.2.0-rc.2, build `5e9e301dd9dc8923b2762f76dacfc5751f6ca851`, uses Electron 44.0.0 / Node 24.18.1 for plugins, not the separate tools Node. The exact pair is admitted after synthetic store/refresh/cancellation/streaming, packaged CLI/SDK, and installed Desktop runtime/profile verification. Full GUI and real subscription behavior still require manual verification. Other Desktop versions and Intel macOS are not claimed as verified, and a different Desktop version requires fresh compatibility verification: do not bypass the host guard or edit a Desktop-bundled runtime.

The host bundles Undici 7.29.0. Plugin HTTP instead uses bundled Undici 7.29.1 and an owned Agent; host global fetch and dispatcher are not used. This addresses the plugin's dependency baseline without changing Desktop. It does not fix or establish security of other Electron, Chromium, or Harness features. [Upstream Undici advisory](https://github.com/nodejs/undici/security/advisories/GHSA-rfgv-xxqx-mfg5). [Electron 44.0.0 release](https://releases.electronjs.org/release/v44.0.0).

## Prepare a separate profile

Two preparation paths produce the same Desktop profile: a one-command install from a published release, and the source-checkout install used for development and recovery.

From a published release, download and read `install.sh`, then select the Desktop surface:

```sh
sh install.sh --tag v0.0.4 --directory "$PWD/artifacts/desktop-profile" --surface desktop
```

From a reviewed checkout, with the standalone Node 22.23.3 used for preparation:

```sh
npm ci --ignore-scripts
npm ci --ignore-scripts --prefix verification/runtime
mkdir -p artifacts
npm run prepare:desktop -- --directory "$PWD/artifacts/desktop-verification"
```

The new directory must not exist. Both paths verify the installed application at `/Applications/DeepSeek Harness.app`, install an actual npm artifact offline, and select the application's runtime resolver for its exact host peers. They create only a new Harness home, profile, workspace, and helpers; they do not edit Desktop, the normal Harness profile, or existing account files. Keep the installed Desktop available at that path. There is no credential copying.

The prepared directory records package integrity and Desktop build; the release path records the release tag and verified digest instead of a commit. Both surfaces list the web application bundle, because the Desktop host reads `ctx.connection` and `ctx.webServer` while booting, before any profile is served. `desktop.sh` runs the normal GUI. No login or GUI is automatically started by preparation.

Neither preparation path writes an `auth.sh` for a Desktop profile. An earlier revision did, and it never worked reliably: it launched the plugin directly rather than through the application's profile boot, so the host peers the plugin imports were resolved only by Node's ordinary directory walk. A profile that happened to sit under a tree also containing those peers made the helper appear to work, which is why the failure looked intermittent.

The helper is not replaced, because the application already provides everything it offered: sign-in, status and logout are in the settings panel, which is the supported path for every Desktop profile. The Web surface keeps its helper, since that profile carries its own runtime and the helper resolves correctly there. Use the in-app panel for Desktop diagnosis.

## Owner-operated real-account check

1. Quit every existing DeepSeek Harness Desktop instance normally. The app uses a single-instance lock; otherwise the new invocation may focus the old window.
2. Start `sh artifacts/desktop-verification/desktop.sh` from Terminal, keeping it open. This launcher is only for selecting the dedicated verification profile.
3. Open **Settings → ChatGPT subscription**. Click **Log in**, click the displayed one-time sign-in code to copy it, and paste it on the linked OpenAI page. The panel updates after approval; no authentication script is needed for this flow.
4. Select `Codex (ChatGPT subscription)` and an advertised model. Send a short prompt, then ask a follow-up. Tool passthrough has since been exercised on this runtime (hundreds of forwarded calls across the plugin's own sessions); image input is implemented but unverified against the real backend, so record separately whether images work. Cancel another turn and verify a later request still works. These requests consume allowance and can refresh this login.
5. Record the reviewed commit, model and pass/fail result. Share only fixed error labels; never share codes, auth files, bootstrap URLs or raw logs/bodies.
6. Use **Log out** in the same settings section to remove the local login when finished. Quit Desktop before filesystem recovery/removal.

Sign-in, status and logout all happen in the in-app panel described in [the README](../README.md); this surface has no command-line equivalent.

Credentials for this profile are located at `<directory>/harness/.dsh-codex-subscription-bridge/auth.json`. Desktop's login-shell HOME merge cannot redirect this store, which is why the launcher sets DSH_HOME explicitly; a bare standalone auth CLI would use its own HOME-based location instead, and would inspect a different store. This path is what to inspect when locating the dedicated store for recovery or removal.

The separate Harness home isolates this profile, sessions and dedicated login. Electron OS preferences, logs, single-instance handling and updater state are not claimed to be isolated. This is not an OS sandbox. Desktop may perform its ordinary anonymous policy/update checks. The agent has not launched the full GUI or authenticated against real services during automated verification.

## Developer checks

For the installed application, without real authentication:

```sh
DSH_DESKTOP_EXECUTABLE="/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" npm run test:desktop
```

This checks the runtime pair, root suite, packaged CLI/SDK synthetic conversation, and a disposable profile against installed Desktop's ASAR runtime resolver. The CI alternative pins Electron 44.0.0 under `verification/desktop`, explicitly runs its checksum-verifying binary downloader, and runs the same host checks. The actual installed-ASAR lane is local only; CI does not have Harness Desktop.

For updates, use a new reviewed checkout/artifact and a new directory. After a Desktop update the exact host guard may refuse startup; revalidate instead of bypassing it. Stop the profile, log out in the settings panel (this surface has no helper), and remove only its reviewed dedicated directory when finished. See [troubleshooting](TROUBLESHOOTING.md).
