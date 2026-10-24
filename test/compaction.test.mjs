import { createHash } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { BlockAssembler } from '@deepseek-ai/dsh-llm';
import { DirectBridge } from '../lib/direct.js';
import { Http } from '../lib/http.js';
import { CHECKPOINT_KEY, CHECKPOINT_MAX_AGE, CHECKPOINT_BYTES, COMPACT_RATIO, CompactionCapture, compactionScope, inspectCheckpoint, selectCheckpoint, compactPlan, trimOldest, threshold, requestLimits, ratio } from '../lib/compaction.js';
import { validateInput, TEXT_LIMIT, TOOL_BYTES_LIMIT } from '../lib/text.js';
import { Context } from '@deepseek-ai/cordis';
import { LlmRuntime } from '@deepseek-ai/dsh-llm';
import * as plugin from '../lib/index.js';
import { AuthStore, authDirectory, compactionAccount } from '../lib/auth.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A user message with one text block. */
const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] });
const compact = { type: 'compaction', id: 'cp-1', encrypted_content: 'synthetic-opaque-checkpoint' };
/** An assistant message with one output text block. */
const reply = (text) => ({ type: 'message', id: 'msg-1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] });
/** A request for the given messages. */
const options = (messages) => ({ provider: 'codex-subscription', model: 'synthetic', messages });
// The fixture's disclosed window. The request byte bound and the compaction
// threshold both derive from it, so payloads that must be refused are sized
// against the bound rather than a fixed constant.
const WINDOW = 272000;
const TEXT_BOUND = requestLimits(WINDOW).textBytes;
/** A synthetic JWT carrying the given account. */
const token = (account) => `x.${Buffer.from(JSON.stringify({ exp: 4000000000, 'https://api.openai.com/auth': { chatgpt_account_id: account } })).toString('base64url')}.x`;
/** An SSE response carrying the given events. */
const sse = (values) => new Response(values.map((value) => `data: ${JSON.stringify(value)}\n\n`).join(''));
/** A terminal event with the given output. */
const complete = (output) => ({ type: 'response.completed', response: { status: 'completed', output } });
/** The sha256 hex the window stores for a value. */
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** The digest Harness computes over the blocks it can prove. */
const contentDigest = (blocks) => createHash('sha256').update(JSON.stringify(blocks.filter((block) => block.type === 'text' || block.type === 'tool-call')
  .map((block) => block.type === 'text' ? { type: 'text', text: block.text } : { type: 'tool-call', id: block.id, name: block.name, arguments: block.arguments }))).digest('hex');
/** The serialized size of a window as the bound measures it. */
const windowBytesOf = (values) => 2 + values.reduce((total, value) => total + Buffer.byteLength(JSON.stringify(value)) + 1, 0);

/** A bridge that answers each request with the next fixture response and records the request bodies. */
function fixture(responses, settings = {}, warnings = []) {
  const payloads = [];
  let account = 'synthetic-account';
  const bridge = new DirectBridge({ token: async () => token(account) }, new Http(async (url, request) => {
    if (url.includes('/models?')) {
      return Response.json({ models: [{ slug: 'synthetic', display_name: 'Synthetic', visibility: 'list',
        ...(settings.modelWindow === null ? {} : { context_window: settings.modelWindow ?? WINDOW }),
        ...(settings.modelPercent == null ? {} : { effective_context_window_percent: settings.modelPercent }) }] });
    }
    payloads.push(JSON.parse(request.body));
    const next = responses.shift();
    if (!next) throw new Error('unexpected request');
    return next instanceof Response ? next : sse(next);
  }), settings, { warn: (message) => warnings.push(message) });
  return { bridge, payloads, warnings, account: (value) => { account = value; } };
}

/** Consume a stream and rebuild the assistant message from its chunks. */
async function run(bridge, request) {
  const chunks = [];
  for await (const chunk of bridge.stream(request)) chunks.push(chunk);
  const assembler = new BlockAssembler();
  for (const chunk of chunks) assembler.push(chunk);
  return { chunks, message: { role: 'assistant', content: assembler.blocks(), source: { kind: 'model', provider: request.provider,
    model: request.model, replayState: assembler.replayState } } };
}

const textDelta = { type: 'response.output_text.delta', item_id: 'msg-1', content_index: 0, delta: 'Hello' };
const textDone = { ...textDelta, type: 'response.output_text.done', text: 'Hello' };

test('the checkpoint survives JSON persistence', async () => {
  const f = fixture([[complete([compact, reply('First')])]]);

  const first = await run(f.bridge, options([user('Start')]));
  const saved = JSON.parse(JSON.stringify(first.message));

  assert.ok(saved.source.replayState.response[CHECKPOINT_KEY]);

  await f.bridge.close();
});

test('a persisted window is reused on the next turn', async () => {
  const f = fixture([[complete([compact, reply('First')])], [complete([reply('Second')])]]);

  const first = await run(f.bridge, options([user('Start')]));
  const saved = JSON.parse(JSON.stringify(first.message));
  await run(f.bridge, options([user('Start'), saved, user('Next')]));

  assert.deepEqual(f.payloads[1].input, [compact, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'First' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Next' }] }]);

  await f.bridge.close();
});

test('a reused window is not sent twice across turns', async () => {
  const f = fixture([[complete([compact, reply('First')])], [complete([reply('Second')])], [complete([reply('Third')])]]);

  const first = await run(f.bridge, options([user('Start')]));
  const saved = JSON.parse(JSON.stringify(first.message));
  const second = await run(f.bridge, options([user('Start'), saved, user('Next')]));
  await run(f.bridge, options([user('Start'), saved, user('Next'), second.message, user('Again')]));

  assert.equal(f.payloads[2].input.length, 5);

  await f.bridge.close();
});

test('every request keeps the stateless shape', async () => {
  const f = fixture([[complete([compact, reply('First')])], [complete([reply('Second')])], [complete([reply('Third')])]]);

  const first = await run(f.bridge, options([user('Start')]));
  const saved = JSON.parse(JSON.stringify(first.message));
  const second = await run(f.bridge, options([user('Start'), saved, user('Next')]));
  await run(f.bridge, options([user('Start'), saved, user('Next'), second.message, user('Again')]));

  assert.ok(f.payloads.every((p) => p.store === false && !('previous_response_id' in p)));

  await f.bridge.close();
});

test('a tool call after compaction is retained exactly once', async () => {
  const call = { type: 'function_call', id: 'tool-item', call_id: 'call-1', name: 'read', arguments: '{}' };
  const f = fixture([[{ type: 'response.output_item.done', output_index: 0, item: compact },
    { type: 'response.output_item.done', output_index: 1, item: call }, complete(null)], [complete([reply('Done')])]]);

  const first = await run(f.bridge, options([user('Read')]));
  await run(f.bridge, options([user('Read'), first.message, { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'Result' }] }]));

  assert.deepEqual(f.payloads[1].input.map((i) => i.type), ['compaction', 'function_call', 'function_call_output']);

  await f.bridge.close();
});

test('the retained tool call and its executed result carry the same call id', async () => {
  const call = { type: 'function_call', id: 'tool-item', call_id: 'call-1', name: 'read', arguments: '{}' };
  const f = fixture([[{ type: 'response.output_item.done', output_index: 0, item: compact },
    { type: 'response.output_item.done', output_index: 1, item: call }, complete(null)], [complete([reply('Done')])]]);

  const first = await run(f.bridge, options([user('Read')]));
  await run(f.bridge, options([user('Read'), first.message, { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'Result' }] }]));

  assert.equal(f.payloads[1].input[1].call_id, f.payloads[1].input[2].call_id);

  await f.bridge.close();
});

