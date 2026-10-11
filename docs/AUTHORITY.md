# Authority isolation

## Current decision

The public adapter now uses the versioned isolated launcher only when a trusted
absolute executable and an explicit credential store are configured. Missing
configuration fails with `CONFIG_REQUIRED`; arbitrary permissions, process
arguments, raw tokens, API-key modes, and migration fallback are unsupported.

The full credential-free binary and packaged Harness SDK tests pass. A real
account is still an explicitly authorized verification step, not an automated
baseline test. Only macOS with the pinned CLI is admitted.

This follows the requirement to establish tool restrictions before user input.
It does not treat a read-only sandbox as filesystem read confinement. Codex's
own process, OS, host, and dependencies remain trusted.

## Evidence examined

On 2026-10-11 the installed CLI reported `codex-cli 0.144.6`. Only version/help
and protocol generation commands ran, not app-server sessions or model requests.
Generated TypeScript protocol files were examined with experimental fields.
The candidate upstream tag is `rust-v0.144.6`, resolving to
`1e66aaa95b5ab39d3ef3057cd50bdecd576a8356`.

Primary sources:

- [Tool registration at the candidate tag](https://github.com/openai/codex/blob/rust-v0.144.6/codex-rs/core/src/tools/spec_plan.rs):
  `add_shell_tools` returns without an environment. Apply-patch and view-image
  registration also require an environment. MCP, extension, dynamic,
  collaboration, and hosted tools use separate paths. A plan tool is added
  unconditionally.
- [Configuration merging](https://github.com/openai/codex/blob/rust-v0.144.6/codex-rs/config/src/merge.rs):
  table overlays merge recursively. An empty table is not evidence that an
  existing table has been cleared.
- [Effective core configuration](https://github.com/openai/codex/blob/rust-v0.144.6/codex-rs/core/src/config/mod.rs):
  inherited MCP registrations, plugin-provided MCP, model providers, and
  orchestration settings have separate resolution paths.
- [Official app-server documentation](https://learn.chatgpt.com/docs/app-server):
  account modes, local stdio, ephemeral threads, and turn permission overrides.

Inference: `environments: []`, `approvalPolicy: never`, and an empty restricted
read sandbox do not by themselves prove the required containment. This
investigation does not prove that no supported isolation mechanism exists.

## Original prerequisite checklist (historical)

1. Establish a supported way to isolate configuration and prevent every
   external native capability before initialization. This includes MCP,
   extensions, hooks, plugins, skills and context reads, inherited provider
   URLs, proxies, and model-catalog-controlled capabilities. Preserve Codex's
   ownership of its existing managed login without copying credentials.
2. Verify those controls using the exact release and a synthetic HOME/config
   containing adversarial settings. Use fake providers/MCP/hooks and private
   sentinel files; no real account is needed for this part.
3. Wire a production launcher with a trusted absolute executable and exact
   version admission. Validate real protocol history injection, notifications,
   and effective sandbox settings against that launcher.
4. Verify the packaged plugin with the full pinned Harness bundle loader in a
   temporary profile. The current package test covers the real LLM service,
   not the complete host.
5. Only after those pass, obtain explicit authorization for a real account and
   model smoke test. Disclose account maintenance performed by Codex.

Neither instructions telling the model to avoid tools nor terminating after a
native-tool event meets the pre-dispatch isolation requirement. Do not replace
the gate with an undocumented opt-in flag. If upstream cannot provide the
required isolation, reconsider the integration architecture with the owner.

## Isolation investigation, second stage

A source-backed replacement path exists in the pinned binary:
`debug.config_lockfile.load_path` loads an authoritative configuration layer,
retaining the selected `CODEX_HOME` and managed requirements. It is not an empty
TOML overlay. The tagged object above peels to source commit
`5d1fbf26c43abc65a203928b2e31561cb039e06d`.

An exported lock was generated under a synthetic HOME with all registered
features disabled, no project documents, no history persistence, no hooks,
plugins, MCP, application tools, remote models, memories, or skill instructions.
The generated lock is stored under `assets/`, with temporary log/database paths
rendered at runtime. A private temporary HOME and cwd prevent ordinary home and
project skill/document discovery, while the explicit existing `CODEX_HOME` can
remain Codex's authentication location. The bridge never opens authentication
files.

Real-binary experiments, without any login, established:

- An adversarial existing config can report its original provider in
  `config/read` while the created thread uses the lock's `openai` provider.
  Therefore `config/read` is not a valid effective-lock attestation.
- The locked configuration creates a credential-free ephemeral thread and
  rejects a lock with a different Codex version.
- With a test-only authentication-free localhost provider, only `update_plan`
  was model-visible. A forced `exec_command` returned an unsupported-tool
  result and did not create its execution marker.

`update_plan` remains an internal, non-filesystem tool. These observations do not
establish a general-purpose OS sandbox or authorize real-account execution.

The integration test exposed a prototype schema error: the installed 0.144.6
`SandboxPolicy` uses `readOnly` with required `networkAccess`; it does not expose
the newer documented `access.readableRoots` field. The existing mock accepted an
invalid request. A proposed correction and test were rejected by automatic
approval review because `readOnly` may allow broad filesystem reads. The owner subsequently authorized correction and credential-free revalidation.
The change now uses the pinned schema: `readOnly` with `networkAccess: false`. An additional restrictive
macOS Seatbelt launch attempt exited before Codex startup, so it has not been
accepted as a verified alternative.

The isolated launcher is now connected to the public adapter behind explicit
executable and credential-store configuration. The unconfigured route never
launches Codex.
The full credential-free protocol/adapter test now passes, including history
injection, visible text streaming, native execution rejection, and absence of
the synthetic private sentinel in model requests. This does not prove OS-level
read confinement: `readOnly` still permits broad reads by trusted Codex itself.
The launcher has additionally been exercised through the pinned Harness
loader and public SDK CLI using synthetic authentication. Real-account
verification remains a separately authorized activity.

## Authentication mode and storage

`account/read` normalizes external ChatGPT tokens to a ChatGPT account summary.
The pinned legacy `getAuthStatus` endpoint exposes the precise backing mode;
the bridge calls it with both `includeToken: false` and `refreshToken: false`.
Only `authMethod: chatgpt` with `authToken: null` is admitted. The API-key
file-rejection test uses a synthetic auth file and verifies that it is unchanged.
The bridge never calls login, logout, token import, or config-read endpoints.

The storage selector is explicit (`file` or `keyring`) and is embedded into the
same authoritative lock. There is no automatic credential-store migration.
The launcher preserves the inherited `CODEX_HOME` or inherited HOME default,
while using a private child HOME/cwd and temporary database/log paths. The
launcher snapshot's process layer prevents a project dotenv file from replacing
the authentication location. Real keyring access remains unverified.

Harness's tool declarations are discarded metadata; they are not forwarded to
Codex and cannot enlarge its fixed authority. Actual tool-call/result messages
remain unsupported. The bridge emits text blocks only, including separate
assistant items, and never translates a Codex tool call into a Harness action.

The currently outstanding checks are explicitly authorized real-account access,
keyring behavior, authentication refresh/revocation, and Desktop/Web GUI behavior.
