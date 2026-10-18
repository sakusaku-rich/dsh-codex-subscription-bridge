import test from 'node:test';
import assert from 'node:assert/strict';
import { BlockAssembler } from '@deepseek-ai/dsh-llm';
import { DirectBridge } from '../src/direct.js';
import { Http } from '../src/http.js';
import { CHECKPOINT_KEY, CompactionCapture, threshold, requestLimits } from '../src/compaction.js';
import { CONVERSATION_KEY, CONVERSATION_MAX_AGE, conversationScope, inspectConversation, appendedItems, conversationRecord } from '../src/conversation.js';
import { digest, contentDigest } from '../src/hashes.js';
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
// The terminal event carries the id the next turn references.
const complete = (output, id = 'resp-1') => ({ type: 'response.completed', response: { status: 'completed', id, output } });
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

test('a chained turn sends only what it appends and references the id it was established on', async () => {
  const f = fixture([[complete([reply('First')])], [complete([reply('Second')])]]);
  try {
    const first = await run(f.bridge, options([user('Start')]));
    const saved = JSON.parse(JSON.stringify(first.message));
    assert.equal(saved.source.replayState.response[CONVERSATION_KEY].id, 'resp-1');
    assert.equal(saved.source.replayState.response[CONVERSATION_KEY].sent, digest(validateInput(options([user('Start')])).input));
    await run(f.bridge, options([user('Start'), saved, user('Next')]));
    assert.equal(f.payloads[1].previous_response_id, 'resp-1');
    assert.deepEqual(f.payloads[1].input, [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Next' }] }]);
    assert.ok(f.payloads.every(payload => payload.store === true));
    // Nothing opaque is carried: the record is a digest, not content.
    assert.ok(!JSON.stringify(saved).includes('opaque'));
  } finally { await f.bridge.close(); }
});

test('tool call history pairs with its executed result across a chained turn', async () => {
  const call = { type: 'function_call', id: 'tool-item', call_id: 'call-1', name: 'read', arguments: '{}' };
  const f = fixture([[{ type: 'response.output_item.done', output_index: 0, item: call }, complete(null, 'resp-1')], [complete([reply('Done')], 'resp-2')]]);
  try {
    const first = await run(f.bridge, options([user('Read')]));
    assert.equal(first.chunks.at(-1).reason.kind, 'tool-calls');
    await run(f.bridge, options([user('Read'), first.message, { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'Result' }] }]));
    assert.deepEqual(f.payloads[1].input.map(value => value.type), ['function_call_output']);
    assert.equal(f.payloads[1].previous_response_id, 'resp-1');
  } finally { await f.bridge.close(); }
});

test('changed history, instructions, tools, account, expiry, content or a malformed id refuses the chain', async () => {
  for (const mutation of ['history', 'instructions', 'tools', 'account', 'expired', 'future', 'content', 'model', 'id', 'role']) {
    const f = fixture([[complete([reply('First')])], [complete([reply('Next')])]]);
    try {
      const first = await run(f.bridge, options([user('Start')]));
      const request = options([user('Start'), first.message, user('Next')]);
      const record = first.message.source.replayState.response[CONVERSATION_KEY];
      if (mutation === 'history') request.messages[0] = user('Edited');
      if (mutation === 'instructions') request.system = 'Changed';
      if (mutation === 'tools') request.tools = [{ name: 'new_tool', parameters: { type: 'object' } }];
      if (mutation === 'account') f.account('another-account');
      if (mutation === 'expired') record.createdAt -= CONVERSATION_MAX_AGE + 1;
      if (mutation === 'future') record.createdAt += 60000;
      if (mutation === 'content') first.message.content[0].text = 'Edited response';
      if (mutation === 'model') record.scope = 'other-model-scope';
      if (mutation === 'id') record.id = '';
      if (mutation === 'role') request.messages[1].role = 'user';
      await run(f.bridge, request);
      // A refused chain is not trusted: the whole history is sent on its own.
      assert.equal(f.payloads[1].previous_response_id, undefined, mutation);
      assert.equal(f.payloads[1].input.length, 3, mutation);
      assert.ok(f.warnings.some(message => message.includes('chain was refused')), mutation);
    } finally { await f.bridge.close(); }
  }
});

