import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readFile, symlink, chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DirectBridge, events } from '../lib/direct.js';
import { AuthStore, claims } from '../lib/auth.js';
import { BridgeError, failure } from '../lib/errors.js';
import { Http, BASE, ISSUER } from '../lib/http.js';
const jwt = (exp = Math.floor(Date.now() / 1000) + 3600, account = 'synthetic-account') => `x.${Buffer.from(JSON.stringify({ exp, 'https://api.openai.com/auth': { chatgpt_account_id: account } })).toString('base64url')}.x`;
const tokens = (exp) => ({ access_token: jwt(exp), refresh_token: 'synthetic-refresh-secret' });
const model = { slug: 'test-model', display_name: 'Test', visibility: 'list', supported_in_api: false };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const sse = (...values) => new Response(values.map(value => `data: ${JSON.stringify(value)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
const delta = { type: 'response.output_text.delta', item_id: 'message-1', content_index: 0, delta: 'Hello' };
const completed = { type: 'response.completed', response: { status: 'completed', output: [] } };
const input = (extra = {}) => ({ provider: 'codex-subscription', model: 'test-model', messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }], ...extra });
const collect = async (stream) => { const result = []; for await (const chunk of stream) result.push(chunk); return result; };
async function fixture(task) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-direct-test-'));
  try { return await task(root); } finally { await rm(root, { recursive: true, force: true }); }
}
test('dedicated store is private, refuses API keys, and never accepts symlink credentials', () => fixture(async root => {
  const store = new AuthStore(join(root, 'auth')); await store.prepare();
  await assert.rejects(store.transaction(() => store.write({ access_token: 'api-key', refresh_token: 'refresh' })), { code: 'AUTH_REQUIRED' });
  await store.transaction(() => store.write(tokens()));
  const state = JSON.parse(await readFile(join(root, 'auth/auth.json'), 'utf8')); assert.equal(state.mode, 'chatgpt');
  await chmod(join(root, 'auth/auth.json'), 0o644);
  await assert.rejects(store.token(), { code: 'AUTH_STORE_INVALID' });
  await rm(join(root, 'auth/auth.json')); await writeFile(join(root, 'external'), 'secret');
  await symlink(join(root, 'external'), join(root, 'auth/auth.json'));
  await assert.rejects(store.token(), { code: 'AUTH_STORE_INVALID' });
  assert.equal(await readFile(join(root, 'external'), 'utf8'), 'secret');
}));
test('refresh is serialized across independent store instances and writes rotated tokens once', () => fixture(async root => {
  let refreshes = 0; const http = new Http(async (url, options) => {
    assert.equal(url, `${ISSUER}/oauth/token`); assert.equal(options.redirect, 'error');
    assert.equal(options.body.get('grant_type'), 'refresh_token'); refreshes++;
    await new Promise(resolve => setTimeout(resolve, 20)); return json({ ...tokens(), refresh_token: 'rotated-secret' });
  });
  const first = new AuthStore(join(root, 'auth'), http); await first.transaction(() => first.write(tokens(1)));
  const second = new AuthStore(join(root, 'auth'), http);
  const values = await Promise.all([first.token(), second.token()]); assert.equal(refreshes, 1); assert.equal(values[0], values[1]);
  assert.equal((await second.transaction(() => second.read())).refresh_token, 'rotated-secret');
}));
test('terminal refresh failures are quarantined; quota failures retain the refresh grant', () => fixture(async root => {
  for (const [status, error] of [[400, 'invalid_grant'], [429, 'rate_limit']]) {
    let calls = 0; const store = new AuthStore(join(root, `auth-${status}`), new Http(async () => { calls++; return json({ error }, status); }));
    await store.transaction(() => store.write(tokens(1)));
    await assert.rejects(store.token(), { code: status === 400 ? 'AUTH_REQUIRED' : 'RATE_LIMIT' });
    await assert.rejects(store.token(), { code: status === 400 ? 'AUTH_REQUIRED' : 'RATE_LIMIT' });
    assert.equal(calls, status === 400 ? 1 : 2);
  }
}));
test('logout removes only the dedicated login and subsequent lookup refuses', () => fixture(async root => {
  const store = new AuthStore(join(root, 'auth')); await store.transaction(() => store.write(tokens()));
  await store.logout(); await assert.rejects(store.token(), { code: 'AUTH_REQUIRED' });
}));
test('HTTP never accepts custom destinations or forwards redirect credentials', async () => {
  let calls = 0; const http = new Http(async (_, options) => { calls++; assert.equal(options.redirect, 'error'); throw new Error('secret-token'); });
  await assert.rejects(http.json('https://chatgpt.com.evil.test/backend-api/codex/models'), { code: 'CONFIG_INVALID' });
  // Dot segments must not escape the fixed path prefix after normalization.
  await assert.rejects(http.json(`${BASE}/../models`), { code: 'CONFIG_INVALID' });
  await assert.rejects(http.json(`${BASE}/../models?cursor=1`), { code: 'CONFIG_INVALID' });
  await assert.rejects(http.json('https://user:pass@chatgpt.com/backend-api/codex/models'), { code: 'CONFIG_INVALID' });
  assert.equal(calls, 0); await assert.rejects(http.json(`${BASE}/models`), error => error.code === 'UPSTREAM_FAILED' && !error.message.includes('secret-token'));
  assert.equal(calls, 1); await assert.rejects(http.json(`${ISSUER}/oauth/token`), error => error.code === 'UPSTREAM_FAILED' && !error.message.includes('secret-token'));
});
test('bounded HTTP JSON refuses oversized and malformed bodies', async () => {
  await assert.rejects(new Http(async () => json({ data: 'x'.repeat(100) })).json(`${BASE}/models`, {}, undefined, 20), { code: 'LIMIT_EXCEEDED' });
  await assert.rejects(new Http(async () => new Response('{')).json(`${BASE}/models`), { code: 'PROTOCOL_INVALID' });
});
test('catalog caches metadata, rechecks auth, shares concurrent calls and excludes hidden models', async () => {
  let calls = 0, authCalls = 0; const auth = { token: async () => { authCalls++; return jwt(); } };
  const bridge = new DirectBridge(auth, new Http(async () => { calls++; return json({ models: [model, { ...model, slug: 'hidden', visibility: 'hide' }] }); }));
  const models = await Promise.all(Array.from({ length: 12 }, () => bridge.listModels())); assert.equal(calls, 1); assert.equal(models[0].length, 1);
  await bridge.listModels(); assert.equal(calls, 1); assert.equal(authCalls, 2);
  models[0][0].name = 'changed'; assert.equal(models[1][0].name, 'Test');
  auth.token = async () => { throw new BridgeError('AUTH_REQUIRED'); };
  await assert.rejects(bridge.listModels(), { code: 'AUTH_REQUIRED' }); await bridge.close();
});
test('catalog projects the disclosed context window and rejects malformed window values', async () => {
  const bridge = new DirectBridge({ token: async () => jwt() }, new Http(async () => json({ models: [{ ...model, slug: 'windowed', context_window: 272000 }] })));
  assert.deepEqual(await bridge.listModels(), [{ id: 'windowed', name: 'Test', provider: 'codex-subscription', inputModalities: ['text', 'image'], contextWindow: 272000 }]);
  const absent = new DirectBridge({ token: async () => jwt() }, new Http(async () => json({ models: [model] })));
  assert.equal('contextWindow' in (await absent.listModels())[0], false);
  for (const value of [0, -1, 1.5, '272000', 2 ** 53]) {
    const bad = new DirectBridge({ token: async () => jwt() }, new Http(async () => json({ models: [{ ...model, context_window: value }] })));
    await assert.rejects(bad.listModels(), { code: 'PROTOCOL_INVALID' });
  }
});
test('stream forwards tools and reasoning effort, stays unpersisted, and normalizes deltas', async () => {
  const calls = []; const bridge = new DirectBridge({ token: async () => jwt() }, new Http(async (url, options) => {
    calls.push({ url, options }); return url.includes('/models?')
      ? json({ models: [{ ...model, supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }] }] })
      : sse(delta, { ...delta, type: 'response.output_text.done', text: 'Hello!' }, completed);
  }));
  const chunks = await collect(bridge.stream(input({ tools: [{ name: 'shell', description: 'Run shell', parameters: { type: 'object' }, deferLoading: true }], reasoningEffort: 'medium' })));
  assert.equal(chunks.at(-1).reason.kind, 'stop'); assert.equal(chunks.find(chunk => chunk.type === 'block-end').block.text, 'Hello!');
  const body = JSON.parse(calls.at(-1).options.body); assert.equal(body.store, false); assert.equal(body.stream, true);
  assert.deepEqual(body.tools, [{ type: 'function', name: 'shell', description: 'Run shell', strict: false, parameters: { type: 'object' } }]);
  // The disclosed id travels verbatim; the backend, not this bridge, owns the scale.
  assert.deepEqual(body.reasoning, { effort: 'medium' });
  await assert.rejects(collect(bridge.stream(input({ reasoningEffort: 'bogus' }))), { code: 'INPUT_UNSUPPORTED' });
  assert.equal((await bridge.listModels()).find(entry => entry.id === 'test-model').inputModalities.join(','), 'text,image');
  assert.equal(calls.at(-1).options.headers['ChatGPT-Account-ID'], 'synthetic-account');
  await collect(bridge.stream(input({ reasoningEffort: 'low' })));
  assert.deepEqual(JSON.parse(calls.at(-1).options.body).reasoning, { effort: 'low' });
  await bridge.close();
});
test('usage separates cached input while preserving totals and optional fields', async () => {
  for (const [details, cached] of [[undefined, undefined], [{}, undefined], [{ cached_tokens: 0 }, 0], [{ cached_tokens: 3 }, 3], [{ cached_tokens: 12 }, 12]]) {
    const wire = { input_tokens: 12, output_tokens: 4, total_tokens: 16, ...(details === undefined ? {} : { input_tokens_details: details }) };
    const bridge = new DirectBridge({ token: async () => jwt() }, new Http(async url => url.includes('/models?')
      ? json({ models: [model] }) : sse({ ...completed, response: { ...completed.response, usage: wire } })));
    try {
      const chunks = await collect(bridge.stream(input()));
      const usage = chunks.find(chunk => chunk.type === 'usage').usage;
      assert.deepEqual(usage, { inputTokens: 12 - (cached ?? 0), outputTokens: 4, totalTokens: 16, ...(cached === undefined ? {} : { cacheReadTokens: cached }) });
      // Harness sums disjoint prompt buckets for cache rate and context pressure.
      const prompt = usage.inputTokens + (usage.cacheReadTokens ?? 0);
      assert.equal(prompt, wire.input_tokens);
      assert.equal(prompt, usage.totalTokens - usage.outputTokens);
      assert.equal((usage.cacheReadTokens ?? 0) / prompt, (cached ?? 0) / wire.input_tokens);
    } finally { await bridge.close(); }
  }
});
test('usage rejects invalid cached counts before emitting usage', async () => {
  for (const cached of [-1, 1.5, '3', null, 13, Number.MAX_SAFE_INTEGER + 1]) {
    const bridge = new DirectBridge({ token: async () => jwt() }, new Http(async url => url.includes('/models?')
      ? json({ models: [model] }) : sse({ ...completed, response: { ...completed.response, usage: { input_tokens: 12, output_tokens: 4, input_tokens_details: { cached_tokens: cached } } } })));
    const chunks = [];
    try {
      await assert.rejects(async () => { for await (const chunk of bridge.stream(input())) chunks.push(chunk); }, { code: 'PROTOCOL_INVALID' });
      assert.equal(chunks.some(chunk => chunk.type === 'usage'), false);
    } finally { await bridge.close(); }
  }
});
test('native tool calls stream as blocks, pair with history outputs, and replay idempotently', async () => {
  const call = { type: 'function_call', call_id: 'call-1', name: 'shell', arguments: '{"cmd":"ls"}', status: 'completed' };
  const calls = []; const bridge = new DirectBridge({ token: async () => jwt() }, new Http(async (url, options) => {
    calls.push({ url, options }); return url.includes('/models?') ? json({ models: [model] }) : sse(
      { type: 'response.output_item.added', item: call },
      { type: 'response.function_call_arguments.delta', item_id: 'call-1', delta: '{"cmd"' },
      { type: 'response.output_item.done', item: call },
      { type: 'response.completed', response: { status: 'completed', output: [call], usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16, input_tokens_details: { cached_tokens: 3 }, output_tokens_details: { reasoning_tokens: 2 } } } });
  }));
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'List files' }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'call-9', name: 'shell', arguments: '{"cmd":"pwd"}' }] },
    { role: 'tool', toolCallId: 'call-9', source: { kind: 'tool', callId: 'call-9' }, content: [{ type: 'text', text: '/tmp' }] },
  ];
  const chunks = await collect(bridge.stream(input({ messages, tools: [{ name: 'shell', parameters: { type: 'object' } }] })));
  assert.deepEqual(chunks.slice(0, 3), [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: 'call-1', name: 'shell', argumentsDelta: '' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call-1', name: 'shell', arguments: '{"cmd":"ls"}' } },
  ]);
  assert.deepEqual(chunks[3], { type: 'usage', usage: { inputTokens: 9, outputTokens: 4, totalTokens: 16, cacheReadTokens: 3, reasoningTokens: 2 } });
  assert.deepEqual(chunks.at(-1).reason, { kind: 'tool-calls' });
  const body = JSON.parse(calls.at(-1).options.body);
  assert.deepEqual(body.input, [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'List files' }] },
    { type: 'function_call', call_id: 'call-9', name: 'shell', arguments: '{"cmd":"pwd"}' },
    { type: 'function_call_output', call_id: 'call-9', output: '/tmp' },
  ]);
  await bridge.close();
});
test('image input is read through the attachment service and sent as data URLs', async () => {
  const attachmentId = `sha256:${'ab'.repeat(32)}`;
  const ref = { attachmentId, mediaType: 'image/png', bytes: 3, width: 1024, height: 768 };
  let requested; const calls = []; const attachments = { readImageRequest: async (candidate, target) => { requested = { candidate, target }; return { ...ref, data: Uint8Array.of(1, 2, 3) }; } };
  const bridge = new DirectBridge({ token: async () => jwt() }, new Http(async (url, options) => {
    calls.push({ url, options }); return url.includes('/models?') ? json({ models: [model] }) : sse(delta, completed);
  }), {},
    { resolveAttachments: () => attachments, resolveImageAccess: (list) => list });
  const messages = [{ role: 'user', content: [{ type: 'image', attachment: ref }, { type: 'text', text: 'Describe' }] }];
  await collect(bridge.stream(input({ messages })));
  const body = JSON.parse(calls.at(-1).options.body);
  assert.deepEqual(requested.candidate, ref); assert.equal(requested.target.width, 1024); assert.equal(requested.target.height, 768);
  assert.deepEqual(body.input, [{ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,AQID' }, { type: 'input_text', text: 'Describe' }] }]);
  const pricing = bridge.imageRequestPricing('codex-subscription', 'test-model');
  assert.deepEqual(pricing.priceImages([{ attachment: ref, offloaded: false }])[0], { visualTokens: 765, text: pricing.priceImages([{ attachment: ref, offloaded: false }])[0].text });
  assert.deepEqual(pricing.priceImages([{ attachment: ref, offloaded: true }])[0], { visualTokens: 0, text: pricing.priceImages([{ attachment: ref, offloaded: true }])[0].text });
  await bridge.close();
});
test('the reported request-image target is the same projection the serializer uses', async () => {
  const bridge = new DirectBridge({ token: async () => jwt() }, new Http(async url => url.includes('/models?') ? json({ models: [model] }) : sse(delta, completed)));
  const ref = { attachmentId: `sha256:${'ab'.repeat(32)}`, mediaType: 'image/png', bytes: 3 };
  assert.deepEqual(bridge.imageRequestTarget('codex-subscription', 'test-model', { ...ref, width: 1024, height: 768 }),
    { width: 1024, height: 768, maxBytes: 1048576 });
  // Past the pixel budget the long-edge step recomputes from the source, so the
  // target is not the pixel-budget projection alone.
  assert.deepEqual(bridge.imageRequestTarget('codex-subscription', 'test-model', { ...ref, width: 8000, height: 1000 }),
    { width: 4096, height: 512, maxBytes: 1048576 });
  assert.throws(() => bridge.imageRequestTarget('codex-subscription', 'test-model', null), { code: 'PROTOCOL_INVALID' });
  for (const image of [{ width: 0, height: 10 }, { width: 10, height: 1.5 }, { width: 2 ** 53, height: 1 }]) {
    assert.throws(() => bridge.imageRequestTarget('codex-subscription', 'test-model', image), { code: 'UNSUPPORTED_CONTENT', diagnostic: 'IMAGE_TARGET' });
  }
  await bridge.close();
});
test('missing attachment service and aggregate offload budgets fail with fixed labels', async () => {
  const ref = { attachmentId: `sha256:${'cd'.repeat(32)}`, mediaType: 'image/png', bytes: 16 * 1024 * 1024, width: 1024, height: 768 };
  const messages = [{ role: 'user', content: [{ type: 'image', attachment: { ...ref, attachmentId: `sha256:${'ef'.repeat(32)}`, bytes: 3 } }] }];
  const noService = new DirectBridge({ token: async () => jwt() }, new Http(async url => url.includes('/models?') ? json({ models: [model] }) : sse(delta, completed)));
  await assert.rejects(collect(noService.stream(input({ messages }))), { code: 'UNSUPPORTED_CONTENT', diagnostic: 'IMAGE_PREPARE' });
  await noService.close();
  const attachments = { readImageRequest: async (candidate) => ({ ...candidate, data: Uint8Array.of(0) }) };
  const oversized = new DirectBridge({ token: async () => jwt() }, new Http(async url => url.includes('/models?') ? json({ models: [model] }) : sse(delta, completed)), {},
    { resolveAttachments: () => attachments, resolveImageAccess: () => undefined });
  await assert.rejects(collect(oversized.stream(input({ messages: [{ role: 'user', content: [{ type: 'image', attachment: ref }] }] }))),
    error => { if (error.code !== 'IMAGE_OFFLOAD_REQUIRED' || error.diagnostic !== 'IMAGE_OFFLOAD' || error.offloadImages !== 1) return false;
      assert.deepEqual(failure(error), { code: 'IMAGE_OFFLOAD_REQUIRED', message: error.message, offloadImages: 1 }); return true; });
  await oversized.close();
});
test('incomplete tool-call streams and malformed arguments fail safely', async () => {
  const added = { type: 'function_call', call_id: 'call-1', name: 'shell', arguments: '{}', status: 'completed' };
  for (const [response, diagnostic] of [
    [sse({ type: 'response.output_item.added', item: added }), 'SSE_INCOMPLETE'],
    [sse({ type: 'response.output_item.done', item: { ...added, arguments: 'nope' } }), 'SSE_TOOL_CALL'],
    [sse({ type: 'response.output_item.done', item: { ...added, arguments: '[1]' } }), 'SSE_TOOL_CALL'],
    [sse({ type: 'response.output_item.done', item: { ...added, status: 'in_progress' } }), 'SSE_TOOL_CALL'],
    [sse(delta, { type: 'response.completed', response: { status: 'completed', output: [added], usage: { input_tokens: -1, output_tokens: 0 } } }), 'SSE_TERMINAL'],
  ]) {
    const bridge = new DirectBridge({ token: async () => jwt() }, new Http(async url => url.includes('/models?') ? json({ models: [model] }) : response));
    await assert.rejects(collect(bridge.stream(input())), error => error.code === 'PROTOCOL_INVALID' && error.diagnostic === diagnostic);
    await bridge.close();
  }
});
test('EOF, native tool calls, failure, malformed catalogs, and rate limits fail safely', async () => {
  for (const response of [sse(delta), sse({ type: 'response.output_item.added', item: { type: 'function_call' } }), sse({ type: 'response.failed', response: { error: { message: 'secret' } } }), json({}, 429)]) {
    const bridge = new DirectBridge({ token: async () => jwt() }, new Http(async url => url.includes('/models?') ? json({ models: [model] }) : response));
    await assert.rejects(collect(bridge.stream(input())), error => ['PROTOCOL_INVALID', 'UPSTREAM_FAILED', 'RATE_LIMIT'].includes(error.code) && !error.message.includes('secret'));
    await bridge.close();
  }
  const bridge = new DirectBridge({ token: async () => jwt() }, new Http(async () => json({ models: [{ ...model, visibility: 'bogus' }] })));
  await assert.rejects(bridge.listModels(), { code: 'PROTOCOL_INVALID' }); await bridge.close();
});
test('temperature is forwarded and usage-limit 429s become quota with a bounded hint', async () => {
  const calls = []; let resetsAt = Math.floor(Date.now() / 1000) + 3600;
  const bridge = new DirectBridge({ token: async () => jwt() }, new Http(async (url, options) => {
    calls.push({ url, options });
    return url.includes('/models?') ? json({ models: [model] })
      : json({ error: { code: 'usage_limit_reached', resets_at: resetsAt, plan_type: 'plus', message: 'secret-upstream-text' } }, 429);
  }));
  await assert.rejects(collect(bridge.stream(input({ temperature: 0.7 }))), error => error.code === 'QUOTA'
    && error.message.includes('Try again in about 60 minutes.') && !error.message.includes('secret-upstream-text') && !error.message.includes('plus'));
  assert.equal(JSON.parse(calls.at(-1).options.body).temperature, 0.7);
  resetsAt = Math.floor(Date.now() / 1000) - 600; // Past reset: the hint drops out.
  await assert.rejects(collect(bridge.stream(input())), error => error.code === 'QUOTA' && error.message.startsWith('The ChatGPT plan usage limit was reached. ['));
  resetsAt = 1e12; // Implausible epoch: the hint clamps to a week.
  await assert.rejects(collect(bridge.stream(input())), error => error.code === 'QUOTA' && error.message.includes('Try again in about 10080 minutes.'));
  await bridge.close();
});
test('non-usage 429 bodies and unreadable bodies stay transient rate limits', async () => {
  for (const [payload, code, message] of [
    [{ error: { code: 'rate_limit_exceeded' } }, 'RATE_LIMIT', undefined],
    [{ error: { type: 'server_error' } }, 'RATE_LIMIT', undefined],
    [{ error: {} }, 'RATE_LIMIT', undefined],
    [{}, 'RATE_LIMIT', undefined],
    [{ error: { code: 'usage_limit_reached' } }, 'QUOTA', 'The ChatGPT plan usage limit was reached.'],
    [{ error: { code: 'usage_not_included' } }, 'QUOTA', 'The ChatGPT plan usage limit was reached.'],
    [{ error: { code: 'usage_limit_reached', resets_at: 0 } }, 'QUOTA', 'The ChatGPT plan usage limit was reached.'],
  ]) {
    const bridge = new DirectBridge({ token: async () => jwt() }, new Http(async url => url.includes('/models?') ? json({ models: [model] }) : json(payload, 429)));
    await assert.rejects(collect(bridge.stream(input())), error => {
      if (error.code !== code) return false;
      if (message !== undefined) assert.equal(error.message, `${message} [HTTP_REQUEST]`); else assert.doesNotMatch(error.message, /minute/);
      return true;
    });
    await bridge.close();
  }
  const bridge = new DirectBridge({ token: async () => jwt() }, new Http(async url => url.includes('/models?') ? json({ models: [model] }) : new Response('Too Many Requests', { status: 429 })));
  await assert.rejects(collect(bridge.stream(input())), { code: 'RATE_LIMIT' });
  await bridge.close();
});
test('cancellation and turn deadline abort the underlying request', async () => {
  for (const timeout of [false, true]) {
    let aborted = false; const controller = new AbortController();
    const bridge = new DirectBridge({ token: async () => jwt() }, new Http(async (url, options) => {
      if (url.includes('/models?')) return json({ models: [model] });
      return new Promise((_, reject) => { options.signal.addEventListener('abort', () => { aborted = true; reject(new Error('secret')); }, { once: true }); if (!timeout) setTimeout(() => controller.abort(), 5); });
    }), { turnTimeoutMs: 20 });
    await assert.rejects(collect(bridge.stream(input({ signal: controller.signal }))), { code: timeout ? 'TIMEOUT' : 'ABORTED' });
    assert.equal(aborted, true); await bridge.close();
  }
});
test('SSE supports fragmented UTF-8 and CRLF, and refuses oversized events', async () => {
  const data = Buffer.from('data: {"type":"test","text":"日本語"}\r\n\r\n');
  const stream = new ReadableStream({ start(controller) { for (const byte of data) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
  const result = []; for await (const value of events(stream, new AbortController().signal)) result.push(value);
  assert.equal(result[0].text, '日本語');
  await assert.rejects(collect(events(new Response('x'.repeat(1024 * 1024 + 1)).body, new AbortController().signal)), { code: 'LIMIT_EXCEEDED' });
});
test('device login exchanges a code into the dedicated store without touching Codex', () => fixture(async root => {
  const calls = []; let announced;
  const store = new AuthStore(join(root, 'auth'), new Http(async (url, options) => {
    calls.push(url);
    if (url.endsWith('/usercode')) return json({ device_auth_id: 'synthetic-device', user_code: 'ABCD-EFGH', interval: 0 });
    if (url.endsWith('/deviceauth/token')) return json({ authorization_code: 'synthetic-code', code_verifier: 'synthetic-verifier' });
    assert.equal(options.body.get('code_verifier'), 'synthetic-verifier'); assert.equal(options.body.get('grant_type'), 'authorization_code');
    return json(tokens());
  }));
  await store.login(value => { announced = value; });
  assert.equal(announced.url, `${ISSUER}/codex/device`); assert.equal(announced.code, 'ABCD-EFGH');
  assert.equal(calls.length, 3); assert.equal(claims(await store.token()).exp > Date.now() / 1000, true);
}));
test('cancelled login never replaces an existing grant and releases the store lock', () => fixture(async root => {
  const controller = new AbortController();
  const store = new AuthStore(join(root, 'auth'), new Http(async () => json({ device_auth_id: 'synthetic-device', user_code: 'ABCD-EFGH', interval: 5 })));
  await store.transaction(() => store.write(tokens())); const original = await readFile(join(root, 'auth/auth.json'), 'utf8');
  await assert.rejects(store.login(() => controller.abort(), controller.signal), { code: 'ABORTED' });
  assert.equal(await readFile(join(root, 'auth/auth.json'), 'utf8'), original); await store.logout();
}));
test('device login honors slow_down backoff and terminal poll results', () => fixture(async root => {
  let polls = 0;
  const store = new AuthStore(join(root, 'auth'), new Http(async url => {
    if (url.endsWith('/usercode')) return json({ device_auth_id: 'synthetic-device', user_code: 'ABCD-EFGH', interval: 0 });
    if (url.endsWith('/deviceauth/token')) { polls++; return polls === 1 ? json({ error: 'slow_down' }, 400) : json({ authorization_code: 'synthetic-code', code_verifier: 'synthetic-verifier' }); }
    return json(tokens());
  }));
  await store.login(() => {}); assert.equal(polls, 2); assert.equal(claims(await store.token()).exp > Date.now() / 1000, true);
  const terminal = new AuthStore(join(root, 'auth-2'), new Http(async url => {
    if (url.endsWith('/usercode')) return json({ device_auth_id: 'synthetic-device', user_code: 'ABCD-EFGH', interval: 0 });
    if (url.endsWith('/deviceauth/token')) return json({ error: 'expired_token' }, 403);
    return json(tokens());
  }));
  await assert.rejects(terminal.login(() => {}), { code: 'AUTH_REQUIRED' });
  await assert.rejects(terminal.transaction(() => terminal.read()), { code: 'AUTH_REQUIRED' });
}));
test('paused stream deadlines cancel its reader and release request capacity', async () => {
  let cancelled = false;
  const bridge = new DirectBridge({ token: async () => jwt() }, new Http(async url => {
    if (url.includes('/models?')) return json({ models: [model] });
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(Buffer.from(`data: ${JSON.stringify(delta)}\n\n`)); }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } });
  }), { turnTimeoutMs: 20 });
  const stream = bridge.stream(input()); await stream.next();
  await new Promise(resolve => setTimeout(resolve, 40)); assert.equal(cancelled, true); assert.equal(bridge.active.size, 0);
  await assert.rejects(stream.next(), { code: 'TIMEOUT' });
  await stream.return(); await bridge.close();
});
test('refresh serialization also holds across separate Node processes', () => fixture(async root => {
  const { execFile } = await import('node:child_process'); const { promisify } = await import('node:util');
  const store = new AuthStore(join(root, 'auth')); await store.transaction(() => store.write(tokens(1)));
  const code = `import {AuthStore} from ${JSON.stringify(new URL('../lib/auth.js', import.meta.url).href)};
import {Http} from ${JSON.stringify(new URL('../lib/http.js', import.meta.url).href)};
import {appendFile} from 'node:fs/promises';
const store=new AuthStore(${JSON.stringify(join(root, 'auth'))},new Http(async()=>{await appendFile(${JSON.stringify(join(root, 'refresh-count'))},'refresh\\n');await new Promise(resolve=>setTimeout(resolve,50));return Response.json(${JSON.stringify(tokens())});}));
await store.token();`;
  await Promise.all([1, 2].map(() => promisify(execFile)(process.execPath, ['--input-type=module', '-e', code], { timeout: 5000 })));
  assert.equal((await readFile(join(root, 'refresh-count'), 'utf8')).split('refresh').length - 1, 1);
}));
test('catalog compatibility fallback does not invent unadvertised models', async () => {
  const urls = []; const bridge = new DirectBridge({ token: async () => jwt() }, new Http(async url => {
    urls.push(url); return json({ models: url.endsWith('99.0.0') ? [] : [model] });
  }));
  assert.deepEqual((await bridge.listModels()).map(value => value.id), ['test-model']);
  assert.equal(urls.length, 2); assert.equal(urls[1].endsWith('0.0.0'), true); await bridge.close();
});
test('terminal text fills missing deltas and rejects inconsistent completed content', async () => {
  for (const [text, success] of [['Hello!', true], ['Different', false]]) {
    const bridge = new DirectBridge({ token: async () => jwt() }, new Http(async url => url.includes('/models?') ? json({ models: [model] }) : sse(delta, {
      type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', id: 'message-1', role: 'assistant', content: [{ type: 'output_text', text }] }] },
    })));
    if (success) assert.equal((await collect(bridge.stream(input()))).find(chunk => chunk.type === 'block-end').block.text, 'Hello!');
    else await assert.rejects(collect(bridge.stream(input())), { code: 'PROTOCOL_INVALID' });
    await bridge.close();
  }
});
test('valid SSE is accepted independently of the response MIME header', async () => {
  for (const contentType of [null, 'application/octet-stream', 'application/json', 'text/event-stream']) {
    const bridge = new DirectBridge({ token: async () => jwt() }, new Http(async url => {
      if (url.includes('/models?')) return json({ models: [model] });
      const response = sse(delta, completed);
      if (contentType === null) response.headers.delete('content-type');
      else response.headers.set('content-type', contentType);
      return response;
    }));
    const chunks = await collect(bridge.stream(input()));
    assert.equal(chunks.at(-1).reason.kind, 'stop');
    assert.equal(chunks.find(chunk => chunk.type === 'block-end').block.text, 'Hello');
    await bridge.close();
  }
});
test('a non-SSE MIME header never turns HTML, JSON errors, or truncated SSE into success', async () => {
  for (const body of ['<html>Upstream error</html>', JSON.stringify({ error: { message: 'synthetic-secret' } }), 'data: {"type":"response.completed"}\n', 'data: {"type":"unknown"}\n\n']) {
    const bridge = new DirectBridge({ token: async () => jwt() }, new Http(async url => url.includes('/models?') ? json({ models: [model] }) : new Response(body, { headers: { 'content-type': 'application/octet-stream' } })));
    await assert.rejects(collect(bridge.stream(input())), error => error.code === 'PROTOCOL_INVALID' && !error.message.includes('synthetic-secret'));
    await bridge.close();
  }
});
test('ambiguous refresh outcomes retain durable intent and never resend the old grant', () => fixture(async root => {
  for (const mode of ['lost-reply', 'bad-json', 'failed-save', 'server-error']) {
    let calls = 0; const http = new Http(async () => {
      calls++;
      if (mode === 'lost-reply') throw new Error('synthetic-secret');
      if (mode === 'bad-json') return new Response('{', { status: 200 });
      if (mode === 'server-error') return json({}, 500);
      return json({ ...tokens(), refresh_token: 'rotated' });
    });
    const directory = join(root, mode); const store = new AuthStore(directory, http);
    await store.transaction(() => store.write(tokens(1)));
    if (mode === 'failed-save') store.write = async () => { throw new Error('synthetic-save-failure'); };
    await assert.rejects(store.token());
    assert.equal(JSON.parse(await readFile(join(directory, 'auth.json'), 'utf8')).refresh_pending, true);
    const other = new AuthStore(directory, http);
    await assert.rejects(other.token(), { code: 'AUTH_REQUIRED' }); assert.equal(calls, 1);
    await other.transaction(() => other.write(tokens()));
    assert.equal(claims(await other.token()).exp > Date.now() / 1000, true); assert.equal(calls, 1);
  }
}));
test('a persisted pre-dispatch refresh intent blocks replay after process restart', () => fixture(async root => {
  const directory = join(root, 'auth'); const store = new AuthStore(directory);
  await store.transaction(() => store.writeState({ version: 1, mode: 'chatgpt', ...tokens(1), refresh_pending: true }));
  let calls = 0; const restarted = new AuthStore(directory, new Http(async () => { calls++; return json(tokens()); }));
  await assert.rejects(restarted.token(), { code: 'AUTH_REQUIRED' }); assert.equal(calls, 0);
}));
test('empty text deltas are accepted without inventing text or ending a block', async () => {
  const bridge = new DirectBridge({ token: async () => jwt() }, new Http(async url => url.includes('/models?') ? json({ models: [model] }) : sse(
    { ...delta, delta: '' }, delta, { ...delta, delta: '' }, { ...delta, type: 'response.output_text.done', text: 'Hello' }, completed,
  )));
  const chunks = await collect(bridge.stream(input()));
  assert.deepEqual(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text), ['Hello']);
  assert.equal(chunks.filter(chunk => chunk.type === 'block-start').length, 1);
  assert.equal(chunks.filter(chunk => chunk.type === 'block-end').length, 1);
  assert.equal(chunks.at(-1).reason.kind, 'stop'); await bridge.close();
});
test('accepting empty deltas still refuses invalid types and oversized deltas', async () => {
  for (const value of [null, 1, {}, 'x'.repeat(256 * 1024 + 1)]) {
    const bridge = new DirectBridge({ token: async () => jwt() }, new Http(async url => url.includes('/models?') ? json({ models: [model] }) : sse({ ...delta, delta: value }, completed)));
    await assert.rejects(collect(bridge.stream(input())), { code: 'PROTOCOL_INVALID' }); await bridge.close();
  }
});
test('diagnostics use fixed allowlisted labels and discard mutable upstream messages', async () => {
  const { BridgeError, failure } = await import('../lib/errors.js');
  const unsafe = new BridgeError('PROTOCOL_INVALID', 'synthetic-secret'); unsafe.message = 'synthetic-secret';
  assert.equal(failure(unsafe).message.includes('synthetic-secret'), false);
  assert.equal(failure(new Error('synthetic-secret')).message.includes('synthetic-secret'), false);
  assert.equal(new BridgeError('__proto__', 'synthetic-secret').code, 'UPSTREAM_FAILED');
  assert.equal(failure(new BridgeError('PROTOCOL_INVALID', 'SSE_FRAME')).message.endsWith('[SSE_FRAME]'), true);
  assert.equal(failure(new BridgeError('QUOTA', undefined, { resetMinutes: 90 })).message.endsWith('Try again in about 90 minutes.'), true);
  assert.equal(new BridgeError('QUOTA', undefined, { resetMinutes: 0 }).message, 'The ChatGPT plan usage limit was reached.');
  assert.equal(new BridgeError('QUOTA', undefined, { resetMinutes: 20000 }).message, 'The ChatGPT plan usage limit was reached.');
  // The diagnostic label allowlist is closed: an upstream-authored name is dropped.
  const unknownLabel = new BridgeError('PROTOCOL_INVALID', 'synthetic_secret');
  assert.equal(unknownLabel.diagnostic, undefined);
  assert.equal(unknownLabel.message.includes('synthetic_secret'), false);
  for (const [response, label] of [
    [new Response('data: {\n\n'), 'SSE_FRAME'],
    [sse({ ...delta, delta: null }), 'SSE_TEXT_DELTA'],
    [sse({ type: 'response.completed', response: { status: 'incomplete' } }), 'SSE_TERMINAL'],
    [sse(delta), 'SSE_INCOMPLETE'],
  ]) {
    const bridge = new DirectBridge({ token: async () => jwt() }, new Http(async url => url.includes('/models?') ? json({ models: [model] }) : response));
    await assert.rejects(collect(bridge.stream(input())), error => error.diagnostic === label && !error.message.includes('synthetic_secret'));
    await bridge.close();
  }
});
test('a content-free notification never discards a completed answer', async () => {
  for (const events of [
    // The observed shape: the notification arrives after the text completion.
    [delta, { ...delta, type: 'response.output_text.done', text: 'Hello' }, { type: 'response.metadata', metadata: { synthetic: true } }, completed],
    // A preceding notification must not disturb the buffered answer either.
    [{ type: 'response.metadata' }, delta, { ...delta, type: 'response.output_text.done', text: 'Hello' }, completed],
    // Progress notifications for item families this bridge does not project,
    // including a nested member and an annotation on the projected text block.
    [{ type: 'response.web_search_call.in_progress', item_id: 'ws-1' }, delta, { ...delta, type: 'response.output_text.done', text: 'Hello' }, completed],
    [{ type: 'response.code_interpreter_call_code.delta', item_id: 'ci-1', delta: 'synthetic' }, delta, { ...delta, type: 'response.output_text.done', text: 'Hello' }, completed],
    [{ type: 'response.output_text.annotation.added', item_id: 'message-1', content_index: 0, annotation: { type: 'url_citation' } }, delta, { ...delta, type: 'response.output_text.done', text: 'Hello' }, completed],
    [{ type: 'response.image_generation_call.generating', item_id: 'ig-1' }, delta, { ...delta, type: 'response.output_text.done', text: 'Hello' }, completed],
    // Reasoning notification variants the reference implementation tolerates but
    // an enumerated allowlist missed, which failed a live turn after delivery.
    [{ type: 'response.reasoning_summary.delta', item_id: 'r-1', delta: 'synthetic' }, delta, { ...delta, type: 'response.output_text.done', text: 'Hello' }, completed],
    [{ type: 'response.reasoning_part.added', item_id: 'r-1' }, delta, { ...delta, type: 'response.output_text.done', text: 'Hello' }, completed],
  ]) {
    const bridge = new DirectBridge({ token: async () => jwt() },
      new Http(async url => url.includes('/models?') ? json({ models: [model] }) : sse(...events)));
    const chunks = await collect(bridge.stream(input()));
    assert.equal(chunks.at(-1).reason.kind, 'stop');
    assert.equal(chunks.find(chunk => chunk.type === 'block-end').block.text, 'Hello');
    await bridge.close();
  }
  // An unrecognized notification is ignored, not fatal: the bridge cannot
  // enumerate a live third-party stream's notification vocabulary, and the
  // reference implementation fails only on terminal errors.
  for (const type of ['response.synthetic_unknown', 'response.web_search_call.synthetic_suffix', 'response.web_search_call', 'response.output_text.annotation.synthetic']) {
    const bridge = new DirectBridge({ token: async () => jwt() },
      new Http(async url => url.includes('/models?') ? json({ models: [model] }) : sse(delta, { type }, completed)));
    const chunks = await collect(bridge.stream(input()));
    assert.equal(chunks.at(-1).reason.kind, 'stop');
    assert.equal(chunks.find(chunk => chunk.type === 'text-delta').text, 'Hello');
    await bridge.close();
  }
});
test('an unrecognized notification cannot inject text, tools or usage', async () => {
  // The consumed branches are the only paths that project content, so an
  // unknown event carrying content-shaped fields contributes nothing.
  const bridge = new DirectBridge({ token: async () => jwt() },
    new Http(async url => url.includes('/models?') ? json({ models: [model] }) : sse(
      { type: 'response.synthetic_unknown', delta: 'injected', text: 'injected', item: { type: 'function_call', call_id: 'c-1', name: 'shell', arguments: '{}' }, response: { usage: { input_tokens: 9, output_tokens: 9 } } },
      delta, completed)));
  const chunks = await collect(bridge.stream(input()));
  assert.equal(chunks.find(chunk => chunk.type === 'text-delta').text, 'Hello');
  assert.equal(chunks.some(chunk => chunk.type === 'tool-call-delta'), false);
  assert.equal(chunks.some(chunk => chunk.type === 'usage'), false);
  assert.equal(chunks.at(-1).reason.kind, 'stop');
  await bridge.close();
});
