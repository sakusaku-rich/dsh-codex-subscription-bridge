import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, access, chmod, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AuthStore } from '../lib/auth.js';

const grantToken = 'x.' + Buffer.from(JSON.stringify({ exp: 1, 'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic-account' } })).toString('base64url') + '.x';

/** A store whose network seam counts calls and fails if the doctor ever uses it. */
function storeAt(directory, calls) {
  return new AuthStore(directory, { open() { calls.value += 1; throw new Error('Network must not run'); } });
}

test('doctor reports a missing store without creating it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-doctor-'));
  const directory = join(root, 'auth');
  const store = storeAt(directory, { value: 0 });

  const result = await store.doctor();

  assert.equal(result.store, 'missing');
  await assert.rejects(access(directory), { code: 'ENOENT' });

  await rm(root, { recursive: true, force: true });
});

test('doctor reports a prepared store with no grant as missing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-doctor-'));
  const directory = join(root, 'auth');
  const store = storeAt(directory, { value: 0 });
  await store.prepare();

  const result = await store.doctor();

  assert.equal(result.auth, 'missing');

  await rm(root, { recursive: true, force: true });
});

test('doctor reports an expired grant without refreshing it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-doctor-'));
  const directory = join(root, 'auth');
  const calls = { value: 0 };
  const store = storeAt(directory, calls);
  await store.prepare();
  await store.transaction(() => store.write({ access_token: grantToken, refresh_token: 'synthetic-secret' }));

  const result = await store.doctor();

  assert.equal(result.auth, 'expired');
  assert.equal(calls.value, 0);

  await rm(root, { recursive: true, force: true });
});

test('doctor output carries no credential value', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-doctor-'));
  const directory = join(root, 'auth');
  const store = storeAt(directory, { value: 0 });
  await store.prepare();
  await store.transaction(() => store.write({ access_token: grantToken, refresh_token: 'synthetic-secret' }));

  const result = await store.doctor();

  assert.equal(JSON.stringify(result).includes('synthetic'), false);

  await rm(root, { recursive: true, force: true });
});

test('doctor does not modify the store it reads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-doctor-'));
  const directory = join(root, 'auth');
  const store = storeAt(directory, { value: 0 });
  await store.prepare();
  await store.transaction(() => store.write({ access_token: grantToken, refresh_token: 'synthetic-secret' }));
  const before = await readFile(join(directory, 'auth.json'), 'utf8');

  await store.doctor();

  assert.equal(await readFile(join(directory, 'auth.json'), 'utf8'), before);

  await rm(root, { recursive: true, force: true });
});

test('doctor reports a lock it cannot attribute', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-doctor-'));
  const directory = join(root, 'auth');
  const store = storeAt(directory, { value: 0 });
  await store.prepare();
  await mkdir(join(directory, 'auth.lock'), { mode: 0o700 });

  const result = await store.doctor();

  assert.equal(result.lock, 'present_owner_unknown');

  await rm(join(directory, 'auth.lock'), { recursive: true });
  await rm(root, { recursive: true, force: true });
});

test('doctor leaves a lock it cannot attribute in place', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-doctor-'));
  const directory = join(root, 'auth');
  const store = storeAt(directory, { value: 0 });
  await store.prepare();
  await mkdir(join(directory, 'auth.lock'), { mode: 0o700 });

  await store.doctor();

  assert.ok(await stat(join(directory, 'auth.lock')));

  await rm(join(directory, 'auth.lock'), { recursive: true });
  await rm(root, { recursive: true, force: true });
});

test('doctor reports a quarantined grant as requiring a fresh login', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-doctor-'));
  const directory = join(root, 'auth');
  const store = storeAt(directory, { value: 0 });
  await store.prepare();
  await store.transaction(() => store.writeState({ version: 1, mode: 'chatgpt', refresh_pending: true }));

  const result = await store.doctor();

  assert.equal(result.auth, 'relogin_required');

  await rm(root, { recursive: true, force: true });
});

test('doctor reports insecure storage without repairing it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-doctor-'));
  const directory = join(root, 'auth');
  const store = storeAt(directory, { value: 0 });
  await store.prepare();
  await store.transaction(() => store.write({ access_token: grantToken, refresh_token: 'synthetic-secret' }));
  await chmod(join(directory, 'auth.json'), 0o644);

  const result = await store.doctor();

  assert.equal(result.auth, 'invalid');

  await rm(root, { recursive: true, force: true });
});
