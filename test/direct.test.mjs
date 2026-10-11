import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readFile, symlink, chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DirectBridge, events } from '../src/direct.js';
import { AuthStore, claims } from '../src/auth.js';
import { Http, BASE, ISSUER } from '../src/http.js';
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
    await assert.rejects(store.token(), { code: status === 400 ? 'AUTH_REQUIRED' : 'RATE_LIMITED' });
    await assert.rejects(store.token(), { code: status === 400 ? 'AUTH_REQUIRED' : 'RATE_LIMITED' });
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
  assert.equal(calls, 0); await assert.rejects(http.json(`${BASE}/models`), error => error.code === 'UPSTREAM_FAILED' && !error.message.includes('secret-token'));
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
  auth.token = async () => { throw Object.assign(new Error(), { code: 'AUTH_REQUIRED' }); };
  await assert.rejects(bridge.listModels(), { code: 'AUTH_REQUIRED' }); await bridge.close();
});
test('stream sends only bounded text, no tools, no persistence, and normalizes deltas', async () => {
  const calls = []; const bridge = new DirectBridge({ token: async () => jwt() }, new Http(async (url, options) => {
    calls.push({ url, options }); return url.includes('/models?') ? json({ models: [model] }) : sse(delta, { ...delta, type: 'response.output_text.done', text: 'Hello!' }, completed);
  }));
  const chunks = await collect(bridge.stream(input({ tools: [{ name: 'shell' }] })));
  assert.equal(chunks.at(-1).reason.kind, 'stop'); assert.equal(chunks.find(chunk => chunk.type === 'block-end').block.text, 'Hello!');
  const body = JSON.parse(calls.at(-1).options.body); assert.equal(body.store, false); assert.equal(body.stream, true); assert.equal(body.tools, undefined);
  assert.equal(calls.at(-1).options.headers['ChatGPT-Account-ID'], 'synthetic-account');
  await bridge.close();
});
test('EOF, native tool calls, failure, malformed catalogs, and rate limits fail safely', async () => {
  for (const response of [sse(delta), sse({ type: 'response.output_item.added', item: { type: 'function_call' } }), sse({ type: 'response.failed', response: { error: { message: 'secret' } } }), json({}, 429)]) {
    const bridge = new DirectBridge({ token: async () => jwt() }, new Http(async url => url.includes('/models?') ? json({ models: [model] }) : response));
    await assert.rejects(collect(bridge.stream(input())), error => ['PROTOCOL_INVALID', 'UPSTREAM_FAILED', 'RATE_LIMITED'].includes(error.code) && !error.message.includes('secret'));
    await bridge.close();
  }
  const bridge = new DirectBridge({ token: async () => jwt() }, new Http(async () => json({ models: [{ ...model, visibility: 'bogus' }] })));
  await assert.rejects(bridge.listModels(), { code: 'PROTOCOL_INVALID' }); await bridge.close();
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
  const code = `import {AuthStore} from ${JSON.stringify(new URL('../src/auth.js', import.meta.url).href)};
import {Http} from ${JSON.stringify(new URL('../src/http.js', import.meta.url).href)};
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
