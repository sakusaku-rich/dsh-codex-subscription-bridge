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
      ...(settings.modelWindow === null ? {} : { context_window: settings.modelWindow ?? WINDOW }),
      ...(settings.modelPercent == null ? {} : { effective_context_window_percent: settings.modelPercent }) }] });
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

test('a covered window past the wire bound is trimmed from the oldest end instead of failing the turn', async () => {
  const big = 'a'.repeat(250000);
  const f = fixture([[complete([compact, reply(big)])], [complete([reply('Trimmed')])], [complete([reply('Fitted')])]]);
  try {
    const start = user('x'.repeat(TEXT_BOUND - 10));
    const first = await run(f.bridge, options([start]));
    // The window plus the tail exceeds the bound, but the tail alone fits: the
    // oldest covered item is dropped and the turn still runs.
    const tail = user('y'.repeat(TEXT_BOUND - Buffer.byteLength(big) + 1));
    await run(f.bridge, options([start, first.message, tail]));
    assert.ok(f.warnings.some(message => message.includes('trimmed from the oldest end')));
    assert.equal(f.payloads[1].input[0].type, 'compaction');
    assert.ok(f.payloads[1].input.some(value => value.content?.[0]?.text === tail.content[0].text), 'the uncovered tail is kept');
    // A refused checkpoint has no window to trim, so the full transcript is
    // revalidated on its own. Following the official client the oldest item is
    // dropped to fit the bound rather than failing the turn.
    f.account('other');
    const refused = await run(f.bridge, options([start, first.message, user('y'.repeat(100))]));
    assert.ok(f.warnings.some(message => message.includes('was refused (SCOPE)')));
    assert.ok(f.warnings.some(message => message.includes('full history was trimmed from the oldest end')));
    assert.equal(f.payloads[2].input[0].content[0].text, first.message.content[0].text, 'the oldest item is dropped and the rest is sent');
    assert.equal(refused.message.content[0].text, 'Fitted');
  } finally { await f.bridge.close(); }
});

const windowBytesOf = values => 2 + values.reduce((total, value) => total + Buffer.byteLength(JSON.stringify(value)) + 1, 0);

test('the bound is a resource limit, not a window guard: a request past the window in the upstream measure is sent whole', async () => {
  // Measured on a real account, the upstream compacts a request whose measured count
  // is past the model window. A transcript that is past the window in the bridge's
  // byte estimate but inside the resource bound is sent as it is.
  const measuredBytesPerToken = 5.14;
  const pastWindow = 'a'.repeat(Math.floor(WINDOW * measuredBytesPerToken * 1.2));
  const f = fixture([[complete([reply('Answered')])]]);
  try {
    await run(f.bridge, options([user(pastWindow)]));
    assert.equal(f.warnings.length, 0, 'nothing is trimmed while the request fits the resource bound');
    assert.equal(f.payloads[0].input[0].content[0].text, pastWindow, 'the whole transcript is sent');
    assert.ok(Buffer.byteLength(pastWindow) / measuredBytesPerToken > WINDOW, 'the upstream measures this past the window');
    assert.ok(Buffer.byteLength(pastWindow) <= requestLimits(WINDOW).inputBytes, 'and it stays inside the resource bound');
  } finally { await f.bridge.close(); }
});

test('a window past its bound drops the oldest covered items instead of refusing', async () => {
  // The bound is derived from the disclosed window, so a window the upstream can
  // produce cannot exceed it; the drop is the residual path, matching the official
  // client removing the oldest history item when the window is exceeded.
  const limit = requestLimits(WINDOW).checkpointBytes;
  const big = { type: 'compaction', id: 'cp-1', encrypted_content: 'y'.repeat(1000000) };
  const many = Array.from({ length: 60 }, (_, index) => reply(`${index} ${'z'.repeat(20000)}`));
  const plan = { input: [], tools: [] };
  const capture = new CompactionCapture(limit);
  const replayState = capture.finish([big, ...many], compactionScope('synthetic-account', 'synthetic', plan), plan,
    many.map(value => ({ type: 'text', text: value.content[0].text })));
  assert.ok(replayState);
  assert.equal(capture.refusal, undefined);
  assert.ok(capture.trimmed > 0);
  const items = replayState.response[CHECKPOINT_KEY].items;
  assert.equal(items[0].type, 'compaction');
  assert.ok(windowBytesOf(items) <= limit);
  assert.ok(items.length < many.length + 1);
  // The persisted digest is computed over the trimmed window, so reuse stays
  // provable: the stored window is exactly what was published.
  const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
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
  assert.ok(result.input.includes(tail), 'the uncovered tail is never dropped');
  assert.equal(result.input[0].type, 'compaction');
  const textBytes = result.input.reduce((total, value) => total + (value.type === 'message'
    ? value.content.reduce((part, block) => part + Buffer.byteLength(block.text), 0) : 0), 0);
  assert.ok(textBytes <= limits.textBytes);
  // Nothing is left to drop once only the compaction item remains, so a tail that
  // exceeds the bound on its own is still refused.
  const oversizedTail = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'b'.repeat(limits.textBytes + 1) }] };
  assert.throws(() => compactPlan({ ...plan, input: [compact, oversizedTail] }, { end: 1, imageEnd: 0, items: [compact] }, limits),
    { code: 'INPUT_UNSUPPORTED' });
});

