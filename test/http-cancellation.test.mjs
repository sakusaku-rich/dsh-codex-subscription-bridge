import test from 'node:test';
import assert from 'node:assert/strict';
import {Http,BASE} from '../lib/http.js';
test('caller abort during JSON body reading is preserved after headers', async () => {
  const controller = new AbortController(); let cancelled = false;
  const http = new Http(async (_, options) => new Response(new ReadableStream({
    start(stream) { stream.enqueue(Buffer.from('{')); options.signal.addEventListener('abort', () => { cancelled = true; stream.error(new DOMException('Synthetic abort', 'AbortError')); }, { once: true }); },
  })));
  const request = http.json(`${BASE}/models`, {}, controller.signal);
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(request, { code: 'ABORTED' }); assert.equal(cancelled, true);
});
