import test from 'node:test';
import assert from 'node:assert/strict';
import { events } from '../lib/sse.js';

async function collect(body, limits) {
  const result = [];
  for await (const value of events(body, new AbortController().signal, undefined, limits)) result.push(value);
  return result;
}

const frame = (text) => new Response(text + '\r\n\r\n').body;
const PREFIX = 'data: {"type":"test","text":"';
const SUFFIX = '"}';
const frameText = (length) => PREFIX + 'x'.repeat(length - Buffer.byteLength(PREFIX + SUFFIX)) + SUFFIX;

test('incremental framing preserves split UTF-8 across single-byte fragments', async () => {
  const bytes = Buffer.from('data: {"type":"test","text":"Hello 🌍"}\r\n\r\n');

  const result = await collect(new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  } }));

  assert.deepEqual(result, [{ type: 'test', text: 'Hello 🌍' }]);
});

test('incremental framing joins multiline data', async () => {
  const result = await collect(new Response('data: {"type":"test",\r\ndata: "text":"Hello"}\r\n\r\n').body);

  assert.deepEqual(result, [{ type: 'test', text: 'Hello' }]);
});

test('incremental framing accepts mixed newline delimiters', async () => {
  const result = await collect(new Response('data: {"type":"second"}\n\r\n').body);

  assert.deepEqual(result, [{ type: 'second' }]);
});

test('a comment line is not an event', async () => {
  const result = await collect(new Response(': comment\n\r\ndata: {"type":"second"}\n\r\n').body);

  assert.deepEqual(result, [{ type: 'second' }]);
});

test('one-byte and empty fragments yield so a cancellation timer can run', async () => {
  for (const empty of [false, true]) {
    let remaining = 131072;
    const controller = new AbortController();
    const seen = [];
    const body = new ReadableStream({ pull(stream) {
      if (!remaining--) { stream.close(); return; }
      stream.enqueue(empty ? new Uint8Array() : Uint8Array.of(120));
    } });
    const timer = setTimeout(() => controller.abort(), 0);

    try {
      await assert.rejects(async () => { for await (const value of events(body, controller.signal)) seen.push(value); }, { code: 'ABORTED' });
    } finally {
      clearTimeout(timer);
    }
  }
});

test('a stream of malformed fragments is refused as an incomplete frame', async () => {
  let remaining = 32768;
  const body = new ReadableStream({ pull(stream) {
    if (!remaining--) { stream.close(); return; }
    stream.enqueue(Uint8Array.of(120));
  } });

  await assert.rejects(collect(body), { code: 'PROTOCOL_INVALID' });
});

test('a body past the aggregate bound is refused', async () => {
  await assert.rejects(collect(new Response('x'.repeat(1024 * 1024 + 1)).body), { code: 'LIMIT_EXCEEDED' });
});

test('a frame exactly at the byte bound is accepted', async () => {
  const result = await collect(frame(frameText(1024 * 1024)));

  assert.equal(result.length, 1);
});

test('a frame past the byte bound is refused', async () => {
  await assert.rejects(collect(frame(frameText(1024 * 1024 + 1))), { code: 'LIMIT_EXCEEDED' });
});

test('the event count bound is enforced at its boundary', async () => {
  const result = await collect(new Response('data: {}\n\r\n'.repeat(4096)).body);

  assert.equal(result.length, 4096);
  await assert.rejects(collect(new Response('data: {}\n\r\n'.repeat(4097)).body), { code: 'LIMIT_EXCEEDED' });
});

test('a raised frame limit admits a frame at the raised bound', async () => {
  const raised = 1024 * 1024 + 65536;

  const result = await collect(frame(frameText(raised)), { frameLimit: raised });

  assert.equal(result.length, 1);
});

test('a frame past the raised frame limit is refused', async () => {
  const raised = 1024 * 1024 + 65536;

  await assert.rejects(collect(frame(frameText(raised + 1)), { frameLimit: raised }), { code: 'LIMIT_EXCEEDED' });
});

