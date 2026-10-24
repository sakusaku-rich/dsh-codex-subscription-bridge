import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,open} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {AuthStore} from '../lib/auth.js';
async function fixture(task) { const root=await mkdtemp(join(tmpdir(),'dsh-special-file-')); try{return await task(root);}finally{await rm(root,{recursive:true,force:true});} }
test('special credential files are refused without blocking or retaining the store lock', () => fixture(async root => {
  const { execFile } = await import('node:child_process'); const { promisify } = await import('node:util');
  const run = promisify(execFile); const directory = join(root, 'auth'); await mkdir(directory, { mode: 0o700 });
  await run('/usr/bin/mkfifo', ['-m', '600', join(directory, 'auth.json')]);
  const code = `import {AuthStore} from ${JSON.stringify(new URL('../lib/auth.js', import.meta.url).href)};
try{await new AuthStore(${JSON.stringify(directory)}).token();process.exitCode=1;}catch(error){if(error.code!=='AUTH_STORE_INVALID')process.exitCode=2;}`;
  await run(process.execPath, ['--input-type=module', '-e', code], { timeout: 1500 });
  const { access } = await import('node:fs/promises');
  await assert.rejects(access(join(directory, 'auth.lock')), { code: 'ENOENT' });
  await rm(join(directory, 'auth.json')); await mkdir(join(directory, 'auth.json'), { mode: 0o700 });
  await assert.rejects(new AuthStore(directory).token(), { code: 'AUTH_STORE_INVALID' });
}));
test('credential reads survive short file reads', () => fixture(async root => {
  const store = new AuthStore(join(root, 'auth')); await store.prepare();
  const access = { access_token: `x.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, 'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic-account' } })).toString('base64url')}.x`, refresh_token: 'synthetic-refresh-secret' };
  await store.transaction(() => store.write(access));
  // Force three-byte reads so a single read cannot return the whole file.
  const probe = await open(join(root, 'probe'), 'w'); const handle = Object.getPrototypeOf(probe); await probe.close();
  const original = handle.read; let reads = 0;
  handle.read = function (buffer, offset, length, position) {
    if (position === undefined || position >= 0) reads++;
    return original.call(this, buffer, offset, Math.min(length, 3), position);
  };
  try {
    const token = await store.token();
    assert.equal(reads > 1, true); // several short reads were actually issued
    assert.equal(typeof token, 'string'); assert.equal(token.split('.').length, 3);
  } finally { handle.read = original; }
}));
