import test from 'node:test';
import assert from 'node:assert/strict';
import { DirectBridge } from '../lib/direct.js';
import { Http } from '../lib/http.js';

const token = 'x.' + Buffer.from(JSON.stringify({ exp: Date.now() / 1000 + 3600, 'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic' } })).toString('base64url') + '.x';
const item = { type: 'message', id: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Complete text' }] };
const request = { provider: 'codex-subscription', model: 'test', messages: [{ role: 'user', content: [{ type: 'text', text: 'Synthetic' }] }] };

/** A bridge whose model request answers with the given stream events. */
function bridgeFor(events) {
  return new DirectBridge({ token: async () => token }, new Http(async (url) => url.includes('/models?')
    ? Response.json({ models: [{ slug: 'test', display_name: 'Test', visibility: 'list' }] })
    : new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''))));
}

/** Consume a stream and return its chunks. */
async function collect(bridge) {
  const chunks = [];
  for await (const chunk of bridge.stream(request)) chunks.push(chunk);
  return chunks;
}

test('a completed item restores the streamed text when terminal output is null', async () => {
  const bridge = bridgeFor([{ type: 'response.output_item.done', item }, { type: 'response.completed', response: { status: 'completed', output: null } }]);

  const chunks = await collect(bridge);

  assert.equal(chunks.find((chunk) => chunk.type === 'block-end').block.text, 'Complete text');

  await bridge.close();
});

test('a null terminal output still reports a stop reason', async () => {
  const bridge = bridgeFor([{ type: 'response.output_item.done', item }, { type: 'response.completed', response: { status: 'completed', output: null } }]);

  const chunks = await collect(bridge);

  assert.equal(chunks.at(-1).reason.kind, 'stop');

  await bridge.close();
});

test('text, item and terminal completions do not duplicate emission', async () => {
  const bridge = bridgeFor([
    { type: 'response.output_text.done', item_id: 'message', content_index: 0, text: 'Complete text' },
    { type: 'response.output_item.done', item },
    { type: 'response.completed', response: { status: 'completed', output: [item] } },
  ]);

  const chunks = await collect(bridge);

  assert.equal(chunks.filter((chunk) => chunk.type === 'block-start').length, 1);
  assert.equal(chunks.filter((chunk) => chunk.type === 'block-end').length, 1);
  assert.equal(chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join(''), 'Complete text');

  await bridge.close();
});

test('a completed item that contradicts the streamed text is refused', async () => {
  const bridge = bridgeFor([{ type: 'response.output_text.delta', item_id: 'message', content_index: 0, delta: 'Complete' },
    { type: 'response.output_item.done', item: { ...item, content: [{ type: 'output_text', text: 'Different' }] } },
    { type: 'response.completed', response: { status: 'completed' } }]);

  await assert.rejects(collect(bridge), { code: 'PROTOCOL_INVALID' });

  await bridge.close();
});

test('a completed item with an unsupported role is refused', async () => {
  const bridge = bridgeFor([{ type: 'response.output_text.delta', item_id: 'message', content_index: 0, delta: 'Complete' },
    { type: 'response.output_item.done', item: { ...item, role: 'user' } },
    { type: 'response.completed', response: { status: 'completed' } }]);

  await assert.rejects(collect(bridge), { code: 'PROTOCOL_INVALID' });

  await bridge.close();
});

test('an incomplete completed item is refused', async () => {
  const bridge = bridgeFor([{ type: 'response.output_text.delta', item_id: 'message', content_index: 0, delta: 'Complete' },
    { type: 'response.output_item.done', item: { ...item, status: 'incomplete' } },
    { type: 'response.completed', response: { status: 'completed' } }]);

  await assert.rejects(collect(bridge), { code: 'PROTOCOL_INVALID' });

  await bridge.close();
});

test('a completed item with unsupported content is refused', async () => {
  const bridge = bridgeFor([{ type: 'response.output_text.delta', item_id: 'message', content_index: 0, delta: 'Complete' },
    { type: 'response.output_item.done', item: { ...item, content: [{ type: 'refusal', refusal: 'Synthetic' }] } },
    { type: 'response.completed', response: { status: 'completed' } }]);

  await assert.rejects(collect(bridge), { code: 'PROTOCOL_INVALID' });

  await bridge.close();
});

test('completed text past the output bound is refused', async () => {
  // The streamed prefix must match the completed item, otherwise the
  // contradiction check fires before the byte bound.
  const bridge = bridgeFor([{ type: 'response.output_text.delta', item_id: 'message', content_index: 0, delta: 'x' },
    { type: 'response.output_item.done', item: { ...item, content: [{ type: 'output_text', text: 'x'.repeat(256 * 1024 + 2) }] } },
    { type: 'response.completed', response: { status: 'completed' } }]);

  await assert.rejects(collect(bridge), { code: 'LIMIT_EXCEEDED' });

  await bridge.close();
});
