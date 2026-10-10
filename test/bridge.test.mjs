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
test('production always fails before touching authentication or launching a process', () => {
  assert.throws(() => createProductionSession({ disableSafety: true }), { code: 'AUTHORITY_UNVERIFIED' });
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
  assert.deepEqual(fake.calls.find((call) => call.method === 'turn/start').params.sandboxPolicy.access.readableRoots, []);
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
for (const override of [{ tools: [{ name: 'shell' }] }, { temperature: 0 }, { maxTokens: 10 }, { messages: [{ role: 'user', content: [{ type: 'image' }] }] }]) {
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
