# Live-access release blocker

## Decision

Keep `createProductionSession()` closed with `AUTHORITY_UNVERIFIED` until native
operations and inherited configuration can be constrained before any user input
or authentication-backed model dispatch. The production entry point does not
accept a session factory, credentials, executable, or authority bypass setting.
The injected factory in the internal bridge is only a synthetic testing seam.

This follows the repository requirement: "Prove native Codex tool restrictions
before accepting real conversation input." A read-only sandbox is insufficient
because it can still permit private reads, and a model-visible tool omission
alone does not prove that a dispatch-only handler cannot run.

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

## Remaining implementation work

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