test('a persisted window past the derived bound is refused whole, not trimmed', () => {
  // Trimming a stored window would change the digest it was proved against, so
  // the drop applies only to a window being published. A stored window past the
  // bound is still refused.
  const limit = requestLimits(WINDOW).checkpointBytes;
  const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const contentDigest = blocks => createHash('sha256').update(JSON.stringify(blocks.filter(block => block.type === 'text' || block.type === 'tool-call')
    .map(block => block.type === 'text' ? { type: 'text', text: block.text } : { type: 'tool-call', id: block.id, name: block.name, arguments: block.arguments }))).digest('hex');
  const big = { type: 'compaction', id: 'cp-1', encrypted_content: 'y'.repeat(1000000) };
  const parts = Array.from({ length: 60 }, (_, index) => ({ type: 'output_text', text: `m${index} ${'z'.repeat(20000)}` }));
  const items = [big, ...parts.map(part => ({ type: 'message', role: 'assistant', content: [part] }))];
  assert.ok(windowBytesOf(items) > limit);
  const blocks = parts.map(part => ({ type: 'text', text: part.text }));
  const messages = [user('Start'), { role: 'assistant', content: blocks, source: {} }, user('Next')];
  const plan = validateInput(options(messages), true);
  const scope = compactionScope({ account: 'one' }, 'model-a', plan);
  messages[1].source.replayState = { response: { [CHECKPOINT_KEY]: { version: 1, createdAt: Date.now(), scope,
    prefix: digest(plan.input.slice(0, plan.spans[1].start)), content: contentDigest(blocks), items, digest: digest(items) } } };
  assert.equal(inspectCheckpoint(messages, plan, scope, Date.now(), limit).refusal, 'WINDOW_BYTES');
  assert.equal(selectCheckpoint(messages, plan, scope, Date.now(), limit), undefined);
  // With no disclosed window the fixed floor still applies, and the derived bound
  // is above the SSE frame limit, so a single item cannot exceed it on a turn.
  assert.equal(requestLimits(null).checkpointBytes, CHECKPOINT_BYTES);
});

