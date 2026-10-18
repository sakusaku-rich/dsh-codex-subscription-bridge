import { BridgeError } from './errors.js';
import { digest, contentDigest } from './hashes.js';
import { TEXT_LIMIT, TOOL_BYTES_LIMIT, MESSAGE_LIMIT, INPUT_BYTES_FLOOR, RETAINED_INPUT_BYTES_FLOOR, RETAINED_TEXT_LIMIT, RETAINED_TOOL_BYTES_LIMIT, RETAINED_MESSAGE_LIMIT } from './text.js';

// The marker reads this record. In a stateful turn nothing is replayed, so the
// record is a count of what the route compacted, not content the bridge carries.
export const CHECKPOINT_KEY = 'subscriptionCompactionV1';
// Per-item bound for wire validation. A single SSE frame is already bounded to
// 1 MiB, so this is the floor used when no window is disclosed.
export const CHECKPOINT_BYTES = 512 * 1024;
// The subscription route's own client measures the active context against a
// limit derived from the disclosed window and a per-model effective percent.
// The percent is read from the catalog when it is disclosed; this ratio is the
// fallback for an undisclosed model. The byte bound below is a guard, not a
// token guarantee, and the route compares its own rendered count against the
// number sent here.
export const COMPACT_RATIO = 0.95;
export const PERCENT_MAX = 100;
export const BYTES_PER_TOKEN = 8;

// The failing stage travels on the thrown error, so this module owns the whole
// label vocabulary and never copies a value out of a response.
const fail = reason => { const error = new BridgeError('PROTOCOL_INVALID', 'COMPACTION'); error.stage = reason; throw error; };
const stage = error => (error instanceof BridgeError && typeof error.stage === 'string' ? error.stage : 'UNKNOWN');
const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && Buffer.byteLength(value) <= max;

function textParts(values, type, limit, tags) {
  if (!Array.isArray(values) || values.length > 64) return fail(tags[0]);
  let bytes = 0;
  return values.map(part => {
    if (part?.type !== type || typeof part.text !== 'string' || part.text.length > limit) return fail(tags[1]);
    bytes += Buffer.byteLength(part.text);
    if (bytes > limit) return fail(tags[2]);
    return { type, text: part.text };
  });
}

/** Only this allowlisted, bounded wire state is accepted; nothing is persisted. */
function item(value, limit = CHECKPOINT_BYTES) {
  if (!value || typeof value !== 'object') return fail('ITEM_VALUE');
  if (value.type === 'compaction') {
    if (!text(value.encrypted_content, limit) || (value.id !== undefined && !text(value.id, 256))) return fail('ITEM_COMPACTION');
    return { type: 'compaction' };
  }
  if (value.type === 'message') {
    if (value.role !== 'assistant') return fail('ITEM_MESSAGE');
    return { type: 'message', role: 'assistant', content: textParts(value.content, 'output_text', TEXT_LIMIT, ['MSG_SHAPE', 'MSG_PART', 'MSG_BYTES']) };
  }
  if (value.type === 'function_call') {
    if (!text(value.call_id, 256) || !text(value.name, 64) || !/^[A-Za-z0-9_-]+$/u.test(value.name) ||
        typeof value.arguments !== 'string' || Buffer.byteLength(value.arguments) > limit) return fail('ITEM_FUNCTION_CALL');
    let args;
    try { args = JSON.parse(value.arguments); } catch { return fail('ITEM_FUNCTION_CALL_ARGS'); }
    if (!args || typeof args !== 'object' || Array.isArray(args)) return fail('ITEM_FUNCTION_CALL_ARGS');
    return { type: 'function_call', call_id: value.call_id, name: value.name, arguments: value.arguments };
  }
  if (value.type === 'reasoning') {
    if (!text(value.id, 256) || !Array.isArray(value.summary) || value.summary.length > 64 ||
        (value.encrypted_content !== undefined && !text(value.encrypted_content, limit))) return fail('ITEM_REASONING');
    return { type: 'reasoning', id: value.id, summary: textParts(value.summary, 'summary_text', limit, ['SUM_SHAPE', 'SUM_PART', 'SUM_BYTES']),
      ...(value.encrypted_content === undefined ? {} : { encrypted_content: value.encrypted_content }) };
  }
  return fail('ITEM_UNKNOWN');
}

/**
 * Capture output order, including tool calls after the last compaction item.
 *
 * A turn that cannot prove its compaction happened publishes nothing: the answer
 * was already delivered, and failing the turn over a marker would discard it. The
 * first refusal label is kept for the host log.
 */