test('a turn that ends on a tool call reports tool-calls as its reason', async () => {
  const call = { type: 'function_call', id: 'tool-item', call_id: 'call-1', name: 'read', arguments: '{}' };
  const f = fixture([[{ type: 'response.output_item.done', output_index: 0, item: compact },
    { type: 'response.output_item.done', output_index: 1, item: call }, complete(null)]]);

  const first = await run(f.bridge, options([user('Read')]));

  assert.equal(first.chunks.at(-1).reason.kind, 'tool-calls');

  await f.bridge.close();
});

test('a window that no longer matches its provenance falls back to full history', async () => {
  for (const mutation of ['history', 'instructions', 'tools', 'account', 'expired', 'future', 'digest', 'content', 'model']) {
    const f = fixture([[complete([compact, reply('First')])], [complete([reply('Next')])]]);

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

    await f.bridge.close();
  }
});

test('a covered window past the wire bound is trimmed from the oldest end instead of failing the turn', async () => {
  const big = 'a'.repeat(250000);
  const f = fixture([[complete([compact, reply(big)])], [complete([reply('Trimmed')])]]);

  const start = user('x'.repeat(TEXT_BOUND - 10));
  const first = await run(f.bridge, options([start]));
  const tail = user('y'.repeat(TEXT_BOUND - Buffer.byteLength(big) + 1));
  await run(f.bridge, options([start, first.message, tail]));

  assert.ok(f.warnings.some((message) => message.includes('trimmed from the oldest end')));

  await f.bridge.close();
});

test('the uncovered tail is kept when the oldest covered item is dropped', async () => {
  const big = 'a'.repeat(250000);
  const f = fixture([[complete([compact, reply(big)])], [complete([reply('Trimmed')])]]);

  const start = user('x'.repeat(TEXT_BOUND - 10));
  const first = await run(f.bridge, options([start]));
  const tail = user('y'.repeat(TEXT_BOUND - Buffer.byteLength(big) + 1));
  await run(f.bridge, options([start, first.message, tail]));

  assert.equal(f.payloads[1].input[0].type, 'compaction');
  assert.ok(f.payloads[1].input.some((value) => value.content?.[0]?.text === tail.content[0].text));

  await f.bridge.close();
});

test('a refused checkpoint has no window to trim, so the full transcript is revalidated on its own', async () => {
  const big = 'a'.repeat(250000);
  const f = fixture([[complete([compact, reply(big)])], [complete([reply('Trimmed')])], [complete([reply('Fitted')])]]);

  const start = user('x'.repeat(TEXT_BOUND - 10));
  const first = await run(f.bridge, options([start]));
  await run(f.bridge, options([start, first.message, user('y'.repeat(TEXT_BOUND - Buffer.byteLength(big) + 1))]));
  f.account('other');
  const refused = await run(f.bridge, options([start, first.message, user('y'.repeat(100))]));

  assert.ok(f.warnings.some((message) => message.includes('was refused (SCOPE)')));
  assert.ok(f.warnings.some((message) => message.includes('full history was trimmed from the oldest end')));
  assert.equal(refused.message.content[0].text, 'Fitted');

  await f.bridge.close();
});

test('the bound is a resource limit, not a window guard', async () => {
  const measuredBytesPerToken = 5.14;
  const pastWindow = 'a'.repeat(Math.floor(WINDOW * measuredBytesPerToken * 1.2));
  const f = fixture([[complete([reply('Answered')])]]);

  await run(f.bridge, options([user(pastWindow)]));

  assert.equal(f.warnings.length, 0);

  await f.bridge.close();
});

test('a transcript past the window but inside the resource bound is sent whole', async () => {
  const measuredBytesPerToken = 5.14;
  const pastWindow = 'a'.repeat(Math.floor(WINDOW * measuredBytesPerToken * 1.2));
  const f = fixture([[complete([reply('Answered')])]]);

  await run(f.bridge, options([user(pastWindow)]));

  assert.equal(f.payloads[0].input[0].content[0].text, pastWindow);

  await f.bridge.close();
});

