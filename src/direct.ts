import {events, FRAME_LIMIT, EVENT_LIMIT_CAP, type SseEvent, type FramingLimits} from './sse.js';
export {events} from './sse.js';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import type { GenerateOptions, StreamChunk, TokenUsage, FinishReason, ImageBlock, ModelModality, ToolCallId, RequestMessage, ImageAttachmentAccess } from '@deepseek-ai/dsh-llm';
import { BridgeError, classified, errorFields, parameterRejection, classifyErrorFields, object, string, type JsonObject } from './errors.js';
import { validateInput, PROVIDER, TOOL_NAME_LIMIT, CALL_ID_LIMIT, TOOL_BYTES_LIMIT, reasoningLevels, type GenerateInput, type RequestPlan, type RequestImageEntry, type ContentBlock, type ImageRef, type ReasoningLevel } from './text.js';
import { REQUEST_IMAGE_OFFLOAD_MAX_BYTES, REQUEST_IMAGE_OFFLOAD_BYTE_QUANTUM, estimateVisionTokens, imageDataUrl, requestImageTarget, type ImageDimensions } from './image.js';
import { offloadedImageText, projectOffloadedImages, requestImageHandleText, requiredImageOffload } from '@deepseek-ai/dsh-llm';
import { Http, BASE, classifyStatusError, readJson } from './http.js';
import type { Response } from 'undici';
import { AuthStore, accountHeaders, compactionAccount } from './auth.js';
import { CompactionCapture, PERCENT_MAX, threshold, requestLimits, compactionScope, inspectCheckpoint, compactPlan, trimOldest, type CheckpointMessage, type SelectedCheckpoint } from './compaction.js';
import { digest, contentDigest, type HashableBlock } from './hashes.js';

const { name, version } = createRequire(import.meta.url)('../package.json');

/** One unvalidated wire record read from the stream. */
type WireRecord = Record<string, unknown>;

/** One streamed block under assembly; a text block carries no type until it is emitted. */
type StreamBlock = {
  index: number;
  type?: string;
  text?: string;
  started?: boolean;
  ended?: boolean;
  id?: string;
  name?: string;
  arguments?: string;
};

/** One tracked controller with the work set and release flags this bridge owns. */
interface TrackedController extends AbortController {
  work: Set<Promise<unknown>>;
  timedOut?: boolean;
  finished?: boolean;
  abortDispatched?: boolean;
  tryRelease: () => void;
  release: () => void;
  removeBodyAbort?: () => void;
}

/** One cached request image version; only the fields this bridge reads are named. */
type RequestImageVersion = { data: Uint8Array; mediaType: string; bytes: number };

/** The attachment store shape this bridge reads; the host mounts it. */
type AttachmentStoreShape = { readImageRequest: (ref: ImageRef, target: ImageDimensions, signal?: AbortSignal) => Promise<RequestImageVersion> };

/** The host services this bridge reads for image access. */
export type BridgeContext = {
  warn?: (message: string) => void;
  // The host attachment service and its reference type are not re-exported by dsh-llm.
  resolveAttachments?: () => any;
  resolveImageAccess?: (attachments: any, ref: any) => ImageAttachmentAccess | undefined;
};

/** The catalog entry this bridge publishes. */
export type CatalogModel = {
  id: string;
  name: string;
  provider: string;
  inputModalities: readonly ModelModality[];
  contextWindow?: number;
  effectivePercent?: number;
  reasoningLevels?: ReasoningLevel[];
  defaultReasoningLevel?: string;
};

/** The cached catalog for one authenticated identity. */
type CatalogCache = { identity: string; models: CatalogModel[]; expires: number };

