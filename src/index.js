import { assertNodeVersion, assertPlatform } from './runtime.js';
import { HarnessError, LlmAdapter, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm';
import { PROVIDER } from './text.js';
import { DirectBridge } from './direct.js';
import { AuthStore, authDirectory } from './auth.js';
import { authenticationEnvironment } from './environment.js';
import { BridgeError, failure } from './errors.js';
import { installAuthUi } from './auth-ui.js';
export const name = 'dsh-codex-subscription-bridge';
export const inject = ['llm'];
class SubscriptionAdapter extends LlmAdapter {
  constructor(environment, context = {}) { super(); this.bridge = new DirectBridge(new AuthStore(authDirectory(environment)), undefined, {}, context); }
  providerInfo() { return { id: PROVIDER, name: 'Codex (ChatGPT subscription)' }; }
  providerRetryPolicy() { return { mode: 'normal', maxRetries: 0, retryableCodes: [], initialDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 }; }
  async listModels(provider) {
    if (provider !== PROVIDER) throw new BridgeError('INPUT_UNSUPPORTED');
    try { return await this.bridge.listModels(); }
    catch (error) { const safe = failure(error); throw new HarnessError(safe.message, safe.code); }
  }
  async resolveModel(provider, model, signal) {
    if (provider !== PROVIDER) throw new BridgeError('INPUT_UNSUPPORTED');
    try { const models = await this.bridge.listModels(signal); const found = models.find(entry => entry.id === model);
      if (!found) throw new BridgeError('MODEL_UNAVAILABLE');
      // The context exposed here is the adapter-declared window the host's
      // compaction requires; an undisclosed window stays omitted. Reasoning is
      // declared only from the backend's own disclosure, which is what makes the
      // host's effort selector available.
      const reasoning = found.reasoningLevels === undefined ? undefined : {
        efforts: found.reasoningLevels,
        ...(found.defaultReasoningLevel === undefined ? {} : { defaultEffort: found.defaultReasoningLevel }),
      };
      return { ...found,
        ...(found.contextWindow === undefined ? {} : { context: { contextWindow: found.contextWindow } }),
        ...(reasoning === undefined ? {} : { reasoning }) }; }
    catch (error) { const safe = failure(error); throw new HarnessError(safe.message, safe.code); }
  }
  async *stream(options) {
    try { yield* this.bridge.stream(options); }
    catch (error) { const safe = failure(error); yield { type: 'finish', reason: { kind: safe.code === 'ABORTED' ? 'aborted' : 'error', failure: safe } }; }
  }
  imageRequestPricing(provider, model) { return this.bridge.imageRequestPricing(provider, model); }
  // The host measures and renders the request image through this hook, so it has
  // to return the same projection the bridge's serializer uses.
  imageRequestTarget(provider, model, image) { return this.bridge.imageRequestTarget(provider, model, image); }
}
export function apply(ctx, config = {}) {
  assertNodeVersion(); assertPlatform();
  if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).length) throw new BridgeError('CONFIG_INVALID');
  const adapter = new SubscriptionAdapter(authenticationEnvironment(ctx), {
    // Mirror the DeepSeek adapter's host wiring so image placeholders, request
    // serialization, and pricing resolve attachments through one resolver.
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(attachments, hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath), ref),
    // Diagnose a refused compaction checkpoint in the host log without ever
    // exposing opaque state or request content.
    warn: message => ctx.logger?.warn?.(message),
  });
  ctx.effect(() => { const unregister = ctx.llm.registerAdapter([PROVIDER], adapter);
    // The settings page describes a route only through the configurable-provider
    // directory, so the bridge declares its own entry with the authentication it
    // performs: no credential reference, no endpoint environment, and a stored
    // OAuth sign-in as the only way to authenticate. The bridge still owns no
    // configurable settings, so the entry carries no endpoint facts and any
    // non-empty config stays refused above.
    const directory = ctx.llm.registerConfigurableProviders([{
      provider: PROVIDER, displayName: 'Codex (ChatGPT subscription)',
      settingsNs: 'llm-codex-subscription', settingsPath: [], declared: false,
      nativeAuth: { env: [], oauth: true },
    }]);
    let active = true;
    installAuthUi(ctx, adapter.bridge.auth, () => {
      adapter.bridge.cache = undefined;
      if (active) unregister.replace([PROVIDER]);
    });
    return async () => { active = false; unregister(); directory(); await adapter.bridge.close(); }; }, 'codex-subscription: register direct adapter');
}