test('malformed or contradictory checkpoint state withholds the window but keeps the answer', async () => {
  for (const events of [
    [complete([{ ...compact, encrypted_content: '' }, reply('No')])],
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
  // Observed on the live endpoint: the compaction item and the message arrive as
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

test('a rejected parameter is dropped and the retry sends the trimmed full history', async () => {
  const f = fixture([[complete([compact, reply('First')])],
    Response.json({ error: { code: 'unsupported_parameter', param: 'context_management' } }, { status: 400 }),
    [complete([reply('Second')])]]);
  try {
    const start = user('x'.repeat(TEXT_BOUND - 10));
    const first = await run(f.bridge, options([start]));
    const second = await run(f.bridge, options([start, first.message, user('x'.repeat(100))]));
    assert.equal(f.payloads.length, 3);
    assert.ok(f.warnings.some(message => message.includes('full history was trimmed from the oldest end')));
    // The rejected parameter is not resent, and the oversized oldest item is gone.
    assert.equal(f.payloads[2].context_management, undefined);
    assert.equal(f.payloads[2].input[0].content[0].text, 'First');
    assert.equal(second.message.content[0].text, 'Second');
  } finally { await f.bridge.close(); }
});

// Measured on a real account, the subscription backend reports a structured
// rejection in the SSE error event, not in the HTTP error body.
test('a structured SSE context-limit error becomes the context-limit code without upstream text', async () => {
  const f = fixture([[{ type: 'error', error: { code: 'context_length_exceeded', param: 'input', type: 'invalid_request_error', message: 'must-not-leak' } }]]);
  try {
    await assert.rejects(run(f.bridge, options([user('Start')])),
      error => error.code === 'CONTEXT_LIMIT' && !error.message.includes('must-not-leak'));
  } finally { await f.bridge.close(); }
  // An unrecognized terminal code stays the generic upstream failure.
  const other = fixture([[{ type: 'error', error: { code: 'server_error', param: 'input', message: 'must-not-leak' } }]]);
  try {
    await assert.rejects(run(other.bridge, options([user('Start')])),
      error => error.code === 'UPSTREAM_FAILED' && !error.message.includes('must-not-leak'));
  } finally { await other.bridge.close(); }
});

test('a structured SSE parameter rejection retries once without the parameter', async () => {
  const rejected = { type: 'error', error: { code: 'unsupported_parameter', param: 'context_management', message: 'must-not-leak' } };
  const f = fixture([[rejected], [complete([reply('Fallback')])]]);
  try {
    await run(f.bridge, options([user('Start')]));
    assert.equal(f.payloads.length, 2);
    assert.ok(f.payloads[0].context_management !== undefined);
    assert.equal(f.payloads[1].context_management, undefined);
  } finally { await f.bridge.close(); }
  // A rejection after text was delivered is not retried.
  const partial = fixture([[{ type: 'response.output_text.delta', item_id: 'msg-1', content_index: 0, delta: 'Half' }, rejected],
    [complete([reply('Second')])]]);
  try {
    await assert.rejects(run(partial.bridge, options([user('Start')])), error => error.code === 'UPSTREAM_FAILED');
    assert.equal(partial.payloads.length, 1);
  } finally { await partial.bridge.close(); }
  // Only the first attempt retries; a second rejection fails closed.
  const twice = fixture([[rejected], [rejected]]);
  try {
    await assert.rejects(run(twice.bridge, options([user('Start')])), error => error.code === 'UPSTREAM_FAILED');
    assert.equal(twice.payloads.length, 2);
  } finally { await twice.bridge.close(); }
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

test('a disclosed per-model percent drives the threshold and the bound, absence falls back to the shipped ratio', async () => {
  assert.equal(threshold(272000, 80), 217600);
  for (const percent of [null, undefined, 0, 101, 95.5, -1]) assert.equal(threshold(272000, percent), 258400);
  assert.equal(requestLimits(500000, false, 80).inputBytes, 400000 * 8);
  assert.equal(requestLimits(500000, false, 80).checkpointBytes, 400000 * 8);
  for (const [modelPercent, expected] of [[80, 217600], [null, 258400]]) {
    const f = fixture([[complete([reply('Plain')])]], { modelPercent });
    try {
      await run(f.bridge, options([user('Start')]));
      assert.equal(f.payloads[0].context_management?.[0].compact_threshold, expected);
    } finally { await f.bridge.close(); }
  }
  // A disclosed value that is not a usable percent fails closed rather than being
  // quietly replaced by the shipped ratio. The live catalog does not disclose one
  // for this account's models, so the fallback is what runs in practice.
  const malformed = fixture([[complete([reply('Plain')])]], { modelPercent: 0 });
  try { await assert.rejects(run(malformed.bridge, options([user('Start')])), { code: 'PROTOCOL_INVALID' }); }
  finally { await malformed.bridge.close(); }
});

test('the request carries the stateless shape the subscription endpoint accepts', async () => {
  const f = fixture([[complete([reply('Plain')])]]);
  try {
    await run(f.bridge, options([user('Start')]));
    // Measured on a real account: this endpoint rejects store true and rejects
    // previous_response_id, so the stateless shape is the only one it accepts.
    assert.equal(f.payloads[0].store, false);
    assert.equal(f.payloads[0].previous_response_id, undefined);
    assert.equal(f.payloads[0].context_management[0].compact_threshold, 258400);
  } finally { await f.bridge.close(); }
});

test('the full history is trimmed from the oldest end, keeping a tool pair as one unit', () => {
  const call = { role: 'assistant', content: [{ type: 'tool-call', id: 'call-1', name: 'read', arguments: 'x'.repeat(TOOL_BYTES_LIMIT + 1) }] };
  const result = { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'y'.repeat(100) }] };
  const plan = validateInput(options([call, result, user('z'.repeat(100))]), true, requestLimits(WINDOW, true));
  const fitted = trimOldest(plan, requestLimits(WINDOW));
  assert.equal(fitted.trimmed, 2);
  assert.deepEqual(fitted.input.map(value => value.type), ['message']);
  assert.equal(fitted.input[0].content[0].text, 'z'.repeat(100));
  // Dropping the call alone would leave its result orphaned, so the pair is one unit.
  assert.equal(fitted.input.some(value => value.type === 'function_call_output'), false);
});

test('an image occurrence is never dropped, and nothing left to drop is still refused', () => {
  const limits = requestLimits(WINDOW);
  const retained = requestLimits(WINDOW, true);
  const image = { type: 'image', attachment: { attachmentId: `sha256:${'ab'.repeat(32)}`, mediaType: 'image/png', bytes: 1024, width: 32, height: 32 } };
  const oversized = 'x'.repeat(retained.textBytes - 10);
  const plan = validateInput(options([{ role: 'user', content: [image, { type: 'text', text: 'Describe' }] }, user(oversized)]), true, retained);
  // The oldest item carries the image. The host owns the attachment store, so the
  // bridge offloads its oldest images instead of dropping the item that holds them.
  assert.throws(() => trimOldest(plan, limits), { code: 'INPUT_UNSUPPORTED' });
  // With only one item left there is nothing to drop, so the request is still refused.
  const last = validateInput(options([user(oversized)]), true, retained);
  assert.throws(() => trimOldest(last, limits), { code: 'INPUT_UNSUPPORTED' });
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

const textDelta = { type: 'response.output_text.delta', item_id: 'msg-1', content_index: 0, delta: 'Hello' };
const textDone = { ...textDelta, type: 'response.output_text.done', text: 'Hello' };

test('an oversized compaction frame streams past the default SSE bound and still publishes its checkpoint', async () => {
  // The observed failure: the request bound admits a compaction item at
  // threshold tokens times 8 bytes, so for a 872,000-token window one
  // encrypted_content can carry well over the parser's default 1 MiB frame.
  // The framing limits must rise with the window instead of killing the
  // stream before the gentle capture refusal can apply.
  const oversized = 'x'.repeat(1.5 * 1024 * 1024);
  const bigCompact = { ...compact, encrypted_content: oversized };
  const f = fixture([[textDelta, textDone,
    { type: 'response.output_item.done', item: bigCompact, output_index: 0 },
    { type: 'response.output_item.done', item: reply('Hello'), output_index: 1 }, complete([bigCompact, reply('Hello')])]],
    { modelWindow: 872000 });
  try {
    const { chunks } = await run(f.bridge, options([user('Start')]));
    assert.equal(chunks.at(-1).reason.kind, 'stop');
    assert.deepEqual(f.payloads[0].context_management, [{ type: 'compaction', compact_threshold: 828400 }]);
    assert.equal(chunks.at(-1).replayState.response[CHECKPOINT_KEY].items[0].encrypted_content, oversized);
    assert.deepEqual(f.warnings, []);
  } finally { await f.bridge.close(); }
});

test('a compaction item above the capture bound is refused gently while the turn still delivers', async () => {
  // Between the capture bound (threshold tokens times 8 bytes) and the raised
  // frame limit, an item costs the next turn its replay window, not this turn
  // its answer: the checkpoint is refused, the full history is resent.
  const oversized = 'x'.repeat(2.5 * 1024 * 1024);
  const bigCompact = { ...compact, encrypted_content: oversized };
  const f = fixture([[textDelta, textDone,
    { type: 'response.output_item.done', item: bigCompact, output_index: 0 },
    { type: 'response.output_item.done', item: reply('Hello'), output_index: 1 }, complete([bigCompact, reply('Hello')])]]);
  try {
    const { chunks } = await run(f.bridge, options([user('Start')]));
    assert.equal(chunks.at(-1).reason.kind, 'stop');
    assert.equal(chunks.find(chunk => chunk.type === 'block-end').block.text, 'Hello');
    assert.equal(chunks.at(-1).replayState, undefined);
    assert.ok(f.warnings.some(message => message.startsWith('The subscription compaction checkpoint was not published (')));
  } finally { await f.bridge.close(); }
});
