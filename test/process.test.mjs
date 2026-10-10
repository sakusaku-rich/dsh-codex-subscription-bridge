import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { RpcProcess, childEnvironment, executablePath, MAX_FRAME } from '../src/process.js';
import { failure } from '../src/errors.js';
const fakePath = fileURLToPath(new URL('./fake-server.mjs', import.meta.url));
const rpc = (mode, options = {}) => new RpcProcess(process.execPath, [fakePath, mode], { env: {}, timeoutMs: 500, ...options });
test('child environment excludes API keys, tokens, proxies, PATH, and Node injection', () => {
  assert.deepEqual(childEnvironment({ HOME: '/synthetic/home', CODEX_HOME: '/synthetic/codex', OPENAI_API_KEY: 'secret-test-value', NODE_OPTIONS: '--require=bad', HTTPS_PROXY: 'http://bad', PATH: '/bad', TOKEN: 'secret-test-value' }), { LANG: 'C.UTF-8', HOME: '/synthetic/home', CODEX_HOME: '/synthetic/codex' });
});
test('relative executable and nonexistent executable are rejected', async () => {
  await assert.rejects(executablePath('codex'), { code: 'CONFIG_INVALID' });
  await assert.rejects(executablePath('/definitely/not/present'), { code: 'CONFIG_INVALID' });
  assert.equal(await executablePath(process.execPath), process.execPath);
});
test('real synthetic process handles requests and closes idempotently', async () => {
  const client = rpc('normal');
  assert.deepEqual(await client.request('test'), { ok: true });
  await Promise.all([client.close(), client.close()]);
  assert.ok(client.child.exitCode !== null || client.child.signalCode !== null);
});
for (const [mode, code] of [['error', 'UPSTREAM_FAILED'], ['malformed', 'PROTOCOL_INVALID'], ['oversized', 'LIMIT_EXCEEDED'], ['utf8', 'PROTOCOL_INVALID'], ['stderr-flood', 'LIMIT_EXCEEDED'], ['hang', 'TIMEOUT']]) {
  test(`process ${mode} produces a bounded credential-safe failure`, async () => {
    const client = rpc(mode);
    try { await assert.rejects(client.request('test'), (error) => {
      assert.equal(error.code, code);
      assert.equal(JSON.stringify(failure(error)).includes('secret-test-value'), false);
      return true;
    }); } finally { await client.close(); }
    assert.equal(client.pending.size, 0);
    assert.equal(client.events.length, 0);
  });
}
test('termination-resistant child is killed within the shutdown bound', async () => {
  const client = rpc('ignore-term', { shutdownMs: 30 });
  await client.request('ready');
  await client.close();
  assert.equal(client.child.signalCode, 'SIGKILL');
});
test('abort stops an unresponsive real child', async () => {
  const client = rpc('hang'); const controller = new AbortController();
  const promise = client.request('test', {}, controller.signal);
  controller.abort();
  await assert.rejects(promise, { code: 'ABORTED' });
  await client.close();
});
test('unsolicited responses and notification floods fail closed', async () => {
  const client = rpc('normal');
  assert.throws(() => client.dispatch({ id: 999, result: {} }), { code: 'PROTOCOL_INVALID' });
  assert.throws(() => {
    for (let i = 0; i < 129; i++) client.dispatch({ method: 'thread/started', params: {} });
  }, { code: 'LIMIT_EXCEEDED' });
  await client.close();
});
test('message nesting and aggregate notification bytes are bounded', async () => {
  const client = rpc('normal');
  let nested = {}; for (let i = 0; i < 34; i++) nested = { nested };
  assert.throws(() => client.dispatch({ method: 'event', params: nested }), { code: 'LIMIT_EXCEEDED' });
  assert.throws(() => {
    client.dispatch({ method: 'event', params: { text: 'x'.repeat(MAX_FRAME / 2) } });
    client.dispatch({ method: 'event', params: { text: 'x'.repeat(MAX_FRAME / 2) } });
  }, { code: 'LIMIT_EXCEEDED' });
  await client.close();
});
