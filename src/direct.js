import {events} from './sse.js';
export {events} from './sse.js';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { BridgeError, classified, object, string } from './errors.js';
import { validateInput, PROVIDER, TOOL_NAME_LIMIT, CALL_ID_LIMIT, TOOL_BYTES_LIMIT, reasoningLevels } from './text.js';
import { REQUEST_IMAGE_OFFLOAD_MAX_BYTES, REQUEST_IMAGE_OFFLOAD_BYTE_QUANTUM, estimateVisionTokens, imageDataUrl, requestImageTarget } from './image.js';
import { offloadedImageText, projectOffloadedImages, requestImageHandleText, requiredImageOffload } from '@deepseek-ai/dsh-llm';
import { Http, BASE, classifyStatusError, readJson } from './http.js';
import { accountHeaders, compactionAccount } from './auth.js';
import { CompactionCapture, PERCENT_MAX, threshold, requestLimits } from './compaction.js';
import { CONVERSATION_ID_MAX, conversationScope, inspectConversation, appendedItems, trimOldest, conversationRecord } from './conversation.js';
import { digest, contentDigest } from './hashes.js';

const { name, version } = createRequire(import.meta.url)('../package.json');

/**
 * Stream events the bridge consumes. Everything else in the stream is a
 * notification: it may announce route state, progress, or parts of an item
 * this bridge does not project, and it carries nothing the bridge renders.
 *
 * The subscription route is a live, evolving Responses surface, and the
 * reference implementation bundled with the verified Harness
 * (`@earendil-works/pi-ai`, `api/openai-responses-shared.js`) dispatches this
 * same event set and has no catch-all that fails an unknown event: only
 * `error` and `response.failed` are fatal there. An allowlist that aborts on
 * anything unrecognized is therefore stricter than the host it feeds, and it
 * fails turns whose text and tool calls had already reconciled — which is what
 * discarded usable answers twice, first on `response.metadata` and then on the
 * annotation and item-progress notifications.
 *
 * The fail-closed property is preserved where it matters: every event this
 * bridge *does* consume is still validated strictly, and an unvalidated event
 * can never inject text or tool calls, because only the handled branches below
 * project content. What is dropped is the claim that the bridge can enumerate
 * a live third-party stream's notification vocabulary.
 */
const CONSUMED_EVENTS = new Set([
  'response.output_text.delta', 'response.output_text.done',
  'response.output_item.added', 'response.output_item.done', 'response.completed',
]);
// Terminal failures and refusals are fatal: they mean the route reported that
// it could not produce the answer, which must not be reported as success.
const TERMINAL_FAILURES = new Set(['error', 'response.failed', 'response.incomplete', 'response.refusal.delta', 'response.refusal.done']);
function headers(token) {
  return { Authorization: `Bearer ${token}`, ...accountHeaders(token),
    'User-Agent': `${name}/${version}`, originator: 'dsh-codex-subscription-bridge' };
}

