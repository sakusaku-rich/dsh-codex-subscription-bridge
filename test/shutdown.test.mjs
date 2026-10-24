import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DirectBridge } from '../lib/direct.js';
import { AuthStore } from '../lib/auth.js';
import { Http } from '../lib/http.js';
import { BridgeError } from '../lib/errors.js';

const token = 'x.' + Buffer.from(JSON.stringify({ exp: Date.now() / 1000 + 3600, 'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic' } })).toString('base64url') + '.x';
const request = { provider: 'codex-subscription', model: 'test', messages: [{ role: 'user', content: [{ type: 'text', text: 'Synthetic' }] }] };

/** A bridge whose token seam runs an owned store transaction that never completes. */
function bridgeOver(root, order) {
  const store = new AuthStore(join(root, 'auth'));
  let start;
  const started = new Promise((resolve) => { start = resolve; });
  const bridge = new DirectBridge({ token: (signal) => store.transaction(async () => {
    order.push('transaction start');
    start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    order.push('transaction end');
    throw new BridgeError('ABORTED');
  }, signal) });
  return { store, bridge, started };
}

test('close waits for an owned authentication transaction to settle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-shutdown-'));
  const order = [];
  const { bridge, started } = bridgeOver(root, order);

  const call = bridge.listModels().catch(() => {});
  await started;
  await bridge.close();
  order.push('close resolved');

  assert.deepEqual(order, ['transaction start', 'transaction end', 'close resolved']);

  await call;
  await rm(root, { recursive: true, force: true });
});

test('a second close returns the same in-flight cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-shutdown-'));
  const order = [];
  const { bridge, started } = bridgeOver(root, order);
  const call = bridge.listModels().catch(() => {});
  await started;

  const first = bridge.close();
  const second = bridge.close();

  assert.equal(second, first);

  await first;
  await call;
  await rm(root, { recursive: true, force: true });
});

test('close releases the lock it owns', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-shutdown-'));
  const order = [];
  const { bridge, started } = bridgeOver(root, order);

  const call = bridge.listModels().catch(() => {});
  await started;
  await bridge.close();

  await assert.rejects(access(join(root, 'auth/auth.lock')), { code: 'ENOENT' });

  await call;
  await rm(root, { recursive: true, force: true });
});

test('close cancels a paused stream reader without requiring consumer progress', async () => {
  let cancelled = false;
  const bridge = new DirectBridge({ token: async () => token }, new Http(async (url) => url.includes('/models?')
    ? Response.json({ models: [{ slug: 'test', display_name: 'Test', visibility: 'list' }] })
    : new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.from(`data: ${JSON.stringify({ type: 'response.output_text.delta', item_id: 'item', content_index: 0, delta: 'Synthetic' })}\n\n`));
      },
      async cancel() {
        await new Promise((resolve) => setTimeout(resolve, 20));
        cancelled = true;
      },
    }))));
  const stream = bridge.stream(request);
  await stream.next();

  await bridge.close();

  assert.equal(cancelled, true);

  await stream.return();
});

test('close clears pending work after cancelling a paused reader', async () => {
  const bridge = new DirectBridge({ token: async () => token }, new Http(async (url) => url.includes('/models?')
    ? Response.json({ models: [{ slug: 'test', display_name: 'Test', visibility: 'list' }] })
    : new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.from(`data: ${JSON.stringify({ type: 'response.output_text.delta', item_id: 'item', content_index: 0, delta: 'Synthetic' })}\n\n`));
      },
      async cancel() {
        await new Promise((resolve) => setTimeout(resolve, 20));
      },
    }))));
  const stream = bridge.stream(request);
  await stream.next();

  await bridge.close();

  assert.equal(bridge.pending.size, 0);

  await stream.return();
});

test('close times out rather than declaring unresponsive cleanup complete', async () => {
  let finish;
  const waiting = new Promise((resolve) => { finish = resolve; });
  const bridge = new DirectBridge({}, undefined, { shutdownTimeoutMs: 10 });
  bridge.track(waiting);

  await assert.rejects(bridge.close(), { code: 'TIMEOUT' });

  finish();
  await waiting;
});
