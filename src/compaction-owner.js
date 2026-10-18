import { PROVIDER } from './text.js';

/** Whether one request header config belongs to this bridge's subscription provider. */
export function ownsSubscriptionCompaction(route) {
  return route?.provider === PROVIDER;
}

/**
 * Build the opt-in compaction backend class for a stock engine.
 *
 * The stock backend condenses retained history locally. This bridge's requests
 * condense server-side instead, so the returned class returns without
 * summarizing for its own provider and delegates every other provider to the base
 * engine unchanged. The base class is supplied by the caller, which keeps this
 * decision testable without the host package mounted.
 * @param Base - the stock compaction engine class to extend.
 * @returns a plugin class that provides the same `compaction` service.
 */
export function createSubscriptionCompactionEngine(Base) {
  return class SubscriptionCompactionEngine extends Base {
    async compactIfNeeded(agent, trigger, signal) {
      const route = agent?.session?.requestHeader?.()?.config;
      if (ownsSubscriptionCompaction(route)) return null;
      return super.compactIfNeeded(agent, trigger, signal);
    }
  };
}
