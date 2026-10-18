import test from 'node:test';
import assert from 'node:assert/strict';
import { createSubscriptionCompactionEngine, ownsSubscriptionCompaction } from '../src/compaction-owner.js';
import { CompactionCapture } from '../src/compaction.js';
import { CONVERSATION_MAX_AGE, conversationScope, inspectConversation, conversationRecord } from '../src/conversation.js';
import { digest, contentDigest } from '../src/hashes.js';
import { validateInput } from '../src/text.js';

const user = text => ({ role: 'user', content: [{ type: 'text', text }] });
const compact = { type: 'compaction', id: 'cp-1', encrypted_content: 'synthetic-opaque-checkpoint' };
const reply = text => ({ type: 'message', id: 'msg-1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] });
const options = messages => ({ provider: 'codex-subscription', model: 'synthetic', messages });
const route = provider => ({ session: { requestHeader: () => ({ config: { provider, model: 'synthetic' } }) } });
const clone = value => JSON.parse(JSON.stringify(value));

test('the opt-in backend owns only this bridge provider', () => {
  assert.equal(ownsSubscriptionCompaction({ provider: 'codex-subscription' }), true);
  assert.equal(ownsSubscriptionCompaction({ provider: 'openrouter', model: 'synthetic' }), false);
  assert.equal(ownsSubscriptionCompaction({}), false);
  assert.equal(ownsSubscriptionCompaction(undefined), false);
  assert.equal(ownsSubscriptionCompaction(null), false);
});

test('the opt-in backend skips local condensation for its provider and delegates every other route', async () => {
  const calls = [];
  class Base { async compactIfNeeded(...args) { calls.push(args); return { kind: 'delegated' }; } }
  const engine = Object.create(createSubscriptionCompactionEngine(Base).prototype);
  const signal = new AbortController().signal;
  assert.equal(await engine.compactIfNeeded(route('codex-subscription'), 'pressure', signal), null);
  assert.deepEqual(calls, []);
  const other = route('openrouter');
  assert.deepEqual(await engine.compactIfNeeded(other, 'context-overflow', signal), { kind: 'delegated' });
  assert.deepEqual(calls, [[other, 'context-overflow', signal]]);
  // A request with no session or route must never throw out of the host hook.
  assert.deepEqual(await engine.compactIfNeeded({ session: {} }, 'pressure', undefined), { kind: 'delegated' });
  assert.deepEqual(await engine.compactIfNeeded(undefined, 'pressure', undefined), { kind: 'delegated' });
  assert.equal(calls.length, 3);
});

test('the shipped backend extends the pinned host engine and inherits its plugin contract', async () => {
  const { BasicCompactionEngine } = await import('@deepseek-ai/dsh-compaction-basic');
  const { default: Engine } = await import('../src/compaction-engine.js');
  assert.equal(typeof Engine, 'function');
  assert.equal(Engine.prototype instanceof BasicCompactionEngine, true);
  // Cordis resolves `inject` and `Config` through the class prototype chain.
  assert.deepEqual(Engine.inject, BasicCompactionEngine.inject);
  assert.equal(Engine.Config, BasicCompactionEngine.Config);
});

function chained() {
  const plan = validateInput(options([user('Start')]));
  const scope = conversationScope({ account: 'one' }, 'synthetic', plan);
  const blocks = [{ type: 'text', text: 'Answer' }];
  return { plan, scope, blocks, record: conversationRecord(scope, 'resp-1', digest(plan.input), contentDigest(blocks)) };
}

test('the marker record carries only a count, because a stateful turn replays nothing', () => {
  const { plan, scope, blocks, record } = chained();
  const marker = new CompactionCapture().finish([compact, reply('Answer')], scope, plan, blocks);
  assert.equal(marker.response.subscriptionCompactionV1.count, 2);
  assert.equal(JSON.stringify(marker.response.subscriptionCompactionV1).includes('opaque'), false);
  assert.equal(record.response.subscriptionConversationV1.id, 'resp-1');
});

test('conversation inspection names every refusal instead of silently trusting a chain', () => {
  const { plan, scope, blocks, record } = chained();
  const messages = [user('Start'), { role: 'assistant', content: blocks, source: { replayState: record } }, user('Next')];
  const next = validateInput(options(messages));
  assert.equal(inspectConversation(messages, next, scope).id, 'resp-1');
  assert.deepEqual(inspectConversation([user('Start')], validateInput(options([user('Start')])), scope), {});
  assert.equal(inspectConversation(messages, next, 'another-scope').refusal, 'SCOPE');
  assert.equal(inspectConversation(messages, next, scope, Date.now() + CONVERSATION_MAX_AGE + 1).refusal, 'EXPIRED');
  const edited = clone(messages); edited[0] = user('Edited');
  assert.equal(inspectConversation(edited, validateInput(options(edited)), scope).refusal, 'PREFIX');
  const content = clone(messages); content[1].content[0].text = 'Changed';
  assert.equal(inspectConversation(content, next, scope).refusal, 'CONTENT');
  const future = clone(messages); future[1].source.replayState.response.subscriptionConversationV1.createdAt = Date.now() + 60_000;
  assert.equal(inspectConversation(future, next, scope).refusal, 'METADATA');
  const opaque = clone(messages); opaque[1].source.replayState.response.subscriptionConversationV1.id = '';
  assert.equal(inspectConversation(opaque, next, scope).refusal, 'ID');
  const role = clone(messages); role[1].role = 'user';
  assert.equal(inspectConversation(role, next, scope).refusal, 'SHAPE');
  // A failure with no stage of its own still reports the generic label.
  assert.equal(inspectConversation(messages, { ...next, spans: undefined }, scope).refusal, 'INVALID');
});
