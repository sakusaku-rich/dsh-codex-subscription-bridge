import { createHash } from 'node:crypto';
import { BridgeError } from './errors.js';
import { TEXT_LIMIT, TOOL_BYTES_LIMIT, MESSAGE_LIMIT, INPUT_BYTES_FLOOR, RETAINED_INPUT_BYTES_FLOOR, RETAINED_TEXT_LIMIT, RETAINED_TOOL_BYTES_LIMIT, RETAINED_MESSAGE_LIMIT, defaultLimits } from './text.js';

export const CHECKPOINT_KEY = 'subscriptionCompactionV1';
// Floor for a window bound, used when no usable window is disclosed.
export const CHECKPOINT_BYTES = 512 * 1024;
export const CHECKPOINT_MAX_AGE = 24 * 60 * 60 * 1000;
// The subscription route's own client measures the active context against a
// limit derived from the disclosed window, and 95% is that client's disclosed
// effective percent. The bridge has no tokenizer: the byte bound below is a
// guard, not a token guarantee, and the route compares its own rendered count
// against the number sent here.
export const COMPACT_RATIO = 0.95;
export const BYTES_PER_TOKEN = 8;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const contentDigest = blocks => digest(blocks.filter(block => block.type === 'text' || block.type === 'tool-call').map(block => block.type === 'text'
  ? { type: 'text', text: block.text } : { type: 'tool-call', id: block.id, name: block.name, arguments: block.arguments }));
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

/** Only this allowlisted, bounded wire state can be persisted and replayed. */
function item(value, limit = CHECKPOINT_BYTES) {
  if (!value || typeof value !== 'object') return fail('ITEM_VALUE');
  if (value.type === 'compaction') {
    if (!text(value.encrypted_content, limit) || (value.id !== undefined && !text(value.id, 256))) return fail('ITEM_COMPACTION');
    return { type: 'compaction', ...(value.id === undefined ? {} : { id: value.id }), encrypted_content: value.encrypted_content };
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

const windowBytes = values => 2 + values.reduce((total, value) => total + Buffer.byteLength(JSON.stringify(value)) + 1, 0);

/**
 * Drop the oldest covered items until the window fits its bound, keeping the
 * compaction item itself. The official client does the same when the window is
 * exceeded while compacting: it removes the oldest history item rather than
 * refusing the turn. A window that cannot fit even with only its compaction item
 * is still refused, because nothing is left to drop.
 */
function trimOldest(values, limit) {
  let trimmed = 0;
  while (values.length > 1 && windowBytes(values) > limit) { values = [values[0], ...values.slice(2)]; trimmed += 1; }
  return { items: values, trimmed };
}

function normalizeWindow(values, limit = CHECKPOINT_BYTES) {
  if (!Array.isArray(values) || !values.length || values.length > 128 || values[0]?.type !== 'compaction') return fail('WINDOW_SHAPE');
  return values.map(value => item(value, limit));
}

function windowItems(values, limit = CHECKPOINT_BYTES) {
  const items = normalizeWindow(values, limit);
  if (windowBytes(items) > limit) return fail('WINDOW_BYTES');
  return items;
}

export function compactionScope(account, model, plan) {
  return digest([account, model, plan.tools ?? [], plan.input.filter(value => value.type === 'message' && value.role === 'developer')]);
}

/**
 * Inspect the newest persisted checkpoint for reuse.
 *
 * Returns the reusable window, or `{ refusal }` naming why the newest candidate
 * was rejected, or `{}` when no message carries a checkpoint. The refusal label
 * is this module's own closed vocabulary, so it is safe to log.
 */
export function inspectCheckpoint(messages, plan, scope, now = Date.now(), limit = CHECKPOINT_BYTES) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const candidate = messages[index].source?.replayState?.response?.[CHECKPOINT_KEY];
    if (!candidate) continue;
    try {
      const span = plan.spans[index];
      if (messages[index].role !== 'assistant') return { refusal: 'SHAPE' };
      if (candidate.version !== 1 || !Number.isSafeInteger(candidate.createdAt) || candidate.createdAt > now) return { refusal: 'METADATA' };
      if (now - candidate.createdAt > CHECKPOINT_MAX_AGE) return { refusal: 'EXPIRED' };
      if (candidate.scope !== scope) return { refusal: 'SCOPE' };
      if (candidate.prefix !== digest(plan.input.slice(0, span.start))) return { refusal: 'PREFIX' };
      if (candidate.content !== contentDigest(messages[index].content)) return { refusal: 'CONTENT' };
      const items = windowItems(candidate.items, limit);
      if (candidate.digest !== digest(items)) return { refusal: 'DIGEST' };
      return { items, end: span.end, imageEnd: span.imageEnd };
    } catch (error) { return { refusal: stage(error) === 'UNKNOWN' ? 'INVALID' : stage(error) }; /* Invalid persisted metadata never authorizes trimming history. */ }
  }
  return {};
}

/** No server IDs are resumed. A checkpoint replaces only its exact covered prefix. */
export function selectCheckpoint(messages, plan, scope, now = Date.now(), limit = CHECKPOINT_BYTES) {
  const found = inspectCheckpoint(messages, plan, scope, now, limit);
  return found.items === undefined ? undefined : found;
}

