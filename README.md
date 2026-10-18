# dsh-codex-subscription-bridge

A minimal DeepSeek Harness provider that connects directly to the Codex subscription backend using a dedicated ChatGPT OAuth login. It forwards Harness tool definitions and executed tool-call history, and sends user message images as base64 `input_image` data URLs. The bridge never executes tools itself; execution stays in the Harness host.

"OpenAI", "ChatGPT", and "Codex" are trademarks of OpenAI. This project is an independent tool and is not affiliated with, endorsed by, or sponsored by OpenAI or DeepSeek. Whether connecting a ChatGPT subscription through this adapter is permitted under the applicable terms is unverified; review the applicable terms before use.

## Requirements

- A ChatGPT subscription with Codex backend access, and device-code sign-in enabled for the account or workspace.
- macOS on Apple Silicon with Node 22.23.3, pinned by `.node-version` and `.nvmrc`, for the standalone CLI/SDK/Web provider; Linux, Windows, Intel macOS, and other runtimes are rejected before authentication.
- DeepSeek Harness Desktop 0.2.0-rc.2 is additionally supported only with its exact Electron 44.0.0 / Node 24.18.1 host pair. See [the support matrix](docs/INSTALL.md#support-and-prerequisites).
- An installed DeepSeek Harness Desktop 0.2.0-rc.2 to add the bridge to, or a released, integrity-verified artifact to prepare a new isolated profile from. A Desktop profile additionally requires the verified Desktop host pair. Installing into a normal profile is supported only through the documented `--profile` path, which backs the profile up first.

## Install and sign in

Download the installer, then run it. Nothing is executed before the checksum matches, and no download is piped into a shell: the file is written to disk first, so you can read it before it runs.

Both examples below name the same tag on purpose. Downloading `install.sh` from `releases/latest` would pair a newer installer with an older `--tag`, so pin both together and replace `v0.0.4` with the release you reviewed.

### Into the Desktop profile you already use

This adds the bridge to your Desktop profile and keeps the settings, credentials and other plugins already there. Restart the application afterwards.

```sh
curl -fsSLO https://github.com/sakusaku-rich/dsh-codex-subscription-bridge/releases/download/v0.0.4/install.sh
sh install.sh --tag v0.0.4 --profile "$HOME/.dsh/profiles/desktop" --surface desktop
```

It modifies a profile you are using, so it backs up `package.json` and the lockfile first, uses the pnpm bundled with Desktop, leaves `cordis.patch.yml` untouched, and restores the backup if the install fails. To undo it, copy those files back over the profile and re-run the same pnpm install. See [the installation guide](docs/INSTALL.md#into-an-existing-desktop-profile).

### Into a new isolated profile

Use this instead when you want the bridge kept apart from your normal profile. Nothing outside the new directory is touched, and the destination's parent must already exist.

```sh
curl -fsSLO https://github.com/sakusaku-rich/dsh-codex-subscription-bridge/releases/download/v0.0.4/install.sh
mkdir -p artifacts
sh install.sh --tag v0.0.4 --directory "$PWD/artifacts/subscription-web"
sh artifacts/subscription-web/start.sh
```

For Desktop, add `--surface desktop` and start the generated `desktop.sh`. An isolated profile starts without your existing plugins or settings, which is the point of it.

### Sign in

In Harness, open **Settings → ChatGPT subscription**, click **Log in**, and approve the displayed one-time code on the linked OpenAI page. Select `Codex (ChatGPT subscription)` and an advertised model, then start a conversation.

[The installation guide](docs/INSTALL.md) covers the support matrix, what each surface prepares and launches, the sign-in panel's controls, credential storage, updates without mutating a running installation, and removal. Desktop preparation and its sign-in steps are described in [the Desktop guide](docs/DESKTOP_VERIFICATION.md).

## Harness configuration

Use the bundle in a dedicated isolated profile prepared by [the installation guide](docs/INSTALL.md), or in an existing Desktop profile through that guide's `--profile` path; the Desktop host also loads it in [its separate verification profile](docs/DESKTOP_VERIFICATION.md). The adapter has no configuration keys:

```yaml
- id: llm-codex-subscription
  config: {}
```

Any configuration key fails with `CONFIG_INVALID`, and no tokens, endpoints, or `.env` credential locations are accepted. Models are fetched live from your visible subscription catalog; seeing a model listed does not establish entitlement to a successful request.

## Compaction

Harness condenses history locally, and the bridge also asks the subscription route to condense server-side, replaying the encrypted window it returns on later turns. A turn whose response published a window is marked "Server-side compaction" in that turn's work details, with the model and the window's item count. This is confirmed on a real account, including a model switch that refused the older window, resent the bounded history and issued a new one. [Compaction design, research and limits](docs/COMPACTION.md) records what a window covers, which refusals count as contradictions, and the wire bounds that force a new conversation.

To let Codex own condensation for this provider's routes instead, enable the agent preset this package ships. It is inserted disabled, so installing the package changes nothing until you add this to the profile's `cordis.patch.yml` and restart Harness:

```yaml
- id: preset-codex-subscription
  disabled: false
```

Then optionally set "Codex subscription" as the new-task default in **Settings → Agent presets**.

Before enabling it, know that:

- Only this provider's routes change. Every other provider, and every other preset, keeps the stock engine.
- The preset subclasses a host-internal class and mirrors the pinned Harness composition, so a Harness upgrade can stop that one preset from composing, or leave the mirror stale. The dangerous case is a reshaped `compaction` group, which silently restores double summarization. [The installation guide](docs/INSTALL.md#consolidate-on-server-side-compaction-opt-in) records those failure modes, the checks to run after restarting, and how a source checkout detects drift.
- Delete that line when you remove the package, as [the installation guide](docs/INSTALL.md#remove-this-dedicated-installation) explains.

## What the provider sends and enforces

- Requests are sent with `store: true`, and a conversation is chained through `previous_response_id` only for a chain this bridge established and can prove from Harness replay metadata; a chain that cannot be proven is refused and the full bounded history is sent. The record holds a bounded response id and integrity digests, not conversation content. Each model advertises the reasoning levels the backend discloses for it (for example `low`, `medium`, `high`, `xhigh`, `max`, `ultra`) together with any disclosed default, so Harness offers the effort selector; the chosen id is forwarded verbatim.
- Harness tool definitions are validated and forwarded, and executed tool-call history is forwarded as `function_call`/`function_call_output` items; the bridge never executes tools itself.
- User message images are sent as `input_image` data URLs. Oversized requests fail with `IMAGE_OFFLOAD_REQUIRED` so the Harness host can offload its oldest images and retry, and image blocks in other roles are rejected.
- `temperature` (finite, 0–2) is validated and forwarded; `maxTokens` (safe integer, 1–1,000,000) is accepted as an advisory budget but deliberately not forwarded; `stop` sequences are rejected with a fixed `UNSUPPORTED_OPTION` error.
- HTTP 429 responses are classified by the backend: a recognized plan usage limit becomes terminal `QUOTA`, optionally with a "Try again in about N minutes." hint, while any other 429 stays transient `RATE_LIMIT`.
- Non-image file attachments are not provider input (the Harness runtime projects them to text first). Search, quota display, and remote access remain outside the initial scope.

## Status

This is an experimental prototype. Synthetic verification covers authentication, refresh, streaming, cancellation, tool-call passthrough, image input, and packaged Harness CLI/SDK composition. Real-account evidence covers sign-in, multi-turn generation, more than nine hundred forwarded tool calls, the disclosed reasoning levels, and server-side compaction issuance, reuse and model-switch handling; [the verification record](docs/VERIFICATION.md#real-account-evidence-and-limits) records exactly what is confirmed and what remains unverified. Do not treat this prototype as a completed security audit.

## Development

Harness 0.2.0-rc.2 and Cordis 4.0.4 remain pinned, and the shipped plugin needs no dependency lifecycle scripts. The reproducible check commands are recorded in [the verification record](docs/VERIFICATION.md#reproducible-checks), including the packaged profile checks.

A real-account check is separate and requires authorization. The prepared `scripts/smoke-account.mjs --allow-real-account` command sends one fixed short prompt using the dedicated login. It may consume subscription quota and refresh this plugin's stored tokens. It has not been run for the direct implementation.

[CI](.github/workflows/ci.yml) runs the same reproducible checks on a GitHub-hosted macOS runner with the exact `.node-version`, installing both lockfiles with lifecycle scripts disabled; it never uses subscription credentials or real-account calls. See [continuous integration](docs/VERIFICATION.md#continuous-integration) for the workflow details.

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

Pull requests are always welcome, including bug fixes, tests, documentation, and security improvements. Report problems, including vulnerabilities, as GitHub Issues; see [the security requirements](SECURITY.md). Keep changes focused, use English for repository content, and include relevant verification results. Please read [AGENTS.md](AGENTS.md) and [the security requirements](SECURITY.md) before contributing.

## License

Licensed under the [MIT License](LICENSE). Copyright (c) 2026 sakusaku-rich. Dependencies retain their own licenses. This license applies to this project and does not grant rights to OpenAI services or override their terms.