test('the upstream measure of that transcript is past the window and inside the resource bound', async () => {
  const measuredBytesPerToken = 5.14;
  const pastWindow = 'a'.repeat(Math.floor(WINDOW * measuredBytesPerToken * 1.2));

  assert.ok(Buffer.byteLength(pastWindow) / measuredBytesPerToken > WINDOW);
  assert.ok(Buffer.byteLength(pastWindow) <= requestLimits(WINDOW).inputBytes);
});

test('a window past its bound drops the oldest covered items instead of refusing', async () => {
  const limit = requestLimits(WINDOW).checkpointBytes;
  const big = { type: 'compaction', id: 'cp-1', encrypted_content: 'y'.repeat(1000000) };
  const many = Array.from({ length: 60 }, (_, index) => reply(`${index} ${'z'.repeat(20000)}`));
  const plan = { input: [], tools: [] };
  const capture = new CompactionCapture(limit);

  const replayState = capture.finish([big, ...many], compactionScope('synthetic-account', 'synthetic', plan), plan,
    many.map((value) => ({ type: 'text', text: value.content[0].text })));

  assert.ok(replayState);
  assert.equal(capture.refusal, undefined);
  assert.ok(capture.trimmed > 0);
});

/** A window over an oversized item and 60 replies, trimmed to the bound. */
function trimmedWindow(limit) {
  const big = { type: 'compaction', id: 'cp-1', encrypted_content: 'y'.repeat(1000000) };
  const many = Array.from({ length: 60 }, (_, index) => reply(`${index} ${'z'.repeat(20000)}`));
  const plan = { input: [], tools: [] };
  const capture = new CompactionCapture(limit);
  const replayState = capture.finish([big, ...many], compactionScope('synthetic-account', 'synthetic', plan), plan,
    many.map((value) => ({ type: 'text', text: value.content[0].text })));
  return { replayState, items: replayState.response[CHECKPOINT_KEY].items, many };
}

test('the trimmed window stays inside its bound', async () => {
  const limit = requestLimits(WINDOW).checkpointBytes;
  const { items } = trimmedWindow(limit);

  assert.ok(windowBytesOf(items) <= limit);
});

test('the oldest covered items are dropped from the window', async () => {
  const limit = requestLimits(WINDOW).checkpointBytes;
  const { items, many } = trimmedWindow(limit);

  assert.ok(items.length < many.length + 1);
});

test('the persisted digest is computed over the trimmed window', async () => {
  const limit = requestLimits(WINDOW).checkpointBytes;
  const { replayState, items } = trimmedWindow(limit);

  assert.equal(digest(items), replayState.response[CHECKPOINT_KEY].digest);
});

test('a compacted request past the wire bound drops the oldest window items instead of failing', async () => {
  const limits = requestLimits(WINDOW);
  const window = [compact, ...Array.from({ length: 8 }, (_, index) => ({ type: 'message', role: 'assistant',
    content: [{ type: 'output_text', text: `m${index} ${'a'.repeat(250000)}` }] }))];
  const tail = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'b'.repeat(200000) }] };
  const plan = { input: [...window, tail], tools: [], imageBlocks: [], images: new Map() };

  const result = compactPlan(plan, { end: window.length, imageEnd: 0, items: window }, limits);

  assert.ok(result.trimmed > 0);
  assert.ok(result.input.includes(tail));
  assert.equal(result.input[0].type, 'compaction');
  assert.ok(result.input.reduce((total, value) => total + (value.type === 'message'
    ? value.content.reduce((part, block) => part + Buffer.byteLength(block.text), 0) : 0), 0) <= limits.textBytes);
});

test('a tail that exceeds the bound on its own is still refused', async () => {
  const limits = requestLimits(WINDOW);
  const window = [compact];
  const plan = { input: [], tools: [], imageBlocks: [], images: new Map() };
  const oversizedTail = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'b'.repeat(limits.textBytes + 1) }] };

  assert.throws(() => compactPlan({ ...plan, input: [compact, oversizedTail] }, { end: 1, imageEnd: 0, items: [compact] }, limits),
    { code: 'INPUT_UNSUPPORTED' });
});

test('a persisted window past the derived bound is refused whole, not trimmed', async () => {
  const limit = requestLimits(WINDOW).checkpointBytes;
  const big = { type: 'compaction', id: 'cp-1', encrypted_content: 'y'.repeat(1000000) };
  const parts = Array.from({ length: 60 }, (_, index) => ({ type: 'output_text', text: `m${index} ${'z'.repeat(20000)}` }));
  const items = [big, ...parts.map((part) => ({ type: 'message', role: 'assistant', content: [part] }))];
  const blocks = parts.map((part) => ({ type: 'text', text: part.text }));
  const messages = [user('Start'), { role: 'assistant', content: blocks, source: {} }, user('Next')];
  const plan = validateInput(options(messages), true);
  const scope = compactionScope({ account: 'one' }, 'model-a', plan);

  messages[1].source.replayState = { response: { [CHECKPOINT_KEY]: { version: 1, createdAt: Date.now(), scope,
    prefix: digest(plan.input.slice(0, plan.spans[1].start)), content: contentDigest(blocks), items, digest: digest(items) } } };

  assert.ok(windowBytesOf(items) > limit);
  assert.equal(inspectCheckpoint(messages, plan, scope, Date.now(), limit).refusal, 'WINDOW_BYTES');
  assert.equal(selectCheckpoint(messages, plan, scope, Date.now(), limit), undefined);
});

test('with no disclosed window the fixed floor still applies', async () => {
  assert.equal(requestLimits(null).checkpointBytes, CHECKPOINT_BYTES);
});

