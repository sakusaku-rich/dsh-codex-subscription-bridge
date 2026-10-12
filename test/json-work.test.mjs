import test from 'node:test';
import assert from 'node:assert/strict';
import { readBytes, readJson } from '../src/http.js';

test('ready tiny and empty JSON fragments yield to cancellation and deadlines', async () => {
  for (const empty of [false, true]) {
    for (const timeout of [false, true]) {
      const controller = new AbortController(); let cancelled = false;
      const signal = timeout ? AbortSignal.timeout(1) : controller.signal;
      const body = new ReadableStream({
        pull(stream) { stream.enqueue(empty ? new Uint8Array() : Uint8Array.of(120)); },
        cancel() { cancelled = true; },
      });
      const timer = timeout ? undefined : setTimeout(() => controller.abort(), 0);
      try { await assert.rejects(readBytes(new Response(body), 1024 * 1024, signal), { code: timeout ? 'TIMEOUT' : 'ABORTED' }); }
      finally { clearTimeout(timer); }
      assert.equal(cancelled, true);
    }
  }
});

test('JSON accumulation preserves split UTF-8 and enforces exact payload bounds', async () => {
  const bytes = Buffer.from('{"text":"Hello 🌍"}'); let index = 0;
  const body = new ReadableStream({ pull(stream) {
    if (index === bytes.length) { stream.close(); return; }
    stream.enqueue(Uint8Array.of(bytes[index++]));
  } });
  assert.deepEqual(await readJson(new Response(body), bytes.length), { text: 'Hello 🌍' });
  const result = await readBytes(new Response('x'.repeat(4096)), 4096);
  assert.equal(result.length, 4096);
  assert.equal(result.buffer.byteLength, 4096);
  await assert.rejects(readBytes(new Response('x'.repeat(4097)), 4096), { code: 'LIMIT_EXCEEDED' });
});
