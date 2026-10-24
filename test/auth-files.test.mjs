import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, open, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AuthStore } from '../lib/auth.js';

const run = promisify(execFile);

/** A synthetic grant that is valid for an hour. */
const grant = { access_token: `x.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, 'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic-account' } })).toString('base64url')}.x`, refresh_token: 'synthetic-refresh-secret' };

/** A child that reads the credential file, keeps the original exit status, and prints the refusal code it got. */
function childCode(directory) {
  return `import { AuthStore } from ${JSON.stringify(new URL('../lib/auth.js', import.meta.url).href)};
try { await new AuthStore(${JSON.stringify(directory)}).token(); process.exitCode = 1; }
catch (error) { if (error.code !== 'AUTH_STORE_INVALID') process.exitCode = 2; else console.log(error.code); }`;
}

/** The FileHandle read patched to serve at most three bytes per call, counting the calls. */
function shortReads(handle) {
  const reads = { value: 0 };
  const original = handle.read;
  handle.read = function (buffer, offset, length, position) {
    if (position === undefined || position >= 0) reads.value += 1;
    return original.call(this, buffer, offset, Math.min(length, 3), position);
  };
  return { reads, restore: () => { handle.read = original; } };
}

test('a special credential file is refused without blocking', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-special-file-'));
  const directory = join(root, 'auth');
  await mkdir(directory, { mode: 0o700 });
  await run('/usr/bin/mkfifo', ['-m', '600', join(directory, 'auth.json')]);

  const result = await run(process.execPath, ['--input-type=module', '-e', childCode(directory)], { timeout: 1500 });

  assert.equal(result.stdout.trim(), 'AUTH_STORE_INVALID');

  await rm(root, { recursive: true, force: true });
});

test('a special credential file does not retain the store lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-special-file-'));
  const directory = join(root, 'auth');
  await mkdir(directory, { mode: 0o700 });
  await run('/usr/bin/mkfifo', ['-m', '600', join(directory, 'auth.json')]);

  await run(process.execPath, ['--input-type=module', '-e', childCode(directory)], { timeout: 1500 });

  await assert.rejects(access(join(directory, 'auth.lock')), { code: 'ENOENT' });

  await rm(root, { recursive: true, force: true });
});

test('a credential path taken by a directory is refused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-special-file-'));
  const directory = join(root, 'auth');
  await mkdir(directory, { mode: 0o700 });
  await mkdir(join(directory, 'auth.json'), { mode: 0o700 });

  await assert.rejects(new AuthStore(directory).token(), { code: 'AUTH_STORE_INVALID' });

  await rm(root, { recursive: true, force: true });
});

test('credential reads are split into short reads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-special-file-'));
  const store = new AuthStore(join(root, 'auth'));
  await store.prepare();
  await store.transaction(() => store.write(grant));
  const probe = await open(join(root, 'probe'), 'w');
  const handle = Object.getPrototypeOf(probe);
  const { reads, restore } = shortReads(handle);
  await probe.close();

  await store.token();

  assert.equal(reads.value > 1, true);

  restore();
  await rm(root, { recursive: true, force: true });
});

test('a credential read reassembles the grant across short reads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-special-file-'));
  const store = new AuthStore(join(root, 'auth'));
  await store.prepare();
  await store.transaction(() => store.write(grant));
  const probe = await open(join(root, 'probe'), 'w');
  const handle = Object.getPrototypeOf(probe);
  const { restore } = shortReads(handle);
  await probe.close();

  const token = await store.token();

  assert.equal(typeof token, 'string');
  assert.equal(token.split('.').length, 3);

  restore();
  await rm(root, { recursive: true, force: true });
});