test('an unprovable window never costs the turn', async () => {
  for (const events of [
    [complete([{ ...compact, encrypted_content: '' }, reply('No')])],
    [{ type: 'response.output_item.done', output_index: 0, item: compact }, complete([{ ...compact, encrypted_content: 'different' }, reply('No')])],
  ]) {
    const f = fixture([events]);

    const { chunks } = await run(f.bridge, options([user('Start')]));

    assert.equal(chunks.at(-1).reason.kind, 'stop');
    assert.ok(chunks.every((chunk) => !chunk.replayState));

    await f.bridge.close();
  }
});

test('an unprovable window reports one fixed refusal', async () => {
  const f = fixture([[complete([{ ...compact, encrypted_content: '' }, reply('No')])]]);

  await run(f.bridge, options([user('Start')]));

  assert.equal(f.warnings.length, 1);
  assert.ok(f.warnings[0].startsWith('The subscription compaction checkpoint was not published ('));

  await f.bridge.close();
});

test('a streamed window the terminal array omits still publishes a checkpoint', async () => {
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

  const first = await run(f.bridge, options([user('Start')]));
  const saved = JSON.parse(JSON.stringify(first.message));
  await run(f.bridge, options([user('Start'), saved, user('Next')]));

  assert.ok(saved.source.replayState.response[CHECKPOINT_KEY]);
  assert.equal(f.payloads[1].input[0].type, 'compaction');

  await f.bridge.close();
});

test('the streamed order is the one that is kept', async () => {
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

  const first = await run(f.bridge, options([user('Start')]));
  await run(f.bridge, options([user('Start'), JSON.parse(JSON.stringify(first.message)), user('Next')]));

  assert.deepEqual(f.warnings, []);

  await f.bridge.close();
});

test('an incomplete or unsupported terminal state still fails the turn', async () => {
  for (const events of [
    [{ type: 'response.output_item.done', output_index: 0, item: compact }],
    [{ type: 'response.output_item.done', output_index: 0, item: compact }, { type: 'response.failed' }],
    [complete([compact, { type: 'web_search_call' }])],
  ]) {
    const f = fixture([events]);

    await assert.rejects(run(f.bridge, options([user('Start')])));

    await f.bridge.close();
  }
});

test('compaction is always requested without configuration', async () => {
  const f = fixture([[complete([reply('Plain')])], [complete([reply('Again')])]]);

  await run(f.bridge, options([user('Start')]));
  await run(f.bridge, options([user('Start')]));

  assert.equal(f.payloads[1].context_management[0].type, 'compaction');

  await f.bridge.close();
});

test('a plain response publishes no checkpoint', async () => {
  const f = fixture([[complete([reply('Plain')])]]);

  const first = await run(f.bridge, options([user('Start')]));

  assert.equal(first.message.source.replayState, undefined);

  await f.bridge.close();
});

test('only a proven last window is retained when several compactions arrive', async () => {
  const plan = validateInput(options([user('Start')]));
  const scope = compactionScope({ account: 'one' }, 'model-a', plan);
  const capture = new CompactionCapture();
  const blocks = [{ type: 'text', text: 'Old' }, { type: 'text', text: 'Final' }];

  const replayState = capture.finish([compact, reply('Old'), { ...compact, id: 'cp-2' }, reply('Final')], scope, plan, blocks);

  assert.equal(replayState.response[CHECKPOINT_KEY].items.length, 2);
});

test('a window is reused only within its model scope', async () => {
  const plan = validateInput(options([user('Start')]));
  const scope = compactionScope({ account: 'one' }, 'model-a', plan);
  const capture = new CompactionCapture();
  const blocks = [{ type: 'text', text: 'Old' }, { type: 'text', text: 'Final' }];
  const replayState = capture.finish([compact, reply('Old'), { ...compact, id: 'cp-2' }, reply('Final')], scope, plan, blocks);
  const messages = [user('Start'), { role: 'assistant', content: blocks, source: { replayState } }, user('Next')];
  const next = validateInput(options(messages));

  assert.ok(selectCheckpoint(messages, next, scope));
  assert.equal(selectCheckpoint(messages, next, compactionScope({ account: 'one' }, 'model-b', plan)), undefined);
});

test('a compaction with no output position is not finished', async () => {
  const plan = validateInput(options([user('Start')]));
  const scope = compactionScope({ account: 'one' }, 'model-a', plan);
  const blocks = [{ type: 'text', text: 'Old' }, { type: 'text', text: 'Final' }];
  const incomplete = new CompactionCapture();

  incomplete.observe({ output_index: 1, item: compact });

  assert.equal(incomplete.finish(null, scope, plan, blocks), undefined);
});

test('an explicit unsupported compaction parameter retries once', async () => {
  const rejected = () => Response.json({ error: { code: 'unsupported_parameter', param: 'context_management', message: 'must-not-leak' } }, { status: 400 });
  const f = fixture([[complete([compact, reply('First')])], rejected(), [complete([reply('Fallback')])]]);

  const first = await run(f.bridge, options([user('Start')]));
  await run(f.bridge, options([user('Start'), first.message, user('Next')]));

  assert.equal(f.payloads.length, 3);
  assert.equal(f.payloads[2].context_management, undefined);

  await f.bridge.close();
});

test('the retry sends the full bounded history, not the window', async () => {
  const rejected = () => Response.json({ error: { code: 'unsupported_parameter', param: 'context_management' } }, { status: 400 });
  const f = fixture([[complete([compact, reply('First')])], rejected(), [complete([reply('Fallback')])]]);

  const first = await run(f.bridge, options([user('Start')]));
  await run(f.bridge, options([user('Start'), first.message, user('Next')]));

  assert.equal(f.payloads[2].input[0].content[0].text, 'Start');
  assert.equal(f.payloads[2].input.length, 3);

  await f.bridge.close();
});

