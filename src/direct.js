import { createHash } from 'node:crypto';
import { BridgeError, object, string } from './errors.js';
import { validateInput, PROVIDER } from './text.js';
import { Http, BASE, statusError } from './http.js';
import { accountHeaders } from './auth.js';

function headers(token) {
  return { Authorization: `Bearer ${token}`, ...accountHeaders(token),
    'User-Agent': 'dsh-codex-subscription-bridge/0.0.0', originator: 'dsh-codex-subscription-bridge' };
}
/** Bounded SSE parser; EOF never substitutes for a successful terminal event. */
export async function* events(body, signal) {
  if (!body) throw new BridgeError('PROTOCOL_INVALID');
  const reader = body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '', total = 0, count = 0;
  try {
    for (;;) {
      if (signal.aborted) throw new BridgeError('ABORTED');
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > 4 * 1024 * 1024) throw new BridgeError('LIMIT_EXCEEDED');
      buffer += decoder.decode(part.value, { stream: true });
      for (;;) {
        const delimiter = /\r?\n\r?\n/u.exec(buffer); if (!delimiter) break;
        const frame = buffer.slice(0, delimiter.index); buffer = buffer.slice(delimiter.index + delimiter[0].length);
        if (Buffer.byteLength(frame) > 1024 * 1024 || ++count > 4096) throw new BridgeError('LIMIT_EXCEEDED');
        const data = frame.split(/\r?\n/u).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /u, '')).join('\n');
        if (!data || data === '[DONE]') continue;
        let value;
        try { value = object(JSON.parse(data)); } catch { throw new BridgeError('PROTOCOL_INVALID'); }
        yield value;
      }
      if (Buffer.byteLength(buffer) > 1024 * 1024) throw new BridgeError('LIMIT_EXCEEDED');
    }
    if (signal.aborted) throw new BridgeError('ABORTED');
    decoder.decode();
    if (buffer.trim()) throw new BridgeError('PROTOCOL_INVALID');
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError(signal.aborted ? 'ABORTED' : 'PROTOCOL_INVALID');
  } finally { signal.removeEventListener('abort', cancel); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export class DirectBridge {
  constructor(auth, http = new Http(), { cacheMs = 60_000, turnTimeoutMs = 120_000 } = {}) {
    this.auth = auth; this.http = http; this.cacheMs = cacheMs; this.turnTimeoutMs = turnTimeoutMs;
    this.active = new Set(); this.closed = false;
  }
  controller(signal, timeoutMs) {
    if (this.closed) throw new BridgeError('CLOSED');
    if (this.active.size >= 4) throw new BridgeError('LIMIT_EXCEEDED');
    const controller = new AbortController(); const timeout = setTimeout(() => { controller.timedOut = true; controller.abort(); }, timeoutMs);
    const cancel = () => controller.abort(); signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel(); this.active.add(controller);
    controller.release = () => { clearTimeout(timeout); signal?.removeEventListener('abort', cancel); this.active.delete(controller); };
    controller.signal.addEventListener('abort', controller.release, { once: true });
    if (controller.signal.aborted) controller.release();
    return controller;
  }
  async catalog(signal, fresh = false) {
    // Always reread/refresh authentication first, including metadata cache hits.
    const token = await this.auth.token(signal);
    const identity = createHash('sha256').update(token).digest('hex');
    if (!fresh && this.cache?.identity === identity && this.cache.expires > Date.now()) return this.cache.models;
    // Match the reference's catalog compatibility selectors, not a CLI identity.
    let result;
    for (const version of ['99.0.0', '0.0.0']) {
      result = object(await this.http.json(`${BASE}/models?client_version=${version}`, { headers: headers(token) }, signal));
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
  }
  async discover(signal) {
    const controller = this.controller(signal, 30_000);
    try { return await this.catalog(controller.signal); }
    catch (error) { if (controller.timedOut) throw new BridgeError('TIMEOUT'); throw error; }
    finally { controller.release(); }
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
    try {
      const models = await this.catalog(controller.signal, true);
      if (!models.some(model => model.id === options.model)) throw new BridgeError('MODEL_UNAVAILABLE');
      const token = await this.auth.token(controller.signal);
      const instructions = history.filter(item => item.role === 'developer').map(item => item.content.map(block => block.text).join('\n')).join('\n');
      response = await this.http.open(`${BASE}/responses`, { method: 'POST', headers: { ...headers(token), 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ model: options.model, instructions, input: history.filter(item => item.role !== 'developer'), store: false, stream: true }) }, controller.signal);
      if (!response.ok) { await response.body?.cancel(); throw statusError(response.status); }
      if (!response.headers.get('content-type')?.startsWith('text/event-stream')) throw new BridgeError('PROTOCOL_INVALID');
      for await (const event of events(response.body, controller.signal)) {
        string(event.type);
        if (event.type === 'response.output_text.delta' || event.type === 'response.output_text.done') {
          const block = getBlock(event.item_id, event.content_index);
          if (block.ended) throw new BridgeError('PROTOCOL_INVALID');
          let text;
          if (event.type.endsWith('.delta')) text = string(event.delta, 256 * 1024);
          else {
            if (typeof event.text !== 'string' || !event.text.startsWith(block.text)) throw new BridgeError('PROTOCOL_INVALID');
            text = event.text.slice(block.text.length);
          }
          outputBytes += Buffer.byteLength(text); if (outputBytes > 256 * 1024) throw new BridgeError('LIMIT_EXCEEDED');
          if (!block.started) { block.started = true; if (controller.signal.aborted) throw new BridgeError('ABORTED'); yield { type: 'block-start', index: block.index, blockType: 'text' }; }
          if (text) { block.text += text; if (controller.signal.aborted) throw new BridgeError('ABORTED'); yield { type: 'text-delta', index: block.index, text }; }
          if (event.type.endsWith('.done')) { block.ended = true; if (controller.signal.aborted) throw new BridgeError('ABORTED'); yield { type: 'block-end', index: block.index, block: { type: 'text', text: block.text } }; }
        } else if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') {
          if (!['message', 'reasoning'].includes(object(event.item).type)) throw new BridgeError('PROTOCOL_INVALID');
        } else if (event.type === 'response.completed') {
          if (object(event.response).status !== 'completed') throw new BridgeError('UPSTREAM_FAILED');
          if (event.response.output !== undefined && event.response.output !== null) {
            if (!Array.isArray(event.response.output) || event.response.output.length > 128 || event.response.output.some(item => !['message', 'reasoning'].includes(item?.type))) throw new BridgeError('PROTOCOL_INVALID');
          }
          for (const item of event.response.output ?? []) {
            if (item.type === 'reasoning') continue;
            if (item.role !== 'assistant' || !Array.isArray(item.content) || item.content.length > 64) throw new BridgeError('PROTOCOL_INVALID');
            for (const [index, content] of item.content.entries()) {
              if (content?.type !== 'output_text' || typeof content.text !== 'string') throw new BridgeError('PROTOCOL_INVALID');
              const block = getBlock(item.id, index);
              if (!content.text.startsWith(block.text) || (block.ended && content.text !== block.text)) throw new BridgeError('PROTOCOL_INVALID');
              const tail = content.text.slice(block.text.length);
              outputBytes += Buffer.byteLength(tail); if (outputBytes > 256 * 1024) throw new BridgeError('LIMIT_EXCEEDED');
              if (!block.started) { block.started = true; if (controller.signal.aborted) throw new BridgeError('ABORTED'); yield { type: 'block-start', index: block.index, blockType: 'text' }; }
              if (tail) { block.text += tail; if (controller.signal.aborted) throw new BridgeError('ABORTED'); yield { type: 'text-delta', index: block.index, text: tail }; }
            }
          }
          for (const block of blocks.values()) if (!block.ended) { block.ended = true; if (controller.signal.aborted) throw new BridgeError('ABORTED'); yield { type: 'block-end', index: block.index, block: { type: 'text', text: block.text } }; }
          complete = true; if (controller.signal.aborted) throw new BridgeError('ABORTED'); yield { type: 'finish', reason: { kind: 'stop' } }; return;
        } else if (['error', 'response.failed', 'response.incomplete', 'response.refusal.delta', 'response.refusal.done'].includes(event.type)) throw new BridgeError('UPSTREAM_FAILED');
        else if (!['response.created', 'response.in_progress', 'response.content_part.added', 'response.content_part.done',
          'response.reasoning_summary_part.added', 'response.reasoning_summary_part.done', 'response.reasoning_summary_text.delta',
          'response.reasoning_summary_text.done', 'response.reasoning_text.delta', 'response.reasoning_text.done'].includes(event.type)) throw new BridgeError('PROTOCOL_INVALID');
      }
      if (!complete) throw new BridgeError('PROTOCOL_INVALID');
    } catch (error) { if (controller.timedOut) throw new BridgeError('TIMEOUT'); if (controller.signal.aborted) throw new BridgeError('ABORTED'); throw error; }
    finally { controller.abort(); await response?.body?.cancel().catch(() => {}); controller.release(); }
  }
  async close() { this.closed = true; this.cache = undefined; for (const controller of this.active) controller.abort(); }
}
