import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

/** A quoted module specifier for the child driver. */
function specifier(path) {
  return JSON.stringify(new URL(path, import.meta.url).href);
}

/**
 * A child that mounts the plugin on a real service over a synthetic store and an
 * in-memory HTTPS seam, then runs `body` as its guarantee.
 */
function driver(body) {
  return `import assert from 'node:assert/strict';
import { Context } from ${specifier('../node_modules/@deepseek-ai/cordis/lib/index.js')};
import { LlmRuntime } from ${specifier('../node_modules/@deepseek-ai/dsh-llm/lib/index.js')};
import * as plugin from ${specifier('../lib/index.js')};
import { AuthStore, authDirectory } from ${specifier('../lib/auth.js')};
import { Http } from ${specifier('../lib/http.js')};
const token = 'x.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, 'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic' } })).toString('base64url') + '.x';
const store = new AuthStore(authDirectory(process.env));
await store.transaction(() => store.write({ access_token: token, refresh_token: 'synthetic' }));
Http.prototype.open = async (url) => url.includes('/models?') ? Response.json({ models: [{ slug: 'synthetic-model', display_name: 'Synthetic', visibility: 'list', context_window: 272000 }] }) : new Response('data: ' + JSON.stringify({ type: 'response.output_text.delta', item_id: 'item', content_index: 0, delta: 'Synthetic response' }) + '\\n\\ndata: ' + JSON.stringify({ type: 'response.completed', response: { status: 'completed' } }) + '\\n\\n', { headers: { 'content-type': 'text/event-stream' } });
const ctx = new Context();
const service = ctx.plugin(LlmRuntime);
const fiber = ctx.plugin(plugin);
await new Promise((resolve) => setImmediate(resolve));
${body}
await fiber.dispose();
await service.dispose();`;
}

/** A driver child running in an isolated home, with the kill timer that bounds it. */
function spawnChild(root) {
  const child = spawn(process.execPath, [join(root, 'driver.mjs')], { env: { HOME: root, LANG: 'C.UTF-8', ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
  const stderr = { value: '' };
  child.stderr.on('data', (bytes) => { stderr.value += bytes; });
  child.stdout.resume();
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  return { child, stderr, timer };
}

test('the adapter lists models from the synthetic direct HTTPS response', { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-direct-plugin-'));
  await writeFile(join(root, 'driver.mjs'), driver(`assert.equal((await ctx.llm.listModels('codex-subscription'))[0].id, 'synthetic-model');`));
  const { child, stderr, timer } = spawnChild(root);

  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });

  assert.equal(code, 0, stderr.value);

  clearTimeout(timer);
  await rm(root, { recursive: true, force: true });
});

test('the adapter reports the model context window from the synthetic response', { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-direct-plugin-'));
  await writeFile(join(root, 'driver.mjs'), driver(`const info = await ctx.llm.resolveModelInfo('codex-subscription', 'synthetic-model');
assert.deepEqual(info.context, { contextWindow: 272000 });`));
  const { child, stderr, timer } = spawnChild(root);

  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });

  assert.equal(code, 0, stderr.value);

  clearTimeout(timer);
  await rm(root, { recursive: true, force: true });
});

test('the adapter ends the synthetic stream with a stop reason', { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-direct-plugin-'));
  await writeFile(join(root, 'driver.mjs'), driver(`const chunks = [];
for await (const chunk of ctx.llm.stream({ provider: 'codex-subscription', model: 'synthetic-model', messages: [{ role: 'user', content: [{ type: 'text', text: 'Synthetic prompt' }] }] })) chunks.push(chunk);
assert.equal(chunks.at(-1).reason.kind, 'stop');`));
  const { child, stderr, timer } = spawnChild(root);

  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });

  assert.equal(code, 0, stderr.value);

  clearTimeout(timer);
  await rm(root, { recursive: true, force: true });
});

test('the adapter yields the synthetic text delta', { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-direct-plugin-'));
  await writeFile(join(root, 'driver.mjs'), driver(`const chunks = [];
for await (const chunk of ctx.llm.stream({ provider: 'codex-subscription', model: 'synthetic-model', messages: [{ role: 'user', content: [{ type: 'text', text: 'Synthetic prompt' }] }] })) chunks.push(chunk);
assert.equal(chunks.find((chunk) => chunk.type === 'text-delta').text, 'Synthetic response');`));
  const { child, stderr, timer } = spawnChild(root);

  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });

  assert.equal(code, 0, stderr.value);

  clearTimeout(timer);
  await rm(root, { recursive: true, force: true });
});

test('the adapter refuses model listing after the store is logged out', { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-direct-plugin-'));
  await writeFile(join(root, 'driver.mjs'), driver(`await store.logout();
await assert.rejects(ctx.llm.listModels('codex-subscription'), { code: 'AUTH_REQUIRED' });`));
  const { child, stderr, timer } = spawnChild(root);

  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });

  assert.equal(code, 0, stderr.value);

  clearTimeout(timer);
  await rm(root, { recursive: true, force: true });
});
