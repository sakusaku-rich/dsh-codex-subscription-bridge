import test from 'node:test';
import assert from 'node:assert/strict';
import { BlockAssembler } from '@deepseek-ai/dsh-llm';
import { DirectBridge } from '../src/direct.js';
import { Http } from '../src/http.js';
import { CHECKPOINT_KEY, CHECKPOINT_MAX_AGE, CompactionCapture, compactionScope, selectCheckpoint, compactPlan, threshold, requestLimits } from '../src/compaction.js';
import { validateInput, TEXT_LIMIT, TOOL_BYTES_LIMIT } from '../src/text.js';
import { Context } from '@deepseek-ai/cordis';
import { LlmRuntime } from '@deepseek-ai/dsh-llm';
import * as plugin from '../src/index.js';
import { AuthStore, authDirectory, compactionAccount } from '../src/auth.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const user = text => ({ role: 'user', content: [{ type: 'text', text }] });
const compact = { type: 'compaction', id: 'cp-1', encrypted_content: 'synthetic-opaque-checkpoint' };
const reply = text => ({ type: 'message', id: 'msg-1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] });
const options = messages => ({ provider: 'codex-subscription', model: 'synthetic', messages });
// The fixture's disclosed window. The request byte bound and the compaction
// threshold both derive from it, so payloads that must be refused are sized
// against the bound rather than a fixed constant.
const WINDOW = 272000;
const TEXT_BOUND = requestLimits(WINDOW).textBytes;
const token = account => `x.${Buffer.from(JSON.stringify({ exp: 4000000000, 'https://api.openai.com/auth': { chatgpt_account_id: account } })).toString('base64url')}.x`;
const sse = values => new Response(values.map(value => `data: ${JSON.stringify(value)}\n\n`).join(''));
const complete = output => ({ type: 'response.completed', response: { status: 'completed', output } });
function fixture(responses, settings = {}, warnings = []) {
  const payloads = []; let account = 'synthetic-account';
  const bridge = new DirectBridge({ token: async () => token(account) }, new Http(async (url, request) => {
    if (url.includes('/models?')) return Response.json({ models: [{ slug: 'synthetic', display_name: 'Synthetic', visibility: 'list',
      ...(settings.modelWindow === null ? {} : { context_window: settings.modelWindow ?? WINDOW }) }] });
    payloads.push(JSON.parse(request.body));
    const next = responses.shift();
    assert.ok(next, 'unexpected request');
    return next instanceof Response ? next : sse(next);
  }), settings, { warn: message => warnings.push(message) });
  return { bridge, payloads, warnings, account: value => { account = value; } };
}
async function run(bridge, request) {
  const chunks = [];
  for await (const chunk of bridge.stream(request)) chunks.push(chunk);
  const assembler = new BlockAssembler();
  for (const chunk of chunks) assembler.push(chunk);
  return { chunks, message: { role: 'assistant', content: assembler.blocks(), source: { kind: 'model', provider: request.provider,
    model: request.model, replayState: assembler.replayState } } };
}

test('encrypted window survives Harness assembly, JSON persistence, and multiple turns without duplicate output', async () => {
  const f = fixture([[complete([compact, reply('First')])], [complete([reply('Second')])], [complete([reply('Third')])]]);
  try {
    const first = await run(f.bridge, options([user('Start')]));
    const saved = JSON.parse(JSON.stringify(first.message));
    assert.ok(saved.source.replayState.response[CHECKPOINT_KEY]);
    const second = await run(f.bridge, options([user('Start'), saved, user('Next')]));
    await run(f.bridge, options([user('Start'), saved, user('Next'), second.message, user('Again')]));
    assert.deepEqual(f.payloads[0].context_management, [{ type: 'compaction', compact_threshold: 258400 }]);
    assert.deepEqual(f.payloads[1].input, [compact, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'First' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Next' }] }]);
    assert.equal(f.payloads[2].input.length, 5);
    assert.ok(f.payloads.every(p => p.store === false && !('previous_response_id' in p)));
  } finally { await f.bridge.close(); }
});

test('tool call after compaction is retained exactly once with its executed result', async () => {
  const call = { type: 'function_call', id: 'tool-item', call_id: 'call-1', name: 'read', arguments: '{}' };
  const f = fixture([[{ type: 'response.output_item.done', output_index: 0, item: compact },
    { type: 'response.output_item.done', output_index: 1, item: call }, complete(null)], [complete([reply('Done')])]]);
  try {
    const first = await run(f.bridge, options([user('Read')]));
    assert.equal(first.chunks.at(-1).reason.kind, 'tool-calls');
    await run(f.bridge, options([user('Read'), first.message, { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'Result' }] }]));
    assert.deepEqual(f.payloads[1].input.map(i => i.type), ['compaction', 'function_call', 'function_call_output']);
    assert.equal(f.payloads[1].input[1].call_id, f.payloads[1].input[2].call_id);
  } finally { await f.bridge.close(); }
});

test('changed history, instructions, tools, account, expired or corrupt metadata fall back to bounded full history', async () => {
  for (const mutation of ['history', 'instructions', 'tools', 'account', 'expired', 'future', 'digest', 'content', 'model']) {
    const f = fixture([[complete([compact, reply('First')])], [complete([reply('Next')])]]);
    try {
      const first = await run(f.bridge, options([user('Start')]));
      const request = options([user('Start'), first.message, user('Next')]);
      const cp = first.message.source.replayState.response[CHECKPOINT_KEY];
      if (mutation === 'history') request.messages[0] = user('Edited');
      if (mutation === 'instructions') request.system = 'Changed';
      if (mutation === 'tools') request.tools = [{ name: 'new_tool', parameters: { type: 'object' } }];
      if (mutation === 'account') f.account('another-account');
      if (mutation === 'expired') cp.createdAt -= CHECKPOINT_MAX_AGE + 1;
      if (mutation === 'future') cp.createdAt += 60000;
      if (mutation === 'digest') cp.items[0].encrypted_content = 'changed';
      if (mutation === 'content') first.message.content[0].text = 'Edited response';
      if (mutation === 'model') cp.scope = 'other-model-scope';
      await run(f.bridge, request);
      assert.equal(f.payloads[1].input[0].type, 'message', mutation);
      assert.equal(f.payloads[1].input.length, 3, mutation);
    } finally { await f.bridge.close(); }
  }
});

test('covered history may exceed text wire budget but fallback and uncovered tail cannot', async () => {
  const f = fixture([[complete([compact, reply('First')])], [complete([reply('Next')])]]);
  try {
    const start = user('x'.repeat(TEXT_BOUND - 10));
    const first = await run(f.bridge, options([start]));
    const request = options([start, first.message, user('y'.repeat(100))]);
    await run(f.bridge, request);
    assert.equal(f.payloads[1].input[0].type, 'compaction');
    await assert.rejects(run(f.bridge, options([start, first.message, user('y'.repeat(TEXT_BOUND))])), { code: 'INPUT_UNSUPPORTED' });
    f.account('other');
    // A refused checkpoint is the consolidation boundary, not a generic shape error.
    await assert.rejects(run(f.bridge, request), { code: 'COMPACTION_UNAVAILABLE' });
    assert.equal(f.payloads.length, 2);
    assert.deepEqual(f.warnings, ['The encrypted subscription compaction state was refused (SCOPE); resending the bounded local history.']);
  } finally { await f.bridge.close(); }
});

test('malformed or contradictory checkpoint state withholds the window but keeps the answer', async () => {
  for (const events of [
    [complete([{ ...compact, encrypted_content: '' }, reply('No')])],
    [complete([{ ...compact, encrypted_content: 'x'.repeat(512 * 1024 + 1) }, reply('No')])],
    [{ type: 'response.output_item.done', output_index: 0, item: compact }, complete([{ ...compact, encrypted_content: 'different' }, reply('No')])],
  ]) {
    const f = fixture([events]); const chunks = [];
    try {
      for await (const chunk of f.bridge.stream(options([user('Start')]))) chunks.push(chunk);
      // Replay metadata is optional: an unprovable window never costs the turn.
      assert.equal(chunks.at(-1).reason.kind, 'stop');
      assert.ok(chunks.every(chunk => !chunk.replayState));
      assert.equal(f.warnings.length, 1);
      assert.ok(f.warnings[0].startsWith('The subscription compaction checkpoint was not published ('));
    } finally { await f.bridge.close(); }
  }
});

test('a streamed window the terminal array omits still publishes and reuses a checkpoint', async () => {
  // Observed on the live route: the compaction item and the message arrive as
  // streamed completed items, while response.completed.response.output omits
  // the compaction item. The streamed order is the one that must be kept.
  const textDelta = { type: 'response.output_text.delta', item_id: 'msg-1', content_index: 0, delta: 'Hello' };
  const textDone = { ...textDelta, type: 'response.output_text.done', text: 'Hello' };
  const streamed = [
    { type: 'response.output_item.added', output_index: 0, item: compact },
    textDelta,
    textDone,
    { type: 'response.output_item.done', output_index: 0, item: compact },
    { type: 'response.output_item.added', output_index: 1, item: reply('Hello') },
    { type: 'response.output_item.done', output_index: 1, item: reply('Hello') },
    complete([reply('Hello')]),
  ];
  const f = fixture([streamed, [complete([reply('Next')])]]);
  try {
    const first = await run(f.bridge, options([user('Start')]));
    const saved = JSON.parse(JSON.stringify(first.message));
    assert.ok(saved.source.replayState.response[CHECKPOINT_KEY]);
    await run(f.bridge, options([user('Start'), saved, user('Next')]));
    assert.equal(f.payloads[1].input[0].type, 'compaction');
    assert.deepEqual(f.warnings, []);
  } finally { await f.bridge.close(); }
});

test('an incomplete or unsupported terminal state still fails the turn', async () => {
  for (const [events, code] of [
    [[{ type: 'response.output_item.done', output_index: 0, item: compact }], 'PROTOCOL_INVALID'],
    [[{ type: 'response.output_item.done', output_index: 0, item: compact }, { type: 'response.failed' }], 'UPSTREAM_FAILED'],
    [[complete([compact, { type: 'web_search_call' }])], 'PROTOCOL_INVALID'],
  ]) {
    const f = fixture([events]);
    try { await assert.rejects(run(f.bridge, options([user('Start')])), { code }); }
    finally { await f.bridge.close(); }
  }
});

test('compaction is always requested without configuration and a plain response publishes no checkpoint', async () => {
  const f = fixture([[complete([reply('Plain')])], [complete([reply('Again')])]]);
  try {
    const first = await run(f.bridge, options([user('Start')]));
    assert.deepEqual(f.payloads[0].context_management, [{ type: 'compaction', compact_threshold: 258400 }]);
    assert.equal(first.message.source.replayState, undefined);
    await run(f.bridge, options([user('Start')]));
    assert.equal(f.payloads[1].context_management[0].type, 'compaction');
  } finally { await f.bridge.close(); }
});

test('model scope, missing output positions, and multiple compactions retain only a proven last window', () => {
  const plan = validateInput(options([user('Start')]));
  const scope = compactionScope({ account: 'one' }, 'model-a', plan);
  const capture = new CompactionCapture();
  const blocks = [{ type: 'text', text: 'Old' }, { type: 'text', text: 'Final' }];
  const replayState = capture.finish([compact, reply('Old'), { ...compact, id: 'cp-2' }, reply('Final')], scope, plan, blocks);
  assert.equal(replayState.response[CHECKPOINT_KEY].items.length, 2);
  const messages = [user('Start'), { role: 'assistant', content: blocks, source: { replayState } }, user('Next')];
  const next = validateInput(options(messages));
  assert.ok(selectCheckpoint(messages, next, scope));
  assert.equal(selectCheckpoint(messages, next, compactionScope({ account: 'one' }, 'model-b', plan)), undefined);
  const incomplete = new CompactionCapture();
  incomplete.observe({ output_index: 1, item: compact });
  assert.equal(incomplete.finish(null, scope, plan, blocks), undefined);
});

test('explicit unsupported compaction parameter retries once with full bounded history', async () => {
  const rejected = () => Response.json({ error: { code: 'unsupported_parameter', param: 'context_management', message: 'must-not-leak' } }, { status: 400 });
  const f = fixture([[complete([compact, reply('First')])], rejected(), [complete([reply('Fallback')])]]);
  try {
    const first = await run(f.bridge, options([user('Start')]));
    await run(f.bridge, options([user('Start'), first.message, user('Next')]));
    assert.equal(f.payloads[1].input[0].type, 'compaction');
    assert.equal(f.payloads[2].context_management, undefined);
    assert.equal(f.payloads[2].input[0].content[0].text, 'Start');
    assert.equal(f.payloads[2].input.length, 3);
  } finally { await f.bridge.close(); }
  for (const response of [rejected(), Response.json({ error: { code: 'unknown', param: 'other' } }, { status: 400 }),
    Response.json({ error: { code: 'unsupported_parameter', param: 'context_management' } }, { status: 429 })]) {
    const f = fixture([response, rejected()]);
    try {
      await assert.rejects(run(f.bridge, options([user('Start')])), error => !error.message.includes('must-not-leak'));
      assert.ok(f.payloads.length <= 2);
      if (f.payloads.length === 2) assert.equal(f.payloads[1].context_management, undefined);
    } finally { await f.bridge.close(); }
  }
});

test('fallback does not resend oversized full history', async () => {
  const f = fixture([[complete([compact, reply('First')])], Response.json({ error: { code: 'unsupported_parameter', param: 'context_management' } }, { status: 400 })]);
  try {
    const start = user('x'.repeat(TEXT_BOUND - 10));
    const first = await run(f.bridge, options([start]));
    await assert.rejects(run(f.bridge, options([start, first.message, user('x'.repeat(100))])), { code: 'INPUT_UNSUPPORTED' });
    assert.equal(f.payloads.length, 2);
  } finally { await f.bridge.close(); }
});

test('cancellation after a completed compaction item never commits replay state', async () => {
  const abort = new AbortController();
  const f = fixture([[{ type: 'response.output_item.done', output_index: 0, item: compact },
    { type: 'response.output_text.delta', item_id: 'msg-1', content_index: 0, delta: 'Partial' }, complete([compact, reply('Partial')])]]);
  const chunks = [];
  try {
    await assert.rejects(async () => {
      for await (const chunk of f.bridge.stream({ ...options([user('Start')]), signal: abort.signal })) {
        chunks.push(chunk);
        if (chunk.type === 'text-delta') abort.abort();
      }
    }, { code: 'ABORTED' });
    assert.ok(chunks.every(chunk => !chunk.replayState));
  } finally { await f.bridge.close(); }
});

test('unrepresented streamed text is never lost behind a checkpoint', async () => {
  const f = fixture([[{ type: 'response.output_item.done', output_index: 0, item: compact },
    { type: 'response.output_text.delta', item_id: 'msg-1', content_index: 0, delta: 'Tail' }, complete(null)]]);
  try {
    const result = await run(f.bridge, options([user('Start')]));
    assert.equal(result.message.content[0].text, 'Tail');
    assert.equal(result.message.source.replayState, undefined);
  } finally { await f.bridge.close(); }
});

test('covered image attachments are not read or resent', async () => {
  const image = { type: 'image', attachment: { attachmentId: `sha256:${'ab'.repeat(32)}`, mediaType: 'image/png', bytes: 1024, width: 32, height: 32 } };
  const start = { role: 'user', content: [image, { type: 'text', text: 'Describe' }] };
  const plan = validateInput(options([start]));
  const content = [{ type: 'text', text: 'Description' }];
  const scope = compactionScope({ 'ChatGPT-Account-ID': 'synthetic-account' }, 'synthetic', plan);
  const replayState = new CompactionCapture().finish([compact, reply('Description')], scope, plan, content);
  const repeated = [start, { role: 'assistant', content, source: { replayState } }, start];
  const repeatedPlan = validateInput(options(repeated));
  assert.equal(compactPlan(repeatedPlan, selectCheckpoint(repeated, repeatedPlan, scope)).imageBlocks.length, 1);
  const f = fixture([[complete([reply('Continued')])]]);
  try {
    await run(f.bridge, options([start, { role: 'assistant', content, source: { replayState } }, user('Next')]));
    assert.equal(f.payloads[0].input[0].type, 'compaction');
    assert.ok(!JSON.stringify(f.payloads[0]).includes('input_image'));
  } finally { await f.bridge.close(); }
});

test('undisclosed model capacity omits compaction and a disclosed window uses the ratio', async () => {
  for (const [modelWindow, expected] of [[null, undefined], [1024, undefined], [4096, 3891], [272000, 258400]]) {
    const f = fixture([[complete([reply('Plain')])]], { modelWindow });
    try {
      await run(f.bridge, options([user('Start')]));
      assert.equal(f.payloads[0].context_management?.[0].compact_threshold, expected);
    } finally { await f.bridge.close(); }
  }
});

test('the request byte bound is derived from the same window as the threshold', async () => {
  const derived = requestLimits(500000);
  assert.equal(threshold(500000), 475000);
  assert.equal(derived.inputBytes, 475000 * 8);
  assert.equal(derived.textBytes, 475000 * 8);
  assert.equal(derived.toolBytes, 475000 * 8);
  // A window too small to derive a bound keeps the fixed floor, so the bound
  // never falls below the shape limits the bridge has always enforced.
  const floor = requestLimits(undefined);
  assert.equal(floor.inputBytes, 256 * 1024 + 2 * 1024 * 1024);
  assert.equal(requestLimits(4096).inputBytes, floor.inputBytes);
  assert.equal(requestLimits(4096).textBytes, TEXT_LIMIT);
  assert.equal(requestLimits(4096).toolBytes, TOOL_BYTES_LIMIT);
});

test('retained transcript limits and parallel conversations remain independent', async () => {
  assert.throws(() => validateInput(options([user('x'.repeat(4 * 1024 * 1024 + 1))]), true), { code: 'INPUT_UNSUPPORTED' });
  assert.throws(() => validateInput(options(Array.from({ length: 4097 }, () => user('x'))), true), { code: 'INPUT_UNSUPPORTED' });
  const f = fixture([[complete([compact, reply('One')])], [complete([{ ...compact, encrypted_content: 'other-opaque' }, reply('Two')])],
    [complete([reply('Continue one')])], [complete([reply('Continue two')])]]);
  try {
    const [one, two] = await Promise.all([run(f.bridge, options([user('One')])), run(f.bridge, options([user('Two')]))]);
    assert.notEqual(one.message.source.replayState.response[CHECKPOINT_KEY].prefix, two.message.source.replayState.response[CHECKPOINT_KEY].prefix);
    await run(f.bridge, options([user('One'), one.message, user('Next')]));
    await run(f.bridge, options([user('Two'), two.message, user('Next')]));
    assert.notEqual(f.payloads[2].input[0].encrypted_content, f.payloads[3].input[0].encrypted_content);
  } finally { await f.bridge.close(); }
});

test('public adapter carries checkpoints through the pinned Harness runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-compaction-public-'));
  const store = new AuthStore(authDirectory({ HOME: root }));
  const originalOpen = Http.prototype.open;
  const ctx = new Context();
  let service, fiber;
  const payloads = [];
  try {
    await store.transaction(() => store.write({ access_token: token('synthetic-account'), refresh_token: 'synthetic-refresh' }));
    Http.prototype.open = async (url, request) => {
      if (url.includes('/models?')) return Response.json({ models: [{ slug: 'synthetic', display_name: 'Synthetic', visibility: 'list', context_window: 272000,
        supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }], default_reasoning_level: 'medium' }] });
      payloads.push(JSON.parse(request.body));
      return sse([complete(payloads.length === 1 ? [compact, reply('First')] : [reply('Next')])]);
    };
    ctx.provide('launchEnvironment', { getFrom: key => ['HOME', 'DSH_HOME'].includes(key) ? { value: root } : undefined });
    service = ctx.plugin(LlmRuntime);
    fiber = ctx.plugin(plugin);
    await new Promise(resolve => setImmediate(resolve));
    // The declared levels are what makes the host's effort selector available, and
    // the default comes from the backend's own disclosure.
    const info = await ctx.llm.resolveModelInfo('codex-subscription', 'synthetic');
    assert.deepEqual(info.reasoning.efforts.map(effort => effort.id), ['low', 'medium', 'high']);
    assert.equal(info.reasoning.defaultEffort, 'medium');
    const first = await run(ctx.llm, options([user('Start')]));
    await run(ctx.llm, options([user('Start'), first.message, user('Next')]));
    assert.equal(payloads[1].input[0].type, 'compaction');
    assert.equal(payloads[1].context_management[0].compact_threshold, 258400);
  } finally {
    await fiber?.dispose(); await service?.dispose(); Http.prototype.open = originalOpen;
    await rm(root, { recursive: true, force: true });
  }
  // Compaction is always requested, so the adapter accepts no configuration keys.
  for (const config of [{ cloudCompaction: true }, { cloudCompaction: false }, { endpoint: 'https://example.invalid' }]) {
    assert.throws(() => plugin.apply({}, config), { code: 'CONFIG_INVALID' });
  }
});


test('checkpoint identity survives refresh but separates users within the same account', () => {
  const jwt = (sub, user, exp) => `x.${Buffer.from(JSON.stringify({ sub, exp, 'https://api.openai.com/auth': {
    chatgpt_account_id: 'shared-account', chatgpt_user_id: user } })).toString('base64url')}.x`;
  const first = compactionAccount(jwt('subject-one', 'user-one', 4000000000));
  assert.deepEqual(first, compactionAccount(jwt('subject-one', 'user-one', 4000001000)));
  assert.notDeepEqual(first, compactionAccount(jwt('subject-two', 'user-two', 4000000000)));
  assert.throws(() => compactionAccount(jwt({}, 'user', 4000000000)), { code: 'AUTH_REQUIRED' });
});
