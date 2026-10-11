# Packaged Harness verification

## Reproducible baseline

`verification/runtime` pins Harness CLI 0.2.0-rc.2 and a separate complete
lockfile. Install with scripts disabled. The plugin's shipped package does not
include this verification runtime or add its dependencies to the host.

```sh
npm ci --ignore-scripts --prefix verification/runtime
DSH_VERIFY_CLI="$PWD/verification/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js" npm run test:profile
```

`scripts/verify-profile.mjs` creates a disposable HOME, Harness home, profile,
workspace, cache, and authentication directory. It installs the actual local
npm tarball offline and supplies the exact host peer modules. No existing
profile, token file, or credential keyring is copied or read by the bridge.

The test executes the official `runProfile` composition API and the public CLI
with the shipped base and SDK bundles. It checks provider registration,
unconfigured refusal propagation, configured SDK text conversation through a
synthetic Codex executable, and complete shutdown. The test also plants a
project `.env` with an alternative `CODEX_HOME` and a synthetic API key; the
child must retain the inherited authentication location and receive no API key.

The synthetic Codex fixture exercises the public configured launcher. The
separate real-Codex/localhost-provider tests exercise the exact binary, version
admission, native-tool restrictions, and protocol history/streaming. Neither
lane establishes real subscription access or GUI behavior.

## Dependency findings

An initial ordinary install of Harness 0.2.0-rc.2 reported 12 npm audit entries
from two underlying advisories (including dependent-package repetitions):

- [MCP OAuth issuer binding advisory](https://github.com/advisories/GHSA-6qxp-vccf-f47h):
  `@modelcontextprotocol/client` versions before 2.2.0 can misdirect OAuth
  credentials in affected HTTP-client configurations. The bridge does not use
  this client, and native Codex MCP capabilities are disabled.
- [fflate ZIP64 denial-of-service advisory](https://github.com/advisories/GHSA-px8p-9vwx-vf98):
  malformed archives can cause an infinite loop before fflate 0.8.3.

The owned verification runtime overrides:

| Package | Fixed version |
| --- | --- |
| `@modelcontextprotocol/client` | `2.2.0` |
| `@modelcontextprotocol/core` | `2.2.0` |
| `fflate` | `0.8.3` |

After these overrides, npm audit reported zero known vulnerabilities and the
packaged profile checks passed again. This result applies to the locked test
runtime, not an existing installation. It does not establish MCP OAuth behavior
or Office archive handling compatibility; neither feature is used in the test.

The MCP advisory also requires issuer-aware credential persistence for affected
existing OAuth state and providers. A version update alone is not a universal
migration remedy. No MCP OAuth state was created or migrated in this verification.
Review the advisory before applying any fix to an existing deployment.

No PR, issue, package publication, or normal-profile installation was performed.
