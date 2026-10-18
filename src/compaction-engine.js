import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';
import { createSubscriptionCompactionEngine } from './compaction-owner.js';

/**
 * Opt-in replacement for the stock `compaction-basic` profile row.
 *
 * It provides the same `compaction` service and delegates every provider except
 * this bridge's own, whose requests rely on Codex server-side compaction. Mount it
 * only by disabling `compaction-basic` and inserting this module in a profile
 * patch; see the opt-in composition and its limits in docs/COMPACTION.md.
 */
export default createSubscriptionCompactionEngine(BasicCompactionEngine);
