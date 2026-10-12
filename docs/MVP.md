# MVP requirements

Use a dedicated ChatGPT OAuth login to connect Harness directly to the Codex subscription backend. No Codex process or token import is required.

Expose live visible models, stream bounded text history, support cancellation, and produce credential-safe errors. Repository and product text remain English.

Initial exclusions: browser PKCE fallback, existing token import, keyring, credential pools, API keys, custom endpoints, tools, images, search and quota UI.

Acceptance requires synthetic dedicated login/refresh/logout, private storage, concurrent updates, terminal failure quarantine, fixed-origin HTTPS, bounded SSE, authentication-aware catalog caching, text history isolation, cancellation, shutdown, and actual packaged Harness CLI/SDK composition. Real OAuth/service/UI verification is a separately authorized step.

See [direct connection design](DIRECT.md) and [security requirements](../SECURITY.md).
