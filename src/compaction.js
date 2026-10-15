import { createHash } from 'node:crypto';
import { BridgeError } from './errors.js';
import { TEXT_LIMIT, TOOL_BYTES_LIMIT, MESSAGE_LIMIT } from './text.js';

export const CHECKPOINT_KEY = 'subscriptionCompactionV1';
export const CHECKPOINT_BYTES = 512 * 1024;
export const CHECKPOINT_MAX_AGE = 24 * 60 * 60 * 1000;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const contentDigest = blocks => digest(blocks.filter(block => block.type === 'text' || block.type === 'tool-call').map(block => block.type === 'text'
  ? { type: 'text', text: block.text } : { type: 'tool-call', id: block.id, name: block.name, arguments: block.arguments }));
const fail = () => { throw new BridgeError('PROTOCOL_INVALID', 'COMPACTION'); };
const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && Buffer.byteLength(value) <= max;

function textParts(values, type, limit) {
  if (!Array.isArray(values) || values.length > 64) return fail();
  let bytes = 0;
  return values.map(part => {
    if (part?.type !== type || typeof part.text !== 'string' || part.text.length > limit) return fail();
    bytes += Buffer.byteLength(part.text);
    if (bytes > limit) return fail();
    return { type, text: part.text };
  });
}

/** Only this allowlisted, bounded wire state can be persisted and replayed. */
function item(value) {
  if (!value || typeof value !== 'object') return fail();
  if (value.type === 'compaction') {
    if (!text(value.encrypted_content, CHECKPOINT_BYTES) || (value.id !== undefined && !text(value.id, 256))) return fail();
    return { type: 'compaction', ...(value.id === undefined ? {} : { id: value.id }), encrypted_content: value.encrypted_content };
  }
  if (value.type === 'message') {
    if (value.role !== 'assistant') return fail();
    return { type: 'message', role: 'assistant', content: textParts(value.content, 'output_text', TEXT_LIMIT) };
  }
  if (value.type === 'function_call') {
    if (!text(value.call_id, 256) || !text(value.name, 64) || !/^[A-Za-z0-9_-]+$/u.test(value.name) ||
        typeof value.arguments !== 'string' || Buffer.byteLength(value.arguments) > CHECKPOINT_BYTES) return fail();
    let args;
    try { args = JSON.parse(value.arguments); } catch { return fail(); }
    if (!args || typeof args !== 'object' || Array.isArray(args)) return fail();
    return { type: 'function_call', call_id: value.call_id, name: value.name, arguments: value.arguments };
  }
  if (value.type === 'reasoning') {
    if (!text(value.id, 256) || !Array.isArray(value.summary) || value.summary.length > 64 ||
        (value.encrypted_content !== undefined && !text(value.encrypted_content, CHECKPOINT_BYTES))) return fail();
    return { type: 'reasoning', id: value.id, summary: textParts(value.summary, 'summary_text', CHECKPOINT_BYTES),
      ...(value.encrypted_content === undefined ? {} : { encrypted_content: value.encrypted_content }) };
  }
  return fail();
}

function windowItems(values) {
  if (!Array.isArray(values) || !values.length || values.length > 128 || values[0]?.type !== 'compaction') return fail();
  const items = []; let bytes = 2;
  for (const value of values) {
    const normalized = item(value);
    bytes += Buffer.byteLength(JSON.stringify(normalized)) + 1;
    if (bytes > CHECKPOINT_BYTES) return fail();
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

/** Capture output order, including tool calls after the last compaction item. */
export class CompactionCapture {
  constructor() { this.observed = new Map(); this.unindexed = false; }
  observe(event) {
    if (event.item?.type === 'compaction') item(event.item);
    if (!Number.isSafeInteger(event.output_index) || event.output_index < 0 || event.output_index >= 128) {
      this.unindexed = true;
      return;
    }
    const previous = this.observed.get(event.output_index);
    if (previous && digest(previous) !== digest(event.item)) return fail();
    this.observed.set(event.output_index, event.item);
  }
  finish(output, scope, plan, blocks, now = Date.now()) {
    let ordered;
    const hasCompaction = (output ?? []).some(value => value.type === 'compaction') || [...this.observed.values()].some(value => value.type === 'compaction');
    if (!hasCompaction) return undefined;
    if (Array.isArray(output)) {
      for (const [index, observed] of this.observed) {
        if (!output[index] || digest(item(observed)) !== digest(item(output[index]))) return fail();
      }
      ordered = output;
    } else {
      if (this.unindexed) return undefined;
      ordered = [...this.observed].sort(([a], [b]) => a - b);
      if (ordered.some(([index], position) => index !== position)) return undefined;
      ordered = ordered.map(([, value]) => value);
    }
    const last = ordered.findLastIndex(value => value.type === 'compaction');
    if (last < 0) return undefined;
    // A text delta without its completed output item cannot be replayed from
    // the encrypted window. Retain full history instead of losing that tail.
    const represented = ordered.flatMap(value => value.type === 'message'
      ? value.content.map(part => ({ type: 'text', text: part.text }))
      : value.type === 'function_call' ? [{ type: 'tool-call', id: value.call_id, name: value.name, arguments: value.arguments }] : []);
    if (contentDigest(represented) !== contentDigest(blocks)) return undefined;
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