test('an unsupported parameter rejection never carries upstream text', async () => {
  for (const response of [
    Response.json({ error: { code: 'unsupported_parameter', param: 'context_management', message: 'must-not-leak' } }, { status: 400 }),
    Response.json({ error: { code: 'unknown', param: 'other' } }, { status: 400 }),
    Response.json({ error: { code: 'unsupported_parameter', param: 'context_management' } }, { status: 429 }),
  ]) {
    const f = fixture([response, Response.json({ error: { code: 'unsupported_parameter', param: 'context_management' } }, { status: 400 })]);

    await assert.rejects(run(f.bridge, options([user('Start')])), (error) => !error.message.includes('must-not-leak'));

    await f.bridge.close();
  }
});

test('the rejected parameter is not resent on the retry', async () => {
  const f = fixture([[complete([compact, reply('First')])],
    Response.json({ error: { code: 'unsupported_parameter', param: 'context_management' } }, { status: 400 }),
    [complete([reply('Second')])]]);

  const start = user('x'.repeat(TEXT_BOUND - 10));
  const first = await run(f.bridge, options([start]));
  await run(f.bridge, options([start, first.message, user('x'.repeat(100))]));

  assert.equal(f.payloads[2].context_management, undefined);

  await f.bridge.close();
});

test('the retry trims the oversized oldest item', async () => {
  const f = fixture([[complete([compact, reply('First')])],
    Response.json({ error: { code: 'unsupported_parameter', param: 'context_management' } }, { status: 400 }),
    [complete([reply('Second')])]]);

  const start = user('x'.repeat(TEXT_BOUND - 10));
  const first = await run(f.bridge, options([start]));
  const second = await run(f.bridge, options([start, first.message, user('x'.repeat(100))]));

  assert.ok(f.warnings.some((message) => message.includes('full history was trimmed from the oldest end')));
  assert.equal(f.payloads[2].input[0].content[0].text, 'First');
  assert.equal(second.message.content[0].text, 'Second');

  await f.bridge.close();
});

test('a structured SSE context-limit error becomes the context-limit code without upstream text', async () => {
  const f = fixture([[{ type: 'error', error: { code: 'context_length_exceeded', param: 'input', type: 'invalid_request_error', message: 'must-not-leak' } }]]);

  await assert.rejects(run(f.bridge, options([user('Start')])),
    (error) => error.code === 'CONTEXT_LIMIT' && !error.message.includes('must-not-leak'));

  await f.bridge.close();
});

test('an unrecognized terminal code stays the generic upstream failure', async () => {
  const f = fixture([[{ type: 'error', error: { code: 'server_error', param: 'input', message: 'must-not-leak' } }]]);

  await assert.rejects(run(f.bridge, options([user('Start')])),
    (error) => error.code === 'UPSTREAM_FAILED' && !error.message.includes('must-not-leak'));

  await f.bridge.close();
});

test('a structured SSE parameter rejection retries once without the parameter', async () => {
  const rejected = { type: 'error', error: { code: 'unsupported_parameter', param: 'context_management', message: 'must-not-leak' } };
  const f = fixture([[rejected], [complete([reply('Fallback')])]]);

  await run(f.bridge, options([user('Start')]));

  assert.equal(f.payloads.length, 2);
  assert.ok(f.payloads[0].context_management !== undefined);
  assert.equal(f.payloads[1].context_management, undefined);

  await f.bridge.close();
});

test('a rejection after text was delivered is not retried', async () => {
  const rejected = { type: 'error', error: { code: 'unsupported_parameter', param: 'context_management', message: 'must-not-leak' } };
  const f = fixture([[{ type: 'response.output_text.delta', item_id: 'msg-1', content_index: 0, delta: 'Half' }, rejected],
    [complete([reply('Second')])]]);

  await assert.rejects(run(f.bridge, options([user('Start')])), (error) => error.code === 'UPSTREAM_FAILED');

  assert.equal(f.payloads.length, 1);

  await f.bridge.close();
});

test('only the first attempt retries; a second rejection fails closed', async () => {
  const rejected = { type: 'error', error: { code: 'unsupported_parameter', param: 'context_management', message: 'must-not-leak' } };
  const f = fixture([[rejected], [rejected]]);

  await assert.rejects(run(f.bridge, options([user('Start')])), (error) => error.code === 'UPSTREAM_FAILED');

  assert.equal(f.payloads.length, 2);

  await f.bridge.close();
});

test('cancellation after a completed compaction item never commits replay state', async () => {
  const abort = new AbortController();
  const f = fixture([[{ type: 'response.output_item.done', output_index: 0, item: compact },
    { type: 'response.output_text.delta', item_id: 'msg-1', content_index: 0, delta: 'Partial' }, complete([compact, reply('Partial')])]]);
  const chunks = [];

  await assert.rejects(async () => {
    for await (const chunk of f.bridge.stream({ ...options([user('Start')]), signal: abort.signal })) {
      chunks.push(chunk);
      if (chunk.type === 'text-delta') abort.abort();
    }
  }, { code: 'ABORTED' });

  assert.ok(chunks.every((chunk) => !chunk.replayState));

  await f.bridge.close();
});

test('unrepresented streamed text is never lost behind a checkpoint', async () => {
  const f = fixture([[{ type: 'response.output_item.done', output_index: 0, item: compact },
    { type: 'response.output_text.delta', item_id: 'msg-1', content_index: 0, delta: 'Tail' }, complete(null)]]);

  const result = await run(f.bridge, options([user('Start')]));

  assert.equal(result.message.content[0].text, 'Tail');

  await f.bridge.close();
});

