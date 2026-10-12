import test from 'node:test';
import assert from 'node:assert/strict';
import { validateInput, PROVIDER, TEXT_LIMIT, MESSAGE_LIMIT, TOOL_PARAMETERS_LIMIT, TOOLS_BYTES_LIMIT, CALL_ID_LIMIT, TOOL_BYTES_LIMIT, IMAGE_MEDIA_TYPES } from '../src/text.js';
import { REQUEST_IMAGE_ATTACHMENT_MAX_BYTES } from '../src/image.js';
const input = (overrides = {}) => ({ provider: PROVIDER, messages: [{ role: 'user', content: [{ type: 'text', text: 'Synthetic prompt' }] }], ...overrides });
const image = (overrides = {}) => ({ type: 'image', attachment: { attachmentId: `sha256:${'ab'.repeat(32)}`, mediaType: 'image/png', bytes: 1024, width: 1024, height: 768 }, ...overrides });

test('text history drops tool declarations execution metadata and replay identifiers', () => {
  const result = validateInput(input({ tools: [{ name: 'synthetic-tool', description: 'Synthetic tool', parameters: { type: 'object' } }],
    toolHistory: { tools: [{ name: 'synthetic-tool' }], updates: [] }, sessionId: 'synthetic-session', reasoningEffort: 'high',
    messages: [{ role: 'assistant', source: { replayState: { response: { id: 'synthetic-replay' } } }, content: [{ type: 'text', text: 'Previous answer' }] },
      { role: 'assistant', content: [{ type: 'reasoning', text: 'Hidden replay' }, { type: 'tool-call', id: 'call-1', name: 'synthetic-tool', arguments: '{}' }] },
      { role: 'tool', source: { kind: 'tool', callId: 'call-1' }, toolCallId: 'call-1', content: [{ type: 'text', text: 'Executed result' }] }, ...input().messages] }));
  assert.equal(result.images.size, 0); assert.deepEqual(result.imageBlocks, []);
  assert.deepEqual(result.reasoning, { effort: 'high' });
  assert.deepEqual(result.tools, [{ type: 'function', name: 'synthetic-tool', description: 'Synthetic tool', strict: false, parameters: { type: 'object' } }]);
  assert.deepEqual(result.input, [
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Previous answer' }] },
    { type: 'function_call', call_id: 'call-1', name: 'synthetic-tool', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call-1', output: 'Executed result' },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Synthetic prompt' }] },
  ]);
});

test('images become wire placeholders with per-attachment request targets', () => {
  const block = image(); const block2 = image({ attachment: { attachmentId: `sha256:${'cd'.repeat(32)}`, mediaType: 'image/jpeg', bytes: 2, width: 10, height: 5 } });
  const result = validateInput(input({ messages: [{ role: 'user', content: [block, { type: 'text', text: 'Synthetic prompt' }, block2] }] }));
  assert.equal(result.images.size, 2); assert.deepEqual(result.imageBlocks, [block, block2]);
  const entry = result.images.get(block.attachment.attachmentId);
  assert.equal(entry.ref, block.attachment);
  assert.equal(entry.target.width, 1024); assert.equal(entry.target.height, 768); assert.equal(entry.target.maxBytes, 1024 * 1024);
  assert.deepEqual(result.input, [{ type: 'message', role: 'user', content: [
    { type: 'input_image', image_url: '', attachmentId: block.attachment.attachmentId },
    { type: 'input_text', text: 'Synthetic prompt' },
    { type: 'input_image', image_url: '', attachmentId: block2.attachment.attachmentId },
  ] }]);
});

