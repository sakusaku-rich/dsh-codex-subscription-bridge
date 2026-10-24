import test from 'node:test';
import assert from 'node:assert/strict';
import { createSubscriptionCompactionEngine, ownsSubscriptionCompaction } from '../lib/compaction-owner.js';
import { CompactionCapture, CHECKPOINT_MAX_AGE, compactionScope, inspectCheckpoint } from '../lib/compaction.js';
import { validateInput } from '../lib/text.js';

const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] });
const compact = { type: 'compaction', id: 'cp-1', encrypted_content: 'synthetic-opaque-checkpoint' };
const reply = (text) => ({ type: 'message', id: 'msg-1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] });
const options = (messages) => ({ provider: 'codex-subscription', model: 'synthetic', messages });
const route = (provider) => ({ session: { requestHeader: () => ({ config: { provider, model: 'synthetic' } }) } });
const clone = (value) => JSON.parse(JSON.stringify(value));

/** A base engine that records every condensation it is asked to perform. */
function engineOver(calls) {
  class Base { async compactIfNeeded(...args) { calls.push(args); return { kind: 'delegated' }; } }
  return Object.create(createSubscriptionCompactionEngine(Base).prototype);
}

/** A captured checkpoint window for a single-turn conversation. */
function checkpointed() {
  const plan = validateInput(options([user('Start')]));
  const scope = compactionScope({ account: 'one' }, 'synthetic', plan);
  const blocks = [{ type: 'text', text: 'Answer' }];
  const replayState = new CompactionCapture().finish([compact, reply('Answer')], scope, plan, blocks);
  return { plan, scope, blocks, replayState };
}

test('the opt-in backend owns only this bridge provider', () => {
  assert.equal(ownsSubscriptionCompaction({ provider: 'codex-subscription' }), true);

  for (const config of [{ provider: 'openrouter', model: 'synthetic' }, {}, undefined, null]) assert.equal(ownsSubscriptionCompaction(config), false);
});

test('the opt-in backend skips local condensation for its provider', async () => {
  const calls = [];
  const engine = engineOver(calls);
  const signal = new AbortController().signal;

  const result = await engine.compactIfNeeded(route('codex-subscription'), 'pressure', signal);

  assert.equal(result, null);
  assert.deepEqual(calls, []);
});

test('the opt-in backend delegates every other provider', async () => {
  const calls = [];
  const engine = engineOver(calls);
  const signal = new AbortController().signal;
  const other = route('openrouter');

  const result = await engine.compactIfNeeded(other, 'context-overflow', signal);

  assert.deepEqual(result, { kind: 'delegated' });
  assert.deepEqual(calls, [[other, 'context-overflow', signal]]);
});

test('the opt-in backend never throws out of the host hook when the request has no session or target', async () => {
  const calls = [];
  const engine = engineOver(calls);

  for (const agent of [{ session: {} }, undefined]) assert.deepEqual(await engine.compactIfNeeded(agent, 'pressure', undefined), { kind: 'delegated' });

  assert.equal(calls.length, 2);
});

test('the shipped backend extends the pinned host engine', async () => {
  const { BasicCompactionEngine } = await import('@deepseek-ai/dsh-compaction-basic');
  const { default: Engine } = await import('../lib/compaction-engine.js');

  assert.equal(typeof Engine, 'function');
  assert.equal(Engine.prototype instanceof BasicCompactionEngine, true);
});

test('the shipped backend inherits the plugin contract from the pinned host engine', async () => {
  const { BasicCompactionEngine } = await import('@deepseek-ai/dsh-compaction-basic');
  const { default: Engine } = await import('../lib/compaction-engine.js');

  assert.deepEqual(Engine.inject, BasicCompactionEngine.inject);
  assert.equal(Engine.Config, BasicCompactionEngine.Config);
});

test('checkpoint inspection keeps a matching checkpoint window', () => {
  const { scope, blocks, replayState } = checkpointed();
  const messages = [user('Start'), { role: 'assistant', content: blocks, source: { replayState } }, user('Next')];
  const next = validateInput(options(messages));

  assert.ok(inspectCheckpoint(messages, next, scope).items);
});

test('checkpoint inspection reports nothing for a conversation with no checkpoint', () => {
  const { scope } = checkpointed();
  const messages = [user('Start')];

  assert.deepEqual(inspectCheckpoint(messages, validateInput(options(messages)), scope), {});
});

test('checkpoint inspection names every refusal', () => {
  const { scope, blocks, replayState } = checkpointed();
  const messages = [user('Start'), { role: 'assistant', content: blocks, source: { replayState } }, user('Next')];
  const next = validateInput(options(messages));
  const edited = clone(messages);
  edited[0] = user('Edited');
  const content = clone(messages);
  content[1].content[0].text = 'Changed';
  const future = clone(messages);
  future[1].source.replayState.response.subscriptionCompactionV1.createdAt = Date.now() + 60_000;
  const digest = clone(messages);
  digest[1].source.replayState.response.subscriptionCompactionV1.items[0].encrypted_content = 'changed';
  const invalid = clone(messages);
  invalid[1].source.replayState.response.subscriptionCompactionV1.items = [];

  assert.equal(inspectCheckpoint(messages, next, 'another-scope').refusal, 'SCOPE');
  assert.equal(inspectCheckpoint(messages, next, scope, Date.now() + CHECKPOINT_MAX_AGE + 1).refusal, 'EXPIRED');
  assert.equal(inspectCheckpoint(edited, validateInput(options(edited)), scope).refusal, 'PREFIX');
  assert.equal(inspectCheckpoint(content, next, scope).refusal, 'CONTENT');
  assert.equal(inspectCheckpoint(future, next, scope).refusal, 'METADATA');
  assert.equal(inspectCheckpoint(digest, next, scope).refusal, 'DIGEST');
  assert.equal(inspectCheckpoint(invalid, next, scope).refusal, 'WINDOW_SHAPE');
  assert.equal(inspectCheckpoint(messages, { ...next, spans: undefined }, scope).refusal, 'INVALID');
});
