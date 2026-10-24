import test from 'node:test';
import assert from 'node:assert/strict';
import { Http, BASE } from '../lib/http.js';

/** A response whose body stream reports whether the reader was cancelled. */
function streamHttp(flag) {
  return new Http(async (_, options) => new Response(new ReadableStream({
    start(stream) {
      stream.enqueue(Buffer.from('{'));
      options.signal.addEventListener('abort', () => {
        flag.value = true;
        stream.error(new DOMException('Synthetic abort', 'AbortError'));
      }, { once: true });
    },
  })));
}

test('a caller abort during JSON body reading reports ABORTED after headers', async () => {
  const http = streamHttp({ value: false });
  const controller = new AbortController();
  const request = http.json(`${BASE}/models`, {}, controller.signal);

  setTimeout(() => controller.abort(), 10);

  await assert.rejects(request, { code: 'ABORTED' });
});

test('a caller abort during JSON body reading cancels the reader', async () => {
  const cancelled = { value: false };
  const http = streamHttp(cancelled);
  const controller = new AbortController();
  const request = http.json(`${BASE}/models`, {}, controller.signal);

  setTimeout(() => controller.abort(), 10);

  await assert.rejects(request, { code: 'ABORTED' });

  assert.equal(cancelled.value, true);
});