test('unrepresented streamed text publishes no checkpoint', async () => {
  const f = fixture([[{ type: 'response.output_item.done', output_index: 0, item: compact },
    { type: 'response.output_text.delta', item_id: 'msg-1', content_index: 0, delta: 'Tail' }, complete(null)]]);

  const result = await run(f.bridge, options([user('Start')]));

  assert.equal(result.message.source.replayState, undefined);

  await f.bridge.close();
});

test('a covered attachment is counted once in the repeated plan', async () => {
  const image = { type: 'image', attachment: { attachmentId: `sha256:${'ab'.repeat(32)}`, mediaType: 'image/png', bytes: 1024, width: 32, height: 32 } };
  const start = { role: 'user', content: [image, { type: 'text', text: 'Describe' }] };
  const plan = validateInput(options([start]));
  const content = [{ type: 'text', text: 'Description' }];
  const scope = compactionScope({ 'ChatGPT-Account-ID': 'synthetic-account' }, 'synthetic', plan);
  const replayState = new CompactionCapture().finish([compact, reply('Description')], scope, plan, content);
  const repeated = [start, { role: 'assistant', content, source: { replayState } }, start];
  const repeatedPlan = validateInput(options(repeated));

  assert.equal(compactPlan(repeatedPlan, selectCheckpoint(repeated, repeatedPlan, scope)).imageBlocks.length, 1);
});

test('a covered attachment is not sent again on the next turn', async () => {
  const image = { type: 'image', attachment: { attachmentId: `sha256:${'ab'.repeat(32)}`, mediaType: 'image/png', bytes: 1024, width: 32, height: 32 } };
  const start = { role: 'user', content: [image, { type: 'text', text: 'Describe' }] };
  const plan = validateInput(options([start]));
  const content = [{ type: 'text', text: 'Description' }];
  const scope = compactionScope({ 'ChatGPT-Account-ID': 'synthetic-account' }, 'synthetic', plan);
  const replayState = new CompactionCapture().finish([compact, reply('Description')], scope, plan, content);
  const f = fixture([[complete([reply('Continued')])]]);

  await run(f.bridge, options([start, { role: 'assistant', content, source: { replayState } }, user('Next')]));

  assert.equal(f.payloads[0].input[0].type, 'compaction');
  assert.ok(!JSON.stringify(f.payloads[0]).includes('input_image'));

  await f.bridge.close();
});

test('undisclosed model capacity omits compaction', async () => {
  for (const modelWindow of [null, 1024]) {
    const f = fixture([[complete([reply('Plain')])]], { modelWindow });

    await run(f.bridge, options([user('Start')]));

    assert.equal(f.payloads[0].context_management, undefined);

    await f.bridge.close();
  }
});

test('a disclosed window uses the shipped ratio', async () => {
  for (const [modelWindow, expected] of [[4096, 3891], [272000, 258400]]) {
    const f = fixture([[complete([reply('Plain')])]], { modelWindow });

    await run(f.bridge, options([user('Start')]));

    assert.equal(f.payloads[0].context_management?.[0].compact_threshold, expected);

    await f.bridge.close();
  }
});

test('a disclosed per-model percent drives the threshold', async () => {
  assert.equal(threshold(272000, 80), 217600);

  const f = fixture([[complete([reply('Plain')])]], { modelPercent: 80 });

  await run(f.bridge, options([user('Start')]));

  assert.equal(f.payloads[0].context_management?.[0].compact_threshold, 217600);

  await f.bridge.close();
});

test('an unusable percent falls back to the shipped ratio', async () => {
  for (const percent of [null, undefined, 0, 101, 95.5, -1]) assert.equal(threshold(272000, percent), 258400);
});

test('the derived bound follows the disclosed percent', async () => {
  assert.equal(requestLimits(500000, false, 80).inputBytes, 400000 * 8);
  assert.equal(requestLimits(500000, false, 80).checkpointBytes, 400000 * 8);
});

test('the request carries the stateless shape the subscription endpoint accepts', async () => {
  const f = fixture([[complete([reply('Plain')])]]);

  await run(f.bridge, options([user('Start')]));

  assert.equal(f.payloads[0].store, false);
  assert.equal(f.payloads[0].previous_response_id, undefined);

  await f.bridge.close();
});

test('the full history is trimmed from the oldest end', async () => {
  const call = { role: 'assistant', content: [{ type: 'tool-call', id: 'call-1', name: 'read', arguments: 'x'.repeat(TOOL_BYTES_LIMIT + 1) }] };
  const result = { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'y'.repeat(100) }] };
  const plan = validateInput(options([call, result, user('z'.repeat(100))]), true, requestLimits(WINDOW, true));

  const fitted = trimOldest(plan, requestLimits(WINDOW));

  assert.equal(fitted.trimmed, 2);
  assert.deepEqual(fitted.input.map((value) => value.type), ['message']);
  assert.equal(fitted.input[0].content[0].text, 'z'.repeat(100));
});

test('a tool call and its result are dropped as one unit', async () => {
  const call = { role: 'assistant', content: [{ type: 'tool-call', id: 'call-1', name: 'read', arguments: 'x'.repeat(TOOL_BYTES_LIMIT + 1) }] };
  const result = { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'y'.repeat(100) }] };
  const plan = validateInput(options([call, result, user('z'.repeat(100))]), true, requestLimits(WINDOW, true));

  const fitted = trimOldest(plan, requestLimits(WINDOW));

  assert.equal(fitted.input.some((value) => value.type === 'function_call_output'), false);
});

