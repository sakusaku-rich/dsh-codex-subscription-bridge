import { PROVIDER } from './text.js';

/** The request-header config shape this bridge checks. */
export type RouteConfig = { provider?: string } | undefined;

/** The agent shape this bridge reads the request header config from. */
export type RouteAgent = { session?: { requestHeader?: () => { config?: RouteConfig } } } | undefined;

/** The stock compaction engine shape this bridge's class extends. */
export interface StockEngine {
  // The host Agent type is not re-exported here, so the agent argument stays untyped.
  compactIfNeeded(agent: any, trigger: unknown, signal?: AbortSignal): unknown;
}

/** Whether one request header config belongs to this bridge's subscription provider. */
export function ownsSubscriptionCompaction(route: RouteConfig): boolean {
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
// The base is a host class whose constructor signature this package cannot name.
export function createSubscriptionCompactionEngine(Base: new (...args: any[]) => StockEngine) {
  return class SubscriptionCompactionEngine extends Base {
    override async compactIfNeeded(agent: RouteAgent, trigger: unknown, signal?: AbortSignal): Promise<unknown> {
      const route = agent?.session?.requestHeader?.()?.config;
      if (ownsSubscriptionCompaction(route)) return null;
      return super.compactIfNeeded(agent, trigger, signal);
    }
  };
}
