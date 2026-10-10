# dsh-codex-subscription-bridge

A minimal DeepSeek Harness plugin that uses an existing Codex ChatGPT
subscription login through the official local Codex app-server.

## Status

Design baseline only. The runtime plugin is not implemented and is not ready
for installation. No real account authentication or model requests have been
tested. This repository is private; no distribution license has been selected.

## Initial scope

- Select models available to the authenticated Codex account.
- Stream text conversations inside DeepSeek Harness.
- Cancel an in-progress request and clean up its process resources.

Codex owns authentication, token refresh, and credential storage. The plugin
communicates with Codex over local stdio JSON-RPC and does not extract tokens or
call OpenAI model endpoints itself. API-key authentication is outside the scope.

The first version does not include search, image generation, quota display,
remote control, custom OAuth, or a Harness tool bridge. Codex's native tools
require separate enforcement; omitting Harness tools alone does not disable
them.

## Project documents

- [MVP requirements and acceptance criteria](docs/MVP.md)
- [Security requirements and limitations](SECURITY.md)
- [Development instructions](AGENTS.md)

This is an independent project and is not affiliated with or endorsed by OpenAI
or DeepSeek. Subscription eligibility, model access, and limits remain subject
to the user's account and the upstream products.