test('an image occurrence is never dropped', async () => {
  const limits = requestLimits(WINDOW);
  const retained = requestLimits(WINDOW, true);
  const image = { type: 'image', attachment: { attachmentId: `sha256:${'ab'.repeat(32)}`, mediaType: 'image/png', bytes: 1024, width: 32, height: 32 } };
  const oversized = 'x'.repeat(retained.textBytes - 10);
  const plan = validateInput(options([{ role: 'user', content: [image, { type: 'text', text: 'Describe' }] }, user(oversized)]), true, retained);

  assert.throws(() => trimOldest(plan, limits), { code: 'INPUT_UNSUPPORTED' });
});

test('nothing left to drop is still refused', async () => {
  const limits = requestLimits(WINDOW);
  const retained = requestLimits(WINDOW, true);
  const oversized = 'x'.repeat(retained.textBytes - 10);
  const last = validateInput(options([user(oversized)]), true, retained);

  assert.throws(() => trimOldest(last, limits), { code: 'INPUT_UNSUPPORTED' });
});

test('the request byte bound is derived from the same window as the threshold', async () => {
  const derived = requestLimits(500000);

  assert.equal(threshold(500000), 475000);
  assert.equal(derived.inputBytes, 475000 * 8);
  assert.equal(derived.textBytes, 475000 * 8);
  assert.equal(derived.toolBytes, 475000 * 8);
});

test('a window too small to derive a bound keeps the fixed floor', async () => {
  const floor = requestLimits(undefined);

  assert.equal(floor.inputBytes, 256 * 1024 + 2 * 1024 * 1024);
  assert.equal(requestLimits(4096).inputBytes, floor.inputBytes);
  assert.equal(requestLimits(4096).textBytes, TEXT_LIMIT);
  assert.equal(requestLimits(4096).toolBytes, TOOL_BYTES_LIMIT);
});

test('retained transcript limits are enforced', async () => {
  assert.throws(() => validateInput(options([user('x'.repeat(4 * 1024 * 1024 + 1))]), true), { code: 'INPUT_UNSUPPORTED' });
  assert.throws(() => validateInput(options(Array.from({ length: 4097 }, () => user('x'))), true), { code: 'INPUT_UNSUPPORTED' });
});

test('parallel conversations keep their own windows', async () => {
  const f = fixture([[complete([compact, reply('One')])], [complete([{ ...compact, encrypted_content: 'other-opaque' }, reply('Two')])],
    [complete([reply('Continue one')])], [complete([reply('Continue two')])]]);

  const [one, two] = await Promise.all([run(f.bridge, options([user('One')])), run(f.bridge, options([user('Two')]))]);
  await run(f.bridge, options([user('One'), one.message, user('Next')]));
  await run(f.bridge, options([user('Two'), two.message, user('Next')]));

  assert.notEqual(one.message.source.replayState.response[CHECKPOINT_KEY].prefix, two.message.source.replayState.response[CHECKPOINT_KEY].prefix);
  assert.notEqual(f.payloads[2].input[0].encrypted_content, f.payloads[3].input[0].encrypted_content);

  await f.bridge.close();
});

test('the public adapter carries checkpoints through the pinned Harness runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-compaction-public-'));
  const store = new AuthStore(authDirectory({ HOME: root }));
  const originalOpen = Http.prototype.open;
  const ctx = new Context();
  let service, fiber;
  const payloads = [];

  await store.transaction(() => store.write({ access_token: token('synthetic-account'), refresh_token: 'synthetic-refresh' }));
  Http.prototype.open = async (url, request) => {
    if (url.includes('/models?')) {
      return Response.json({ models: [{ slug: 'synthetic', display_name: 'Synthetic', visibility: 'list', context_window: 272000,
        supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }], default_reasoning_level: 'medium' }] });
    }
    payloads.push(JSON.parse(request.body));
    return sse([complete(payloads.length === 1 ? [compact, reply('First')] : [reply('Next')])]);
  };
  ctx.provide('launchEnvironment', { getFrom: (key) => ['HOME', 'DSH_HOME'].includes(key) ? { value: root } : undefined });
  service = ctx.plugin(LlmRuntime);
  fiber = ctx.plugin(plugin);
  await new Promise((resolve) => setImmediate(resolve));

  const first = await run(ctx.llm, options([user('Start')]));
  await run(ctx.llm, options([user('Start'), first.message, user('Next')]));

  assert.equal(payloads[1].input[0].type, 'compaction');

  await fiber?.dispose();
  await service?.dispose();
  Http.prototype.open = originalOpen;
  await rm(root, { recursive: true, force: true });
});

/** A mounted public adapter over a synthetic store and the declared level list. */
async function levelsAdapter(root) {
  const store = new AuthStore(authDirectory({ HOME: root }));
  const ctx = new Context();
  await store.transaction(() => store.write({ access_token: token('synthetic-account'), refresh_token: 'synthetic-refresh' }));
  Http.prototype.open = async () => Response.json({ models: [{ slug: 'synthetic', display_name: 'Synthetic', visibility: 'list', context_window: 272000,
    supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }], default_reasoning_level: 'medium' }] });
  ctx.provide('launchEnvironment', { getFrom: (key) => ['HOME', 'DSH_HOME'].includes(key) ? { value: root } : undefined });
  const service = ctx.plugin(LlmRuntime);
  const fiber = ctx.plugin(plugin);
  await new Promise((resolve) => setImmediate(resolve));
  return { ctx, service, fiber };
}

test('the declared levels make the host effort selector available', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-compaction-public-'));
  const originalOpen = Http.prototype.open;
  const { ctx, service, fiber } = await levelsAdapter(root);

  const info = await ctx.llm.resolveModelInfo('codex-subscription', 'synthetic');

  assert.deepEqual(info.reasoning.efforts.map((effort) => effort.id), ['low', 'medium', 'high']);

  await fiber.dispose();
  await service.dispose();
  Http.prototype.open = originalOpen;
  await rm(root, { recursive: true, force: true });
});

