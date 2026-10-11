import { BridgeError, object, string } from './errors.js';

export const PROVIDER = 'codex-subscription';
const TEXT_LIMIT = 256 * 1024;
function validateInput(options) {
  if (options.provider !== PROVIDER || !Array.isArray(options.messages) || options.messages.length > 128 || !options.messages.length ||
      options.temperature !== undefined || options.maxTokens !== undefined ||
      options.stop !== undefined || options.reasoningEffort !== undefined) throw new BridgeError('INPUT_UNSUPPORTED');
  // Harness includes declarations in ordinary text requests. They grant no
  // Codex authority and are never serialized into app-server input.
  if (options.tools !== undefined && (!Array.isArray(options.tools) || options.tools.length > 256)) throw new BridgeError('INPUT_UNSUPPORTED');
  if (options.toolHistory !== undefined && (!options.toolHistory || typeof options.toolHistory !== 'object' ||
      !Array.isArray(options.toolHistory.tools) || options.toolHistory.tools.length > 256 ||
      !Array.isArray(options.toolHistory.updates) || options.toolHistory.updates.length > 128)) throw new BridgeError('INPUT_UNSUPPORTED');
  let bytes = 0;
  const history = [];
  if (options.system !== undefined) {
    if (typeof options.system !== 'string') throw new BridgeError('INPUT_UNSUPPORTED');
    history.push({ type: 'message', role: 'developer', content: [{ type: 'input_text', text: options.system }] });
    bytes += Buffer.byteLength(options.system);
  }
  for (const message of options.messages) {
    if (!message || !['system', 'developer', 'user', 'assistant'].includes(message.role) || !Array.isArray(message.content)) throw new BridgeError('INPUT_UNSUPPORTED');
    const content = [];
    for (const block of message.content) {
      if (!block || block.type !== 'text' || typeof block.text !== 'string') throw new BridgeError('INPUT_UNSUPPORTED');
      bytes += Buffer.byteLength(block.text);
      if (bytes > TEXT_LIMIT || content.length >= 64) throw new BridgeError('INPUT_UNSUPPORTED');
      content.push({ type: message.role === 'assistant' ? 'output_text' : 'input_text', text: block.text });
    }
    history.push({ type: 'message', role: message.role === 'system' ? 'developer' : message.role, content });
  }
  if (bytes > TEXT_LIMIT || history.at(-1).role !== 'user') throw new BridgeError('INPUT_UNSUPPORTED');
  return history;
}

