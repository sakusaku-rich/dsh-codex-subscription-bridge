# dsh-codex-subscription-bridge

A minimal DeepSeek Harness provider that connects directly to the Codex subscription backend using a dedicated ChatGPT OAuth login.

It forwards Harness tool definitions and executed tool-call history. It sends user message images as base64 `input_image` data URLs. The bridge never executes tools itself; execution stays in the Harness host.

"OpenAI", "ChatGPT", and "Codex" are trademarks of OpenAI.

This project is an independent tool. It is not affiliated with, endorsed by, or sponsored by OpenAI or DeepSeek.

Whether connecting a ChatGPT subscription through this adapter is permitted under the applicable terms is unverified. Review the applicable terms before use.

## Requirements

- A ChatGPT subscription with Codex backend access.
- Device-code sign-in enabled for the account or workspace.
- macOS on Apple Silicon with Node 22.23.3 for the standalone CLI/SDK/Web provider. The version is pinned by `.node-version` and `.nvmrc`. Linux, Windows and other runtimes are rejected before authentication. Intel macOS passes the platform gate but is not independently verified.
- DeepSeek Harness Desktop 0.2.1-rc.2 is the supported Desktop host, and only with its exact Electron 44.7.0 / Node 24.21.0 host pair. See [the support matrix](docs/INSTALL.md#support-and-prerequisites).
- An installed DeepSeek Harness Desktop 0.2.1-rc.2 to add the bridge to, or a released, integrity-verified artifact to prepare a new isolated profile from. A Desktop profile additionally requires the verified Desktop host pair.

Installing into a normal profile is supported only through the documented `--profile` path. That path backs the profile up first.

## Install and sign in

Download the installer, then run it. Nothing is executed before the checksum matches. No download is piped into a shell: the file is written to disk first, so you can read it before it runs.

Both examples below name the same tag on purpose. Downloading `install.sh` from `releases/latest` would pair a newer installer with an older `--tag`. Pin both together, and replace `v0.0.4` with the release you reviewed.

### Into the Desktop profile you already use

This adds the bridge to your Desktop profile. It keeps the settings, credentials and other plugins already there. Restart the application afterwards.

```sh
curl -fsSLO https://github.com/sakusaku-rich/dsh-codex-subscription-bridge/releases/download/v0.0.4/install.sh
sh install.sh --tag v0.0.4 --profile "$HOME/.dsh/profiles/desktop" --surface desktop
```

It modifies a profile you are using. It backs up `package.json` and the lockfile first. It uses the pnpm bundled with Desktop. It leaves `cordis.patch.yml` untouched. It restores the backup if the install fails.

To undo it, copy those files back over the profile and re-run the same pnpm install. See [the installation guide](docs/INSTALL.md#into-an-existing-desktop-profile).

### Into a new isolated profile

Use this instead when you want the bridge kept apart from your normal profile. Nothing outside the new directory is touched. The destination's parent must already exist.

```sh
curl -fsSLO https://github.com/sakusaku-rich/dsh-codex-subscription-bridge/releases/download/v0.0.4/install.sh
mkdir -p artifacts
sh install.sh --tag v0.0.4 --directory "$PWD/artifacts/subscription-web"
sh artifacts/subscription-web/start.sh
```

For Desktop, add `--surface desktop` and start the generated `desktop.sh`. An isolated profile starts without your existing plugins or settings. That is the point of it.

### Sign in

In Harness, open **Settings → ChatGPT subscription** and click **Log in**. Approve the displayed one-time code on the linked OpenAI page. Select `Codex (ChatGPT subscription)` and an advertised model, then start a conversation.

- [The installation guide](docs/INSTALL.md) covers the support matrix, what each surface prepares and launches, the sign-in panel's controls, credential storage, updates without mutating a running installation, and removal.
- [The Desktop guide](docs/DESKTOP_VERIFICATION.md) covers Desktop preparation and its sign-in steps.

## Harness configuration

Use the bundle in a dedicated isolated profile prepared by [the installation guide](docs/INSTALL.md). Alternatively, use an existing Desktop profile through that guide's `--profile` path. The Desktop host also loads it in [its separate verification profile](docs/DESKTOP_VERIFICATION.md). The adapter has no configuration keys:

```yaml
- id: llm-codex-subscription
  config: {}
```

Any configuration key fails with `CONFIG_INVALID`. No tokens, endpoints, or `.env` credential locations are accepted.

Models are fetched live from your visible subscription catalog. Seeing a model listed does not establish entitlement to a successful request.

## Compaction

Harness condenses history locally. The bridge also asks the subscription backend to condense server-side over a stateless request form (`store: false`), so no server-side conversation is kept.

A turn whose response published a compaction is marked "Server-side compaction" in that turn's work details. The marker shows the model and the number of items in the saved window.

[Compaction design, research and limits](docs/COMPACTION.md) records the stateless request shape, the window binding, the wire bounds, the oldest-end recovery, and the differences deliberately not closed.

To let Codex own condensation for this provider instead, enable the agent preset this package ships. It is inserted disabled. Installing the package therefore adds no selectable preset and changes no compaction behavior until you add this to the profile's `cordis.patch.yml` and restart Harness:

```yaml
- id: preset-codex-subscription
  disabled: false
```

Then optionally set "Codex subscription" as the new-task default in **Settings → Agent presets**.

Before enabling it, know that:

- Only this provider's behavior changes. Every other provider, and every other preset, keeps the stock engine.
- The preset subclasses a host-internal class. It also mirrors the pinned Harness composition. A Harness upgrade can therefore stop that one preset from composing, or leave the mirror stale.
  The dangerous case is a reshaped `compaction` group, which silently restores double summarization.
  [The installation guide](docs/INSTALL.md#consolidate-on-server-side-compaction-opt-in) records those failure modes, the checks to run after restarting, and how a source checkout detects drift.
- Delete that line when you remove the package, as [the installation guide](docs/INSTALL.md#remove-this-dedicated-installation) explains.

## What the provider sends and enforces

- Requests are stateless (`store: false`): the bridge keeps no server-side conversation and replays the bounded compaction window it can prove. [The compaction design](docs/COMPACTION.md#state-and-validation) records what happens when a window cannot be proven.
- Each model advertises the reasoning levels the backend discloses for it (for example `low`, `medium`, `high`, `xhigh`, `max`, `ultra`), together with any disclosed default. Harness offers the effort selector, and the chosen id is forwarded verbatim.
- Harness tool definitions are validated and forwarded. Executed tool-call history is forwarded as `function_call`/`function_call_output` items. The bridge never executes tools itself.
- User message images are sent as `input_image` data URLs. Image blocks in other roles are rejected.
  Oversized requests fail with `IMAGE_OFFLOAD_REQUIRED`, so the Harness host can offload its oldest images and retry.
- `temperature` (finite, 0–2) is validated and forwarded.
  `maxTokens` (safe integer, 1–1,000,000) is accepted as an advisory budget but deliberately not forwarded.
  `stop` sequences are rejected with a fixed `UNSUPPORTED_OPTION` error.
- HTTP 429 responses are classified by the backend. A recognized plan usage limit becomes terminal `QUOTA`, optionally with a "Try again in about N minutes." hint. Any other 429 stays transient `RATE_LIMIT`.
- Non-image file attachments are not provider input. The Harness runtime projects them to text first. Search, quota display, and remote access remain outside the initial scope.

## Status

This is an experimental prototype.

Synthetic verification covers authentication, refresh, streaming, cancellation, tool-call passthrough, image input, and packaged Harness CLI/SDK composition.

Real-account evidence covers sign-in, multi-turn generation, more than nine hundred forwarded tool calls, the disclosed reasoning levels, and server-side compaction issuance, reuse and model-switch handling.

[The verification record](docs/VERIFICATION.md#real-account-evidence-and-limits) records exactly what is confirmed and what remains unverified. Do not treat this prototype as a completed security audit.

## Development

Harness 0.2.1-rc.2 and Cordis 4.0.5 remain pinned. The shipped plugin needs no dependency lifecycle scripts. The reproducible check commands are recorded in [the verification record](docs/VERIFICATION.md#reproducible-checks), including the packaged profile checks.

A real-account check is separate and requires authorization. The prepared `scripts/smoke-account.mjs --allow-real-account` command sends one fixed short prompt using the dedicated login. It may consume subscription quota. It may refresh this plugin's stored tokens. It has not been run for the direct implementation.

[CI](.github/workflows/ci.yml) runs the same reproducible checks on a GitHub-hosted macOS runner with the exact `.node-version`. It installs both lockfiles with lifecycle scripts disabled. It never uses subscription credentials or real-account calls. See [continuous integration](docs/VERIFICATION.md#continuous-integration) for the workflow details.

## Documentation

- [Initial scope](docs/SCOPE.md) — what the initial release includes and excludes.
- [Installation guide](docs/INSTALL.md) — the release and source install paths, updates, removal, and the support matrix.
- [Desktop verification](docs/DESKTOP_VERIFICATION.md) — the separate Desktop host profile and its launcher.
- [Direct connection architecture](docs/ARCHITECTURE.md) — behavior guarantees and limits.
- [Compaction design and limits](docs/COMPACTION.md) — server-side windows, refusals, and the local fallback.
- [Authentication panel design](docs/UI_DESIGN.md) — the sign-in panel's visual and interaction policy.
- [Security requirements](SECURITY.md) — controls, problem reporting, and supported versions.
- [Verification record](docs/VERIFICATION.md) — what was verified, the reproducible checks, and CI.
- [Local diagnosis and recovery](docs/TROUBLESHOOTING.md) — recovery from lock, refresh, and quota problems.
- [Packaged Harness verification](docs/PACKAGED_VERIFICATION.md) — the reproducible packaged baseline.

## Contributing

Pull requests are always welcome, including bug fixes, tests, documentation, and security improvements. Report problems, including vulnerabilities, as GitHub Issues; see [the security requirements](SECURITY.md). Keep changes focused. Use English for repository content. Include relevant verification results. Please read [AGENTS.md](AGENTS.md) and [the security requirements](SECURITY.md) before contributing.

## License

Licensed under the [MIT License](LICENSE). Copyright (c) 2026 sakusaku-rich. Dependencies retain their own licenses. This license applies to this project. It does not grant rights to OpenAI services or override their terms.
