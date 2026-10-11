import {events} from './sse.js';
export {events} from './sse.js';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { BridgeError, classified, object, string } from './errors.js';
import { validateInput, PROVIDER } from './text.js';
import { Http, BASE, statusError } from './http.js';
import { accountHeaders } from './auth.js';

const { name, version } = createRequire(import.meta.url)('../package.json');

function headers(token) {
  return { Authorization: `Bearer ${token}`, ...accountHeaders(token),
    'User-Agent': `${name}/${version}`, originator: 'dsh-codex-subscription-bridge' };
}
export class DirectBridge {
  constructor(auth, http = new Http(), { cacheMs = 60_000, turnTimeoutMs = 120_000, shutdownTimeoutMs = 5000 } = {}) {
    this.auth = auth; this.http = http; this.cacheMs = cacheMs; this.turnTimeoutMs = turnTimeoutMs;
    this.active = new Set(); this.owners = new WeakMap(); this.pending = new Set(); this.closed = false; this.shutdownTimeoutMs = shutdownTimeoutMs;
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
        if (entry.visibility === 'list') models.push({ id, name: string(entry.display_name), provider: PROVIDER, inputModalities: ['text'] });
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
    const history = validateInput(options); string(options.model);
    const controller = this.controller(options.signal, this.turnTimeoutMs); let response;
    let phase = 'MODEL_CATALOG';
    const blocks = new Map(); let outputBytes = 0, complete = false;
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
      if (!['message', 'reasoning'].includes(item.type)) throw new BridgeError('PROTOCOL_INVALID', 'SSE_OUTPUT_ITEM');
      if (item.type === 'reasoning') return;
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
      if (!models.some(model => model.id === options.model)) throw new BridgeError('MODEL_UNAVAILABLE');
      const token = await this.own(() => this.auth.token(controller.signal), controller.signal);
      const instructions = history.filter(item => item.role === 'developer').map(item => item.content.map(block => block.text).join('\n')).join('\n');
      phase = 'HTTP_REQUEST';
      response = await this.own(async () => {
        const result = await this.http.open(`${BASE}/responses`, { method: 'POST', headers: { ...headers(token), 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ model: options.model, instructions, input: history.filter(item => item.role !== 'developer'), store: false, stream: true }) }, controller.signal);
        const cancel = () => this.track(Promise.resolve(result.body?.cancel()).catch(() => {}), controller);
        controller.signal.addEventListener('abort', cancel, { once: true });
        controller.removeBodyAbort = () => controller.signal.removeEventListener('abort', cancel);
        if (controller.signal.aborted) await cancel();
        return result;
      }, controller.signal);
      if (!response.ok) { await response.body?.cancel(); throw statusError(response.status); }
      // The subscription backend can send valid SSE without an SSE MIME header.
      // Trust the bounded frame/event parser and terminal state, not Content-Type.
      phase = 'SSE_FRAME';
      for await (const event of events(response.body, controller.signal, promise => this.track(promise, controller))) {
        try { string(event.type); } catch (error) { throw classified(error, 'SSE_EVENT_TYPE'); }
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
          if (!['message', 'reasoning'].includes(object(event.item).type)) throw new BridgeError('PROTOCOL_INVALID', 'SSE_OUTPUT_ITEM');
          if (event.type === 'response.output_item.done') yield* reconcile(event.item);
        } else if (event.type === 'response.completed') {
          phase = 'SSE_TERMINAL';
          if (object(event.response).status !== 'completed') throw new BridgeError('UPSTREAM_FAILED', 'SSE_TERMINAL');
          if (event.response.output !== undefined && event.response.output !== null) {
            if (!Array.isArray(event.response.output) || event.response.output.length > 128 || event.response.output.some(item => !['message', 'reasoning'].includes(item?.type))) throw new BridgeError('PROTOCOL_INVALID', 'SSE_OUTPUT_ITEM');
          }
          for (const item of event.response.output ?? []) yield* reconcile(item);
          for (const block of blocks.values()) if (!block.ended) { block.ended = true; if (controller.signal.aborted) throw new BridgeError('ABORTED'); yield { type: 'block-end', index: block.index, block: { type: 'text', text: block.text } }; }
          complete = true; if (controller.signal.aborted) throw new BridgeError('ABORTED'); yield { type: 'finish', reason: { kind: 'stop' } }; return;
        } else if (['error', 'response.failed', 'response.incomplete', 'response.refusal.delta', 'response.refusal.done'].includes(event.type)) throw new BridgeError('UPSTREAM_FAILED', 'SSE_TERMINAL');
        else if (!['response.created', 'response.in_progress', 'response.content_part.added', 'response.content_part.done',
          'response.reasoning_summary_part.added', 'response.reasoning_summary_part.done', 'response.reasoning_summary_text.delta',
          'response.reasoning_summary_text.done', 'response.reasoning_text.delta', 'response.reasoning_text.done'].includes(event.type)) throw new BridgeError('PROTOCOL_INVALID', 'SSE_EVENT_UNSUPPORTED');
      }
      if (!complete) throw new BridgeError('PROTOCOL_INVALID', 'SSE_INCOMPLETE');
    } catch (error) { if (controller.timedOut) throw new BridgeError('TIMEOUT'); if (controller.signal.aborted) throw new BridgeError('ABORTED'); throw classified(error, phase); }
    finally { controller.abort(); controller.removeBodyAbort?.(); await this.track(Promise.resolve(response?.body?.cancel()).catch(() => {}), controller); controller.release(); }
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
