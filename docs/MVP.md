# MVP requirements

Use a dedicated ChatGPT OAuth login to connect Harness directly to the Codex subscription backend. No Codex process or token import is required.

Expose live visible models, stream bounded text history with forwarded Harness tool definitions and executed tool-call history, accept user message image blocks as `input_image` data URLs, support cancellation, and produce credential-safe errors.

Initial exclusions: browser PKCE fallback, existing token import, keyring, credential pools, API keys, custom endpoints, tool execution by the bridge, stop-sequence overrides, search and quota UI. Non-image file attachments need no bridge handling (see the input mapping in [direct connection design](DIRECT.md)).

Acceptance is proven by the synthetic checks recorded in [verification](VERIFICATION.md): dedicated authentication, private storage, bounded transport and history, validated tool and image passthrough with offload budgets, cancellation, shutdown, and packaged Harness CLI/SDK composition. Real OAuth/service/UI verification is a separately authorized step.

See [direct connection design](DIRECT.md) and [security requirements](../SECURITY.md).
