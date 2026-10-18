import test from 'node:test';
import assert from 'node:assert/strict';
import { createSubscriptionCompactionEngine, ownsSubscriptionCompaction } from '../src/compaction-owner.js';
import { CompactionCapture, CHECKPOINT_MAX_AGE, compactionScope, inspectCheckpoint } from '../src/compaction.js';
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

function checkpointed() {
  const plan = validateInput(options([user('Start')]));
  const scope = compactionScope({ account: 'one' }, 'synthetic', plan);
  const blocks = [{ type: 'text', text: 'Answer' }];
  const replayState = new CompactionCapture().finish([compact, reply('Answer')], scope, plan, blocks);
  return { plan, scope, blocks, replayState };
}

test('checkpoint inspection names every refusal instead of silently discarding state', () => {
  const { plan, scope, blocks, replayState } = checkpointed();
  const messages = [user('Start'), { role: 'assistant', content: blocks, source: { replayState } }, user('Next')];
  const next = validateInput(options(messages));
  assert.ok(inspectCheckpoint(messages, next, scope).items);
  assert.deepEqual(inspectCheckpoint([user('Start')], validateInput(options([user('Start')])), scope), {});
  assert.equal(inspectCheckpoint(messages, next, 'another-scope').refusal, 'SCOPE');
  assert.equal(inspectCheckpoint(messages, next, scope, Date.now() + CHECKPOINT_MAX_AGE + 1).refusal, 'EXPIRED');
  const edited = clone(messages); edited[0] = user('Edited');
  assert.equal(inspectCheckpoint(edited, validateInput(options(edited)), scope).refusal, 'PREFIX');
  const content = clone(messages); content[1].content[0].text = 'Changed';
  assert.equal(inspectCheckpoint(content, next, scope).refusal, 'CONTENT');
  const future = clone(messages); future[1].source.replayState.response.subscriptionCompactionV1.createdAt = Date.now() + 60_000;
  assert.equal(inspectCheckpoint(future, next, scope).refusal, 'METADATA');
  const digest = clone(messages); digest[1].source.replayState.response.subscriptionCompactionV1.items[0].encrypted_content = 'changed';
  assert.equal(inspectCheckpoint(digest, next, scope).refusal, 'DIGEST');
  const invalid = clone(messages); invalid[1].source.replayState.response.subscriptionCompactionV1.items = [];
  assert.equal(inspectCheckpoint(invalid, next, scope).refusal, 'WINDOW_SHAPE');
  // A failure with no stage of its own still reports the generic label.
  assert.equal(inspectCheckpoint(messages, { ...next, spans: undefined }, scope).refusal, 'INVALID');
});