/**
 * Stream events the bridge consumes. Everything else in the stream is a
 * notification: it may announce backend state, progress, or parts of an item
 * this bridge does not project, and it carries nothing the bridge renders.
 *
 * The subscription backend is a live, evolving Responses surface, and the
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
const CONSUMED_EVENTS = new Set<string>([
  'response.output_text.delta', 'response.output_text.done',
  'response.output_item.added', 'response.output_item.done', 'response.completed',
]);
// Terminal failures and refusals are fatal: they mean the backend reported that
// it could not produce the answer, which must not be reported as success.
const TERMINAL_FAILURES = new Set<string>(['error', 'response.failed', 'response.incomplete', 'response.refusal.delta', 'response.refusal.done']);
function headers(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, ...accountHeaders(token),
    'User-Agent': `${name}/${version}`, originator: 'dsh-codex-subscription-bridge' };
}

/** Map the subscription backend's terminal usage record; absent fields stay absent. */
function responseUsage(value: unknown, diagnostic: string): TokenUsage {
  const wire = object(value);
  const inputTokens = wire.input_tokens, outputTokens = wire.output_tokens;
  // `Number.isSafeInteger` proves the value is a number but cannot narrow it.
  if (!Number.isSafeInteger(inputTokens) || (inputTokens as number) < 0 || !Number.isSafeInteger(outputTokens) || (outputTokens as number) < 0) throw new BridgeError('PROTOCOL_INVALID', diagnostic);
  const usage: TokenUsage = { inputTokens: inputTokens as number, outputTokens: outputTokens as number };
  const cached = (wire.input_tokens_details as JsonObject | undefined)?.cached_tokens;
  if (cached !== undefined) {
    if (!Number.isSafeInteger(cached) || (cached as number) < 0 || (cached as number) > (inputTokens as number)) throw new BridgeError('PROTOCOL_INVALID', diagnostic);
    // Responses input includes cache hits; Harness expects disjoint input buckets.
    usage.inputTokens = (inputTokens as number) - (cached as number);
    usage.cacheReadTokens = cached as number;
  }
  const reasoning = (wire.output_tokens_details as JsonObject | undefined)?.reasoning_tokens;
  if (reasoning !== undefined) { if (!Number.isSafeInteger(reasoning) || (reasoning as number) < 0) throw new BridgeError('PROTOCOL_INVALID', diagnostic); usage.reasoningTokens = reasoning as number; }
  const total = wire.total_tokens;
  if (total !== undefined) { if (!Number.isSafeInteger(total) || (total as number) < 0) throw new BridgeError('PROTOCOL_INVALID', diagnostic); usage.totalTokens = total as number; }
  return usage;
}
export class DirectBridge {
  auth: AuthStore;
  http: Http;
  cache: CatalogCache | undefined;
  cacheMs: number;
  active: Set<TrackedController>;
  owners: WeakMap<AbortSignal, TrackedController>;
  pending: Set<Promise<unknown>>;
  closed: boolean;
  discovery: Promise<CatalogModel[]> | undefined;
  closing: Promise<void> | undefined;
  turnTimeoutMs: number;
  shutdownTimeoutMs: number;
  context: BridgeContext;
  warn: (message: string) => void;
  imageAccess: (ref: ImageRef) => ImageAttachmentAccess | undefined;

