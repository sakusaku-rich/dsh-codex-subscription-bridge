# Packaged Harness verification

## Reproducible baseline

`verification/runtime` pins Harness CLI 0.2.1-rc.2 and a separate complete lockfile. Install with scripts disabled. The plugin's shipped package does not include this verification runtime or add its dependencies to the host.

```sh
npm ci --ignore-scripts --prefix verification/runtime
DSH_VERIFY_CLI="$PWD/verification/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js" npm run test:profile
```

`scripts/verify-profile.mjs` creates a disposable HOME, Harness home, profile, workspace, cache, and authentication directory. It installs the actual local npm tarball offline and supplies the exact host peer modules. No existing profile, token file, or credential keyring is copied or read by the bridge.

The test executes the official `runProfile` composition API and the public CLI with the shipped base and SDK bundles. It checks provider registration, missing-auth refusal propagation, configured SDK text conversation through in-memory synthetic HTTPS responses, and complete shutdown. The test also plants a project `.env` with an alternative `CODEX_HOME` and a synthetic API key; the child must retain the inherited authentication location and receive no API key.

The synthetic fixture creates a dedicated disposable OAuth store and replaces HTTPS only within its verification child process. It does not establish real subscription access or GUI behavior.

## Dependency findings

An initial ordinary install of Harness 0.2.0-rc.2 reported 12 npm audit entries from two underlying advisories (including dependent-package repetitions):

- [MCP OAuth issuer binding advisory](https://github.com/advisories/GHSA-6qxp-vccf-f47h): `@modelcontextprotocol/client` versions before 2.2.0 can misdirect OAuth credentials in affected HTTP-client configurations. The bridge does not use this client and does not expose MCP tools.
- [fflate ZIP64 denial-of-service advisory](https://github.com/advisories/GHSA-px8p-9vwx-vf98): malformed archives can cause an infinite loop before fflate 0.8.3.

A later advisory moved the client pin again:

- [MCP cross-origin redirect advisory](https://github.com/advisories/GHSA-6prh-2h8m-c8cw): `@modelcontextprotocol/client` versions before 2.3.0 follow cross-origin redirects in HTTP transports and OAuth requests and re-send custom headers and request bodies. Dependabot could not open an update because the pinned Harness dependency range does not admit 2.3.0, so the runtime override pins the fixed version directly. The bridge rejects redirects and does not use this client.

The owned verification runtime overrides:

| Package | Fixed version |
| --- | --- |
| `@modelcontextprotocol/client` | `2.3.1` |
| `@modelcontextprotocol/core` | `2.3.1` |
| `fflate` | `0.8.3` |

After these overrides, npm audit reported zero known vulnerabilities and the packaged profile checks passed again. The client and core pins moved from 2.2.0 to 2.3.1 when the cross-origin redirect advisory landed; 2.2.0 remains the security fix for the issuer-binding advisory above. This result applies to the locked test runtime, not an existing installation. MCP and Office surfaces are outside this project's scope, so the overrides establish nothing about them.
