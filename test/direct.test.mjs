import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, symlink, chmod, writeFile } from 'node:fs/promises';
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
const sse = (...values) => new Response(values.map((value) => `data: ${JSON.stringify(value)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
const delta = { type: 'response.output_text.delta', item_id: 'message-1', content_index: 0, delta: 'Hello' };
const completed = { type: 'response.completed', response: { status: 'completed', output: [] } };
const input = (extra = {}) => ({ provider: 'codex-subscription', model: 'test-model', messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }], ...extra });

async function collect(stream) {
  const result = [];
  for await (const chunk of stream) result.push(chunk);
  return result;
}

/** A bridge whose catalog answers with the model list and whose turn answers with the given response. */
function bridgeFor(response, settings) {
  return new DirectBridge({ token: async () => jwt() }, new Http(async (url) => url.includes('/models?') ? json({ models: [model] }) : response), settings);
}

/** A bridge whose catalog answers with the model list and whose turn answers with the given response, recording each request. */
function bridgeForTurn(calls, response, settings) {
  return new DirectBridge({ token: async () => jwt() }, new Http(async (url, options) => {
    calls.push({ url, options });
    return url.includes('/models?') ? json({ models: [model] }) : response;
  }), settings);
}

/** A bridge whose catalog answers with the given response. */
function bridgeForCatalog(handler) {
  return new DirectBridge({ token: async () => jwt() }, new Http(async () => handler()));
}

async function tempRoot(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

test('the dedicated store refuses an API-key shaped grant', async () => {
  const root = await tempRoot('dsh-direct-test-');
  const store = new AuthStore(join(root, 'auth'));
  await store.prepare();

  await assert.rejects(store.transaction(() => store.write({ access_token: 'api-key', refresh_token: 'refresh' })), { code: 'AUTH_REQUIRED' });

  await rm(root, { recursive: true, force: true });
});

test('a subscription grant is recorded as chatgpt mode', async () => {
  const root = await tempRoot('dsh-direct-test-');
  const store = new AuthStore(join(root, 'auth'));
  await store.prepare();
  await store.transaction(() => store.write(tokens()));

  const state = JSON.parse(await readFile(join(root, 'auth/auth.json'), 'utf8'));

  assert.equal(state.mode, 'chatgpt');

  await rm(root, { recursive: true, force: true });
});

test('the dedicated store refuses a grant stored with group or other access', async () => {
  const root = await tempRoot('dsh-direct-test-');
  const store = new AuthStore(join(root, 'auth'));
  await store.prepare();
  await store.transaction(() => store.write(tokens()));
  await chmod(join(root, 'auth/auth.json'), 0o644);

  await assert.rejects(store.token(), { code: 'AUTH_STORE_INVALID' });

  await rm(root, { recursive: true, force: true });
});

test('the dedicated store refuses a symlinked credential file without reading the target', async () => {
  const root = await tempRoot('dsh-direct-test-');
  const store = new AuthStore(join(root, 'auth'));
  await store.prepare();
  await store.transaction(() => store.write(tokens()));
  await rm(join(root, 'auth/auth.json'));
  await writeFile(join(root, 'external'), 'secret');
  await symlink(join(root, 'external'), join(root, 'auth/auth.json'));

  await assert.rejects(store.token(), { code: 'AUTH_STORE_INVALID' });

  assert.equal(await readFile(join(root, 'external'), 'utf8'), 'secret');

  await rm(root, { recursive: true, force: true });
});

test('refresh is serialized across independent store instances', async () => {
  const root = await tempRoot('dsh-direct-test-');
  let refreshes = 0;
  const http = new Http(async () => {
    refreshes += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return json({ ...tokens(), refresh_token: 'rotated-secret' });
  });
  const first = new AuthStore(join(root, 'auth'), http);
  await first.transaction(() => first.write(tokens(1)));
  const second = new AuthStore(join(root, 'auth'), http);

  const values = await Promise.all([first.token(), second.token()]);

  assert.equal(refreshes, 1);
  assert.equal(values[0], values[1]);

  await rm(root, { recursive: true, force: true });
});

test('a serialized refresh writes the rotated grant once', async () => {
  const root = await tempRoot('dsh-direct-test-');
  const http = new Http(async () => json({ ...tokens(), refresh_token: 'rotated-secret' }));
  const first = new AuthStore(join(root, 'auth'), http);
  await first.transaction(() => first.write(tokens(1)));
  const second = new AuthStore(join(root, 'auth'), http);
  await Promise.all([first.token(), second.token()]);

  const stored = await second.transaction(() => second.read());

  assert.equal(stored.refresh_token, 'rotated-secret');

  await rm(root, { recursive: true, force: true });
});

test('the refresh request goes to the fixed issuer with the refresh grant', async () => {
  const root = await tempRoot('dsh-direct-test-');
  const http = new Http(async (url, options) => {
    assert.equal(url, `${ISSUER}/oauth/token`);
    assert.equal(options.redirect, 'error');
    assert.equal(options.body.get('grant_type'), 'refresh_token');
    return json({ ...tokens(), refresh_token: 'rotated-secret' });
  });
  const store = new AuthStore(join(root, 'auth'), http);
  await store.transaction(() => store.write(tokens(1)));

  await store.token();

  await rm(root, { recursive: true, force: true });
});

test('a terminal refresh failure quarantines the grant', async () => {
  const root = await tempRoot('dsh-direct-test-');
  const store = new AuthStore(join(root, 'auth'), new Http(async () => json({ error: 'invalid_grant' }, 400)));
  await store.transaction(() => store.write(tokens(1)));

  await assert.rejects(store.token(), { code: 'AUTH_REQUIRED' });

  await rm(root, { recursive: true, force: true });
});

test('a quarantined grant is not refreshed again', async () => {
  const root = await tempRoot('dsh-direct-test-');
  let calls = 0;
  const store = new AuthStore(join(root, 'auth'), new Http(async () => {
    calls += 1;
    return json({ error: 'invalid_grant' }, 400);
  }));
  await store.transaction(() => store.write(tokens(1)));

  await assert.rejects(store.token(), { code: 'AUTH_REQUIRED' });
  await assert.rejects(store.token(), { code: 'AUTH_REQUIRED' });

  assert.equal(calls, 1);

  await rm(root, { recursive: true, force: true });
});

test('a quota refresh failure keeps the grant for the next request', async () => {
  const root = await tempRoot('dsh-direct-test-');
  const store = new AuthStore(join(root, 'auth'), new Http(async () => json({ error: 'rate_limit' }, 429)));
  await store.transaction(() => store.write(tokens(1)));

  await assert.rejects(store.token(), { code: 'RATE_LIMIT' });
  await assert.rejects(store.token(), { code: 'RATE_LIMIT' });

  await rm(root, { recursive: true, force: true });
});

test('a quota refresh failure retries the refresh on the next request', async () => {
  const root = await tempRoot('dsh-direct-test-');
  let calls = 0;
  const store = new AuthStore(join(root, 'auth'), new Http(async () => {
    calls += 1;
    return json({ error: 'rate_limit' }, 429);
  }));
  await store.transaction(() => store.write(tokens(1)));

  await assert.rejects(store.token(), { code: 'RATE_LIMIT' });
  await assert.rejects(store.token(), { code: 'RATE_LIMIT' });

  assert.equal(calls, 2);

  await rm(root, { recursive: true, force: true });
});

test('logout removes only the dedicated login', async () => {
  const root = await tempRoot('dsh-direct-test-');
  const store = new AuthStore(join(root, 'auth'));
  await store.transaction(() => store.write(tokens()));

  await store.logout();

  await assert.rejects(store.token(), { code: 'AUTH_REQUIRED' });

  await rm(root, { recursive: true, force: true });
});

test('a destination outside the fixed prefix is refused before any request', async () => {
  let calls = 0;
  const http = new Http(async () => {
    calls += 1;
    throw new Error('secret-token');
  });

  await assert.rejects(http.json('https://chatgpt.com.evil.test/backend-api/codex/models'), { code: 'CONFIG_INVALID' });

  assert.equal(calls, 0);
});

test('dot segments cannot escape the fixed path prefix', async () => {
  const http = new Http(async () => { throw new Error('secret-token'); });

  await assert.rejects(http.json(`${BASE}/../models`), { code: 'CONFIG_INVALID' });
  await assert.rejects(http.json(`${BASE}/../models?cursor=1`), { code: 'CONFIG_INVALID' });
});

test('userinfo in the URL is refused', async () => {
  const http = new Http(async () => { throw new Error('secret-token'); });

  await assert.rejects(http.json('https://user:pass@chatgpt.com/backend-api/codex/models'), { code: 'CONFIG_INVALID' });
});

test('the transport requests redirect-error mode so credentials are not forwarded', async () => {
  const http = new Http(async (_, options) => {
    assert.equal(options.redirect, 'error');
    throw new Error('secret-token');
  });

  await assert.rejects(http.json(`${BASE}/models`), { code: 'UPSTREAM_FAILED' });
});

test('an upstream failure diagnostic never carries the thrown secret', async () => {
  const http = new Http(async () => { throw new Error('secret-token'); });

  await assert.rejects(http.json(`${BASE}/models`), (error) => error.code === 'UPSTREAM_FAILED' && !error.message.includes('secret-token'));
  await assert.rejects(http.json(`${ISSUER}/oauth/token`), (error) => error.code === 'UPSTREAM_FAILED' && !error.message.includes('secret-token'));
});

test('bounded HTTP JSON refuses a body past its bound', async () => {
  const http = new Http(async () => json({ data: 'x'.repeat(100) }));

  await assert.rejects(http.json(`${BASE}/models`, {}, undefined, 20), { code: 'LIMIT_EXCEEDED' });
});

test('bounded HTTP JSON refuses a malformed body', async () => {
  const http = new Http(async () => new Response('{'));

  await assert.rejects(http.json(`${BASE}/models`), { code: 'PROTOCOL_INVALID' });
});

test('the catalog shares one request across concurrent calls', async () => {
  let calls = 0;
  const bridge = bridgeForCatalog(() => {
    calls += 1;
    return json({ models: [model] });
  });

  const models = await Promise.all(Array.from({ length: 12 }, () => bridge.listModels()));

  assert.equal(calls, 1);
  assert.equal(models[0].length, 1);

  await bridge.close();
});

test('the catalog caches its metadata across later calls', async () => {
  let calls = 0;
  const bridge = bridgeForCatalog(() => {
    calls += 1;
    return json({ models: [model] });
  });
  await bridge.listModels();

  await bridge.listModels();

  assert.equal(calls, 1);

  await bridge.close();
});

test('the catalog rechecks authentication on each call', async () => {
  let authCalls = 0;
  const auth = { token: async () => {
    authCalls += 1;
    return jwt();
  } };
  const bridge = new DirectBridge(auth, new Http(async () => json({ models: [model] })));

  await Promise.all(Array.from({ length: 12 }, () => bridge.listModels()));
  await bridge.listModels();

  assert.equal(authCalls, 2);

  await bridge.close();
});

test('a cached catalog entry is not shared as a mutable object', async () => {
  const bridge = bridgeForCatalog(() => json({ models: [model] }));
  const models = await Promise.all(Array.from({ length: 12 }, () => bridge.listModels()));

  models[0][0].name = 'changed';

  assert.equal(models[1][0].name, 'Test');

  await bridge.close();
});

test('hidden models are excluded from the catalog', async () => {
  const bridge = bridgeForCatalog(() => json({ models: [model, { ...model, slug: 'hidden', visibility: 'hide' }] }));

  const models = await bridge.listModels();

  assert.equal(models.length, 1);

  await bridge.close();
});

test('a catalog call fails when authentication is required', async () => {
  const auth = { token: async () => { throw new BridgeError('AUTH_REQUIRED'); } };
  const bridge = new DirectBridge(auth, new Http(async () => json({ models: [model] })));

  await assert.rejects(bridge.listModels(), { code: 'AUTH_REQUIRED' });

  await bridge.close();
});

test('the catalog projects the disclosed context window', async () => {
  const bridge = bridgeForCatalog(() => json({ models: [{ ...model, slug: 'windowed', context_window: 272000 }] }));

  const models = await bridge.listModels();

  assert.deepEqual(models, [{ id: 'windowed', name: 'Test', provider: 'codex-subscription', inputModalities: ['text', 'image'], contextWindow: 272000 }]);

  await bridge.close();
});

test('a model with no disclosed window has no projected window', async () => {
  const bridge = bridgeForCatalog(() => json({ models: [model] }));

  const models = await bridge.listModels();

  assert.equal('contextWindow' in models[0], false);

  await bridge.close();
});

test('a malformed window value is refused', async () => {
  for (const value of [0, -1, 1.5, '272000', 2 ** 53]) {
    const bridge = bridgeForCatalog(() => json({ models: [{ ...model, context_window: value }] }));

    await assert.rejects(bridge.listModels(), { code: 'PROTOCOL_INVALID' });

    await bridge.close();
  }
});

test('the turn request is sent unpersisted and streamed', async () => {
  const calls = [];
  const bridge = bridgeForTurn(calls, sse(delta, completed));

  await collect(bridge.stream(input()));

  const body = JSON.parse(calls.at(-1).options.body);
  assert.equal(body.store, false);
  assert.equal(body.stream, true);

  await bridge.close();
});

test('tool declarations are forwarded without execution metadata', async () => {
  const calls = [];
  const bridge = bridgeForTurn(calls, sse(delta, completed));

  await collect(bridge.stream(input({ tools: [{ name: 'shell', description: 'Run shell', parameters: { type: 'object' }, deferLoading: true }] })));

  assert.deepEqual(JSON.parse(calls.at(-1).options.body).tools, [{ type: 'function', name: 'shell', description: 'Run shell', strict: false, parameters: { type: 'object' } }]);

  await bridge.close();
});

test('reasoning effort is forwarded verbatim', async () => {
  const calls = [];
  const bridge = new DirectBridge({ token: async () => jwt() }, new Http(async (url, options) => {
    calls.push({ url, options });
    return url.includes('/models?')
      ? json({ models: [{ ...model, supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }] }] })
      : sse(delta, completed);
  }));

  await collect(bridge.stream(input({ reasoningEffort: 'medium' })));

  assert.deepEqual(JSON.parse(calls.at(-1).options.body).reasoning, { effort: 'medium' });

  await bridge.close();
});

test('an unsupported reasoning level is refused', async () => {
  const bridge = bridgeForTurn([], sse(delta, completed));

  await assert.rejects(collect(bridge.stream(input({ reasoningEffort: 'bogus' }))), { code: 'INPUT_UNSUPPORTED' });

  await bridge.close();
});

test('the account header carries the account from the claim', async () => {
  const calls = [];
  const bridge = bridgeForTurn(calls, sse(delta, completed));

  await collect(bridge.stream(input()));

  assert.equal(calls.at(-1).options.headers['ChatGPT-Account-ID'], 'synthetic-account');

  await bridge.close();
});

test('the projected model entry carries its input modalities', async () => {
  const bridge = bridgeForCatalog(() => json({ models: [{ ...model, supported_reasoning_levels: [{ effort: 'low' }] }] }));

  const models = await bridge.listModels();

  assert.equal(models.find((entry) => entry.id === 'test-model').inputModalities.join(','), 'text,image');

  await bridge.close();
});

test('streamed text keeps the delta and the terminal completion as one block', async () => {
  const bridge = bridgeForTurn([], sse(delta, { ...delta, type: 'response.output_text.done', text: 'Hello!' }, completed));

  const chunks = await collect(bridge.stream(input()));

  assert.equal(chunks.find((chunk) => chunk.type === 'block-end').block.text, 'Hello!');
  assert.equal(chunks.at(-1).reason.kind, 'stop');

  await bridge.close();
});

test('usage separates cached input while preserving totals', async () => {
  for (const [details, cached] of [[undefined, undefined], [{}, undefined], [{ cached_tokens: 0 }, 0], [{ cached_tokens: 3 }, 3], [{ cached_tokens: 12 }, 12]]) {
    const wire = { input_tokens: 12, output_tokens: 4, total_tokens: 16, ...(details === undefined ? {} : { input_tokens_details: details }) };
    const bridge = bridgeForTurn([], sse({ ...completed, response: { ...completed.response, usage: wire } }));

    const chunks = await collect(bridge.stream(input()));
    const usage = chunks.find((chunk) => chunk.type === 'usage').usage;

    assert.deepEqual(usage, { inputTokens: 12 - (cached ?? 0), outputTokens: 4, totalTokens: 16, ...(cached === undefined ? {} : { cacheReadTokens: cached }) });

    await bridge.close();
  }
});

test('the prompt buckets stay disjoint so the cache rate is computable', async () => {
  const wire = { input_tokens: 12, output_tokens: 4, total_tokens: 16, input_tokens_details: { cached_tokens: 3 } };
  const bridge = bridgeForTurn([], sse({ ...completed, response: { ...completed.response, usage: wire } }));

  const chunks = await collect(bridge.stream(input()));
  const usage = chunks.find((chunk) => chunk.type === 'usage').usage;
  const prompt = usage.inputTokens + (usage.cacheReadTokens ?? 0);

  assert.equal(prompt, wire.input_tokens);
  assert.equal(prompt, usage.totalTokens - usage.outputTokens);
  assert.equal((usage.cacheReadTokens ?? 0) / prompt, 3 / wire.input_tokens);

  await bridge.close();
});

test('an invalid cached count is refused before usage is emitted', async () => {
  for (const cached of [-1, 1.5, '3', null, 13, Number.MAX_SAFE_INTEGER + 1]) {
    const bridge = bridgeForTurn([], sse({ ...completed, response: { ...completed.response, usage: { input_tokens: 12, output_tokens: 4, input_tokens_details: { cached_tokens: cached } } } }));
    const chunks = [];

    try {
      await assert.rejects(async () => { for await (const chunk of bridge.stream(input())) chunks.push(chunk); }, { code: 'PROTOCOL_INVALID' });
      assert.equal(chunks.some((chunk) => chunk.type === 'usage'), false);
    } finally {
      await bridge.close();
    }
  }
});

test('a native tool call streams as one block', async () => {
  const call = { type: 'function_call', call_id: 'call-1', name: 'shell', arguments: '{"cmd":"ls"}', status: 'completed' };
  const bridge = bridgeForTurn([], sse(
    { type: 'response.output_item.added', item: call },
    { type: 'response.function_call_arguments.delta', item_id: 'call-1', delta: '{"cmd"' },
    { type: 'response.output_item.done', item: call },
    { type: 'response.completed', response: { status: 'completed', output: [call] } }));

  const chunks = await collect(bridge.stream(input({ tools: [{ name: 'shell', parameters: { type: 'object' } }] })));

  assert.deepEqual(chunks.slice(0, 3), [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: 'call-1', name: 'shell', argumentsDelta: '' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call-1', name: 'shell', arguments: '{"cmd":"ls"}' } },
  ]);

  await bridge.close();
});

test('a tool call repeated in the terminal response is not emitted twice', async () => {
  const call = { type: 'function_call', call_id: 'call-1', name: 'shell', arguments: '{"cmd":"ls"}', status: 'completed' };
  const bridge = bridgeForTurn([], sse(
    { type: 'response.output_item.done', item: call },
    { type: 'response.completed', response: { status: 'completed', output: [call] } }));

  const chunks = await collect(bridge.stream(input({ tools: [{ name: 'shell', parameters: { type: 'object' } }] })));

  assert.equal(chunks.filter((chunk) => chunk.type === 'block-end').length, 1);

  await bridge.close();
});

test('a tool call pairs with its executed history output in the request', async () => {
  const calls = [];
  const call = { type: 'function_call', call_id: 'call-1', name: 'shell', arguments: '{"cmd":"ls"}', status: 'completed' };
  const bridge = bridgeForTurn(calls, sse({ type: 'response.output_item.done', item: call }, completed));
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'List files' }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'call-9', name: 'shell', arguments: '{"cmd":"pwd"}' }] },
    { role: 'tool', toolCallId: 'call-9', source: { kind: 'tool', callId: 'call-9' }, content: [{ type: 'text', text: '/tmp' }] },
  ];

  await collect(bridge.stream(input({ messages, tools: [{ name: 'shell', parameters: { type: 'object' } }] })));

  assert.deepEqual(JSON.parse(calls.at(-1).options.body).input, [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'List files' }] },
    { type: 'function_call', call_id: 'call-9', name: 'shell', arguments: '{"cmd":"pwd"}' },
    { type: 'function_call_output', call_id: 'call-9', output: '/tmp' },
  ]);

  await bridge.close();
});

test('the turn reports tool calls as the stop reason', async () => {
  const call = { type: 'function_call', call_id: 'call-1', name: 'shell', arguments: '{}', status: 'completed' };
  const bridge = bridgeForTurn([], sse({ type: 'response.output_item.done', item: call }, completed));

  const chunks = await collect(bridge.stream(input({ tools: [{ name: 'shell', parameters: { type: 'object' } }] })));

  assert.deepEqual(chunks.at(-1).reason, { kind: 'tool-calls' });

  await bridge.close();
});

test('image input is read through the attachment service and sent as a data URL', async () => {
  const ref = { attachmentId: `sha256:${'ab'.repeat(32)}`, mediaType: 'image/png', bytes: 3, width: 1024, height: 768 };
  const calls = [];
  const attachments = { readImageRequest: async (candidate, target) => ({ ...ref, data: Uint8Array.of(1, 2, 3) }) };
  const bridge = new DirectBridge({ token: async () => jwt() }, new Http(async (url, options) => {
    calls.push({ url, options });
    return url.includes('/models?') ? json({ models: [model] }) : sse(delta, completed);
  }), {}, { resolveAttachments: () => attachments, resolveImageAccess: (list) => list });
  const messages = [{ role: 'user', content: [{ type: 'image', attachment: ref }, { type: 'text', text: 'Describe' }] }];

  await collect(bridge.stream(input({ messages })));

  assert.deepEqual(JSON.parse(calls.at(-1).options.body).input, [{ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,AQID' }, { type: 'input_text', text: 'Describe' }] }]);

  await bridge.close();
});

test('the attachment service is asked for the request target the serializer uses', async () => {
  const ref = { attachmentId: `sha256:${'ab'.repeat(32)}`, mediaType: 'image/png', bytes: 3, width: 1024, height: 768 };
  let requested;
  const attachments = { readImageRequest: async (candidate, target) => {
    requested = { candidate, target };
    return { ...ref, data: Uint8Array.of(1, 2, 3) };
  } };
  const bridge = new DirectBridge({ token: async () => jwt() }, new Http(async (url) => url.includes('/models?') ? json({ models: [model] }) : sse(delta, completed)), {},
    { resolveAttachments: () => attachments, resolveImageAccess: (list) => list });

  await collect(bridge.stream(input({ messages: [{ role: 'user', content: [{ type: 'image', attachment: ref }] }] })));

  assert.deepEqual(requested.candidate, ref);
  assert.equal(requested.target.width, 1024);
  assert.equal(requested.target.height, 768);

  await bridge.close();
});

test('the reported request-image target is the same projection the serializer uses', async () => {
  const bridge = bridgeForTurn([], sse(delta, completed));
  const ref = { attachmentId: `sha256:${'ab'.repeat(32)}`, mediaType: 'image/png', bytes: 3 };

  const target = bridge.imageRequestTarget('codex-subscription', 'test-model', { ...ref, width: 1024, height: 768 });

  assert.deepEqual(target, { width: 1024, height: 768, maxBytes: 1048576 });

  await bridge.close();
});

test('past the pixel budget the target recomputes from the long edge', async () => {
  const bridge = bridgeForTurn([], sse(delta, completed));
  const ref = { attachmentId: `sha256:${'ab'.repeat(32)}`, mediaType: 'image/png', bytes: 3 };

  const target = bridge.imageRequestTarget('codex-subscription', 'test-model', { ...ref, width: 8000, height: 1000 });

  assert.deepEqual(target, { width: 4096, height: 512, maxBytes: 1048576 });

  await bridge.close();
});

test('the reported request-image target refuses a reference the bridge cannot validate', async () => {
  const bridge = bridgeForTurn([], sse(delta, completed));

  assert.throws(() => bridge.imageRequestTarget('codex-subscription', 'test-model', null), { code: 'PROTOCOL_INVALID' });

  await bridge.close();
});

test('an image outside the target bounds is refused', async () => {
  const bridge = bridgeForTurn([], sse(delta, completed));

  for (const image of [{ width: 0, height: 10 }, { width: 10, height: 1.5 }, { width: 2 ** 53, height: 1 }]) {
    assert.throws(() => bridge.imageRequestTarget('codex-subscription', 'test-model', image), { code: 'UNSUPPORTED_CONTENT', diagnostic: 'IMAGE_TARGET' });
  }

  await bridge.close();
});

test('image pricing counts visual tokens only for an unoffloaded attachment', async () => {
  const bridge = bridgeForTurn([], sse(delta, completed));
  const ref = { attachmentId: `sha256:${'ab'.repeat(32)}`, mediaType: 'image/png', bytes: 3, width: 1024, height: 768 };
  const pricing = bridge.imageRequestPricing('codex-subscription', 'test-model');

  assert.equal(pricing.priceImages([{ attachment: ref, offloaded: false }])[0].visualTokens, 765);
  assert.equal(pricing.priceImages([{ attachment: ref, offloaded: true }])[0].visualTokens, 0);

  await bridge.close();
});

test('a missing attachment service fails with the fixed prepare label', async () => {
  const bridge = bridgeForTurn([], sse(delta, completed));
  const messages = [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: `sha256:${'ef'.repeat(32)}`, mediaType: 'image/png', bytes: 3, width: 1024, height: 768 } }] }];

  await assert.rejects(collect(bridge.stream(input({ messages }))), { code: 'UNSUPPORTED_CONTENT', diagnostic: 'IMAGE_PREPARE' });

  await bridge.close();
});

test('an attachment past the aggregate offload budget is refused with its own label', async () => {
  const ref = { attachmentId: `sha256:${'cd'.repeat(32)}`, mediaType: 'image/png', bytes: 16 * 1024 * 1024, width: 1024, height: 768 };
  const attachments = { readImageRequest: async (candidate) => ({ ...candidate, data: Uint8Array.of(0) }) };
  const bridge = new DirectBridge({ token: async () => jwt() }, new Http(async (url) => url.includes('/models?') ? json({ models: [model] }) : sse(delta, completed)), {},
    { resolveAttachments: () => attachments, resolveImageAccess: () => undefined });

  await assert.rejects(collect(bridge.stream(input({ messages: [{ role: 'user', content: [{ type: 'image', attachment: ref }] }] }))),
    (error) => {
      if (error.code !== 'IMAGE_OFFLOAD_REQUIRED' || error.diagnostic !== 'IMAGE_OFFLOAD' || error.offloadImages !== 1) return false;
      assert.deepEqual(failure(error), { code: 'IMAGE_OFFLOAD_REQUIRED', message: error.message, offloadImages: 1 });
      return true;
    });

  await bridge.close();
});

test('an incomplete tool-call stream is refused with its own label', async () => {
  const added = { type: 'function_call', call_id: 'call-1', name: 'shell', arguments: '{}', status: 'completed' };

  for (const [response, diagnostic] of [
    [sse({ type: 'response.output_item.added', item: added }), 'SSE_INCOMPLETE'],
    [sse({ type: 'response.output_item.done', item: { ...added, arguments: 'nope' } }), 'SSE_TOOL_CALL'],
    [sse({ type: 'response.output_item.done', item: { ...added, arguments: '[1]' } }), 'SSE_TOOL_CALL'],
    [sse({ type: 'response.output_item.done', item: { ...added, status: 'in_progress' } }), 'SSE_TOOL_CALL'],
    [sse(delta, { type: 'response.completed', response: { status: 'completed', output: [added], usage: { input_tokens: -1, output_tokens: 0 } } }), 'SSE_TERMINAL'],
  ]) {
    const bridge = bridgeForTurn([], response);

    await assert.rejects(collect(bridge.stream(input())), (error) => error.code === 'PROTOCOL_INVALID' && error.diagnostic === diagnostic);

    await bridge.close();
  }
});

test('EOF, a failed turn, a malformed catalog and a rate limit fail safely without leaking upstream text', async () => {
  for (const response of [sse(delta), sse({ type: 'response.output_item.added', item: { type: 'function_call' } }), sse({ type: 'response.failed', response: { error: { message: 'secret' } } }), json({}, 429)]) {
    const bridge = bridgeForTurn([], response);

    await assert.rejects(collect(bridge.stream(input())), (error) => ['PROTOCOL_INVALID', 'UPSTREAM_FAILED', 'RATE_LIMIT'].includes(error.code) && !error.message.includes('secret'));

    await bridge.close();
  }
});

test('a malformed catalog visibility is refused', async () => {
  const bridge = bridgeForCatalog(() => json({ models: [{ ...model, visibility: 'bogus' }] }));

  await assert.rejects(bridge.listModels(), { code: 'PROTOCOL_INVALID' });

  await bridge.close();
});

test('temperature is forwarded to the turn request', async () => {
  const calls = [];
  const bridge = bridgeForTurn(calls, json({ error: { code: 'usage_limit_reached', resets_at: Math.floor(Date.now() / 1000) + 3600 } }, 429));

  await collect(bridge.stream(input({ temperature: 0.7 }))).catch(() => {});

  assert.equal(JSON.parse(calls.at(-1).options.body).temperature, 0.7);

  await bridge.close();
});

test('a usage-limit 429 becomes quota with a bounded hint', async () => {
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;
  const bridge = bridgeForTurn([], json({ error: { code: 'usage_limit_reached', resets_at: resetsAt, plan_type: 'plus', message: 'secret-upstream-text' } }, 429));

  await assert.rejects(collect(bridge.stream(input())), (error) => error.code === 'QUOTA'
    && error.message.includes('Try again in about 60 minutes.')
    && !error.message.includes('secret-upstream-text')
    && !error.message.includes('plus'));

  await bridge.close();
});

test('a usage-limit past its reset drops the hint', async () => {
  const resetsAt = Math.floor(Date.now() / 1000) - 600;
  const bridge = bridgeForTurn([], json({ error: { code: 'usage_limit_reached', resets_at: resetsAt } }, 429));

  await assert.rejects(collect(bridge.stream(input())), (error) => error.code === 'QUOTA' && error.message.startsWith('The ChatGPT plan usage limit was reached. ['));

  await bridge.close();
});

test('an implausible reset clamps to a week', async () => {
  const bridge = bridgeForTurn([], json({ error: { code: 'usage_limit_reached', resets_at: 1e12 } }, 429));

  await assert.rejects(collect(bridge.stream(input())), (error) => error.code === 'QUOTA' && error.message.includes('Try again in about 10080 minutes.'));

  await bridge.close();
});

test('non-usage 429 bodies stay transient rate limits without a hint', async () => {
  for (const payload of [{ error: { code: 'rate_limit_exceeded' } }, { error: { type: 'server_error' } }, { error: {} }, {}]) {
    const bridge = bridgeForTurn([], json(payload, 429));

    await assert.rejects(collect(bridge.stream(input())), (error) => error.code === 'RATE_LIMIT' && !error.message.includes('minute'));

    await bridge.close();
  }
});

test('a usage-shaped 429 body becomes quota with the fixed label', async () => {
  for (const payload of [{ error: { code: 'usage_limit_reached' } }, { error: { code: 'usage_not_included' } }, { error: { code: 'usage_limit_reached', resets_at: 0 } }]) {
    const bridge = bridgeForTurn([], json(payload, 429));

    await assert.rejects(collect(bridge.stream(input())), (error) => error.code === 'QUOTA' && error.message === 'The ChatGPT plan usage limit was reached. [HTTP_REQUEST]');

    await bridge.close();
  }
});

test('an unreadable 429 body stays a transient rate limit', async () => {
  const bridge = bridgeForTurn([], new Response('Too Many Requests', { status: 429 }));

  await assert.rejects(collect(bridge.stream(input())), { code: 'RATE_LIMIT' });

  await bridge.close();
});

test('a caller cancellation aborts the underlying request', async () => {
  let aborted = false;
  const controller = new AbortController();
  const bridge = new DirectBridge({ token: async () => jwt() }, new Http(async (url, options) => {
    if (url.includes('/models?')) return json({ models: [model] });
    return new Promise((_, reject) => {
      options.signal.addEventListener('abort', () => { aborted = true; reject(new Error('secret')); }, { once: true });
      setTimeout(() => controller.abort(), 5);
    });
  }));

  await assert.rejects(collect(bridge.stream(input({ signal: controller.signal }))), { code: 'ABORTED' });

  assert.equal(aborted, true);

  await bridge.close();
});

test('a turn deadline aborts the underlying request', async () => {
  let aborted = false;
  const bridge = new DirectBridge({ token: async () => jwt() }, new Http(async (url, options) => {
    if (url.includes('/models?')) return json({ models: [model] });
    return new Promise((_, reject) => {
      options.signal.addEventListener('abort', () => { aborted = true; reject(new Error('secret')); }, { once: true });
    });
  }), { turnTimeoutMs: 20 });

  await assert.rejects(collect(bridge.stream(input())), { code: 'TIMEOUT' });

  assert.equal(aborted, true);

  await bridge.close();
});

test('SSE framing preserves split UTF-8 and CRLF', async () => {
  const data = Buffer.from('data: {"type":"test","text":"日本語"}\r\n\r\n');
  const stream = new ReadableStream({ start(controller) {
    for (const byte of data) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  } });

  const result = [];
  for await (const value of events(stream, new AbortController().signal)) result.push(value);

  assert.equal(result[0].text, '日本語');
});

test('SSE refuses a body past the aggregate bound', async () => {
  await assert.rejects(collect(events(new Response('x'.repeat(1024 * 1024 + 1)).body, new AbortController().signal)), { code: 'LIMIT_EXCEEDED' });
});

test('device login announces the fixed device URL and the user code', async () => {
  const root = await tempRoot('dsh-direct-test-');
  let announced;
  const store = new AuthStore(join(root, 'auth'), new Http(async (url) => {
    if (url.endsWith('/usercode')) return json({ device_auth_id: 'synthetic-device', user_code: 'ABCD-EFGH', interval: 0 });
    if (url.endsWith('/deviceauth/token')) return json({ authorization_code: 'synthetic-code', code_verifier: 'synthetic-verifier' });
    return json(tokens());
  }));

  await store.login((value) => { announced = value; });

  assert.equal(announced.url, `${ISSUER}/codex/device`);
  assert.equal(announced.code, 'ABCD-EFGH');

  await rm(root, { recursive: true, force: true });
});

test('device login reaches the dedicated store through exactly the three fixed endpoints', async () => {
  const root = await tempRoot('dsh-direct-test-');
  const urls = [];
  const store = new AuthStore(join(root, 'auth'), new Http(async (url) => {
    urls.push(url);
    if (url.endsWith('/usercode')) return json({ device_auth_id: 'synthetic-device', user_code: 'ABCD-EFGH', interval: 0 });
    if (url.endsWith('/deviceauth/token')) return json({ authorization_code: 'synthetic-code', code_verifier: 'synthetic-verifier' });
    return json(tokens());
  }));

  await store.login(() => {});

  assert.equal(urls.length, 3);

  await rm(root, { recursive: true, force: true });
});

test('device login stores a grant the dedicated store can read back', async () => {
  const root = await tempRoot('dsh-direct-test-');
  const store = new AuthStore(join(root, 'auth'), new Http(async (url) => {
    if (url.endsWith('/usercode')) return json({ device_auth_id: 'synthetic-device', user_code: 'ABCD-EFGH', interval: 0 });
    if (url.endsWith('/deviceauth/token')) return json({ authorization_code: 'synthetic-code', code_verifier: 'synthetic-verifier' });
    return json(tokens());
  }));

  await store.login(() => {});

  assert.equal(claims(await store.token()).exp > Date.now() / 1000, true);

  await rm(root, { recursive: true, force: true });
});

test('a cancelled login never replaces an existing grant', async () => {
  const root = await tempRoot('dsh-direct-test-');
  const controller = new AbortController();
  const store = new AuthStore(join(root, 'auth'), new Http(async () => json({ device_auth_id: 'synthetic-device', user_code: 'ABCD-EFGH', interval: 5 })));
  await store.transaction(() => store.write(tokens()));
  const original = await readFile(join(root, 'auth/auth.json'), 'utf8');

  await assert.rejects(store.login(() => controller.abort(), controller.signal), { code: 'ABORTED' });

  assert.equal(await readFile(join(root, 'auth/auth.json'), 'utf8'), original);

  await store.logout();
  await rm(root, { recursive: true, force: true });
});

test('device login honors slow_down backoff', async () => {
  const root = await tempRoot('dsh-direct-test-');
  let polls = 0;
  const store = new AuthStore(join(root, 'auth'), new Http(async (url) => {
    if (url.endsWith('/usercode')) return json({ device_auth_id: 'synthetic-device', user_code: 'ABCD-EFGH', interval: 0 });
    if (url.endsWith('/deviceauth/token')) {
      polls += 1;
      return polls === 1 ? json({ error: 'slow_down' }, 400) : json({ authorization_code: 'synthetic-code', code_verifier: 'synthetic-verifier' });
    }
    return json(tokens());
  }));

  await store.login(() => {});

  assert.equal(polls, 2);

  await rm(root, { recursive: true, force: true });
});

test('a terminal poll result is refused and leaves no grant', async () => {
  const root = await tempRoot('dsh-direct-test-');
  const store = new AuthStore(join(root, 'auth'), new Http(async (url) => {
    if (url.endsWith('/usercode')) return json({ device_auth_id: 'synthetic-device', user_code: 'ABCD-EFGH', interval: 0 });
    if (url.endsWith('/deviceauth/token')) return json({ error: 'expired_token' }, 403);
    return json(tokens());
  }));

  await assert.rejects(store.login(() => {}), { code: 'AUTH_REQUIRED' });

  await assert.rejects(store.transaction(() => store.read()), { code: 'AUTH_REQUIRED' });

  await rm(root, { recursive: true, force: true });
});

test('a paused stream deadline cancels its reader', async () => {
  let cancelled = false;
  const bridge = new DirectBridge({ token: async () => jwt() }, new Http(async (url) => {
    if (url.includes('/models?')) return json({ models: [model] });
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(Buffer.from(`data: ${JSON.stringify(delta)}\n\n`)); },
      cancel() { cancelled = true; },
    }), { headers: { 'content-type': 'text/event-stream' } });
  }), { turnTimeoutMs: 20 });
  const stream = bridge.stream(input());
  await stream.next();

  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.equal(cancelled, true);

  await stream.return();
  await bridge.close();
});

test('a paused stream deadline releases request capacity', async () => {
  const bridge = new DirectBridge({ token: async () => jwt() }, new Http(async (url) => {
    if (url.includes('/models?')) return json({ models: [model] });
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(Buffer.from(`data: ${JSON.stringify(delta)}\n\n`)); },
      cancel() {},
    }), { headers: { 'content-type': 'text/event-stream' } });
  }), { turnTimeoutMs: 20 });
  const stream = bridge.stream(input());
  await stream.next();

  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.equal(bridge.active.size, 0);

  await stream.return();
  await bridge.close();
});

test('a paused stream reports TIMEOUT after its deadline', async () => {
  const bridge = new DirectBridge({ token: async () => jwt() }, new Http(async (url) => {
    if (url.includes('/models?')) return json({ models: [model] });
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(Buffer.from(`data: ${JSON.stringify(delta)}\n\n`)); },
      cancel() {},
    }), { headers: { 'content-type': 'text/event-stream' } });
  }), { turnTimeoutMs: 20 });
  const stream = bridge.stream(input());
  await stream.next();

  await new Promise((resolve) => setTimeout(resolve, 40));

  await assert.rejects(stream.next(), { code: 'TIMEOUT' });

  await stream.return();
  await bridge.close();
});

test('refresh serialization holds across separate Node processes', async () => {
  const root = await tempRoot('dsh-direct-test-');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const store = new AuthStore(join(root, 'auth'));
  await store.transaction(() => store.write(tokens(1)));
  const code = `import {AuthStore} from ${JSON.stringify(new URL('../lib/auth.js', import.meta.url).href)};
import {Http} from ${JSON.stringify(new URL('../lib/http.js', import.meta.url).href)};
import {appendFile} from 'node:fs/promises';
const store=new AuthStore(${JSON.stringify(join(root, 'auth'))},new Http(async()=>{await appendFile(${JSON.stringify(join(root, 'refresh-count'))},'refresh\\n');await new Promise(resolve=>setTimeout(resolve,50));return Response.json(${JSON.stringify(tokens())});}));
await store.token();`;

  await Promise.all([1, 2].map(() => promisify(execFile)(process.execPath, ['--input-type=module', '-e', code], { timeout: 5000 })));

  assert.equal((await readFile(join(root, 'refresh-count'), 'utf8')).split('refresh').length - 1, 1);

  await rm(root, { recursive: true, force: true });
});

test('the catalog compatibility fallback does not invent unadvertised models', async () => {
  const urls = [];
  const bridge = new DirectBridge({ token: async () => jwt() }, new Http(async (url) => {
    urls.push(url);
    return json({ models: url.endsWith('99.0.0') ? [] : [model] });
  }));

  const models = await bridge.listModels();

  assert.deepEqual(models.map((value) => value.id), ['test-model']);
  assert.equal(urls.length, 2);
  assert.equal(urls[1].endsWith('0.0.0'), true);

  await bridge.close();
});

test('terminal text fills a missing delta', async () => {
  const bridge = bridgeForTurn([], sse(delta, { type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', id: 'message-1', role: 'assistant', content: [{ type: 'output_text', text: 'Hello!' }] }] } }));

  const chunks = await collect(bridge.stream(input()));

  assert.equal(chunks.find((chunk) => chunk.type === 'block-end').block.text, 'Hello!');

  await bridge.close();
});

test('terminal text that contradicts the streamed delta is refused', async () => {
  const bridge = bridgeForTurn([], sse(delta, { type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', id: 'message-1', role: 'assistant', content: [{ type: 'output_text', text: 'Different' }] }] } }));

  await assert.rejects(collect(bridge.stream(input())), { code: 'PROTOCOL_INVALID' });

  await bridge.close();
});

test('valid SSE is accepted independently of the response MIME header', async () => {
  for (const contentType of [null, 'application/octet-stream', 'application/json', 'text/event-stream']) {
    const bridge = new DirectBridge({ token: async () => jwt() }, new Http(async (url) => {
      if (url.includes('/models?')) return json({ models: [model] });
      const response = sse(delta, completed);
      if (contentType === null) response.headers.delete('content-type');
      else response.headers.set('content-type', contentType);
      return response;
    }));

    const chunks = await collect(bridge.stream(input()));

    assert.equal(chunks.at(-1).reason.kind, 'stop');

    await bridge.close();
  }
});

test('a non-SSE MIME header never turns HTML, JSON errors or truncated SSE into success', async () => {
  for (const body of ['<html>Upstream error</html>', JSON.stringify({ error: { message: 'synthetic-secret' } }), 'data: {"type":"response.completed"}\n', 'data: {"type":"unknown"}\n\n']) {
    const bridge = new DirectBridge({ token: async () => jwt() }, new Http(async (url) => url.includes('/models?') ? json({ models: [model] }) : new Response(body, { headers: { 'content-type': 'application/octet-stream' } })));

    await assert.rejects(collect(bridge.stream(input())), (error) => error.code === 'PROTOCOL_INVALID' && !error.message.includes('synthetic-secret'));

    await bridge.close();
  }
});

test('an ambiguous refresh retains durable intent', async () => {
  for (const mode of ['lost-reply', 'bad-json', 'failed-save', 'server-error']) {
    const root = await tempRoot('dsh-direct-test-');
    const directory = join(root, mode);
    const http = new Http(async () => {
      if (mode === 'lost-reply') throw new Error('synthetic-secret');
      if (mode === 'bad-json') return new Response('{', { status: 200 });
      if (mode === 'server-error') return json({}, 500);
      return json({ ...tokens(), refresh_token: 'rotated' });
    });
    const store = new AuthStore(directory, http);
    await store.transaction(() => store.write(tokens(1)));
    if (mode === 'failed-save') store.write = async () => { throw new Error('synthetic-save-failure'); };

    await assert.rejects(store.token());

    assert.equal(JSON.parse(await readFile(join(directory, 'auth.json'), 'utf8')).refresh_pending, true);

    await rm(root, { recursive: true, force: true });
  }
});

test('an ambiguous refresh never resends the old grant', async () => {
  for (const mode of ['lost-reply', 'bad-json', 'failed-save', 'server-error']) {
    const root = await tempRoot('dsh-direct-test-');
    const directory = join(root, mode);
    let calls = 0;
    const http = new Http(async () => {
      calls += 1;
      if (mode === 'lost-reply') throw new Error('synthetic-secret');
      if (mode === 'bad-json') return new Response('{', { status: 200 });
      if (mode === 'server-error') return json({}, 500);
      return json({ ...tokens(), refresh_token: 'rotated' });
    });
    const store = new AuthStore(directory, http);
    await store.transaction(() => store.write(tokens(1)));
    if (mode === 'failed-save') store.write = async () => { throw new Error('synthetic-save-failure'); };
    await assert.rejects(store.token());

    const other = new AuthStore(directory, http);

    await assert.rejects(other.token(), { code: 'AUTH_REQUIRED' });

    assert.equal(calls, 1);

    await rm(root, { recursive: true, force: true });
  }
});

test('a persisted pre-dispatch refresh intent blocks replay after process restart', async () => {
  const root = await tempRoot('dsh-direct-test-');
  const directory = join(root, 'auth');
  const store = new AuthStore(directory);
  await store.transaction(() => store.writeState({ version: 1, mode: 'chatgpt', ...tokens(1), refresh_pending: true }));
  let calls = 0;
  const restarted = new AuthStore(directory, new Http(async () => {
    calls += 1;
    return json(tokens());
  }));

  await assert.rejects(restarted.token(), { code: 'AUTH_REQUIRED' });

  assert.equal(calls, 0);

  await rm(root, { recursive: true, force: true });
});

test('empty text deltas are accepted without inventing text', async () => {
  const bridge = bridgeForTurn([], sse({ ...delta, delta: '' }, delta, { ...delta, delta: '' }, { ...delta, type: 'response.output_text.done', text: 'Hello' }, completed));

  const chunks = await collect(bridge.stream(input()));

  assert.deepEqual(chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text), ['Hello']);

  await bridge.close();
});

test('empty text deltas do not open or close an extra block', async () => {
  const bridge = bridgeForTurn([], sse({ ...delta, delta: '' }, delta, { ...delta, type: 'response.output_text.done', text: 'Hello' }, completed));

  const chunks = await collect(bridge.stream(input()));

  assert.equal(chunks.filter((chunk) => chunk.type === 'block-start').length, 1);
  assert.equal(chunks.filter((chunk) => chunk.type === 'block-end').length, 1);

  await bridge.close();
});

test('an invalid delta type is refused', async () => {
  for (const value of [null, 1, {}]) {
    const bridge = bridgeForTurn([], sse({ ...delta, delta: value }, completed));

    await assert.rejects(collect(bridge.stream(input())), { code: 'PROTOCOL_INVALID' });

    await bridge.close();
  }
});

test('a delta past the output bound is refused', async () => {
  const bridge = bridgeForTurn([], sse({ ...delta, delta: 'x'.repeat(256 * 1024 + 1) }, completed));

  await assert.rejects(collect(bridge.stream(input())), { code: 'PROTOCOL_INVALID' });

  await bridge.close();
});

test('diagnostics use fixed allowlisted labels', async () => {
  assert.equal(failure(new BridgeError('PROTOCOL_INVALID', 'SSE_FRAME')).message.endsWith('[SSE_FRAME]'), true);
  assert.equal(new BridgeError('__proto__', 'synthetic-secret').code, 'UPSTREAM_FAILED');
});

test('diagnostics discard a mutable upstream message', async () => {
  const unsafe = new BridgeError('PROTOCOL_INVALID', 'synthetic-secret');
  unsafe.message = 'synthetic-secret';

  assert.equal(failure(unsafe).message.includes('synthetic-secret'), false);
  assert.equal(failure(new Error('synthetic-secret')).message.includes('synthetic-secret'), false);
});

test('an upstream-authored diagnostic label is dropped', async () => {
  const unknownLabel = new BridgeError('PROTOCOL_INVALID', 'synthetic_secret');

  assert.equal(unknownLabel.diagnostic, undefined);
  assert.equal(unknownLabel.message.includes('synthetic_secret'), false);
});

test('the quota hint is bounded', async () => {
  assert.equal(failure(new BridgeError('QUOTA', undefined, { resetMinutes: 90 })).message.endsWith('Try again in about 90 minutes.'), true);
  assert.equal(new BridgeError('QUOTA', undefined, { resetMinutes: 0 }).message, 'The ChatGPT plan usage limit was reached.');
  assert.equal(new BridgeError('QUOTA', undefined, { resetMinutes: 20000 }).message, 'The ChatGPT plan usage limit was reached.');
});

test('the stream labels each consumed branch with its own diagnostic', async () => {
  for (const [response, label] of [
    [new Response('data: {\n\n'), 'SSE_FRAME'],
    [sse({ ...delta, delta: null }), 'SSE_TEXT_DELTA'],
    [sse({ type: 'response.completed', response: { status: 'incomplete' } }), 'SSE_TERMINAL'],
    [sse(delta), 'SSE_INCOMPLETE'],
  ]) {
    const bridge = bridgeForTurn([], response);

    await assert.rejects(collect(bridge.stream(input())), (error) => error.diagnostic === label && !error.message.includes('synthetic_secret'));

    await bridge.close();
  }
});

test('a content-free notification never discards a completed answer', async () => {
  for (const events of [
    [delta, { ...delta, type: 'response.output_text.done', text: 'Hello' }, { type: 'response.metadata', metadata: { synthetic: true } }, completed],
    [{ type: 'response.metadata' }, delta, { ...delta, type: 'response.output_text.done', text: 'Hello' }, completed],
    [{ type: 'response.web_search_call.in_progress', item_id: 'ws-1' }, delta, { ...delta, type: 'response.output_text.done', text: 'Hello' }, completed],
    [{ type: 'response.code_interpreter_call_code.delta', item_id: 'ci-1', delta: 'synthetic' }, delta, { ...delta, type: 'response.output_text.done', text: 'Hello' }, completed],
    [{ type: 'response.output_text.annotation.added', item_id: 'message-1', content_index: 0, annotation: { type: 'url_citation' } }, delta, { ...delta, type: 'response.output_text.done', text: 'Hello' }, completed],
    [{ type: 'response.image_generation_call.generating', item_id: 'ig-1' }, delta, { ...delta, type: 'response.output_text.done', text: 'Hello' }, completed],
    [{ type: 'response.reasoning_summary.delta', item_id: 'r-1', delta: 'synthetic' }, delta, { ...delta, type: 'response.output_text.done', text: 'Hello' }, completed],
    [{ type: 'response.reasoning_part.added', item_id: 'r-1' }, delta, { ...delta, type: 'response.output_text.done', text: 'Hello' }, completed],
  ]) {
    const bridge = bridgeForTurn([], sse(...events));

    const chunks = await collect(bridge.stream(input()));

    assert.equal(chunks.at(-1).reason.kind, 'stop');

    await bridge.close();
  }
});

test('an unrecognized notification is ignored rather than fatal', async () => {
  for (const type of ['response.synthetic_unknown', 'response.web_search_call.synthetic_suffix', 'response.web_search_call', 'response.output_text.annotation.synthetic']) {
    const bridge = bridgeForTurn([], sse(delta, { type }, completed));

    const chunks = await collect(bridge.stream(input()));

    assert.equal(chunks.at(-1).reason.kind, 'stop');

    await bridge.close();
  }
});

test('an unrecognized notification cannot inject text', async () => {
  const bridge = bridgeForTurn([], sse(
    { type: 'response.synthetic_unknown', delta: 'injected', text: 'injected', item: { type: 'function_call', call_id: 'c-1', name: 'shell', arguments: '{}' }, response: { usage: { input_tokens: 9, output_tokens: 9 } } },
    delta, completed));

  const chunks = await collect(bridge.stream(input()));

  assert.equal(chunks.find((chunk) => chunk.type === 'text-delta').text, 'Hello');

  await bridge.close();
});

test('an unrecognized notification cannot inject a tool call', async () => {
  const bridge = bridgeForTurn([], sse(
    { type: 'response.synthetic_unknown', delta: 'injected', text: 'injected', item: { type: 'function_call', call_id: 'c-1', name: 'shell', arguments: '{}' }, response: { usage: { input_tokens: 9, output_tokens: 9 } } },
    delta, completed));

  const chunks = await collect(bridge.stream(input()));

  assert.equal(chunks.some((chunk) => chunk.type === 'tool-call-delta'), false);

  await bridge.close();
});

test('an unrecognized notification cannot inject usage', async () => {
  const bridge = bridgeForTurn([], sse(
    { type: 'response.synthetic_unknown', delta: 'injected', text: 'injected', item: { type: 'function_call', call_id: 'c-1', name: 'shell', arguments: '{}' }, response: { usage: { input_tokens: 9, output_tokens: 9 } } },
    delta, completed));

  const chunks = await collect(bridge.stream(input()));

  assert.equal(chunks.some((chunk) => chunk.type === 'usage'), false);

  await bridge.close();
});