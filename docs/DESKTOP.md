# Desktop verification

## Scope

macOS Desktop 0.2.0-rc.2, build `5e9e301dd9dc8923b2762f76dacfc5751f6ca851`, uses Electron 44.0.0 / Node 24.18.1 for plugins, not the separate tools Node. The exact pair is admitted after synthetic store/refresh/cancellation/streaming, packaged CLI/SDK, and installed Desktop runtime/profile verification. Full GUI and real subscription behavior still require manual verification. Other Desktop versions and Intel macOS are not claimed as verified.

The host bundles Undici 7.29.0. Plugin HTTP instead uses bundled Undici 7.29.1 and an owned Agent; host global fetch and dispatcher are not used. This addresses the plugin's dependency baseline without changing Desktop. It does not fix or establish security of other Electron, Chromium, or Harness features. [Upstream Undici advisory](https://github.com/nodejs/undici/security/advisories/GHSA-rfgv-xxqx-mfg5). [Electron 44.0.0 release](https://releases.electronjs.org/release/v44.0.0).

## Prepare a separate profile

From a reviewed checkout, with the standalone Node 22.23.3 used for preparation:

```sh
npm ci --ignore-scripts
npm ci --ignore-scripts --prefix verification/runtime
mkdir -p artifacts
npm run prepare:desktop -- --directory "$PWD/artifacts/desktop-verification"
```

The new directory must not exist. The script verifies the installed application at `/Applications/DeepSeek Harness.app`, prepares an actual npm artifact offline, and selects the application's runtime resolver for its exact host peers. It creates only a new Harness home, profile, workspace, and helpers; it does not edit Desktop, the normal Harness profile, or existing account files. Keep the installed Desktop available at that path. There is no credential copying.

The prepared directory records package integrity, commit and Desktop build. `auth.sh` runs the installed Electron in Node mode; `desktop.sh` runs its normal GUI. No login or GUI is automatically started by preparation.

## Owner-operated real-account check

1. Quit every existing DeepSeek Harness Desktop instance normally. The app uses a single-instance lock; otherwise the new invocation may focus the old window.
2. Start `sh artifacts/desktop-verification/desktop.sh` from Terminal, keeping it open. This launcher is only for selecting the dedicated verification profile.
3. Open **Settings → ChatGPT subscription**. Click **Log in**, click the displayed one-time sign-in code to copy it, and paste it on the linked OpenAI page. The panel updates after approval; no authentication script is needed for this flow.
4. Select `Codex (ChatGPT subscription)` and an advertised model. Send a short prompt, then ask a follow-up. Tool passthrough and image input are implemented but unverified against the real backend, so record separately whether tool calls and images work. Cancel another turn and verify a later request still works. These requests consume allowance and can refresh this login.
5. Record the reviewed commit, model and pass/fail result. Share only fixed error labels; never share codes, auth files, bootstrap URLs or raw logs/bodies.
6. Use **Log out** in the same settings section to remove the local login when finished. Quit Desktop before filesystem recovery/removal.

The generated `auth.sh` remains an optional developer/recovery tool, not the normal sign-in flow. See [the authentication UI](AUTH_UI.md).

With the helper's explicit DSH_HOME, credentials are located at `<directory>/harness/.dsh-codex-subscription-bridge/auth.json`. Desktop's login-shell HOME merge cannot redirect this store. A bare standalone auth CLI uses its own HOME-based location instead, so always use the generated helper for this profile.

The separate Harness home isolates this profile, sessions and dedicated login. Electron OS preferences, logs, single-instance handling and updater state are not claimed to be isolated. This is not an OS sandbox. Desktop may perform its ordinary anonymous policy/update checks. The agent has not launched the full GUI or authenticated against real services during automated verification.

## Developer checks

For the installed application, without real authentication:

```sh
DSH_DESKTOP_EXECUTABLE="/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" npm run test:desktop
```

This checks the runtime pair, root suite, packaged CLI/SDK synthetic conversation, and a disposable profile against installed Desktop's ASAR runtime resolver. The CI alternative pins Electron 44.0.0 under `verification/desktop`, explicitly runs its checksum-verifying binary downloader, and runs the same host checks. The actual installed-ASAR lane is local only; CI does not have Harness Desktop.

For updates, use a new reviewed checkout/artifact and a new directory. After a Desktop update the exact host guard may refuse startup; revalidate instead of bypassing it. Stop the profile, log out with its helper, and remove only its reviewed dedicated directory when finished. See [recovery](RECOVERY.md).
