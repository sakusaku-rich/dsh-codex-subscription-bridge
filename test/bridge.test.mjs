import test from 'node:test';
import assert from 'node:assert/strict';
import { SubscriptionBridge, PROVIDER } from '../src/bridge.js';
import { createProductionSession } from '../src/process.js';
import { BridgeError, failure } from '../src/errors.js';
const input = (extra = {}) => ({ provider: PROVIDER, model: 'test-model', messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }], ...extra });
class Fake {
  constructor({ auth = 'chatgpt', mode = 'normal' } = {}) { this.auth = auth; this.mode = mode; this.calls = []; this.closed = 0; this.events = []; }
  notify(method) { this.calls.push({ method }); }
  async request(method, params) {
    this.calls.push({ method, params });
    switch (method) {
      case 'initialize': return { userAgent: 'synthetic-server/0.144.6' };
      case 'getAuthStatus': return { authMethod: this.auth, authToken: null, requiresOpenaiAuth: true };
      case 'account/read': return { account: this.auth === null ? null : { type: this.auth, email: 'synthetic@example.invalid' }, requiresOpenaiAuth: true };
      case 'model/list': return this.mode === 'bad-models' ? { data: [{}], nextCursor: null } : { data: [{ model: 'test-model', displayName: 'Test model', hidden: false }], nextCursor: null };
      case 'thread/start': return { thread: { id: 'synthetic-thread' } };
      case 'thread/inject_items': return {};
      case 'turn/start':
        this.events = [
          { method: 'item/agentMessage/delta', params: { threadId: 'synthetic-thread', turnId: 'synthetic-turn', itemId: 'message', delta: 'Hello!' } },
          { method: 'turn/completed', params: { threadId: 'synthetic-thread', turn: { id: 'synthetic-turn', status: this.mode === 'failed' ? 'failed' : 'completed', error: { message: 'secret-test-value' } } } },
        ];
        if (this.mode === 'native-tool') this.events[0] = { method: 'item/started', params: { threadId: 'synthetic-thread', turnId: 'synthetic-turn', item: { type: 'commandExecution' } } };
        return { turn: { id: 'synthetic-turn' } };
      case 'turn/interrupt': return {};
      default: throw new Error('secret-test-value');
    }
  }
  async next(signal) {
    if (this.mode === 'hang') return new Promise((_, reject) => {
      if (signal.aborted) return reject(new BridgeError('ABORTED'));
      signal.addEventListener('abort', () => reject(new BridgeError('ABORTED')), { once: true });
    });
    return this.events.shift();
  }
  async close() { this.closed++; }
}
const collect = async (stream) => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks; };
test('unconfigured production fails before touching authentication or launching a process', () => {
  assert.throws(() => createProductionSession(), { code: 'CONFIG_REQUIRED' });
  assert.throws(() => createProductionSession('/synthetic/codex'), { code: 'CONFIG_REQUIRED' });
  assert.throws(() => createProductionSession('/synthetic/codex', {}, 'auto'), { code: 'CONFIG_INVALID' });
  assert.throws(() => createProductionSession({ disableSafety: true }), { code: 'CONFIG_INVALID' });
});
for (const auth of ['apikey', 'chatgptAuthTokens', 'bedrock', null]) {
  test(`rejects authentication mode ${auth} and cleans up`, async () => {
    const fake = new Fake({ auth });
    const bridge = new SubscriptionBridge(async () => fake);
    await assert.rejects(bridge.listModels(), { code: 'AUTH_REQUIRED' });
    assert.equal(fake.closed, 1);
    assert.equal(fake.calls.some((call) => call.method === 'model/list'), false);
  });
}
test('bounded model discovery returns only text route metadata', async () => {
  const fake = new Fake();
  assert.deepEqual(await new SubscriptionBridge(async () => fake).listModels(), [{ id: 'test-model', name: 'Test model', provider: PROVIDER, inputModalities: ['text'] }]);
  assert.deepEqual(fake.calls.find((call) => call.method === 'account/read').params, { refreshToken: false });
  assert.deepEqual(fake.calls.find((call) => call.method === 'getAuthStatus').params, { includeToken: false, refreshToken: false });
  assert.equal(fake.closed, 1);
});
test('malformed model discovery fails and closes', async () => {
  const fake = new Fake({ mode: 'bad-models' });
  await assert.rejects(new SubscriptionBridge(async () => fake).listModels(), { code: 'PROTOCOL_INVALID' });
  assert.equal(fake.closed, 1);
});
test('text streaming completes without replay state or native tools', async () => {
  const fake = new Fake();
  const chunks = await collect(new SubscriptionBridge(async () => fake).stream(input()));
  assert.deepEqual(chunks.map((chunk) => chunk.type), ['block-start', 'text-delta', 'block-end', 'finish']);
  assert.equal(chunks.at(-1).reason.kind, 'stop');
  const start = fake.calls.find((call) => call.method === 'thread/start');
  assert.deepEqual(start.params.environments, []);
  assert.equal(start.params.ephemeral, true);
  assert.deepEqual(fake.calls.find((call) => call.method === 'turn/start').params.sandboxPolicy, { type: 'readOnly', networkAccess: false });
  assert.equal(fake.calls.some((call) => call.method === 'turn/interrupt'), false);
  assert.equal(fake.closed, 1);
});
test('parallel and forked histories always use new sessions and ignore replay IDs', async () => {
  const fakes = [];
  const bridge = new SubscriptionBridge(async () => { const fake = new Fake(); fakes.push(fake); return fake; });
  const messages = [{ role: 'assistant', content: [{ type: 'text', text: 'Previous answer' }], source: { replayState: { response: { threadId: 'parent-thread' } } } }, ...input().messages];
  await Promise.all([collect(bridge.stream(input({ messages, sessionId: 'parent' }))), collect(bridge.stream(input({ messages, sessionId: 'fork' })))]);
  assert.equal(fakes.length, 2);
  for (const fake of fakes) {
    assert.equal(fake.calls.some((call) => call.method === 'thread/resume'), false);
    assert.equal(JSON.stringify(fake.calls).includes('parent-thread'), false);
    assert.equal(fake.closed, 1);
  }
});
for (const override of [{ tools: {} }, { temperature: 0 }, { maxTokens: 10 }, { messages: [{ role: 'user', content: [{ type: 'image' }] }] }]) {
  test('unsupported input is refused before starting a child', async () => {
    let called = false;
    await assert.rejects(collect(new SubscriptionBridge(async () => { called = true; }).stream(input(override))), { code: 'INPUT_UNSUPPORTED' });
    assert.equal(called, false);
  });
}
test('unexpected native execution terminates the protocol session', async () => {
  const fake = new Fake({ mode: 'native-tool' });
  await assert.rejects(collect(new SubscriptionBridge(async () => fake).stream(input())), { code: 'PROTOCOL_INVALID' });
  assert.equal(fake.closed, 1);
});
test('upstream failure bodies are never exposed', async () => {
  const fake = new Fake({ mode: 'failed' });
  try { await collect(new SubscriptionBridge(async () => fake).stream(input())); assert.fail(); }
  catch (error) { assert.equal(error.code, 'UPSTREAM_FAILED'); assert.equal(JSON.stringify(failure(error)).includes('secret-test-value'), false); }
});
test('cancellation interrupts and releases the active child', async () => {
  const fake = new Fake({ mode: 'hang' });
  const controller = new AbortController();
  const promise = collect(new SubscriptionBridge(async () => fake).stream(input({ signal: controller.signal })));
  setTimeout(() => controller.abort(), 15);
  await assert.rejects(promise, { code: 'ABORTED' });
  assert.equal(fake.calls.some((call) => call.method === 'turn/interrupt'), true);
  assert.equal(fake.closed, 1);
});
test('turn deadline is independent of incoming events', async () => {
  const fake = new Fake({ mode: 'hang' });
  await assert.rejects(collect(new SubscriptionBridge(async () => fake, { turnTimeoutMs: 15 }).stream(input())), { code: 'TIMEOUT' });
  assert.equal(fake.closed, 1);
});
test('early iterator return and repeated disposal release resources', async () => {
  const fake = new Fake(); const bridge = new SubscriptionBridge(async () => fake);
  for await (const chunk of bridge.stream(input())) { assert.equal(chunk.type, 'block-start'); break; }
  await bridge.close(); await bridge.close();
  assert.equal(fake.closed, 1);
  await assert.rejects(bridge.listModels(), { code: 'CLOSED' });
});
test('deadline releases a child even while the consumer pauses at a yield', async () => {
  const fake = new Fake();
  const bridge = new SubscriptionBridge(async () => fake, { turnTimeoutMs: 15 });
  const iterator = bridge.stream(input())[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value.type, 'block-start');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(fake.closed, 1);
  await iterator.return();
  assert.equal(fake.closed, 1);
});
test('Harness declarations are discarded without granting or forwarding tool authority', async () => {
  const fake = new Fake();
  await collect(new SubscriptionBridge(async () => fake).stream(input({
    tools: [{ name: 'private-harness-tool', parameters: { secret: 'synthetic-header-only' } }],
    toolHistory: { tools: [{ name: 'private-harness-tool' }], updates: [] },
  })));
  assert.equal(JSON.stringify(fake.calls).includes('private-harness-tool'), false);
  assert.equal(JSON.stringify(fake.calls).includes('synthetic-header-only'), false);
  assert.deepEqual(fake.calls.find((call) => call.method === 'thread/start').params.dynamicTools, []);
});
test('actual tool execution history is rejected before dispatch', async () => {
  let called = false;
  const bridge = new SubscriptionBridge(async () => { called = true; });
  await assert.rejects(collect(bridge.stream(input({ messages: [
    { role: 'assistant', content: [{ type: 'tool-call', name: 'shell', arguments: '{}' }] }, ...input().messages,
  ] }))), { code: 'INPUT_UNSUPPORTED' });
  assert.equal(called, false);
});
test('even a ChatGPT account summary cannot admit externally managed credentials', async () => {
  const fake = new Fake();
  const original = fake.request.bind(fake);
  fake.request = async (method, params) => method === 'getAuthStatus' ? { authMethod: 'chatgptAuthTokens', authToken: null, requiresOpenaiAuth: true } : original(method, params);
  await assert.rejects(new SubscriptionBridge(async () => fake).listModels(), { code: 'AUTH_REQUIRED' });
  assert.equal(fake.closed, 1);
});
test('a token-bearing auth-mode response is refused without echoing it', async () => {
  const fake = new Fake();
  const original = fake.request.bind(fake);
  fake.request = async (method, params) => method === 'getAuthStatus' ? { authMethod: 'chatgpt', authToken: 'synthetic-secret-value', requiresOpenaiAuth: true } : original(method, params);
  await assert.rejects(new SubscriptionBridge(async () => fake).listModels(), (error) => error.code === 'PROTOCOL_INVALID' && !error.message.includes('synthetic-secret-value'));
});
test('multiple assistant items retain independent text blocks', async () => {
  const fake = new Fake();
  const original = fake.request.bind(fake);
  fake.request = async (method, params) => {
    const result = await original(method, params);
    if (method === 'turn/start') {
      const paramsFor = (itemId) => ({ threadId: 'synthetic-thread', turnId: 'synthetic-turn', itemId });
      fake.events.splice(1, 0,
        { method: 'item/completed', params: { ...paramsFor('message'), item: { type: 'agentMessage', id: 'message', text: 'Hello!' } } },
        { method: 'item/agentMessage/delta', params: { ...paramsFor('second'), delta: 'Second answer' } },
        { method: 'item/completed', params: { ...paramsFor('second'), item: { type: 'agentMessage', id: 'second', text: 'Second answer' } } });
    }
    return result;
  };
  const chunks = await collect(new SubscriptionBridge(async () => fake).stream(input()));
  assert.deepEqual(chunks.filter((chunk) => chunk.type === 'block-end').map((chunk) => [chunk.index, chunk.block.text]), [[0, 'Hello!'], [1, 'Second answer']]);
  assert.equal(chunks.at(-1).reason.kind, 'stop');
});

test('concurrent discovery shares one child and retries after settlement', async () => {
  const children = [];
  const bridge = new SubscriptionBridge(async () => {
    const fake = new Fake(); children.push(fake); return fake;
  });
  const models = await Promise.all(Array.from({ length: 12 }, () => bridge.listModels()));
  assert.equal(children.length, 1);
  assert.equal(children[0].closed, 1);
  assert.equal(models.every((value) => value[0].id === 'test-model'), true);
  models[0][0].inputModalities.push('image');
  assert.deepEqual(models[1][0].inputModalities, ['text']);
  await bridge.listModels();
  assert.equal(children.length, 2);
  await bridge.close();
});
test('failed shared discovery does not poison subsequent discovery', async () => {
  let calls = 0;
  const bridge = new SubscriptionBridge(async () => new Fake({ auth: ++calls === 1 ? 'apikey' : 'chatgpt' }));
  const results = await Promise.allSettled(Array.from({ length: 12 }, () => bridge.listModels()));
  assert.equal(calls, 1);
  assert.equal(results.every((result) => result.status === 'rejected' && result.reason.code === 'AUTH_REQUIRED'), true);
  assert.equal((await bridge.listModels())[0].id, 'test-model');
  assert.equal(calls, 2);
  await bridge.close();
});
