import { isAbsolute } from 'node:path';
import { HarnessError, LlmAdapter } from '@deepseek-ai/dsh-llm';
import { SubscriptionBridge, PROVIDER } from './bridge.js';
import { createProductionSession } from './process.js';
import { authenticationEnvironment } from './environment.js';
import { BridgeError, failure } from './errors.js';

export const name = 'dsh-codex-subscription-bridge';
export const inject = ['llm'];
class SubscriptionAdapter extends LlmAdapter {
  constructor(executable, environment, credentialStore) { super(); this.bridge = new SubscriptionBridge(() => createProductionSession(executable, environment, credentialStore)); }
  providerInfo() { return { id: PROVIDER, name: 'Codex (ChatGPT subscription, text only)' }; }
  providerRetryPolicy() { return { mode: 'normal', maxRetries: 0, retryableCodes: [], initialDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 }; }
  async listModels(provider) {
    if (provider !== PROVIDER) throw new BridgeError('INPUT_UNSUPPORTED');
    try { return await this.bridge.listModels(); }
    catch (error) { const safe = failure(error); throw new HarnessError(safe.message, safe.code); }
  }
  async resolveModel(provider, model, signal) {
    if (provider !== PROVIDER) throw new BridgeError('INPUT_UNSUPPORTED');
    let models;
    try { models = await this.bridge.listModels(signal); }
    catch (error) { const safe = failure(error); throw new HarnessError(safe.message, safe.code); }
    const found = models.find((entry) => entry.id === model);
    if (!found) throw new BridgeError('MODEL_UNAVAILABLE');
    return found;
  }
  async *stream(options) {
    try { yield* this.bridge.stream(options); }
    catch (error) {
      const safe = failure(error);
      yield { type: 'finish', reason: { kind: safe.code === 'ABORTED' ? 'aborted' : 'error', failure: safe } };
    }
  }
}
export function apply(ctx, config = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).some((key) => !['executable', 'credentialStore'].includes(key))) throw new BridgeError('CONFIG_INVALID');
  const executable = config.executable;
  if (executable !== undefined && (typeof executable !== 'string' || !isAbsolute(executable) || /[\x00\r\n]/u.test(executable))) throw new BridgeError('CONFIG_INVALID');
  if (config.credentialStore !== undefined && !['file', 'keyring'].includes(config.credentialStore)) throw new BridgeError('CONFIG_INVALID');
  const adapter = new SubscriptionAdapter(executable, authenticationEnvironment(ctx), config.credentialStore);
  ctx.effect(() => {
    const unregister = ctx.llm.registerAdapter([PROVIDER], adapter);
    return async () => { unregister(); await adapter.bridge.close(); };
  }, 'codex-subscription: register guarded adapter');
}
