import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AuthStore } from '../lib/auth.js';
import { Http, readJson } from '../lib/http.js';

/** A login seam that answers the device code, then errors the polling body when its signal aborts. */
function loginSeam(abort) {
  return new Http(async (url, options) => {
    if (url.endsWith('/usercode')) return Response.json({ device_auth_id: 'synthetic', user_code: 'ABCD-EFGH', interval: 0 });
    const body = new ReadableStream({ start(stream) {
      stream.enqueue(Buffer.from('{'));
      options.signal.addEventListener('abort', () => stream.error(new DOMException('Synthetic abort', 'AbortError')), { once: true });
    } });
    setTimeout(abort, 5);
    return new Response(body);
  });
}

/** A login seam whose pending-status body is already errored before the caller aborts. */
function pendingStatusSeam(abort) {
  return new Http(async (url, options) => {
    if (url.endsWith('/usercode')) return Response.json({ device_auth_id: 'synthetic', user_code: 'ABCD-EFGH', interval: 0 });
    const body = new ReadableStream({ start(stream) {
      options.signal.addEventListener('abort', () => stream.error(new DOMException('Synthetic abort', 'AbortError')), { once: true });
    } });
    queueMicrotask(abort);
    return new Response(body, { status: 403 });
  });
}

test('a cancelled login poll reports ABORTED', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-login-abort-'));
  const controller = new AbortController();
  const store = new AuthStore(join(root, 'auth'), loginSeam(() => controller.abort()));

  await assert.rejects(store.login(() => {}, controller.signal), { code: 'ABORTED' });

  await rm(root, { recursive: true, force: true });
});

test('a cancelled login poll leaves no credential file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-login-abort-'));
  const controller = new AbortController();
  const store = new AuthStore(join(root, 'auth'), loginSeam(() => controller.abort()));

  await assert.rejects(store.login(() => {}, controller.signal), { code: 'ABORTED' });

  await assert.rejects(readFile(join(root, 'auth/auth.json')), { code: 'ENOENT' });

  await rm(root, { recursive: true, force: true });
});

test('a cancelled login poll releases the store lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-login-abort-'));
  const controller = new AbortController();
  const store = new AuthStore(join(root, 'auth'), loginSeam(() => controller.abort()));

  await assert.rejects(store.login(() => {}, controller.signal), { code: 'ABORTED' });

  await assert.rejects(readFile(join(root, 'auth/auth.lock')), { code: 'ENOENT' });

  await rm(root, { recursive: true, force: true });
});

test('signal-aware body reads distinguish a deadline from a caller cancellation', async () => {
  for (const deadline of [false, true]) {
    const controller = new AbortController();
    const signal = deadline ? AbortSignal.timeout(10) : controller.signal;
    const body = new ReadableStream({ start(stream) {
      stream.enqueue(Buffer.from('{'));
      signal.addEventListener('abort', () => stream.error(new DOMException('Synthetic abort', 'AbortError')), { once: true });
    } });
    const keepAlive = setTimeout(() => controller.abort(), 10);

    try {
      await assert.rejects(readJson(new Response(body), 1024, signal), { code: deadline ? 'TIMEOUT' : 'ABORTED' });
    } finally {
      clearTimeout(keepAlive);
    }
  }
});

test('poll cancellation stays ABORTED when a pending-status body is already errored', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-poll-status-'));
  const controller = new AbortController();
  const store = new AuthStore(join(root, 'auth'), pendingStatusSeam(() => controller.abort()));

  await assert.rejects(store.login(() => {}, controller.signal), { code: 'ABORTED' });

  await rm(root, { recursive: true, force: true });
});