export function threshold(contextWindow) {
  return Number.isSafeInteger(contextWindow) && contextWindow >= 2048 ? Math.floor(contextWindow * COMPACT_RATIO) : undefined;
}

/**
 * Express the persisted window bound in bytes for one disclosed window.
 *
 * A compaction window is a reduction of the input the route measured, and that
 * input is bounded by the same derived value, so a window the route can produce
 * cannot exceed this bound. The fixed value stays as the floor when no usable
 * window is disclosed.
 */
export function checkpointLimit(contextWindow) {
  const tokens = threshold(contextWindow);
  return tokens === undefined ? CHECKPOINT_BYTES : Math.max(tokens * BYTES_PER_TOKEN, CHECKPOINT_BYTES);
}

/**
 * Express the request bound in bytes for one disclosed window.
 *
 * The bound is the compaction threshold at a conservative bytes-per-token, with
 * the fixed floor kept when no window is usable. A request that can reach the
 * threshold must fit under this bound, otherwise the bridge refuses it before
 * the route has a chance to compact.
 */
export function requestLimits(contextWindow, retained = false) {
  const tokens = threshold(contextWindow);
  const floor = retained ? RETAINED_INPUT_BYTES_FLOOR : INPUT_BYTES_FLOOR;
  const bound = tokens === undefined ? floor : tokens * BYTES_PER_TOKEN;
  return {
    inputBytes: Math.max(bound, floor),
    textBytes: Math.max(bound, retained ? RETAINED_TEXT_LIMIT : TEXT_LIMIT),
    toolBytes: Math.max(bound, retained ? RETAINED_TOOL_BYTES_LIMIT : TOOL_BYTES_LIMIT),
    messageLimit: retained ? RETAINED_MESSAGE_LIMIT : MESSAGE_LIMIT,
    checkpointBytes: checkpointLimit(contextWindow),
  };
}

/**
 * Capture output order, including tool calls after the last compaction item.
 *
 * Replaying history is optional, so a checkpoint this capture cannot prove is
 * simply not published: the answer was already delivered, and failing the turn
 * over replay metadata would discard it. The first refusal label is kept for
 * the host log.
 */
export class CompactionCapture {
  constructor(limit = CHECKPOINT_BYTES) { this.observed = new Map(); this.unindexed = false; this.refusal = undefined; this.trimmed = 0; this.limit = limit; }
  /** Record the first reason no checkpoint was published; labels are local. */
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
    // A checkpoint is replay metadata for a turn whose answer is already
    // delivered: failing to prove one never fails that turn.
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
    // A text delta without its completed output item cannot be replayed from
    // the encrypted window. Retain full history instead of losing that tail.
    const represented = ordered.flatMap(value => value.type === 'message'
      ? (Array.isArray(value.content) ? value.content.map(part => ({ type: 'text', text: part.text })) : [])
      : value.type === 'function_call' ? [{ type: 'tool-call', id: value.call_id, name: value.name, arguments: value.arguments }] : []);
    if (contentDigest(represented) !== contentDigest(blocks)) return this.refuse('CONTENT_MISMATCH');
    const { items, trimmed } = trimOldest(normalizeWindow(ordered.slice(last), this.limit), this.limit);
    this.trimmed = trimmed;
    return { response: { [CHECKPOINT_KEY]: { version: 1, createdAt: now, scope,
      prefix: digest(plan.input), content: contentDigest(blocks), items, digest: digest(items) } } };
  }
}

function measure(input) {
  let textBytes = 0, toolBytes = 0;
  const attachments = new Set();
  for (const value of input) {
    if (value.type === 'message') for (const part of value.content) {
      if (typeof part.text === 'string') textBytes += Buffer.byteLength(part.text);
      if (part.attachmentId) attachments.add(part.attachmentId);
    }
    if (value.type === 'function_call') toolBytes += Buffer.byteLength(value.arguments);
    if (value.type === 'function_call_output') toolBytes += Buffer.byteLength(value.output);
  }
  return { textBytes, toolBytes, attachments };
}

/** Revalidate the selected wire window against the bound the request was admitted under. */
export function compactPlan(plan, checkpoint, limits = defaultLimits(false)) {
  const prefix = plan.input.slice(0, checkpoint.end).filter(value => value.type === 'message' && value.role === 'developer');
  const suffix = plan.input.slice(checkpoint.end);
  let items = checkpoint.items, trimmed = 0;
  for (;;) {
    const input = [...prefix, ...items, ...suffix];
    const measured = measure(input);
    if (input.length <= limits.messageLimit && measured.textBytes <= limits.textBytes &&
        measured.toolBytes <= limits.toolBytes && measured.textBytes + measured.toolBytes <= limits.inputBytes) {
      return { ...plan, input, images: new Map([...plan.images].filter(([id]) => measured.attachments.has(id))),
        imageBlocks: plan.imageBlocks.slice(checkpoint.imageEnd), trimmed };
    }
    // Only the covered window can be dropped: the uncovered tail is the live
    // conversation, and the compaction item itself is what makes the window
    // replayable. The official client removes the oldest history item here instead
    // of failing the turn; once only the compaction item is left there is nothing
    // to drop, so that case is still refused.
    if (items.length <= 1) throw new BridgeError('INPUT_UNSUPPORTED', 'COMPACTION');
    items = [items[0], ...items.slice(2)]; trimmed += 1;
  }
}
