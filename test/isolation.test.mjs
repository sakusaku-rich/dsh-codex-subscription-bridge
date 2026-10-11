import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, stat } from 'node:fs/promises';
import { prepareRuntime, isolatedArguments, verifyVersion } from '../src/isolation.js';

test('private runtime replaces paths without copying authentication or configuration', async () => {
  const runtime = await prepareRuntime();
  try {
    assert.equal((await stat(runtime.root)).mode & 0o777, 0o700);
    assert.equal((await stat(runtime.lock)).mode & 0o777, 0o600);
    const lock = await readFile(runtime.lock, 'utf8');
    assert.equal(lock.includes('__BRIDGE_RUNTIME__'), false);
    assert.ok(lock.includes('forced_login_method = "chatgpt"'));
    for (const flag of ['shell_tool', 'unified_exec', 'hooks', 'plugins', 'apps', 'remote_models']) assert.ok(lock.includes(`${flag} = false`));
    assert.ok(lock.includes('[config.mcp_servers]\n\n'));
    assert.ok(lock.includes('[config.model_providers]\n\n'));
    assert.ok(lock.includes('project_doc_max_bytes = 0'));
    assert.deepEqual(isolatedArguments(runtime.lock).slice(0, 2), ['app-server', '--stdio']);
  } finally { await runtime.remove(); await runtime.remove(); }
  await assert.rejects(access(runtime.root));
});
test('non-Codex executable cannot pass exact version admission', async () => {
  const runtime = await prepareRuntime();
  try { await assert.rejects(verifyVersion(process.execPath, runtime), { code: 'VERSION_UNSUPPORTED' }); }
  finally { await runtime.remove(); }
});
