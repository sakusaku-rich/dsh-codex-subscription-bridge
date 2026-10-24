import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const run = promisify(execFile);

/** A child that holds the store lock, releases it from the contender's mkdir hook under `scenario`, and reports what the contender did. */
async function race(root, scenario) {
  const driver = `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
const original = fs.promises.mkdir;
let hook;
fs.promises.mkdir = async (path, options) => {
  try { return await original(path, options); }
  catch (error) { if (path.endsWith('/auth.lock') && error.code === 'EEXIST') await hook?.(path); throw error; }
};
syncBuiltinESMExports();
const { AuthStore } = await import(${JSON.stringify(new URL('../lib/auth.js', import.meta.url).href)});
const root = ${JSON.stringify(root)};
const scenario = ${JSON.stringify(scenario)};
const originalNow = Date.now;
try {
  let release, entered, ownerDone;
  const controller = new AbortController();
  const directory = join(root, scenario);
  const store = new AuthStore(directory);
  const ready = new Promise((resolve) => { entered = resolve; });
  const wait = new Promise((resolve) => { release = resolve; });
  ownerDone = store.transaction(async () => { entered(); await wait; });
  await ready;
  hook = async (path) => {
    hook = undefined;
    release();
    await ownerDone;
    if (scenario === 'insecure') await original(path, { mode: 0o777 }).then(() => fs.promises.chmod(path, 0o777));
    if (scenario === 'symlink') await fs.promises.symlink(directory, path);
    if (scenario === 'aborted') controller.abort();
    if (scenario === 'deadline') Date.now = () => originalNow() + 60000;
  };
  let ran = false;
  try {
    await new AuthStore(directory).transaction(async () => { ran = true; }, controller.signal);
    console.log(JSON.stringify({ ran, code: null }));
  }
  catch (error) { console.log(JSON.stringify({ ran, code: error.code })); }
}
finally {
  Date.now = originalNow;
  fs.promises.mkdir = original;
  syncBuiltinESMExports();
}
`;

  const result = await run(process.execPath, ['--input-type=module', '-e', driver], { timeout: 5000 });
  return JSON.parse(result.stdout);
}

test('a lock released by its owner is retried by the contender', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lock-regression-'));

  const outcome = await race(root, 'released');

  assert.equal(outcome.ran, true);

  await rm(root, { recursive: true, force: true });
});

test('a lock created with an insecure mode is refused without running the contender', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lock-regression-'));

  const outcome = await race(root, 'insecure');

  assert.equal(outcome.code, 'AUTH_STORE_INVALID');
  assert.equal(outcome.ran, false);

  await rm(root, { recursive: true, force: true });
});

test('a lock path that is a symlink is refused without running the contender', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lock-regression-'));

  const outcome = await race(root, 'symlink');

  assert.equal(outcome.code, 'AUTH_STORE_INVALID');
  assert.equal(outcome.ran, false);

  await rm(root, { recursive: true, force: true });
});

test('a contender cancelled before its retry never runs its transaction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lock-regression-'));

  const outcome = await race(root, 'aborted');

  assert.equal(outcome.code, 'ABORTED');
  assert.equal(outcome.ran, false);

  await rm(root, { recursive: true, force: true });
});

test('a contender past the deadline is refused as busy without running its transaction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lock-regression-'));

  const outcome = await race(root, 'deadline');

  assert.equal(outcome.code, 'AUTH_BUSY');
  assert.equal(outcome.ran, false);

  await rm(root, { recursive: true, force: true });
});