test('a chained turn whose appended part exceeds the wire bound is refused', async () => {
  const f = fixture([[complete([reply('First')])], [complete([reply('Next')])]]);
  try {
    const first = await run(f.bridge, options([user('Start')]));
    await assert.rejects(run(f.bridge, options([user('Start'), first.message, user('y'.repeat(TEXT_BOUND + 1))])),
      { code: 'INPUT_UNSUPPORTED' });
    assert.equal(f.payloads.length, 1);
  } finally { await f.bridge.close(); }
});

test('a refused chain with a full history past the wire bounds names the boundary', async () => {
  const f = fixture([[complete([reply('First')])], [complete([reply('Next')])]]);
  try {
    const start = user('x'.repeat(TEXT_BOUND - 10));
    const first = await run(f.bridge, options([start]));
    const request = options([start, first.message, user('y'.repeat(100))]);
    request.messages[0] = user('x'.repeat(TEXT_BOUND - 10).replace('x', 'y'));
    await assert.rejects(run(f.bridge, request), { code: 'CONVERSATION_UNAVAILABLE' });
    assert.ok(f.warnings.some(message => message.includes('chain was refused (PREFIX)')));
  } finally { await f.bridge.close(); }
});

test('the marker carries only a count and an unprovable marker never costs the turn', async () => {
  for (const events of [
    [complete([{ ...compact, encrypted_content: '' }, reply('No')])],
    [{ type: 'response.output_item.done', output_index: 0, item: compact }, complete([{ ...compact, encrypted_content: 'different' }, reply('No')])],
  ]) {
    const f = fixture([events]); const chunks = [];
    try {
      for await (const chunk of f.bridge.stream(options([user('Start')]))) chunks.push(chunk);
      // The answer is delivered either way; only the marker is withheld.
      assert.equal(chunks.at(-1).reason.kind, 'stop');
      assert.equal(chunks.at(-1).replayState.response[CHECKPOINT_KEY], undefined);
      assert.equal(chunks.at(-1).replayState.response[CONVERSATION_KEY].id, 'resp-1');
      assert.equal(f.warnings.length, 1);
      assert.ok(f.warnings[0].startsWith('The subscription compaction marker was not published ('));
    } finally { await f.bridge.close(); }
  }
});

