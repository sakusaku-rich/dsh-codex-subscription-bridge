# Initial scope

Use a dedicated ChatGPT OAuth login to connect Harness directly to the Codex subscription backend. No Codex process or token import is required.

Expose live visible models, stream bounded text history with forwarded Harness tool definitions and executed tool-call history, accept user message image blocks as `input_image` data URLs, support cancellation, and produce credential-safe errors. Server-side compaction carries bounded encrypted windows through Harness replay metadata and marks each turn that published one in the chat, and an opt-in agent preset can replace local condensation for this provider while other providers keep the stock backend; see [compaction design and research](COMPACTION.md).

Initial exclusions: browser PKCE fallback, existing token import, keyring, credential pools, API keys, custom endpoints, tool execution by the bridge, stop-sequence overrides, search and quota UI. Non-image file attachments are rejected defensively, because the Harness runtime already projects file blocks to text before dispatch (see the input mapping in [direct connection architecture](ARCHITECTURE.md)).

Acceptance is proven by the synthetic checks recorded in [verification](VERIFICATION.md): dedicated authentication, private storage, bounded transport and history, validated tool and image passthrough with offload budgets, cancellation, shutdown, and packaged Harness CLI/SDK composition. Real-account verification was authorized later and is recorded in the same document; it covers sign-in, multi-turn generation, tool turns and server-side compaction, and what remains open is listed there.

See [direct connection architecture](ARCHITECTURE.md) and [security requirements](../SECURITY.md).