/** Protocol bridge. The public entry fixes its launcher; factory injection is a test seam. */
export class SubscriptionBridge {
  constructor(sessionFactory, { turnTimeoutMs = 120_000 } = {}) {
    this.factory = sessionFactory;
    this.turnTimeoutMs = turnTimeoutMs;
    this.active = new Set();
    this.releases = new WeakMap();
    this.closed = false;
  }
  async session(signal) {
    if (this.closed) throw new BridgeError('CLOSED');
    if (signal?.aborted) throw new BridgeError('ABORTED');
    if (this.active.size >= 4) throw new BridgeError('LIMIT_EXCEEDED');
    // Reserve capacity before the factory awaits.
    const reservation = {};
    this.active.add(reservation);
    let rpc;
    try {
      rpc = await this.factory();
      if (this.closed || signal?.aborted) throw new BridgeError(this.closed ? 'CLOSED' : 'ABORTED');
      this.active.delete(reservation);
      this.active.add(rpc);
      const result = object(await rpc.request('initialize', {
        clientInfo: { name: 'dsh_codex_subscription_bridge', version: '0.0.0' },
        capabilities: { experimentalApi: true },
      }, signal));
      string(result.userAgent, 1024);
      rpc.notify('initialized');
      const mode = object(await rpc.request('getAuthStatus', { includeToken: false, refreshToken: false }, signal));
      if (mode.authToken !== null) throw new BridgeError('PROTOCOL_INVALID');
      if (mode.authMethod !== 'chatgpt' || mode.requiresOpenaiAuth !== true) throw new BridgeError('AUTH_REQUIRED');
      const auth = object(await rpc.request('account/read', { refreshToken: false }, signal));
      if (!auth.account || object(auth.account).type !== 'chatgpt' || auth.requiresOpenaiAuth !== true) throw new BridgeError('AUTH_REQUIRED');
      return rpc;
    } catch (error) {
      this.active.delete(reservation);
      if (rpc) { await rpc.close(); this.active.delete(rpc); }
      throw error;
    }
  }
  release(rpc) {
    if (!this.releases.has(rpc)) {
      this.releases.set(rpc, (async () => {
        try { await rpc.close(); } finally { this.active.delete(rpc); }
      })());
    }
    return this.releases.get(rpc);
  }
  async catalog(rpc, signal) {
    const models = [];
    const ids = new Set();
    const cursors = new Set();
    let cursor = null;
    for (let page = 0; page < 8; page++) {
      const result = object(await rpc.request('model/list', { cursor, limit: 64, includeHidden: false }, signal));
      if (!Array.isArray(result.data) || result.data.length > 64) throw new BridgeError('PROTOCOL_INVALID');
      for (const entry of result.data) {
        object(entry);
        const id = string(entry.model);
        const name = string(entry.displayName);
        if (typeof entry.hidden !== 'boolean' || ids.has(id)) throw new BridgeError('PROTOCOL_INVALID');
        ids.add(id);
        if (!entry.hidden) models.push({ id, name, provider: PROVIDER, inputModalities: ['text'] });
      }
      if (result.nextCursor === null) return models;
      cursor = string(result.nextCursor);
      if (cursors.has(cursor)) throw new BridgeError('PROTOCOL_INVALID');
      cursors.add(cursor);
    }
    throw new BridgeError('LIMIT_EXCEEDED');
  }
  async listModels(signal) {
    // UI consumers often discover the same provider concurrently. Share only
    // in-flight, uncancelled discovery; never cache authentication or entitlements.
    if (signal) return this.discoverModels(signal);
    if (!this.discovery) {
      this.discovery = this.discoverModels().finally(() => { this.discovery = undefined; });
    }
    const models = await this.discovery;
    return models.map((model) => ({ ...model, inputModalities: [...model.inputModalities] }));
  }
  async discoverModels(signal) {
    const rpc = await this.session(signal);
    try { return await this.catalog(rpc, signal); }
    finally { await this.release(rpc); }
  }
  async *stream(options) {
    const history = validateInput(options);
    string(options.model);
    const controller = new AbortController();
    let rpc, threadId, turnId, completedSuccessfully = false;
    const cancelled = () => {
      controller.abort();
      if (rpc) void this.release(rpc);
    };
    options.signal?.addEventListener('abort', cancelled, { once: true });
    if (options.signal?.aborted) cancelled();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; cancelled(); }, this.turnTimeoutMs);
    try {
      rpc = await this.session(controller.signal);
      const models = await this.catalog(rpc, controller.signal);
      if (!models.some((model) => model.id === options.model)) throw new BridgeError('MODEL_UNAVAILABLE');
      const result = object(await rpc.request('thread/start', {
        model: options.model, modelProvider: 'openai', allowProviderModelFallback: false,
        ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only',
        environments: [], dynamicTools: [], baseInstructions: 'Respond to the conversation using text only.',
        developerInstructions: '',
      }, controller.signal));
      threadId = string(object(result.thread).id);
      // Never read source/replay metadata or resume an inherited thread.
      if (history.length > 1) await rpc.request('thread/inject_items', { threadId, items: history.slice(0, -1) }, controller.signal);
      const turn = object(await rpc.request('turn/start', {
        threadId, model: options.model, approvalPolicy: 'never', environments: [],
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
        input: history.at(-1).content.map((block) => ({ type: 'text', text: block.text })),
      }, controller.signal));
      turnId = string(object(turn.turn).id);
      const blocks = new Map();
      let outputBytes = 0;
      function blockFor(id) {
        if (!blocks.has(id)) {
          if (blocks.size >= 128) throw new BridgeError('LIMIT_EXCEEDED');
          blocks.set(id, { index: blocks.size, text: '', ended: false });
        }
        return blocks.get(id);
      }
      function append(block, delta) {
        if (block.ended) throw new BridgeError('PROTOCOL_INVALID');
        outputBytes += Buffer.byteLength(delta);
        if (outputBytes > TEXT_LIMIT) throw new BridgeError('LIMIT_EXCEEDED');
        block.text += delta;
      }
      while (true) {
        if (controller.signal.aborted) throw new BridgeError(timedOut ? 'TIMEOUT' : 'ABORTED');
        const event = await rpc.next(controller.signal);
        const params = object(event.params);
        if (['deprecationNotice', 'account/rateLimits/updated'].includes(event.method)) continue;
        if (event.method === 'remoteControl/status/changed') {
          if (params.status !== 'disabled') throw new BridgeError('PROTOCOL_INVALID');
          continue;
        }
        if (event.method === 'thread/started') {
          if (object(params.thread).id !== threadId) throw new BridgeError('PROTOCOL_INVALID');
          continue;
        }
        if (params.threadId !== threadId) throw new BridgeError('PROTOCOL_INVALID');
        if (event.method === 'item/agentMessage/delta') {
          if (params.turnId !== turnId) throw new BridgeError('PROTOCOL_INVALID');
          const id = string(params.itemId);
          const existing = blocks.has(id);
          const block = blockFor(id);
          if (!existing) yield { type: 'block-start', index: block.index, blockType: 'text' };
          const delta = string(params.delta, TEXT_LIMIT);
          append(block, delta);
          yield { type: 'text-delta', index: block.index, text: delta };
        } else if (event.method === 'turn/completed') {
          const completed = object(params.turn);
          if (completed.id !== turnId) throw new BridgeError('PROTOCOL_INVALID');
          if (completed.status !== 'completed') throw new BridgeError(completed.status === 'interrupted' ? 'ABORTED' : 'UPSTREAM_FAILED');
          for (const block of blocks.values()) {
            if (!block.ended) { block.ended = true; yield { type: 'block-end', index: block.index, block: { type: 'text', text: block.text } }; }
          }
          completedSuccessfully = true;
          yield { type: 'finish', reason: { kind: 'stop' } };
          return;
        } else if (event.method === 'item/started' || event.method === 'item/completed') {
          const item = object(params.item);
          if (params.turnId !== turnId || !['userMessage', 'agentMessage', 'reasoning', 'plan'].includes(item.type)) throw new BridgeError('PROTOCOL_INVALID');
          if (event.method === 'item/completed' && item.type === 'agentMessage') {
            const id = string(item.id);
            const text = typeof item.text === 'string' && item.text.length === 0 ? '' : string(item.text, TEXT_LIMIT);
            const existing = blocks.has(id);
            const block = blockFor(id);
            if (!existing) yield { type: 'block-start', index: block.index, blockType: 'text' };
            if (block.ended || !text.startsWith(block.text)) throw new BridgeError('PROTOCOL_INVALID');
            const tail = text.slice(block.text.length);
            if (tail) { append(block, tail); yield { type: 'text-delta', index: block.index, text: tail }; }
            block.ended = true;
            yield { type: 'block-end', index: block.index, block: { type: 'text', text: block.text } };
          }
        } else if (event.method === 'turn/started' || event.method === 'thread/status/changed' || event.method === 'thread/tokenUsage/updated' || event.method === 'turn/plan/updated') {
          // Metadata is deliberately not copied to Harness.
        } else if (event.method.startsWith('item/reasoning/')) {
          if (params.turnId !== turnId) throw new BridgeError('PROTOCOL_INVALID');
        } else { throw new BridgeError('PROTOCOL_INVALID'); }
      }
    } catch (error) {
      if (timedOut) throw new BridgeError('TIMEOUT');
      throw error;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', cancelled);
      if (rpc) {
        // A bounded best-effort interrupt precedes process termination.
        if (!completedSuccessfully && threadId && turnId) {
          try { await rpc.request('turn/interrupt', { threadId, turnId }); } catch {}
        }
        await this.release(rpc);
      }
    }
  }
  async close() {
    this.closed = true;
    await Promise.all([...this.active].filter((item) => item.close).map((rpc) => this.release(rpc)));
  }
}