test('unsupported inputs and text bounds are refused before transport', () => {
  for (const overrides of [
    { tools: {} }, { reasoningEffort: 'medium' },
    { messages: [] }, { messages: Array(MESSAGE_LIMIT + 1).fill(input().messages[0]) },
    { messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Last assistant' }] }] },
    { messages: [{ role: 'user', content: Array(65).fill({ type: 'text', text: '' }) }] },
    { system: 'x'.repeat(TEXT_LIMIT + 1) },
    { messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(TEXT_LIMIT + 1) }] }] },
  ]) assert.throws(() => validateInput(input(overrides)), { code: 'INPUT_UNSUPPORTED' });
  assert.doesNotThrow(() => validateInput(input({ messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(TEXT_LIMIT) }] }] })));
  assert.doesNotThrow(() => validateInput(input({ messages: Array(MESSAGE_LIMIT).fill(input().messages[0]) })));
});

test('generation overrides forward temperature and accept advisory budgets', () => {
  assert.equal(validateInput(input({ temperature: 0.7, maxTokens: 4096 })).temperature, 0.7);
  assert.equal(validateInput(input({ maxTokens: 4096 })).temperature, undefined);
  assert.equal(validateInput(input()).temperature, undefined);
  for (const overrides of [
    { temperature: 'warm' }, { temperature: Number.NaN }, { temperature: -0.1 }, { temperature: 2.1 },
    { maxTokens: 0 }, { maxTokens: 1.5 }, { maxTokens: 1000001 }, { maxTokens: 'many' },
    { stop: [] }, { stop: 'END' },
  ]) assert.throws(() => validateInput(input(overrides)), error => error.code === 'UNSUPPORTED_OPTION' && error.diagnostic === 'STOP' ||
    error.code === 'INPUT_UNSUPPORTED' && ['TEMPERATURE', 'MAX_TOKENS'].includes(error.diagnostic),
    `expected refusal for ${JSON.stringify(overrides)}`);
});

test('tool declarations are validated conservatively', () => {
  const big = (bytes) => JSON.parse(`{"type":"object","properties":{"x":{"type":"string","description":"${'y'.repeat(bytes)}"}}}`);
  for (const tools of [
    Array(257).fill({ name: 'synthetic-tool' }), [{ name: 'space name' }], [{ name: 'a'.repeat(65) }], [{ name: '' }],
    [{ name: 'synthetic-tool' }, { name: 'synthetic-tool' }], [{ name: 'synthetic-tool', description: 'd'.repeat(8193) }],
    [{ name: 'synthetic-tool', parameters: [] }], [{ name: 'synthetic-tool', parameters: 'x' }],
    [{ name: 'synthetic-tool', parameters: big(TOOL_PARAMETERS_LIMIT) }], [{ name: 'synthetic-tool', deferLoading: 'yes' }],
    Array(300).fill({ name: 'a'.repeat(64), parameters: { type: 'object' } }).map((tool, index) => ({ ...tool, name: `${tool.name}_${index}` })),
  ]) assert.throws(() => validateInput(input({ tools })), { code: 'INPUT_UNSUPPORTED', diagnostic: 'TOOL_INPUT' });
  // Oversized aggregate: 3 tools with ~86 KiB parameter payloads each.
  const aggregate = Array(3).fill({ name: 'x', parameters: big(Math.floor(TOOLS_BYTES_LIMIT / 3) - 60) })
    .map((tool, index) => ({ ...tool, name: `tool_${index}` }));
  assert.throws(() => validateInput(input({ tools: aggregate })), { code: 'INPUT_UNSUPPORTED' });
  assert.doesNotThrow(() => validateInput(input({ tools: [{ name: 'synthetic-tool', parameters: { type: 'object' } }, { name: 'other-tool', description: 'Optional', parameters: { type: 'object', properties: {} } }, { name: 'third', parameters: { type: 'object' }, deferLoading: true }] })));
});