test('a streamed compaction item the terminal array omits still marks the turn', async () => {
  // Observed on the live route: the compaction item and the message arrive as
  // streamed completed items, while response.completed.response.output omits the
  // compaction item. The streamed order is the one that must be kept.
  const textDelta = { type: 'response.output_text.delta', item_id: 'msg-1', content_index: 0, delta: 'Hello' };
  const textDone = { ...textDelta, type: 'response.output_text.done', text: 'Hello' };
  const streamed = [
    { type: 'response.output_item.added', output_index: 0, item: compact },
    textDelta, textDone,
    { type: 'response.output_item.done', output_index: 0, item: compact },
    { type: 'response.output_item.added', output_index: 1, item: reply('Hello') },
    { type: 'response.output_item.done', output_index: 1, item: reply('Hello') },
    complete([reply('Hello')], 'resp-1'),
  ];
  const f = fixture([streamed, [complete([reply('Next')], 'resp-2')]]);
  try {
    const first = await run(f.bridge, options([user('Start')]));
    const saved = JSON.parse(JSON.stringify(first.message));
    assert.equal(saved.source.replayState.response[CHECKPOINT_KEY].count, 2);
    await run(f.bridge, options([user('Start'), saved, user('Next')]));
    assert.equal(f.payloads[1].previous_response_id, 'resp-1');
    assert.deepEqual(f.warnings.filter(message => message.includes('marker')), []);
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

test('compaction is always requested without configuration and a plain response publishes no marker', async () => {
  const f = fixture([[complete([reply('Plain')])], [complete([reply('Again')])]]);
  try {
    const first = await run(f.bridge, options([user('Start')]));
    assert.deepEqual(f.payloads[0].context_management, [{ type: 'compaction', compact_threshold: 258400 }]);
    assert.equal(first.message.source.replayState.response[CHECKPOINT_KEY], undefined);
    assert.ok(first.message.source.replayState.response[CONVERSATION_KEY]);
    await run(f.bridge, options([user('Start')]));
    assert.equal(f.payloads[1].context_management[0].type, 'compaction');
  } finally { await f.bridge.close(); }
});

test('explicit unsupported parameters retry once with full bounded history', async () => {
  const rejected = param => Response.json({ error: { code: 'unsupported_parameter', param, message: 'must-not-leak' } }, { status: 400 });
  for (const param of ['context_management', 'previous_response_id']) {
    const f = fixture([[complete([compact, reply('First')])], rejected(param), [complete([reply('Fallback')])]]);
    try {
      const first = await run(f.bridge, options([user('Start')]));
      await run(f.bridge, options([user('Start'), first.message, user('Next')]));
      assert.equal(f.payloads[1].previous_response_id, 'resp-1');
      // Only the rejected parameter is dropped from the one bounded retry.
      assert.deepEqual(f.payloads[2].context_management, param === 'context_management' ? undefined : [{ type: 'compaction', compact_threshold: 258400 }]);
      assert.equal(f.payloads[2].previous_response_id, param === 'previous_response_id' ? undefined : 'resp-1');
      assert.equal(f.payloads[2].input[0].content[0].text, 'Start');
      assert.equal(f.payloads[2].input.length, 3);
    } finally { await f.bridge.close(); }
  }
  for (const response of [rejected('previous_response_id'), Response.json({ error: { code: 'unknown', param: 'other' } }, { status: 400 }),
    rejected('previous_response_id')]) {
    const f = fixture([response, rejected('context_management')]);
    try {
      await assert.rejects(run(f.bridge, options([user('Start')])), error => !error.message.includes('must-not-leak'));
      assert.ok(f.payloads.length <= 2);
    } finally { await f.bridge.close(); }
  }
});

test('fallback does not resend oversized full history', async () => {
  const f = fixture([[complete([compact, reply('First')])], Response.json({ error: { code: 'unsupported_parameter', param: 'previous_response_id' } }, { status: 400 })]);
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

test('unrepresented streamed text is never lost behind a marker', async () => {
  const f = fixture([[{ type: 'response.output_item.done', output_index: 0, item: compact },
    { type: 'response.output_text.delta', item_id: 'msg-1', content_index: 0, delta: 'Tail' }, complete(null)]]);
  try {
    const result = await run(f.bridge, options([user('Start')]));
    assert.equal(result.message.content[0].text, 'Tail');
    assert.equal(result.message.source.replayState.response[CHECKPOINT_KEY], undefined);
    assert.ok(result.message.source.replayState.response[CONVERSATION_KEY]);
  } finally { await f.bridge.close(); }
});

test('covered image attachments are not read or resent on a chained turn', async () => {
  const image = { type: 'image', attachment: { attachmentId: `sha256:${'ab'.repeat(32)}`, mediaType: 'image/png', bytes: 1024, width: 32, height: 32 } };
  const start = { role: 'user', content: [image, { type: 'text', text: 'Describe' }] };
  const plan = validateInput(options([start]));
  const content = [{ type: 'text', text: 'Description' }];
  const scope = conversationScope(compactionAccount(token('synthetic-account')), 'synthetic', plan);
  const record = conversationRecord(scope, 'resp-1', digest(plan.input), contentDigest(content));
  const messages = [start, { role: 'assistant', content, source: { replayState: record } }, user('Next')];
  const f = fixture([[complete([reply('Continued')])]]);
  try {
    await run(f.bridge, options(messages));
    // Only the new part is sent, so the covered attachment is never read.
    assert.equal(f.payloads[0].input.length, 1);
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
  const f = fixture([[complete([reply('One')], 'resp-a')], [complete([reply('Two')], 'resp-b')],
    [complete([reply('Continue one')])], [complete([reply('Continue two')])]]);
  try {
    const [one, two] = await Promise.all([run(f.bridge, options([user('One')])), run(f.bridge, options([user('Two')]))]);
    assert.notEqual(one.message.source.replayState.response[CONVERSATION_KEY].sent, two.message.source.replayState.response[CONVERSATION_KEY].sent);
    await run(f.bridge, options([user('One'), one.message, user('Next')]));
    await run(f.bridge, options([user('Two'), two.message, user('Next')]));
    assert.equal(f.payloads[2].previous_response_id, 'resp-a');
    assert.equal(f.payloads[3].previous_response_id, 'resp-b');
  } finally { await f.bridge.close(); }
});

test('inspection names every refusal instead of silently trusting a chain', () => {
  const plan = validateInput(options([user('Start')]));
  const scope = conversationScope({ account: 'one' }, 'synthetic', plan);
  const blocks = [{ type: 'text', text: 'Answer' }];
  const record = { version: 1, createdAt: Date.now(), scope, id: 'resp-1', sent: digest(plan.input), content: contentDigest(blocks) };
  const messages = [user('Start'), { role: 'assistant', content: blocks, source: { replayState: { response: { [CONVERSATION_KEY]: record } } } }, user('Next')];
  const next = validateInput(options(messages));
  assert.equal(inspectConversation(messages, next, scope).id, 'resp-1');
  assert.deepEqual(inspectConversation([user('Start')], validateInput(options([user('Start')])), scope), {});
  assert.equal(inspectConversation(messages, next, 'another-scope').refusal, 'SCOPE');
  assert.equal(inspectConversation(messages, next, scope, Date.now() + CONVERSATION_MAX_AGE + 1).refusal, 'EXPIRED');
  const edited = JSON.parse(JSON.stringify(messages)); edited[0] = user('Edited');
  assert.equal(inspectConversation(edited, validateInput(options(edited)), scope).refusal, 'PREFIX');
  const content = JSON.parse(JSON.stringify(messages)); content[1].content[0].text = 'Changed';
  assert.equal(inspectConversation(content, next, scope).refusal, 'CONTENT');
  const future = JSON.parse(JSON.stringify(messages)); future[1].source.replayState.response[CONVERSATION_KEY].createdAt = Date.now() + 60_000;
  assert.equal(inspectConversation(future, next, scope).refusal, 'METADATA');
  const opaque = JSON.parse(JSON.stringify(messages)); opaque[1].source.replayState.response[CONVERSATION_KEY].id = '';
  assert.equal(inspectConversation(opaque, next, scope).refusal, 'ID');
  // A failure with no stage of its own still reports the generic label.
  assert.equal(inspectConversation(messages, { ...next, spans: undefined }, scope).refusal, 'INVALID');
});

test('the appended part is bounded on its own and keeps the covered part out of the request', () => {
  const limits = requestLimits(WINDOW);
  const window = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'a'.repeat(300000) }] }];
  const tail = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'b'.repeat(200000) }] };
  const plan = { input: [...window, tail], tools: [], imageBlocks: [], images: new Map(), spans: [{ start: 0, end: 1, imageEnd: 0 }] };
  const result = appendedItems(plan, { end: 1, imageEnd: 0 }, limits);
  assert.equal(result.input.length, 1);
  assert.ok(result.input.includes(tail));
  assert.ok(result.attachments.size === 0);
  // A tail that exceeds the bound on its own is refused rather than sent oversized.
  const oversizedTail = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'b'.repeat(limits.textBytes + 1) }] };
  assert.throws(() => appendedItems({ ...plan, input: [oversizedTail] }, { end: 0, imageEnd: 0 }, limits), { code: 'INPUT_UNSUPPORTED' });
});

test('public adapter carries the conversation record through the pinned Harness runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-conversation-public-'));
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
      return sse([complete(payloads.length === 1 ? [compact, reply('First')] : [reply('Next')], `resp-${payloads.length}`)]);
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
    assert.equal(payloads[1].previous_response_id, 'resp-1');
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

test('conversation identity survives refresh but separates users within the same account', () => {
  const jwt = (sub, user, exp) => `x.${Buffer.from(JSON.stringify({ sub, exp, 'https://api.openai.com/auth': {
    chatgpt_account_id: 'shared-account', chatgpt_user_id: user } })).toString('base64url')}.x`;
  const first = compactionAccount(jwt('subject-one', 'user-one', 4000000000));
  assert.deepEqual(first, compactionAccount(jwt('subject-one', 'user-one', 4000001000)));
  assert.notDeepEqual(first, compactionAccount(jwt('subject-two', 'user-two', 4000000000)));
  assert.throws(() => compactionAccount(jwt({}, 'user', 4000000000)), { code: 'AUTH_REQUIRED' });
});