test('passing no limits object keeps the default bounds', async () => {
  const raised = 1024 * 1024 + 65536;

  await assert.rejects(collect(frame(frameText(raised - 64)), undefined), { code: 'LIMIT_EXCEEDED' });
});

test('a raised total limit admits more framed bytes than the default', async () => {
  const one = (length) => frameText(length) + '\r\n\r\n';
  const raised = { frameLimit: 1024 * 1024 + 65536 };

  const result = await collect(new Response([1100000, 1100000, 1100000].map(one).join('')).body, raised);

  assert.equal(result.length, 3);
});

test('the default total bound stays enforced when only the frame limit is raised', async () => {
  const one = (length) => frameText(length) + '\r\n\r\n';

  await assert.rejects(collect(new Response([1100000, 1100000, 1100000, 1100000].map(one).join('')).body, undefined,
    { frameLimit: 1024 * 1024 + 65536 }), { code: 'LIMIT_EXCEEDED' });
});

test('a raised total limit admits the framed bytes it covers', async () => {
  const one = (length) => frameText(length) + '\r\n\r\n';

  const result = await collect(new Response([1100000, 1100000, 1100000, 1100000].map(one).join('')).body,
    { frameLimit: 1024 * 1024 + 65536, totalLimit: 6 * 1024 * 1024 });

  assert.equal(result.length, 4);
});

test('a raised event limit admits more events than the default', async () => {
  const raised = { frameLimit: 8 * 1024 * 1024, totalLimit: 64 * 1024 * 1024, eventLimit: 65536 };

  const result = await collect(new Response('data: {}\n\r\n'.repeat(10000)).body, raised);

  assert.equal(result.length, 10000);
});

test('a raised event count alone lifts the bound within the default totals', async () => {
  const result = await collect(new Response('data: {}\n\r\n'.repeat(10000)).body, { eventLimit: 16384 });

  assert.equal(result.length, 10000);
});

test('raised framing alone keeps the default event count and names the bound', async () => {
  await assert.rejects(collect(new Response('data: {}\n\r\n'.repeat(4097)).body, undefined,
    { frameLimit: 8 * 1024 * 1024, totalLimit: 64 * 1024 * 1024 }),
  (error) => {
    assert.equal(error.code, 'LIMIT_EXCEEDED');
    assert.match(error.message, /SSE_FRAME:EVENTS/);
    assert.equal(error.sseCount, 4097);
    assert.equal(error.sseLimit, 4096);
    return true;
  });
});

test('default limits refuse the same stream of small deltas', async () => {
  await assert.rejects(collect(new Response('data: {}\n\r\n'.repeat(10000)).body, undefined),
  (error) => {
    assert.equal(error.code, 'LIMIT_EXCEEDED');
    assert.match(error.message, /SSE_FRAME:EVENTS/);
    return true;
  });
});

test('lowering or corrupting a framing limit is a programming error', async () => {
  for (const limits of [{ frameLimit: 1024 * 1024 - 1 }, { frameLimit: 1.5 }, { frameLimit: 'big' }, { totalLimit: 4 * 1024 * 1024 - 1 },
    { eventLimit: 4096 - 1 }, { eventLimit: 1.5 }, { eventLimit: 'big' }, { eventLimit: 65536 + 1 }]) {
    await assert.rejects(collect(frame('data: {}'), limits), (error) => {
      assert.equal(error.code, undefined);
      assert.match(error.message, /framing limits/);
      return true;
    });
  }
});

test('limits exactly at the defaults or the cap are valid', async () => {
  const result = await collect(frame('data: {}'), { frameLimit: 1024 * 1024, totalLimit: 4 * 1024 * 1024, eventLimit: 4096 });

  assert.equal(result.length, 1);
  assert.equal((await collect(frame('data: {}'), { eventLimit: 65536 })).length, 1);
});

test('no limits object means the default bounds', async () => {
  const result = await collect(frame('data: {}'), undefined);

  assert.equal(result.length, 1);
});