/** Map the subscription route's terminal usage record; absent fields stay absent. */
function responseUsage(value, diagnostic) {
  const wire = object(value);
  const inputTokens = wire.input_tokens, outputTokens = wire.output_tokens;
  if (!Number.isSafeInteger(inputTokens) || inputTokens < 0 || !Number.isSafeInteger(outputTokens) || outputTokens < 0) throw new BridgeError('PROTOCOL_INVALID', diagnostic);
  const usage = { inputTokens, outputTokens };
  const cached = wire.input_tokens_details?.cached_tokens;
  if (cached !== undefined) {
    if (!Number.isSafeInteger(cached) || cached < 0 || cached > inputTokens) throw new BridgeError('PROTOCOL_INVALID', diagnostic);
    // Responses input includes cache hits; Harness expects disjoint input buckets.
    usage.inputTokens = inputTokens - cached;
    usage.cacheReadTokens = cached;
  }
  const reasoning = wire.output_tokens_details?.reasoning_tokens;
  if (reasoning !== undefined) { if (!Number.isSafeInteger(reasoning) || reasoning < 0) throw new BridgeError('PROTOCOL_INVALID', diagnostic); usage.reasoningTokens = reasoning; }
  const total = wire.total_tokens;
  if (total !== undefined) { if (!Number.isSafeInteger(total) || total < 0) throw new BridgeError('PROTOCOL_INVALID', diagnostic); usage.totalTokens = total; }
  return usage;
}
export class DirectBridge {
  constructor(auth, http = new Http(), { cacheMs = 60_000, turnTimeoutMs = 120_000, shutdownTimeoutMs = 5000 } = {}, context = {}) {
    this.auth = auth; this.http = http; this.cacheMs = cacheMs; this.turnTimeoutMs = turnTimeoutMs;
    this.active = new Set(); this.owners = new WeakMap(); this.pending = new Set(); this.closed = false; this.shutdownTimeoutMs = shutdownTimeoutMs;
    this.context = context; this.warn = typeof context?.warn === 'function' ? context.warn : () => {};
    // Mirror the DeepSeek adapter's shared access resolver: image placeholders,
    // request serialization, and pricing all resolve through one function that
    // stays undefined while no attachment service is mounted.
    this.imageAccess = (ref) => {
      const attachments = this.context?.resolveAttachments?.();
      return attachments === undefined ? undefined : this.context.resolveImageAccess?.(attachments, ref);
    };
  }
  track(promise, owner) {
    this.pending.add(promise); owner?.work.add(promise);
    const settled = () => { this.pending.delete(promise); owner?.work.delete(promise); owner?.tryRelease(); };
    promise.then(settled, settled);
    return promise;
  }
  own(task, signal) {
    if (this.closed) return Promise.reject(new BridgeError('CLOSED'));
    if (signal?.aborted) return Promise.reject(new BridgeError('ABORTED'));
    return this.track(Promise.resolve().then(() => {
      if (signal?.aborted) throw new BridgeError('ABORTED');
      return task();
    }), this.owners.get(signal));
  }
  controller(signal, timeoutMs) {
    if (this.closed) throw new BridgeError('CLOSED');
    if (signal?.aborted) throw new BridgeError('ABORTED');
    if (this.active.size >= 4) throw new BridgeError('LIMIT_EXCEEDED');
    const controller = new AbortController(); controller.work = new Set();
    this.owners.set(controller.signal, controller);
    const timeout = setTimeout(() => { controller.timedOut = true; controller.abort(); }, timeoutMs);
    const cancel = () => controller.abort(); signal?.addEventListener('abort', cancel, { once: true });
    this.active.add(controller);
    controller.tryRelease = () => {
      if ((controller.finished || controller.abortDispatched) && !controller.work.size) this.active.delete(controller);
    };
    controller.release = () => { clearTimeout(timeout); signal?.removeEventListener('abort', cancel); controller.finished = true; controller.tryRelease(); };
    controller.signal.addEventListener('abort', () => {
      clearTimeout(timeout); signal?.removeEventListener('abort', cancel);
      // Let every abort listener register its reader/transport cleanup first.
      queueMicrotask(() => { controller.abortDispatched = true; controller.tryRelease(); });
    }, { once: true });
    return controller;
  }
  async catalog(signal, fresh = false) {
    try {
      // Always reread/refresh authentication first, including metadata cache hits.
      const token = await this.own(() => this.auth.token(signal), signal);
      const identity = createHash('sha256').update(token).digest('hex');
      if (!fresh && this.cache?.identity === identity && this.cache.expires > Date.now()) return this.cache.models;
      // Match the reference's catalog compatibility selectors, not a CLI identity.
      let result;
      for (const version of ['99.0.0', '0.0.0']) {
        result = object(await this.own(() => this.http.json(`${BASE}/models?client_version=${version}`, { headers: headers(token) }, signal), signal));
        if (!Array.isArray(result.models) || result.models.length > 512) throw new BridgeError('PROTOCOL_INVALID');
        if (result.models.length) break;
      }
      const ids = new Set(); const models = [];
      for (const entry of result.models) {
        object(entry); const id = string(entry.slug); if (ids.has(id)) throw new BridgeError('PROTOCOL_INVALID'); ids.add(id);
        if (!['list', 'hide'].includes(entry.visibility)) throw new BridgeError('PROTOCOL_INVALID');
        if (entry.visibility === 'list') {
          const model = { id, name: string(entry.display_name), provider: PROVIDER, inputModalities: ['text', 'image'] };
          // The disclosed per-model window is the combined request and response
          // context the host needs for compaction pressure; absence stays optional.
          if (entry.context_window !== undefined) {
            if (!Number.isSafeInteger(entry.context_window) || entry.context_window <= 0) throw new BridgeError('PROTOCOL_INVALID');
            model.contextWindow = entry.context_window;
          }
          // The route's own client derives its compaction limit from a per-model
          // effective percent, so a disclosed percent is read here. Absence stays
          // optional and the shipped ratio is the fallback; a malformed disclosed
          // value fails closed like the window does.
          if (entry.effective_context_window_percent !== undefined) {
            if (!Number.isSafeInteger(entry.effective_context_window_percent) ||
                entry.effective_context_window_percent < 1 || entry.effective_context_window_percent > PERCENT_MAX) throw new BridgeError('PROTOCOL_INVALID');
            model.effectivePercent = entry.effective_context_window_percent;
          }
          // The backend also discloses this model's reasoning levels and, when
          // it names one, the default it would apply. Both stay optional so an
          // undisclosed model simply offers no effort selector.
          const levels = reasoningLevels(entry.supported_reasoning_levels);
          if (levels !== undefined) {
            model.reasoningLevels = levels;
            if (typeof entry.default_reasoning_level === 'string' && levels.some(level => level.id === entry.default_reasoning_level)) {
              model.defaultReasoningLevel = entry.default_reasoning_level;
            }
          }
          models.push(model);
        }
      }
      this.cache = { identity, models, expires: Date.now() + this.cacheMs }; return models;
    } catch (error) { throw classified(error, 'MODEL_CATALOG'); }
  }
  async discover(signal) {
    const controller = this.controller(signal, 30_000);
    return this.track((async () => {
      try { return await this.catalog(controller.signal); }
      catch (error) { if (controller.timedOut) throw new BridgeError('TIMEOUT'); throw error; }
      finally { controller.release(); }
    })(), controller);
  }
  async listModels(signal) {
    if (this.closed) throw new BridgeError('CLOSED');
    if (signal) return this.discover(signal);
    this.discovery ??= this.discover().finally(() => { this.discovery = undefined; });
    const models = await this.discovery;
    return models.map(model => ({ ...model, inputModalities: [...model.inputModalities] }));
  }
  async *stream(options) {
    // Project offloaded image occurrences into text placeholders before
    // validation, matching the DeepSeek adapter's projection order.
    const messages = projectOffloadedImages(options.messages, ref => offloadedImageText(ref, this.imageAccess(ref)));
    string(options.model);
    const capture = new CompactionCapture(); let scope, compactThreshold, conversationId, trimmed;
    const controller = this.controller(options.signal, this.turnTimeoutMs); let response;
    let phase = 'MODEL_CATALOG';
    const blocks = new Map(); let outputBytes = 0, toolBytes = 0, complete = false, toolCalls = false;
    const getBlock = (id, contentIndex) => {
      string(id); if (!Number.isSafeInteger(contentIndex) || contentIndex < 0 || contentIndex > 63) throw new BridgeError('PROTOCOL_INVALID');
      const key = `${id}:${contentIndex}`;
      if (!blocks.has(key)) {
        if (blocks.size >= 128) throw new BridgeError('LIMIT_EXCEEDED');
        blocks.set(key, { index: blocks.size, text: '', started: false, ended: false });
      }
      return blocks.get(key);
    };
    function* reconcile(item) {
      object(item);
      if (!['message', 'reasoning', 'function_call', 'compaction'].includes(item.type)) throw new BridgeError('PROTOCOL_INVALID', 'SSE_OUTPUT_ITEM');
      if (item.type === 'reasoning' || item.type === 'compaction') return;
      if (item.type === 'function_call') {
        if (item.status !== undefined && item.status !== 'completed') throw new BridgeError('PROTOCOL_INVALID', 'SSE_TOOL_CALL');
        const callId = item.call_id;
        if (typeof callId !== 'string' || callId.length === 0 || callId.length > CALL_ID_LIMIT) throw new BridgeError('PROTOCOL_INVALID', 'SSE_TOOL_CALL');
        if (typeof item.name !== 'string' || item.name.length === 0 || Buffer.byteLength(item.name) > TOOL_NAME_LIMIT ||
            typeof item.arguments !== 'string') throw new BridgeError('PROTOCOL_INVALID', 'SSE_TOOL_CALL');
        // Mirror the DeepSeek adapter: received arguments must parse as a JSON
        // object; anything else is a protocol violation, not host input.
        try { object(JSON.parse(item.arguments)); } catch { throw new BridgeError('PROTOCOL_INVALID', 'SSE_TOOL_CALL'); }
        const key = `call:${callId}`;
        const existing = blocks.get(key);
        // Idempotent replay: the completed response may repeat emitted items.
        if (existing) {
          if (existing.name !== item.name || existing.arguments !== item.arguments) throw new BridgeError('PROTOCOL_INVALID', 'SSE_TOOL_CALL');
          return;
        }
        if (blocks.size >= 128) throw new BridgeError('LIMIT_EXCEEDED');
        toolBytes += Buffer.byteLength(item.arguments); if (toolBytes > TOOL_BYTES_LIMIT) throw new BridgeError('LIMIT_EXCEEDED');
        const block = { index: blocks.size, type: 'tool-call', id: callId, name: item.name, arguments: item.arguments, ended: true };
        blocks.set(key, block); toolCalls = true;
        // Mirror the DeepSeek adapter: an empty delta marks the open call block,
        // and the block-end frame carries the full arguments at once.
        if (controller.signal.aborted) throw new BridgeError('ABORTED');
        yield { type: 'block-start', index: block.index, blockType: 'tool-call' };
        if (controller.signal.aborted) throw new BridgeError('ABORTED');
        yield { type: 'tool-call-delta', index: block.index, id: callId, name: item.name, argumentsDelta: '' };
        if (controller.signal.aborted) throw new BridgeError('ABORTED');
        yield { type: 'block-end', index: block.index, block: { type: 'tool-call', id: callId, name: item.name, arguments: item.arguments } };
        return;
      }
      if (item.status !== undefined && item.status !== 'completed') throw new BridgeError('PROTOCOL_INVALID', 'SSE_OUTPUT_ITEM');
      if (item.role !== 'assistant' || !Array.isArray(item.content) || item.content.length > 64) throw new BridgeError('PROTOCOL_INVALID', 'SSE_OUTPUT_ITEM');
      for (const [index, content] of item.content.entries()) {
        if (content?.type !== 'output_text' || typeof content.text !== 'string') throw new BridgeError('PROTOCOL_INVALID', 'SSE_OUTPUT_ITEM');
        const block = getBlock(item.id, index);
        if (!content.text.startsWith(block.text) || (block.ended && content.text !== block.text)) throw new BridgeError('PROTOCOL_INVALID', 'SSE_OUTPUT_ITEM');
        const tail = content.text.slice(block.text.length);
        outputBytes += Buffer.byteLength(tail); if (outputBytes > 256 * 1024) throw new BridgeError('LIMIT_EXCEEDED');
        if (!block.started) { block.started = true; if (controller.signal.aborted) throw new BridgeError('ABORTED'); yield { type: 'block-start', index: block.index, blockType: 'text' }; }
        if (tail) { block.text += tail; if (controller.signal.aborted) throw new BridgeError('ABORTED'); yield { type: 'text-delta', index: block.index, text: tail }; }
        if (!block.ended) { block.ended = true; if (controller.signal.aborted) throw new BridgeError('ABORTED'); yield { type: 'block-end', index: block.index, block: { type: 'text', text: block.text } }; }
      }
    }
    try {
      const models = await this.catalog(controller.signal, true);
      const selected = models.find(model => model.id === options.model);
      if (selected === undefined) throw new BridgeError('MODEL_UNAVAILABLE');
      // The request bound and the compaction threshold come from the same
      // disclosed window and the same per-model percent, so the model has to be
      // resolved before validation. Retained limits admit a transcript that may
      // be trimmed from the oldest end to fit the wire bound below.
      const retainedLimits = requestLimits(selected.contextWindow, true, selected.effectivePercent);
      const wireLimits = requestLimits(selected.contextWindow, false, selected.effectivePercent);
      phase = 'INPUT';
      const originalPlan = validateInput({ ...options, messages }, true, retainedLimits);
      let plan = originalPlan;
      // The host selects only declared levels, but a direct caller can name any
      // bounded id; a choice the model does not disclose fails closed here.
      if (plan.reasoning !== undefined && !(selected.reasoningLevels ?? []).some(level => level.id === plan.reasoning.effort)) {
        throw new BridgeError('INPUT_UNSUPPORTED');
      }
      const token = await this.own(() => this.auth.token(controller.signal), controller.signal);
      scope = conversationScope(compactionAccount(token), options.model, originalPlan);
      compactThreshold = threshold(selected.contextWindow, selected.effectivePercent);
      const conversation = inspectConversation(messages, originalPlan, scope);
      // A refusal is the model-switch, expiry and edited-history boundary: the
      // bridge can prove what it sent but not what the backend still holds, so the
      // chain is refused rather than trusted, and the host log names it before the
      // full history is sent on its own.
      if (conversation.refusal !== undefined) this.warn(`The subscription conversation chain was refused (${conversation.refusal}); sending the full history.`);
      // The full local transcript is the input when no chain is usable. Following
      // the official client, the oldest history items are dropped until the request
      // fits instead of failing the turn; a tool call and its executed result are
      // dropped as one unit, and an image occurrence is left for the host to
      // offload. Nothing left to drop is still a refusal, and limits are never
      // raised silently.
      const fullHistory = () => {
        const fitted = trimOldest(originalPlan, wireLimits);
        if (fitted.trimmed > 0) {
          this.warn(`The full history was trimmed from the oldest end (${fitted.trimmed} items) to fit the request bound.`);
          // A trimmed request is not the whole transcript, so the bridge cannot
          // prove the backend holds what the transcript says. The chain is not
          // published and the next turn starts a new conversation.
          trimmed = true;
        }
        return fitted;
      };
      if (conversation.id !== undefined) {
        const appended = appendedItems(originalPlan, conversation, wireLimits);
        plan = { ...originalPlan, input: appended.input,
          images: new Map([...originalPlan.images].filter(([id]) => appended.attachments.has(id))),
          imageBlocks: originalPlan.imageBlocks.slice(conversation.imageEnd) };
        conversationId = conversation.id;
      }
      else {
        try { plan = { ...originalPlan, ...fullHistory() }; }
        catch (error) {
          // Without a usable chain and with nothing left to drop, name that
          // boundary instead of the generic shape failure.
          if (conversation.refusal !== undefined && error instanceof BridgeError && error.code === 'INPUT_UNSUPPORTED') throw new BridgeError('CONVERSATION_UNAVAILABLE', 'CONVERSATION');
          throw error;
        }
      }
      const openTurn = async () => {
        phase = 'IMAGE_PREPARE';
        const versions = await this.prepareImages(plan, controller);
        const input = versions.size ? plan.input.map(item => item.type !== 'message' ? item : { ...item, content: item.content.map(part => {
          if (part.type !== 'input_image') return part;
          const image = versions.get(part.attachmentId);
          return { type: 'input_image', image_url: imageDataUrl(image.mediaType, Buffer.from(image.data).toString('base64')) };
        }) }) : plan.input;
        const instructions = input.filter(item => item.type === 'message' && item.role === 'developer').map(item => item.content.map(block => block.text).join('\n')).join('\n');
        phase = 'HTTP_REQUEST';
        return await this.own(async () => {
          const result = await this.http.open(`${BASE}/responses`, { method: 'POST', headers: { ...headers(token), 'Content-Type': 'application/json', Accept: 'text/event-stream' },
          body: JSON.stringify({ model: options.model, instructions, input: input.filter(item => !(item.type === 'message' && item.role === 'developer')),
            store: true, stream: true, ...(conversationId === undefined ? {} : { previous_response_id: conversationId }), ...(compactThreshold === undefined ? {} : { context_management: [{ type: 'compaction', compact_threshold: compactThreshold }] }), ...(plan.temperature === undefined ? {} : { temperature: plan.temperature }),
            ...(plan.tools === undefined ? {} : { tools: plan.tools }), ...(plan.reasoning === undefined ? {} : { reasoning: plan.reasoning }) }) }, controller.signal);
          const cancel = () => this.track(Promise.resolve(result.body?.cancel()).catch(() => {}), controller);
          controller.signal.addEventListener('abort', cancel, { once: true });
          controller.removeBodyAbort = () => controller.signal.removeEventListener('abort', cancel);
          if (controller.signal.aborted) await cancel();
          return result;
        }, controller.signal);
      };
      response = await openTurn();
      // Only an explicit parameter rejection authorizes one bounded full-history retry.
      // Never retry partial streams, quota/auth failures, or arbitrary upstream errors.
      if ((compactThreshold !== undefined || conversationId !== undefined) && [400, 422].includes(response.status)) {
        let rejected;
        try {
          const body = await this.own(() => readJson(response, 16 * 1024, controller.signal), controller.signal);
          if (['context_management', 'previous_response_id'].includes(body?.error?.param) &&
              ['unsupported_parameter', 'unknown_parameter'].includes(body.error.code)) rejected = body.error.param;
        } catch { if (controller.signal.aborted) throw new BridgeError('ABORTED'); }
        if (rejected !== undefined) {
          // A rejected chain id is not reused, so the chain is dropped with it.
          if (rejected === 'previous_response_id') conversationId = undefined;
          else compactThreshold = undefined;
          controller.removeBodyAbort?.();
          await this.track(Promise.resolve(response.body?.cancel()).catch(() => {}), controller);
          plan = { ...originalPlan, ...fullHistory() };
          response = await openTurn();
        }
      }
      if (!response.ok) throw await classifyStatusError(response.status, response, controller.signal);
      // The subscription backend can send valid SSE without an SSE MIME header.
      // Trust the bounded frame/event parser and terminal state, not Content-Type.
      phase = 'SSE_FRAME';
      for await (const event of events(response.body, controller.signal, promise => this.track(promise, controller))) {
        try { string(event.type); } catch (error) { throw classified(error, 'SSE_EVENT_TYPE'); }
        if (!CONSUMED_EVENTS.has(event.type) && !TERMINAL_FAILURES.has(event.type)) continue;
        if (event.type === 'response.output_text.delta' || event.type === 'response.output_text.done') {
          phase = event.type.endsWith('.delta') ? 'SSE_TEXT_DELTA' : 'SSE_TEXT_COMPLETION';
          const block = getBlock(event.item_id, event.content_index);
          if (block.ended) throw new BridgeError('PROTOCOL_INVALID', 'SSE_TEXT_COMPLETION');
          let text;
          if (event.type.endsWith('.delta')) {
            if (typeof event.delta !== 'string' || Buffer.byteLength(event.delta) > 256 * 1024) throw new BridgeError('PROTOCOL_INVALID', 'SSE_TEXT_DELTA');
            text = event.delta;
          }
          else {
            if (typeof event.text !== 'string' || !event.text.startsWith(block.text)) throw new BridgeError('PROTOCOL_INVALID', 'SSE_TEXT_COMPLETION');
            text = event.text.slice(block.text.length);
          }
          outputBytes += Buffer.byteLength(text); if (outputBytes > 256 * 1024) throw new BridgeError('LIMIT_EXCEEDED');
          if (!block.started) { block.started = true; if (controller.signal.aborted) throw new BridgeError('ABORTED'); yield { type: 'block-start', index: block.index, blockType: 'text' }; }
          if (text) { block.text += text; if (controller.signal.aborted) throw new BridgeError('ABORTED'); yield { type: 'text-delta', index: block.index, text }; }
          if (event.type.endsWith('.done')) { block.ended = true; if (controller.signal.aborted) throw new BridgeError('ABORTED'); yield { type: 'block-end', index: block.index, block: { type: 'text', text: block.text } }; }
        } else if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') {
          phase = 'SSE_OUTPUT_ITEM';
          if (!['message', 'reasoning', 'function_call', 'compaction'].includes(object(event.item).type)) throw new BridgeError('PROTOCOL_INVALID', 'SSE_OUTPUT_ITEM');
          if (event.type === 'response.output_item.done') {
            capture.observe(event);
            yield* reconcile(event.item);
          }
        } else if (event.type === 'response.completed') {
          phase = 'SSE_TERMINAL';
          if (object(event.response).status !== 'completed') throw new BridgeError('UPSTREAM_FAILED', 'SSE_TERMINAL');
          if (event.response.output !== undefined && event.response.output !== null) {
            if (!Array.isArray(event.response.output) || event.response.output.length > 128 || event.response.output.some(item => !['message', 'reasoning', 'function_call', 'compaction'].includes(item?.type))) throw new BridgeError('PROTOCOL_INVALID', 'SSE_OUTPUT_ITEM');
          }
          for (const item of event.response.output ?? []) yield* reconcile(item);
          for (const block of blocks.values()) if (!block.ended) { block.ended = true; if (controller.signal.aborted) throw new BridgeError('ABORTED'); yield { type: 'block-end', index: block.index, block: { type: 'text', text: block.text } }; }
          complete = true;
          if (event.response.usage !== undefined && event.response.usage !== null) { if (controller.signal.aborted) throw new BridgeError('ABORTED'); yield { type: 'usage', usage: responseUsage(event.response.usage, 'SSE_TERMINAL') }; }
          if (controller.signal.aborted) throw new BridgeError('ABORTED');
          const emitted = [...blocks.values()].map(block => block.type === 'tool-call'
            ? { type: 'tool-call', id: block.id, name: block.name, arguments: block.arguments } : { type: 'text', text: block.text });
          const marker = capture.finish(event.response.output, scope, originalPlan, emitted);
          // A marker is not part of the answer: failing to prove one never fails the turn.
          if (capture.refusal !== undefined) this.warn(`The subscription compaction marker was not published (${capture.refusal}); the turn's answer is unaffected.`);
          // The record is what the next turn can prove against. A turn whose id
          // cannot be bounded publishes nothing, and a trimmed turn cannot prove
          // the backend holds what the transcript says, so the chain is not
          // published and the next turn starts a new conversation.
          const record = trimmed ? { refusal: 'TRIMMED' }
            : conversationRecord(scope, event.response.id, digest(originalPlan.input), contentDigest(emitted));
          if (record.refusal !== undefined) this.warn(`The subscription conversation record was not published (${record.refusal}); the next turn sends the full history.`);
          const published = { ...(record.refusal === undefined ? record.response : {}), ...(marker?.response ?? {}) };
          yield { type: 'finish', reason: { kind: toolCalls ? 'tool-calls' : 'stop' }, ...(Object.keys(published).length === 0 ? {} : { replayState: { response: published } }) }; return;
        } else if (TERMINAL_FAILURES.has(event.type)) throw new BridgeError('UPSTREAM_FAILED', 'SSE_TERMINAL');
        // Any other event is a notification the bridge does not project. It is
        // ignored rather than failing a turn whose answer was already
        // delivered; the consumed branches above remain the only paths that
        // can produce text or tool calls.
      }
      if (!complete) throw new BridgeError('PROTOCOL_INVALID', 'SSE_INCOMPLETE');
    } catch (error) { if (controller.timedOut) throw new BridgeError('TIMEOUT'); if (controller.signal.aborted) throw new BridgeError('ABORTED'); throw classified(error, phase); }
    finally { controller.abort(); controller.removeBodyAbort?.(); await this.track(Promise.resolve(response?.body?.cancel()).catch(() => {}), controller); controller.release(); }
  }
  /** Read referenced image versions and enforce the aggregate offload budget. */
  async prepareImages(plan, controller) {
    const versions = new Map();
    if (!plan.images.size) return versions;
    const attachments = this.context?.resolveAttachments?.();
    if (attachments === undefined) throw new BridgeError('UNSUPPORTED_CONTENT', 'IMAGE_PREPARE');
    for (const entry of plan.images.values()) {
      if (versions.has(entry.ref.attachmentId)) continue;
      versions.set(entry.ref.attachmentId, await this.track(attachments.readImageRequest(entry.ref, entry.target, controller.signal), controller));
    }
    const offloadImages = requiredImageOffload(plan.imageBlocks.map(block => ({ content: [block] })),
      { representation: 'base64', maxBytes: REQUEST_IMAGE_OFFLOAD_MAX_BYTES, byteQuantum: REQUEST_IMAGE_OFFLOAD_BYTE_QUANTUM },
      block => versions.get(block.attachment.attachmentId).bytes);
    if (offloadImages > 0) throw new BridgeError('IMAGE_OFFLOAD_REQUIRED', 'IMAGE_OFFLOAD', { offloadImages });
    return versions;
  }
  /** Conservative host-side budgeting hint; the tile formula is an estimate. */
  imageRequestPricing(_provider, model) {
    string(model);
    return { priceImages: images => images.map(({ attachment: ref, offloaded }) => {
      if (offloaded === true) return { visualTokens: 0, text: offloadedImageText(ref, this.imageAccess(ref)) };
      const target = requestImageTarget(ref.width, ref.height);
      return { visualTokens: estimateVisionTokens(target.width, target.height), text: requestImageHandleText(ref, target, this.imageAccess(ref)) };
    }) };
  }
  close() {
    this.closing ??= this.shutdown();
    return this.closing;
  }
  async shutdown() {
    this.closed = true; this.cache = undefined;
    for (const controller of this.active) controller.abort();
    let timer;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new BridgeError('TIMEOUT')), this.shutdownTimeoutMs); });
    try {
      while (this.pending.size) await Promise.race([Promise.allSettled([...this.pending]), deadline]);
    } finally { clearTimeout(timer); }
  }
}