test('tool call history pairing and byte bounds are enforced', () => {
  const call = (overrides = {}) => ({ type: 'tool-call', id: 'call-1', name: 'synthetic-tool', arguments: '{}', ...overrides });
  const toolMessage = (overrides = {}) => ({ role: 'tool', source: { kind: 'tool', callId: 'call-1' }, toolCallId: 'call-1', content: [{ type: 'text', text: 'ok' }], ...overrides });
  for (const messages of [
    [{ role: 'tool', content: [{ type: 'text', text: 'orphan' }] }],
    [{ role: 'user', content: [call()] }],
    [{ role: 'assistant', content: [call({ id: '' })] }],
    [{ role: 'assistant', content: [call({ id: 'a'.repeat(CALL_ID_LIMIT + 1) })] }],
    [{ role: 'assistant', content: [call({ arguments: 5 })] }],
    [{ role: 'assistant', content: [call(), call()] }],
    [{ role: 'assistant', content: [call()] }, { role: 'tool', content: [{ type: 'text', text: 'ok' }], toolCallId: 'call-1' }, toolMessage()],
    [{ role: 'assistant', content: [call()] }, { role: 'tool', source: { kind: 'other', callId: 'call-1' }, content: [{ type: 'text', text: 'ok' }] }],
    [{ role: 'assistant', content: [call()] }, { role: 'tool', content: [{ type: 'image', attachment: {} }] }],
    [{ role: 'assistant', content: [call()] }, { role: 'user', content: [{ type: 'text', text: 'Interrupted' }] }],
    [{ role: 'assistant', content: [call()] }, { role: 'tool', content: [{ type: 'text', text: 'x'.repeat(TOOL_BYTES_LIMIT) }] }],
    [{ role: 'assistant', content: [call({ arguments: `"${'x'.repeat(TOOL_BYTES_LIMIT)}"` })] }],
  ]) assert.throws(() => validateInput(input({ messages })),
    (error) => error.code === 'INPUT_UNSUPPORTED' || error.code === 'LIMIT_EXCEEDED' || error.code === 'UNSUPPORTED_CONTENT');
  assert.doesNotThrow(() => validateInput(input({ messages: [
    { role: 'assistant', content: [call({ id: 'call-2', name: 'other-tool', arguments: '{"x":1}' })] },
    { role: 'tool', toolCallId: 'call-2', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }, ...input().messages] })));
});

test('image blocks are validated conservatively', () => {
  const offId = () => `sha256:${'ef'.repeat(32)}`;
  for (const block of [
    { type: 'image' }, { type: 'image', attachment: {} },
    image({ attachment: { attachmentId: 'sha256:short', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } }),
    image({ attachment: { attachmentId: offId(), mediaType: 'image/x-unknown', bytes: 1, width: 1, height: 1 } }),
    image({ attachment: { attachmentId: offId(), mediaType: 'image/png', bytes: 0, width: 1, height: 1 } }),
    image({ attachment: { attachmentId: offId(), mediaType: 'image/png', bytes: REQUEST_IMAGE_ATTACHMENT_MAX_BYTES + 1, width: 1, height: 1 } }),
    image({ attachment: { attachmentId: offId(), mediaType: 'image/png', bytes: 1, width: 0, height: 1 } }),
    image({ attachment: { attachmentId: offId(), mediaType: 'image/png', bytes: 1, width: 1, height: 1.5 } }),
    image({ attachment: { attachmentId: offId(), mediaType: 'image/png', bytes: 1, width: 1, height: 1, name: 7 } }),
    image({ offloaded: true, attachment: { attachmentId: offId(), mediaType: 'image/png', bytes: 1, width: 1, height: 1 } }),
  ]) assert.throws(() => validateInput(input({ messages: [{ role: 'user', content: [block] }] })),
    (error) => error.code === 'INPUT_UNSUPPORTED' || error.code === 'UNSUPPORTED_CONTENT');
  for (const mediaType of IMAGE_MEDIA_TYPES) {
    assert.doesNotThrow(() => validateInput(input({ messages: [{ role: 'user', content: [image({ attachment: { attachmentId: offId(), mediaType, bytes: 1, width: 1, height: 1 } })] }] })));
  }
  assert.throws(() => validateInput(input({ messages: [{ role: 'assistant', content: [image()] }] })), { code: 'UNSUPPORTED_CONTENT', diagnostic: 'IMAGE_PREPARE' });
  assert.throws(() => validateInput(input({ messages: [{ role: 'user', content: [{ type: 'file' }] }] })), { code: 'UNSUPPORTED_CONTENT' });
});