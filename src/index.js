import { assertNodeVersion, assertPlatform } from './runtime.js';
import { HarnessError, LlmAdapter } from '@deepseek-ai/dsh-llm';
import { PROVIDER } from './text.js';
import { DirectBridge } from './direct.js';
import { AuthStore, authDirectory } from './auth.js';
import { authenticationEnvironment } from './environment.js';
import { BridgeError, failure } from './errors.js';
export const name = 'dsh-codex-subscription-bridge';
export const inject = ['llm'];
class SubscriptionAdapter extends LlmAdapter {
  constructor(environment) { super(); this.bridge = new DirectBridge(new AuthStore(authDirectory(environment))); }
  providerInfo() { return { id: PROVIDER, name: 'Codex (ChatGPT subscription, text only)' }; }
  providerRetryPolicy() { return { mode: 'normal', maxRetries: 0, retryableCodes: [], initialDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 }; }
  async listModels(provider) {
    if (provider !== PROVIDER) throw new BridgeError('INPUT_UNSUPPORTED');
    try { return await this.bridge.listModels(); }
    catch (error) { const safe = failure(error); throw new HarnessError(safe.message, safe.code); }
  }
  async resolveModel(provider, model, signal) {
    if (provider !== PROVIDER) throw new BridgeError('INPUT_UNSUPPORTED');
    try { const models = await this.bridge.listModels(signal); const found = models.find(entry => entry.id === model);
      if (!found) throw new BridgeError('MODEL_UNAVAILABLE'); return found; }
    catch (error) { const safe = failure(error); throw new HarnessError(safe.message, safe.code); }
  }
  async *stream(options) {
    try { yield* this.bridge.stream(options); }
    catch (error) { const safe = failure(error); yield { type: 'finish', reason: { kind: safe.code === 'ABORTED' ? 'aborted' : 'error', failure: safe } }; }
  }
}
export function apply(ctx, config = {}) {
  assertNodeVersion(); assertPlatform();
  if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).length) throw new BridgeError('CONFIG_INVALID');
  const adapter = new SubscriptionAdapter(authenticationEnvironment(ctx));
  ctx.effect(() => { const unregister = ctx.llm.registerAdapter([PROVIDER], adapter);
    return async () => { unregister(); await adapter.bridge.close(); }; }, 'codex-subscription: register direct adapter');
}