test('the default effort comes from the backend', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-compaction-public-'));
  const originalOpen = Http.prototype.open;
  const { ctx, service, fiber } = await levelsAdapter(root);

  const info = await ctx.llm.resolveModelInfo('codex-subscription', 'synthetic');

  assert.equal(info.reasoning.defaultEffort, 'medium');

  await fiber.dispose();
  await service.dispose();
  Http.prototype.open = originalOpen;
  await rm(root, { recursive: true, force: true });
});

test('compaction is always requested, so the adapter accepts no configuration keys', async () => {
  for (const config of [{ cloudCompaction: true }, { cloudCompaction: false }, { endpoint: 'https://example.invalid' }]) {
    assert.throws(() => plugin.apply({}, config), { code: 'CONFIG_INVALID' });
  }
});

test('checkpoint identity survives a refresh', async () => {
  const jwt = (sub, user, exp) => `x.${Buffer.from(JSON.stringify({ sub, exp, 'https://api.openai.com/auth': {
    chatgpt_account_id: 'shared-account', chatgpt_user_id: user } })).toString('base64url')}.x`;

  const first = compactionAccount(jwt('subject-one', 'user-one', 4000000000));

  assert.deepEqual(first, compactionAccount(jwt('subject-one', 'user-one', 4000001000)));
});

test('checkpoint identity separates users within the same account', async () => {
  const jwt = (sub, user, exp) => `x.${Buffer.from(JSON.stringify({ sub, exp, 'https://api.openai.com/auth': {
    chatgpt_account_id: 'shared-account', chatgpt_user_id: user } })).toString('base64url')}.x`;

  const first = compactionAccount(jwt('subject-one', 'user-one', 4000000000));

  assert.notDeepEqual(first, compactionAccount(jwt('subject-two', 'user-two', 4000000000)));
});

test('a claim without a subject is refused', async () => {
  const jwt = (sub, user, exp) => `x.${Buffer.from(JSON.stringify({ sub, exp, 'https://api.openai.com/auth': {
    chatgpt_account_id: 'shared-account', chatgpt_user_id: user } })).toString('base64url')}.x`;

  assert.throws(() => compactionAccount(jwt({}, 'user', 4000000000)), { code: 'AUTH_REQUIRED' });
});

test('an oversized compaction frame streams past the default SSE bound', async () => {
  const oversized = 'x'.repeat(1.5 * 1024 * 1024);
  const bigCompact = { ...compact, encrypted_content: oversized };
  const f = fixture([[textDelta, textDone,
    { type: 'response.output_item.done', item: bigCompact, output_index: 0 },
    { type: 'response.output_item.done', item: reply('Hello'), output_index: 1 }, complete([bigCompact, reply('Hello')])]],
    { modelWindow: 872000 });

  const { chunks } = await run(f.bridge, options([user('Start')]));

  assert.equal(chunks.at(-1).reason.kind, 'stop');

  await f.bridge.close();
});

test('the framing limits rise with the window so an oversized item still publishes its checkpoint', async () => {
  const oversized = 'x'.repeat(1.5 * 1024 * 1024);
  const bigCompact = { ...compact, encrypted_content: oversized };
  const f = fixture([[textDelta, textDone,
    { type: 'response.output_item.done', item: bigCompact, output_index: 0 },
    { type: 'response.output_item.done', item: reply('Hello'), output_index: 1 }, complete([bigCompact, reply('Hello')])]],
    { modelWindow: 872000 });

  await run(f.bridge, options([user('Start')]));

  assert.deepEqual(f.payloads[0].context_management, [{ type: 'compaction', compact_threshold: 828400 }]);
  assert.deepEqual(f.warnings, []);

  await f.bridge.close();
});

test('the published window keeps the oversized item it captured', async () => {
  const oversized = 'x'.repeat(1.5 * 1024 * 1024);
  const bigCompact = { ...compact, encrypted_content: oversized };
  const f = fixture([[textDelta, textDone,
    { type: 'response.output_item.done', item: bigCompact, output_index: 0 },
    { type: 'response.output_item.done', item: reply('Hello'), output_index: 1 }, complete([bigCompact, reply('Hello')])]],
    { modelWindow: 872000 });

  const { chunks } = await run(f.bridge, options([user('Start')]));

  assert.equal(chunks.at(-1).replayState.response[CHECKPOINT_KEY].items[0].encrypted_content, oversized);

  await f.bridge.close();
});

test('a compaction item above the capture bound is refused gently', async () => {
  const oversized = 'x'.repeat(2.5 * 1024 * 1024);
  const bigCompact = { ...compact, encrypted_content: oversized };
  const f = fixture([[textDelta, textDone,
    { type: 'response.output_item.done', item: bigCompact, output_index: 0 },
    { type: 'response.output_item.done', item: reply('Hello'), output_index: 1 }, complete([bigCompact, reply('Hello')])]]);

  const { chunks } = await run(f.bridge, options([user('Start')]));

  assert.equal(chunks.at(-1).replayState, undefined);
  assert.ok(f.warnings.some((message) => message.startsWith('The subscription compaction checkpoint was not published (')));

  await f.bridge.close();
});

test('a gently refused checkpoint still delivers the turn', async () => {
  const oversized = 'x'.repeat(2.5 * 1024 * 1024);
  const bigCompact = { ...compact, encrypted_content: oversized };
  const f = fixture([[textDelta, textDone,
    { type: 'response.output_item.done', item: bigCompact, output_index: 0 },
    { type: 'response.output_item.done', item: reply('Hello'), output_index: 1 }, complete([bigCompact, reply('Hello')])]]);

  const { chunks } = await run(f.bridge, options([user('Start')]));

  assert.equal(chunks.at(-1).reason.kind, 'stop');
  assert.equal(chunks.find((chunk) => chunk.type === 'block-end').block.text, 'Hello');

  await f.bridge.close();
});