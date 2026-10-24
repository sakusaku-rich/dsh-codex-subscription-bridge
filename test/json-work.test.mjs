import test from 'node:test';
import assert from 'node:assert/strict';
import { readBytes, readJson } from '../lib/http.js';

/** A body that yields one fragment, empty or a single byte. */
function fragmentStream(empty) {
  return new ReadableStream({ pull(stream) { stream.enqueue(empty ? new Uint8Array() : Uint8Array.of(120)); } });
}

test('an abort during a JSON read reports ABORTED', async () => {
  for (const empty of [false, true]) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 0);

    try {
      await assert.rejects(readBytes(new Response(fragmentStream(empty)), 1024 * 1024, controller.signal), { code: 'ABORTED' });
    } finally {
      clearTimeout(timer);
    }
  }
});

test('a deadline during a JSON read reports TIMEOUT', async () => {
  for (const empty of [false, true]) {
    await assert.rejects(readBytes(new Response(fragmentStream(empty)), 1024 * 1024, AbortSignal.timeout(1)), { code: 'TIMEOUT' });
  }
});

test('a JSON read cancels the reader when it yields to cancellation', async () => {
  for (const empty of [false, true]) {
    let cancelled = false;
    const body = new ReadableStream({ pull: (stream) => stream.enqueue(empty ? new Uint8Array() : Uint8Array.of(120)), cancel() { cancelled = true; } });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 0);

    try {
      await assert.rejects(readBytes(new Response(body), 1024 * 1024, controller.signal), { code: 'ABORTED' });
    } finally {
      clearTimeout(timer);
    }

    assert.equal(cancelled, true);
  }
});

test('JSON accumulation preserves split UTF-8 across single-byte chunks', async () => {
  const bytes = Buffer.from('{"text":"Hello 🌍"}');
  let index = 0;
  const body = new ReadableStream({ pull(stream) {
    if (index === bytes.length) { stream.close(); return; }
    stream.enqueue(Uint8Array.of(bytes[index++]));
  } });

  const result = await readJson(new Response(body), bytes.length);

  assert.deepEqual(result, { text: 'Hello 🌍' });
});

test('JSON accumulation accepts a payload exactly at the bound', async () => {
  const result = await readBytes(new Response('x'.repeat(4096)), 4096);

  assert.equal(result.length, 4096);
  assert.equal(result.buffer.byteLength, 4096);
});

test('JSON accumulation refuses a payload past the bound', async () => {
  await assert.rejects(readBytes(new Response('x'.repeat(4097)), 4096), { code: 'LIMIT_EXCEEDED' });
});