export class CompactionCapture {
  constructor(limit = CHECKPOINT_BYTES) { this.observed = new Map(); this.unindexed = false; this.refusal = undefined; this.limit = limit; }
  /** Record the first reason nothing was published; labels are local. */
  refuse(reason) { this.refusal ??= reason; return undefined; }
  observe(event) {
    try {
      if (event.item?.type === 'compaction') item(event.item, this.limit);
      if (!Number.isSafeInteger(event.output_index) || event.output_index < 0 || event.output_index >= 128) {
        this.unindexed = true;
        return;
      }
      const previous = this.observed.get(event.output_index);
      if (previous && digest(previous) !== digest(event.item)) return this.refuse('OBSERVE_DUPLICATE');
      this.observed.set(event.output_index, event.item);
    } catch (error) { return this.refuse(stage(error)); }
  }
  finish(output, scope, plan, blocks, now = Date.now()) {
    try { return this.build(output, scope, plan, blocks, now); }
    // A marker is not part of the answer: failing to prove one never fails the turn.
    catch (error) { return this.refuse(stage(error)); }
  }
  build(output, scope, plan, blocks, now) {
    const terminal = Array.isArray(output) ? output : undefined;
    const streamed = [...this.observed.values()];
    if (!terminal?.some(value => value?.type === 'compaction') && !streamed.some(value => value?.type === 'compaction')) return undefined;
    // The streamed order is authoritative: the subscription route omits items
    // from the terminal array (observed as a missing index on a real
    // compaction), so positional agreement with it cannot be required. A
    // terminal compaction item that exists and disagrees is still a
    // contradiction and publishes nothing.
    const streamedCompaction = streamed.find(value => value?.type === 'compaction');
    const terminalCompaction = terminal?.find(value => value?.type === 'compaction');
    if (streamedCompaction !== undefined && terminalCompaction !== undefined
        && digest(item(terminalCompaction, this.limit)) !== digest(item(streamedCompaction, this.limit))) return this.refuse('COMPACTION_MISMATCH');
    let ordered;
    if (!this.unindexed && this.observed.size > 0) ordered = [...this.observed].sort(([a], [b]) => a - b).map(([, value]) => value);
    else if (terminal !== undefined) ordered = terminal;
    else return this.refuse('NO_ORDER');
    const last = ordered.findLastIndex(value => value?.type === 'compaction');
    if (last < 0) return undefined;
    // A text delta without its completed output item cannot be attributed to the
    // compacted part, so the turn is not marked.
    const represented = ordered.flatMap(value => value.type === 'message'
      ? (Array.isArray(value.content) ? value.content.map(part => ({ type: 'text', text: part.text })) : [])
      : value.type === 'function_call' ? [{ type: 'tool-call', id: value.call_id, name: value.name, arguments: value.arguments }] : []);
    if (contentDigest(represented) !== contentDigest(blocks)) return this.refuse('CONTENT_MISMATCH');
    const items = ordered.slice(last).map(value => item(value, this.limit));
    if (items.length > 128) return this.refuse('WINDOW_SHAPE');
    return { response: { [CHECKPOINT_KEY]: { version: 1, createdAt: now, scope, count: items.length } } };
  }
}

/** The per-model effective percent when the catalog discloses one, else the shipped ratio. */
export function ratio(percent) {
  return Number.isSafeInteger(percent) && percent >= 1 && percent <= PERCENT_MAX ? percent / 100 : COMPACT_RATIO;
}

export function threshold(contextWindow, percent) {
  return Number.isSafeInteger(contextWindow) && contextWindow >= 2048 ? Math.floor(contextWindow * ratio(percent)) : undefined;
}

/**
 * Express the request bound in bytes for one disclosed window.
 *
 * The bound is the compaction threshold at a conservative bytes-per-token, with
 * the fixed floor kept when no window is usable. A request that can reach the
 * threshold must fit under this bound, otherwise the bridge trims the oldest
 * history items to fit it. In a stateful turn the bound applies only to what
 * this turn appends; the part the backend already holds is not bounded here.
 */
export function requestLimits(contextWindow, retained = false, percent) {
  const tokens = threshold(contextWindow, percent);
  const floor = retained ? RETAINED_INPUT_BYTES_FLOOR : INPUT_BYTES_FLOOR;
  const bound = tokens === undefined ? floor : tokens * BYTES_PER_TOKEN;
  return {
    inputBytes: Math.max(bound, floor),
    textBytes: Math.max(bound, retained ? RETAINED_TEXT_LIMIT : TEXT_LIMIT),
    toolBytes: Math.max(bound, retained ? RETAINED_TOOL_BYTES_LIMIT : TOOL_BYTES_LIMIT),
    messageLimit: retained ? RETAINED_MESSAGE_LIMIT : MESSAGE_LIMIT,
  };
}
