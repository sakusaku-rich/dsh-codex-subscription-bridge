import { createHash } from 'node:crypto';
import { BridgeError } from './errors.js';
import { TEXT_LIMIT, TOOL_BYTES_LIMIT, MESSAGE_LIMIT } from './text.js';

export const CHECKPOINT_KEY = 'subscriptionCompactionV1';
export const CHECKPOINT_BYTES = 512 * 1024;
export const CHECKPOINT_MAX_AGE = 24 * 60 * 60 * 1000;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const contentDigest = blocks => digest(blocks.filter(block => block.type === 'text' || block.type === 'tool-call').map(block => block.type === 'text'
  ? { type: 'text', text: block.text } : { type: 'tool-call', id: block.id, name: block.name, arguments: block.arguments }));
// The failing stage travels on the thrown error, so this module owns the whole
// label vocabulary and never copies a value out of a response.
const fail = reason => { const error = new BridgeError('PROTOCOL_INVALID', 'COMPACTION'); error.stage = reason; throw error; };
const stage = error => (error instanceof BridgeError && typeof error.stage === 'string' ? error.stage : 'UNKNOWN');
const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && Buffer.byteLength(value) <= max;

function textParts(values, type, limit, tags = ['PARTS_SHAPE', 'PARTS_PART', 'PARTS_BYTES']) {
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
function item(value) {
  if (!value || typeof value !== 'object') return fail('ITEM_VALUE');
  if (value.type === 'compaction') {
    if (!text(value.encrypted_content, CHECKPOINT_BYTES) || (value.id !== undefined && !text(value.id, 256))) return fail('ITEM_COMPACTION');
    return { type: 'compaction', ...(value.id === undefined ? {} : { id: value.id }), encrypted_content: value.encrypted_content };
  }
  if (value.type === 'message') {
    if (value.role !== 'assistant') return fail('ITEM_MESSAGE');
    return { type: 'message', role: 'assistant', content: textParts(value.content, 'output_text', TEXT_LIMIT, ['MSG_SHAPE', 'MSG_PART', 'MSG_BYTES']) };
  }
  if (value.type === 'function_call') {
    if (!text(value.call_id, 256) || !text(value.name, 64) || !/^[A-Za-z0-9_-]+$/u.test(value.name) ||
        typeof value.arguments !== 'string' || Buffer.byteLength(value.arguments) > CHECKPOINT_BYTES) return fail('ITEM_FUNCTION_CALL');
    let args;
    try { args = JSON.parse(value.arguments); } catch { return fail('ITEM_FUNCTION_CALL_ARGS'); }
    if (!args || typeof args !== 'object' || Array.isArray(args)) return fail('ITEM_FUNCTION_CALL_ARGS');
    return { type: 'function_call', call_id: value.call_id, name: value.name, arguments: value.arguments };
  }
  if (value.type === 'reasoning') {
    if (!text(value.id, 256) || !Array.isArray(value.summary) || value.summary.length > 64 ||
        (value.encrypted_content !== undefined && !text(value.encrypted_content, CHECKPOINT_BYTES))) return fail('ITEM_REASONING');
    return { type: 'reasoning', id: value.id, summary: textParts(value.summary, 'summary_text', CHECKPOINT_BYTES, ['SUM_SHAPE', 'SUM_PART', 'SUM_BYTES']),
      ...(value.encrypted_content === undefined ? {} : { encrypted_content: value.encrypted_content }) };
  }
  return fail('ITEM_UNKNOWN');
}

function windowItems(values) {
  if (!Array.isArray(values) || !values.length || values.length > 128 || values[0]?.type !== 'compaction') return fail('WINDOW_SHAPE');
  const items = []; let bytes = 2;
  for (const value of values) {
    const normalized = item(value);
    bytes += Buffer.byteLength(JSON.stringify(normalized)) + 1;
    if (bytes > CHECKPOINT_BYTES) return fail('WINDOW_BYTES');
    items.push(normalized);
  }
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
export function inspectCheckpoint(messages, plan, scope, now = Date.now()) {
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
      const items = windowItems(candidate.items);
      if (candidate.digest !== digest(items)) return { refusal: 'DIGEST' };
      return { items, end: span.end, imageEnd: span.imageEnd };
    } catch { return { refusal: 'INVALID' }; /* Invalid persisted metadata never authorizes trimming history. */ }
  }
  return {};
}

/** No server IDs are resumed. A checkpoint replaces only its exact covered prefix. */
export function selectCheckpoint(messages, plan, scope, now = Date.now()) {
  const found = inspectCheckpoint(messages, plan, scope, now);
  return found.items === undefined ? undefined : found;
}

export function threshold(contextWindow) {
  return Number.isSafeInteger(contextWindow) && contextWindow >= 2048 ? Math.min(32768, Math.floor(contextWindow / 2)) : undefined;
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
  constructor() { this.observed = new Map(); this.unindexed = false; this.refusal = undefined; }
  /** Record the first reason no checkpoint was published; labels are local. */
  refuse(reason) { this.refusal ??= reason; return undefined; }
  observe(event) {
    try {
      if (event.item?.type === 'compaction') item(event.item);
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
        && digest(item(terminalCompaction)) !== digest(item(streamedCompaction))) return this.refuse('COMPACTION_MISMATCH');
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
    const items = windowItems(ordered.slice(last));
    return { response: { [CHECKPOINT_KEY]: { version: 1, createdAt: now, scope,
      prefix: digest(plan.input), content: contentDigest(blocks), items, digest: digest(items) } } };
  }
}

/** Preserve existing wire budgets even when the retained transcript is larger. */
export function compactPlan(plan, checkpoint) {
  const input = [...plan.input.slice(0, checkpoint.end).filter(value => value.type === 'message' && value.role === 'developer'),
    ...checkpoint.items, ...plan.input.slice(checkpoint.end)];
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
  if (input.length > MESSAGE_LIMIT || textBytes > TEXT_LIMIT || toolBytes > TOOL_BYTES_LIMIT) throw new BridgeError('INPUT_UNSUPPORTED', 'COMPACTION');
  return { ...plan, input, images: new Map([...plan.images].filter(([id]) => attachments.has(id))),
    imageBlocks: plan.imageBlocks.slice(checkpoint.imageEnd) };
}