  constructor(auth: AuthStore, http = new Http(), { cacheMs = 60_000, turnTimeoutMs = 120_000, shutdownTimeoutMs = 5000 }: { cacheMs?: number; turnTimeoutMs?: number; shutdownTimeoutMs?: number } = {}, context: BridgeContext = {}) {
    this.auth = auth; this.http = http; this.cacheMs = cacheMs; this.turnTimeoutMs = turnTimeoutMs;
    this.active = new Set(); this.owners = new WeakMap(); this.pending = new Set(); this.closed = false; this.shutdownTimeoutMs = shutdownTimeoutMs;
    this.context = context; this.warn = typeof context?.warn === 'function' ? context.warn : () => {};
    // Mirror the DeepSeek adapter's shared access resolver: image placeholders,
    // request serialization, and pricing all resolve through one function that
    // stays undefined while no attachment service is mounted.
    this.imageAccess = (ref: ImageRef) => {
      const attachments = this.context?.resolveAttachments?.();
      return attachments === undefined ? undefined : this.context.resolveImageAccess?.(attachments, ref);
    };
  }
  track(promise: Promise<unknown>, owner: TrackedController | undefined): Promise<unknown> {
    this.pending.add(promise); owner?.work.add(promise);
    const settled = () => { this.pending.delete(promise); owner?.work.delete(promise); owner?.tryRelease(); };
    promise.then(settled, settled);
    return promise;
  }
  own<T>(task: () => T | Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.closed) return Promise.reject(new BridgeError('CLOSED'));
    if (signal?.aborted) return Promise.reject(new BridgeError('ABORTED'));
    return this.track(Promise.resolve().then(() => {
      if (signal?.aborted) throw new BridgeError('ABORTED');
      return task();
    }), signal === undefined ? undefined : this.owners.get(signal)) as Promise<T>;
  }
  controller(signal: AbortSignal | undefined, timeoutMs: number): TrackedController {
    if (this.closed) throw new BridgeError('CLOSED');
    if (signal?.aborted) throw new BridgeError('ABORTED');
    if (this.active.size >= 4) throw new BridgeError('LIMIT_EXCEEDED');
    const controller = new AbortController() as TrackedController; controller.work = new Set();
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
  async catalog(signal?: AbortSignal, fresh = false): Promise<CatalogModel[]> {
    try {
      // Always reread/refresh authentication first, including metadata cache hits.
      const token = await this.own(() => this.auth.token(signal), signal);
      const identity = createHash('sha256').update(token).digest('hex');
      if (!fresh && this.cache?.identity === identity && this.cache.expires > Date.now()) return this.cache.models;
      // Match the reference's catalog compatibility selectors, not a CLI identity.
      let result: JsonObject | undefined;
      for (const version of ['99.0.0', '0.0.0']) {
        result = object(await this.own(() => this.http.json(`${BASE}/models?client_version=${version}`, { headers: headers(token) }, signal), signal));
        if (!Array.isArray(result.models) || result.models.length > 512) throw new BridgeError('PROTOCOL_INVALID');
        if (result.models.length) break;
      }
      const ids = new Set<string>(); const models: CatalogModel[] = [];
      // The loop above proves the parsed catalog body.
      for (const entry of (result as JsonObject).models as WireRecord[]) {
        object(entry); const id = string(entry.slug); if (ids.has(id)) throw new BridgeError('PROTOCOL_INVALID'); ids.add(id);
        if (!['list', 'hide'].includes(entry.visibility as string)) throw new BridgeError('PROTOCOL_INVALID');
        if (entry.visibility === 'list') {
          const model: CatalogModel = { id, name: string(entry.display_name), provider: PROVIDER, inputModalities: ['text', 'image'] };
          // The disclosed per-model window is the combined request and response
          // context the host needs for compaction pressure; absence stays optional.
          if (entry.context_window !== undefined) {
            if (!Number.isSafeInteger(entry.context_window) || (entry.context_window as number) <= 0) throw new BridgeError('PROTOCOL_INVALID');
            model.contextWindow = entry.context_window as number;
          }
          // The backend's own client derives its compaction limit from a per-model
          // effective percent, so a disclosed percent is read here. Absence stays
          // optional and the shipped ratio is the fallback; a malformed disclosed
          // value fails closed like the window does.
          if (entry.effective_context_window_percent !== undefined) {
            if (!Number.isSafeInteger(entry.effective_context_window_percent) ||
                (entry.effective_context_window_percent as number) < 1 || (entry.effective_context_window_percent as number) > PERCENT_MAX) throw new BridgeError('PROTOCOL_INVALID');
            model.effectivePercent = entry.effective_context_window_percent as number;
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
  async discover(signal?: AbortSignal): Promise<CatalogModel[]> {
    const controller = this.controller(signal, 30_000);
    return this.track((async () => {
      try { return await this.catalog(controller.signal); }
      catch (error) { if (controller.timedOut) throw new BridgeError('TIMEOUT'); throw error; }
      finally { controller.release(); }
    })(), controller) as Promise<CatalogModel[]>;
  }
  async listModels(signal?: AbortSignal): Promise<CatalogModel[]> {
    if (this.closed) throw new BridgeError('CLOSED');
    if (signal) return this.discover(signal);
    this.discovery ??= this.discover().finally(() => { this.discovery = undefined; });
    const models = await this.discovery;
    return models.map(model => ({ ...model, inputModalities: [...model.inputModalities] }));
  }
  async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk, void, undefined> {
    // Project offloaded image occurrences into text placeholders before
    // validation, matching the DeepSeek adapter's projection order.
    const messages = projectOffloadedImages(options.messages, ref => offloadedImageText(ref, this.imageAccess(ref)));
    string(options.model);
    const capture = new CompactionCapture(); let scope: string; let compactThreshold: number | undefined;
    const controller = this.controller(options.signal, this.turnTimeoutMs); let response: Response | undefined;
    let phase = 'MODEL_CATALOG';
    const blocks = new Map<string, StreamBlock>(); let outputBytes = 0, toolBytes = 0, complete = false, toolCalls = false;
    const getBlock = (id: unknown, contentIndex: unknown): StreamBlock => {
      string(id); if (!Number.isSafeInteger(contentIndex) || (contentIndex as number) < 0 || (contentIndex as number) > 63) throw new BridgeError('PROTOCOL_INVALID');
      const key = `${id}:${contentIndex}`;
      if (!blocks.has(key)) {
        if (blocks.size >= 128) throw new BridgeError('LIMIT_EXCEEDED');
        blocks.set(key, { index: blocks.size, text: '', started: false, ended: false });
      }
      return blocks.get(key) as StreamBlock;
    };
    function* reconcile(item: WireRecord): Generator<StreamChunk> {
      object(item);
      if (!['message', 'reasoning', 'function_call', 'compaction'].includes(item.type as string)) throw new BridgeError('PROTOCOL_INVALID', 'SSE_OUTPUT_ITEM');
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
        // The host keys tool calls by its own branded id; the validated string is that id.
        yield { type: 'tool-call-delta', index: block.index, id: callId as ToolCallId, name: item.name, argumentsDelta: '' };
        if (controller.signal.aborted) throw new BridgeError('ABORTED');
        yield { type: 'block-end', index: block.index, block: { type: 'tool-call', id: callId as ToolCallId, name: item.name, arguments: item.arguments } };
        return;
      }
      if (item.status !== undefined && item.status !== 'completed') throw new BridgeError('PROTOCOL_INVALID', 'SSE_OUTPUT_ITEM');
      if (item.role !== 'assistant' || !Array.isArray(item.content) || item.content.length > 64) throw new BridgeError('PROTOCOL_INVALID', 'SSE_OUTPUT_ITEM');
      for (const [index, content] of item.content.entries()) {
        if (content?.type !== 'output_text' || typeof content.text !== 'string') throw new BridgeError('PROTOCOL_INVALID', 'SSE_OUTPUT_ITEM');
        const block = getBlock(item.id, index);
        if (!content.text.startsWith(block.text as string) || (block.ended && content.text !== block.text)) throw new BridgeError('PROTOCOL_INVALID', 'SSE_OUTPUT_ITEM');
        const tail = content.text.slice((block.text as string).length);
        outputBytes += Buffer.byteLength(tail); if (outputBytes > 256 * 1024) throw new BridgeError('LIMIT_EXCEEDED');
        if (!block.started) { block.started = true; if (controller.signal.aborted) throw new BridgeError('ABORTED'); yield { type: 'block-start', index: block.index, blockType: 'text' }; }
        if (tail) { block.text = (block.text as string) + tail; if (controller.signal.aborted) throw new BridgeError('ABORTED'); yield { type: 'text-delta', index: block.index, text: tail }; }
        if (!block.ended) { block.ended = true; if (controller.signal.aborted) throw new BridgeError('ABORTED'); yield { type: 'block-end', index: block.index, block: { type: 'text', text: block.text as string } }; }
      }
    }
    try {
      const models = await this.catalog(controller.signal, true);
      const selected = models.find(model => model.id === options.model);
      if (selected === undefined) throw new BridgeError('MODEL_UNAVAILABLE');
      // The request bound and the compaction threshold come from the same
      // disclosed window and the same per-model percent, so the model has to be
      // resolved before validation. Retained limits admit a transcript that may
      // be trimmed from the oldest end to fit the wire bound below. Trimming
      // enforces that resource limit; it is not what keeps the request inside the
      // model window, because the backend compacts a request past the window.
      const retainedLimits = requestLimits(selected.contextWindow, true, selected.effectivePercent);
      const wireLimits = requestLimits(selected.contextWindow, false, selected.effectivePercent);
      // The persisted window bound comes from the same disclosed window as the
      // threshold. It bounds opaque content the bridge cannot measure in tokens.
      capture.limit = wireLimits.checkpointBytes;
      phase = 'INPUT';
      // Host messages arrive unvalidated; the local shape is what validation checks field by field.
      const originalPlan = validateInput({ ...options, messages } as GenerateInput, true, retainedLimits);
      let plan: RequestPlan & { trimmed?: number } = originalPlan;
      // The host selects only declared levels, but a direct caller can name any
      // bounded id; a choice the model does not disclose fails closed here.
      if (plan.reasoning !== undefined && !(selected.reasoningLevels ?? []).some(level => level.id === plan.reasoning?.effort)) {
        throw new BridgeError('INPUT_UNSUPPORTED');
      }
      const token = await this.own(() => this.auth.token(controller.signal), controller.signal);
      scope = compactionScope(compactionAccount(token), options.model, originalPlan);
      compactThreshold = threshold(selected.contextWindow, selected.effectivePercent);
      // The transport framing must stay above the admitted window, not at it:
      // one compaction item travels inside a single event frame and repeats in
      // up to three events (added, done and the terminal echo). The window
      // estimate is the capture bound, so content the capture refuses gently —
      // an encoding denser than the estimate — still streams and the turn keeps
      // its answer; framing fails only past twice the estimate. Without a
      // threshold no compaction item can appear and the default bounds stand.
      const itemFrame = compactThreshold === undefined ? undefined : 2 * wireLimits.checkpointBytes;
      // The event count rises with the framing bounds: a long answer streams
      // many small deltas — including reasoning deltas the bridge does not
      // forward — and the default 4096-event count fails such a turn before
      // any text is delivered. The count sizes from the same admitted window
      // at a conservative 128-byte event envelope estimate, so the admitted
      // byte budget bounds the count too; the aggregate byte limit stays the
      // hard backstop for streams of smaller events.
      const framing = itemFrame === undefined ? undefined
        : { frameLimit: itemFrame, totalLimit: 3 * itemFrame + 4 * FRAME_LIMIT,
            eventLimit: Math.min(EVENT_LIMIT_CAP, Math.ceil(itemFrame / 128)) };
      // The persisted replay shape is this module's own; the host source carries it opaquely.
      const checkpoint = compactThreshold === undefined ? {} : inspectCheckpoint(messages as readonly CheckpointMessage[], originalPlan, scope, Date.now(), wireLimits.checkpointBytes);
      // A refusal is the model-switch, expiry and edited-history boundary: the
      // opaque state cannot carry over, so the host log names it before the
      // bounded local history is resent on its own.
      if (checkpoint.refusal !== undefined) this.warn(`The encrypted subscription compaction state was refused (${checkpoint.refusal}); resending the bounded local history.`);
      // A selected checkpoint replaces only its exact covered prefix. Otherwise
      // the retained transcript is revalidated under the window-derived wire limits.
      const fullHistory = () => {
        const fitted = trimOldest(originalPlan, wireLimits);
        if (fitted.trimmed > 0) this.warn(`The full history was trimmed from the oldest end (${fitted.trimmed} items) to fit the request bound.`);
        return fitted;
      };
      if (checkpoint.items !== undefined) {
        plan = compactPlan(originalPlan, checkpoint as SelectedCheckpoint, wireLimits);
        // Dropping the oldest covered items is recovery, not refusal: the turn
        // still runs on a shorter window, matching the official client's behavior
        // when the window is exceeded while compacting. The log names the count.
        if ((plan.trimmed as number) > 0) this.warn(`The subscription compaction window was trimmed from the oldest end (${plan.trimmed} items) to fit the request bound.`);
      }
      else {
        try { plan = { ...originalPlan, ...fullHistory() }; }
        catch (error) {
          // Without a reusable checkpoint the full local transcript is the only
          // remaining input; name that boundary instead of the generic shape failure.
          if (checkpoint.refusal !== undefined && error instanceof BridgeError && error.code === 'INPUT_UNSUPPORTED') throw new BridgeError('COMPACTION_UNAVAILABLE', 'COMPACTION');
          throw error;
        }
      }
      const openTurn = async () => {
        phase = 'IMAGE_PREPARE';
        const versions = await this.prepareImages(plan, controller);
        const input = versions.size ? plan.input.map(item => item.type !== 'message' ? item : { ...item, content: item.content.map(part => {
          if (part.type !== 'input_image') return part;
          const image = versions.get(part.attachmentId as string) as RequestImageVersion;
          return { type: 'input_image', image_url: imageDataUrl(image.mediaType, Buffer.from(image.data).toString('base64')) };
        }) }) : plan.input;
        const instructions = input.filter(item => item.type === 'message' && item.role === 'developer').map(item => ((item as { content: WireRecord[] }).content).map(block => block.text).join('\n')).join('\n');
        phase = 'HTTP_REQUEST';
        return await this.own(async () => {
          const result = await this.http.open(`${BASE}/responses`, { method: 'POST', headers: { ...headers(token), 'Content-Type': 'application/json', Accept: 'text/event-stream' },
          body: JSON.stringify({ model: options.model, instructions, input: input.filter(item => !(item.type === 'message' && item.role === 'developer')),
            store: false, stream: true, ...(compactThreshold === undefined ? {} : { context_management: [{ type: 'compaction', compact_threshold: compactThreshold }] }), ...(plan.temperature === undefined ? {} : { temperature: plan.temperature }),
            ...(plan.tools === undefined ? {} : { tools: plan.tools }), ...(plan.reasoning === undefined ? {} : { reasoning: plan.reasoning }) }) }, controller.signal);
          const cancel = () => this.track(Promise.resolve(result.body?.cancel()).catch(() => {}), controller);
          controller.signal.addEventListener('abort', cancel, { once: true });
          controller.removeBodyAbort = () => controller.signal.removeEventListener('abort', cancel);
          if (controller.signal.aborted) await cancel();
          return result;
        }, controller.signal);
      };
      let attempt = 0;
      while (true) {
        response = await openTurn();
        // Only an explicit parameter rejection authorizes one bounded full-history
        // retry, and only before anything was delivered. The endpoint reports it in the
        // structured error body on this path; the measured path reports it as an SSE
        // error event, handled below. Both are read only to recognize the fixed code
        // and the fixed parameter name.
        if (compactThreshold !== undefined && attempt === 0 && [400, 422].includes(response.status)) {
          let rejected: boolean | undefined;
          try {
            const body = await this.own(() => readJson(response as Response, 16 * 1024, controller.signal), controller.signal);
            if (parameterRejection(errorFields((body as JsonObject)?.error))) rejected = true;
          } catch { if (controller.signal.aborted) throw new BridgeError('ABORTED'); }
          if (rejected) {
            // A rejected parameter is not resent, so the retry drops it.
            compactThreshold = undefined;
            controller.removeBodyAbort?.();
            await this.track(Promise.resolve(response.body?.cancel()).catch(() => {}), controller);
            plan = { ...originalPlan, ...fullHistory() };
            attempt += 1;
            continue;
          }
        }
        if (!response.ok) throw await classifyStatusError(response.status, response, controller.signal);
        // The subscription backend can send valid SSE without an SSE MIME header.
        // Trust the bounded frame/event parser and terminal state, not Content-Type.
        phase = 'SSE_FRAME';
        let rejectedParameter = false;
        // The retry after a rejected parameter drops the threshold, so it also
        // drops the raised bounds: no compaction item can arrive on that stream.
        for await (const event of events(response.body, controller.signal, promise => this.track(promise, controller), compactThreshold === undefined ? undefined : framing)) {
          try { string(event.type); } catch (error) { throw classified(error, 'SSE_EVENT_TYPE'); }
          if (!CONSUMED_EVENTS.has(event.type) && !TERMINAL_FAILURES.has(event.type)) continue;
          if (event.type === 'response.output_text.delta' || event.type === 'response.output_text.done') {
            phase = event.type.endsWith('.delta') ? 'SSE_TEXT_DELTA' : 'SSE_TEXT_COMPLETION';
            const block = getBlock(event.item_id, event.content_index);
            if (block.ended) throw new BridgeError('PROTOCOL_INVALID', 'SSE_TEXT_COMPLETION');
            let text: string;
            if (event.type.endsWith('.delta')) {
              if (typeof event.delta !== 'string' || Buffer.byteLength(event.delta) > 256 * 1024) throw new BridgeError('PROTOCOL_INVALID', 'SSE_TEXT_DELTA');
              text = event.delta;
            }
            else {
              if (typeof event.text !== 'string' || !event.text.startsWith(block.text as string)) throw new BridgeError('PROTOCOL_INVALID', 'SSE_TEXT_COMPLETION');
              text = event.text.slice((block.text as string).length);
            }
            outputBytes += Buffer.byteLength(text); if (outputBytes > 256 * 1024) throw new BridgeError('LIMIT_EXCEEDED');
            if (!block.started) { block.started = true; if (controller.signal.aborted) throw new BridgeError('ABORTED'); yield { type: 'block-start', index: block.index, blockType: 'text' }; }
            if (text) { block.text = (block.text as string) + text; if (controller.signal.aborted) throw new BridgeError('ABORTED'); yield { type: 'text-delta', index: block.index, text }; }
            if (event.type.endsWith('.done')) { block.ended = true; if (controller.signal.aborted) throw new BridgeError('ABORTED'); yield { type: 'block-end', index: block.index, block: { type: 'text', text: block.text as string } }; }
          } else if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') {
            phase = 'SSE_OUTPUT_ITEM';
            if (!['message', 'reasoning', 'function_call', 'compaction'].includes(object(event.item).type as string)) throw new BridgeError('PROTOCOL_INVALID', 'SSE_OUTPUT_ITEM');
            if (event.type === 'response.output_item.done') {
              capture.observe(event);
              yield* reconcile(event.item as WireRecord);
            }
          } else if (event.type === 'response.completed') {
            phase = 'SSE_TERMINAL';
            if (object(event.response).status !== 'completed') throw new BridgeError('UPSTREAM_FAILED', 'SSE_TERMINAL');
            // `event.response` is the unvalidated terminal record; the checks below prove it.
            const terminal = object(event.response);
            if (terminal.output !== undefined && terminal.output !== null) {
              if (!Array.isArray(terminal.output) || terminal.output.length > 128 || terminal.output.some(item => !['message', 'reasoning', 'function_call', 'compaction'].includes((item as WireRecord)?.type as string))) throw new BridgeError('PROTOCOL_INVALID', 'SSE_OUTPUT_ITEM');
            }
            for (const item of (terminal.output as WireRecord[]) ?? []) yield* reconcile(item);
            for (const block of blocks.values()) if (!block.ended) { block.ended = true; if (controller.signal.aborted) throw new BridgeError('ABORTED'); yield { type: 'block-end', index: block.index, block: { type: 'text', text: block.text as string } }; }
            complete = true;
            if (terminal.usage !== undefined && terminal.usage !== null) { if (controller.signal.aborted) throw new BridgeError('ABORTED'); yield { type: 'usage', usage: responseUsage(terminal.usage, 'SSE_TERMINAL') }; }
            if (controller.signal.aborted) throw new BridgeError('ABORTED');
            const emitted: HashableBlock[] = [...blocks.values()].map(block => block.type === 'tool-call'
              ? { type: 'tool-call', id: block.id, name: block.name, arguments: block.arguments } : { type: 'text', text: block.text });
            const replayState = compactThreshold === undefined ? undefined : capture.finish(terminal.output, scope, originalPlan, emitted);
            // A refused checkpoint costs the next turn its replay window, not this
            // turn's answer, so it is logged rather than raised.
            if (capture.refusal !== undefined) this.warn(`The subscription compaction checkpoint was not published (${capture.refusal}); the bounded local history is resent.`);
            if (capture.trimmed > 0) this.warn(`The published subscription compaction window was trimmed from the oldest end (${capture.trimmed} items) to fit its bound.`);
            yield { type: 'finish', reason: { kind: toolCalls ? 'tool-calls' : 'stop' } as FinishReason, ...(replayState === undefined ? {} : { replayState }) }; return;
          } else if (TERMINAL_FAILURES.has(event.type)) {
            const fields = errorFields(event.error);
            // On this backend a rejected parameter arrives as a structured SSE error
            // event rather than in the HTTP body. Nothing delivered to the host yet is
            // the boundary that still allows the one bounded retry.
            if (compactThreshold !== undefined && attempt === 0 && blocks.size === 0 && parameterRejection(fields)) { rejectedParameter = true; break; }
            throw classifyErrorFields(fields);
          }
          // Any other event is a notification the bridge does not project. It is
          // ignored rather than failing a turn whose answer was already
          // delivered; the consumed branches above remain the only paths that
          // can produce text or tool calls.
          }
        if (rejectedParameter) {
          // A rejected parameter is not resent, so the retry drops it. The stream
          // ended at the error event, so nothing was delivered on this attempt.
          compactThreshold = undefined;
          controller.removeBodyAbort?.();
          await this.track(Promise.resolve(response.body?.cancel()).catch(() => {}), controller);
          plan = { ...originalPlan, ...fullHistory() };
          attempt += 1;
          continue;
        }
        if (!complete) throw new BridgeError('PROTOCOL_INVALID', 'SSE_INCOMPLETE');
        return;
      }
    } catch (error) {
      if (controller.timedOut) throw new BridgeError('TIMEOUT');
      if (controller.signal.aborted) throw new BridgeError('ABORTED');
      const failed = classified(error, phase);
      // A resource-limit failure carries only structured numbers; the owner's
      // log names the bound they hit, with no request or response content.
      if (failed.sseLimit !== undefined) this.warn(`${failed.message} (${failed.sseCount} of ${failed.sseLimit} in the admitted window.)`);
      throw failed;
    }
    finally { controller.abort(); controller.removeBodyAbort?.(); await this.track(Promise.resolve(response?.body?.cancel()).catch(() => {}), controller); controller.release(); }
  }
  /** Read referenced image versions and enforce the aggregate offload budget. */
  async prepareImages(plan: RequestPlan, controller: TrackedController): Promise<Map<string, RequestImageVersion>> {
    const versions = new Map<string, RequestImageVersion>();
    if (!plan.images.size) return versions;
    const attachments = this.context?.resolveAttachments?.();
    if (attachments === undefined) throw new BridgeError('UNSUPPORTED_CONTENT', 'IMAGE_PREPARE');
    for (const entry of plan.images.values()) {
      if (versions.has(entry.ref.attachmentId)) continue;
      // `track` returns the same promise it was given.
      versions.set(entry.ref.attachmentId, await this.track(attachments.readImageRequest(entry.ref, entry.target, controller.signal), controller) as RequestImageVersion);
    }
    // The host helper takes its own request-message shape; the bridge's validated blocks are the same content.
    const offloadImages = requiredImageOffload(plan.imageBlocks.map(block => ({ content: [block] })) as unknown as readonly RequestMessage[],
      { representation: 'base64', maxBytes: REQUEST_IMAGE_OFFLOAD_MAX_BYTES, byteQuantum: REQUEST_IMAGE_OFFLOAD_BYTE_QUANTUM },
      block => (versions.get(block.attachment.attachmentId) as RequestImageVersion).bytes);
    if (offloadImages > 0) throw new BridgeError('IMAGE_OFFLOAD_REQUIRED', 'IMAGE_OFFLOAD', { offloadImages });
    return versions;
  }
  /** Conservative host-side budgeting hint; the tile formula is an estimate. */
  imageRequestPricing(_provider: string, model: string): { priceImages: (images: readonly ImageBlock[]) => { visualTokens: number; text: string }[] } {
    string(model);
    return { priceImages: images => images.map(({ attachment: ref, offloaded }) => {
      if (offloaded === true) return { visualTokens: 0, text: offloadedImageText(ref, this.imageAccess(ref)) };
      const target = requestImageTarget(ref.width, ref.height);
      return { visualTokens: estimateVisionTokens(target.width, target.height), text: requestImageHandleText(ref, target, this.imageAccess(ref)) };
    }) };
  }
  /** Report the projection the request serializer uses, so host consumers measure the same image. */
  imageRequestTarget(_provider: string, model: string, image: ImageRef): ImageDimensions & { maxBytes: number } {
    string(model);
    const ref = object(image) as ImageRef;
    if (!Number.isSafeInteger(ref.width) || (ref.width as number) < 1 || !Number.isSafeInteger(ref.height) || (ref.height as number) < 1) {
      throw new BridgeError('UNSUPPORTED_CONTENT', 'IMAGE_TARGET');
    }
    return requestImageTarget(ref.width as number, ref.height as number);
  }
  close(): Promise<void> {
    this.closing ??= this.shutdown(); return this.closing;
  }
  async shutdown(): Promise<void> {
    this.closed = true; this.cache = undefined;
    for (const controller of this.active) controller.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new BridgeError('TIMEOUT')), this.shutdownTimeoutMs); });
    try {
      while (this.pending.size) await Promise.race([Promise.allSettled([...this.pending]), deadline]);
    } finally { clearTimeout(timer); }
  }
}
