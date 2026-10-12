# dsh-codex-subscription-bridge

A minimal DeepSeek Harness provider that connects directly to the Codex subscription backend using a dedicated ChatGPT OAuth login. It forwards Harness tool definitions and executed tool-call history, and sends user message images as base64 `input_image` data URLs. The bridge never executes tools itself; execution stays in the Harness host.

"OpenAI", "ChatGPT", and "Codex" are trademarks of OpenAI. This project is an independent tool and is not affiliated with, endorsed by, or sponsored by OpenAI or DeepSeek. Whether connecting a ChatGPT subscription through this adapter is permitted under the applicable terms is unverified; review the applicable terms before use.

## Requirements

- A ChatGPT subscription with Codex backend access, and device-code sign-in enabled for the account or workspace.
- macOS on Apple Silicon with Node 22.23.3, pinned by `.node-version` and `.nvmrc`, for the standalone CLI/SDK/Web provider; Linux, Windows, Intel macOS, and other runtimes are rejected before authentication.
- DeepSeek Harness Desktop 0.2.0-rc.2 is additionally supported only with its exact Electron 44.0.0 / Node 24.18.1 host pair. See [the support matrix](docs/INSTALL.md#support-and-prerequisites).
- An isolated Harness profile built from a reviewed full commit SHA. No published npm release exists, and normal-profile installation is not supported.

## Install and sign in

1. Follow [the installation guide](docs/INSTALL.md) to prepare the isolated source-checkout profile and start it. The same guide covers updates without mutating a running installation and removal; Desktop uses [its separate verification profile](docs/DESKTOP_VERIFICATION.md).
2. In Harness, open **Settings → ChatGPT subscription** and click **Log in**. The panel shows a temporary one-time sign-in code that you can click to copy, and a fixed `https://auth.openai.com/codex/device` link; paste or enter the code on that page and approve it in your browser. Harness polls for completion and updates the panel, then model observers refresh. The code is not an access token and disappears after cancellation, completion, or failure; do not share it or put it in logs. **Cancel login** stops a pending login, **Refresh status** reads only local state, and **Log out** removes only this plugin's local grant after confirmation without revoking provider sessions.
3. Select `Codex (ChatGPT subscription)` and an advertised model, then start a conversation.

`node src/auth-cli.js login`, `status`, `doctor`, and `logout` from the checkout remain an optional developer/recovery path; the packaged command is `dsh-codex-subscription-auth`. Run it with the same inherited HOME as Harness (Desktop uses its generated `auth.sh`). `doctor` does not contact OpenAI, and `logout` removes only this plugin's local login — it does not revoke tokens server-side or change Codex's login. For diagnosis and recovery see [the troubleshooting guide](docs/TROUBLESHOOTING.md).

Credentials are stored in `~/.dsh-codex-subscription-bridge/auth.json` with a 0700 directory and 0600 file; a dedicated Desktop launch with `DSH_HOME` stores the grant under `$DSH_HOME/.dsh-codex-subscription-bridge/auth.json` instead. This is plaintext storage protected by filesystem permissions, not a keyring. Never upload, paste, commit, or copy that file into an issue.

## Harness configuration

Use the bundle only in a dedicated isolated profile prepared by [the installation guide](docs/INSTALL.md); the Desktop host loads it in [its separate verification profile](docs/DESKTOP_VERIFICATION.md). The adapter has no configuration keys:

```yaml
- id: llm-codex-subscription
  config: {}
```

Any configuration key fails with `CONFIG_INVALID`, and no tokens, endpoints, or `.env` credential locations are accepted. Models are fetched live from your visible subscription catalog; seeing a model listed does not establish entitlement to a successful request.

## What the provider sends and enforces

- Only bounded text history is sent, with `store: false`; no conversation IDs are resumed or chained. Reasoning effort maps to `low` or `high`.
- Harness tool definitions are validated and forwarded as strict function tools, and executed tool-call history is forwarded as `function_call`/`function_call_output` items; the bridge never executes tools itself.
- User message images are sent as `input_image` data URLs. Oversized requests fail with `IMAGE_OFFLOAD_REQUIRED` so the Harness host can offload its oldest images and retry, and image blocks in other roles are rejected.
- `temperature` (finite, 0–2) is validated and forwarded; `maxTokens` (safe integer, 1–1,000,000) is accepted as an advisory budget but deliberately not forwarded; `stop` sequences are rejected with a fixed `UNSUPPORTED_OPTION` error.
- HTTP 429 responses are classified by the backend: a recognized plan usage limit becomes terminal `QUOTA`, optionally with a "Try again in about N minutes." hint, while any other 429 stays transient `RATE_LIMIT`.
- Non-image file attachments are not provider input (the Harness runtime projects them to text first). Search, quota display, and remote access remain outside the initial scope.

## Status

This is an experimental prototype. Synthetic verification covers authentication, refresh, streaming, cancellation, tool-call passthrough, image input, and packaged Harness CLI/SDK composition. Real-account evidence is limited; [the verification record](docs/VERIFICATION.md#real-account-evidence-and-limits) records exactly what is confirmed and what remains unverified. Do not treat this prototype as a completed security audit.

## Development

Harness 0.2.0-rc.2 and Cordis 4.0.4 remain pinned, and the shipped plugin needs no dependency lifecycle scripts. The reproducible check commands are recorded in [the verification record](docs/VERIFICATION.md#reproducible-checks), including the packaged profile checks.

A real-account check is separate and requires authorization. The prepared `scripts/smoke-account.mjs --allow-real-account` command sends one fixed short prompt using the dedicated login. It may consume subscription quota and refresh this plugin's stored tokens. It has not been run for the direct implementation.

[CI](.github/workflows/ci.yml) runs the same reproducible checks on a GitHub-hosted macOS runner with the exact `.node-version`, installing both lockfiles with lifecycle scripts disabled; it never uses subscription credentials or real-account calls. See [continuous integration](docs/VERIFICATION.md#continuous-integration) for the workflow details.

## Documentation

- [Initial scope](docs/SCOPE.md) — what the initial release includes and excludes.
- [Installation guide](docs/INSTALL.md) — profile preparation, updates, removal, and the support matrix.
- [Desktop verification](docs/DESKTOP_VERIFICATION.md) — the separate Desktop host profile and its launcher.
- [Direct connection architecture](docs/ARCHITECTURE.md) — behavior guarantees and limits.
- [Authentication panel design](docs/UI_DESIGN.md) — the sign-in panel's visual and interaction policy.
- [Security requirements](SECURITY.md) — controls, problem reporting, and supported versions.
- [Verification record](docs/VERIFICATION.md) — what was verified, the reproducible checks, and CI.
- [Local diagnosis and recovery](docs/TROUBLESHOOTING.md) — recovery from lock, refresh, and quota problems.
- [Packaged Harness verification](docs/PACKAGED_VERIFICATION.md) — the reproducible packaged baseline.

## Contributing

Pull requests are always welcome, including bug fixes, tests, documentation, and security improvements. Report problems, including vulnerabilities, as GitHub Issues; see [the security requirements](SECURITY.md). Keep changes focused, use English for repository content, and include relevant verification results. Please read [AGENTS.md](AGENTS.md) and [the security requirements](SECURITY.md) before contributing.

Never include credentials, device codes, authentication files, or raw authenticated responses in issues or pull requests.

## License

Licensed under the [MIT License](LICENSE). Copyright (c) 2026 sakusaku-rich. Dependencies retain their own licenses. This license applies to this project and does not grant rights to OpenAI services or override their terms.
