import test from 'node:test';
import assert from 'node:assert/strict';
import { validateInput, PROVIDER, TEXT_LIMIT, MESSAGE_LIMIT, TOOL_PARAMETERS_LIMIT, TOOLS_BYTES_LIMIT, CALL_ID_LIMIT, TOOL_BYTES_LIMIT, IMAGE_MEDIA_TYPES, reasoningLevels, REASONING_LEVEL_LIMIT } from '../lib/text.js';
import { REQUEST_IMAGE_ATTACHMENT_MAX_BYTES } from '../lib/image.js';

/** A minimal request that takes per-case overrides. */
const input = (overrides = {}) => ({ provider: PROVIDER, messages: [{ role: 'user', content: [{ type: 'text', text: 'Synthetic prompt' }] }], ...overrides });

/** A minimal image block that takes per-case overrides. */
const image = (overrides = {}) => ({ type: 'image', attachment: { attachmentId: `sha256:${'ab'.repeat(32)}`, mediaType: 'image/png', bytes: 1024, width: 1024, height: 768 }, ...overrides });

/** An image attachment id that differs from the default block's. */
const offId = () => `sha256:${'ef'.repeat(32)}`;

/** A tool call block that takes per-case overrides. */
const call = (overrides = {}) => ({ type: 'tool-call', id: 'call-1', name: 'synthetic-tool', arguments: '{}', ...overrides });

/** A tool result message paired with the default call. */
const toolMessage = (overrides = {}) => ({ role: 'tool', source: { kind: 'tool', callId: 'call-1' }, toolCallId: 'call-1', content: [{ type: 'text', text: 'ok' }], ...overrides });

/** A tool parameters object whose serialized form is the requested size. */
const big = (bytes) => JSON.parse(`{"type":"object","properties":{"x":{"type":"string","description":"${'y'.repeat(bytes)}"}}}`);

/** A history that carries tool declarations, tool results and a replay identifier. */
const historyInput = () => input({
  tools: [{ name: 'synthetic-tool', description: 'Synthetic tool', parameters: { type: 'object' } }],
  toolHistory: { tools: [{ name: 'synthetic-tool' }], updates: [] },
  sessionId: 'synthetic-session',
  reasoningEffort: 'high',
  messages: [
    { role: 'assistant', source: { replayState: { response: { id: 'synthetic-replay' } } }, content: [{ type: 'text', text: 'Previous answer' }] },
    { role: 'assistant', content: [{ type: 'reasoning', text: 'Hidden replay' }, { type: 'tool-call', id: 'call-1', name: 'synthetic-tool', arguments: '{}' }] },
    { role: 'tool', source: { kind: 'tool', callId: 'call-1' }, toolCallId: 'call-1', content: [{ type: 'text', text: 'Executed result' }] },
    ...input().messages,
  ],
});

test('text history reports no images for a text-only request', () => {
  const request = historyInput();

  const result = validateInput(request);

  assert.equal(result.images.size, 0);
  assert.deepEqual(result.imageBlocks, []);
});

test('text history projects the requested reasoning effort', () => {
  const request = historyInput();

  const result = validateInput(request);

  assert.deepEqual(result.reasoning, { effort: 'high' });
});

test('text history projects a tool declaration as a wire function tool', () => {
  const request = historyInput();

  const result = validateInput(request);

  assert.deepEqual(result.tools, [{ type: 'function', name: 'synthetic-tool', description: 'Synthetic tool', strict: false, parameters: { type: 'object' } }]);
});

test('text history drops execution metadata and replay identifiers from the projected input', () => {
  const request = historyInput();

  const result = validateInput(request);

  assert.deepEqual(result.input, [
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Previous answer' }] },
    { type: 'function_call', call_id: 'call-1', name: 'synthetic-tool', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call-1', output: 'Executed result' },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Synthetic prompt' }] },
  ]);
});

test('image blocks are collected in request order', () => {
  const block = image();
  const second = image({ attachment: { attachmentId: `sha256:${'cd'.repeat(32)}`, mediaType: 'image/jpeg', bytes: 2, width: 10, height: 5 } });
  const request = input({ messages: [{ role: 'user', content: [block, { type: 'text', text: 'Synthetic prompt' }, second] }] });

  const result = validateInput(request);

  assert.equal(result.images.size, 2);
  assert.deepEqual(result.imageBlocks, [block, second]);
});

test('an image entry keeps its own attachment reference', () => {
  const block = image();
  const second = image({ attachment: { attachmentId: `sha256:${'cd'.repeat(32)}`, mediaType: 'image/jpeg', bytes: 2, width: 10, height: 5 } });
  const request = input({ messages: [{ role: 'user', content: [block, { type: 'text', text: 'Synthetic prompt' }, second] }] });

  const result = validateInput(request);
  const entry = result.images.get(block.attachment.attachmentId);

  assert.equal(entry.ref, block.attachment);
});

test('an image entry carries the per-attachment request target', () => {
  const block = image();
  const second = image({ attachment: { attachmentId: `sha256:${'cd'.repeat(32)}`, mediaType: 'image/jpeg', bytes: 2, width: 10, height: 5 } });
  const request = input({ messages: [{ role: 'user', content: [block, { type: 'text', text: 'Synthetic prompt' }, second] }] });

  const result = validateInput(request);
  const entry = result.images.get(block.attachment.attachmentId);

  assert.equal(entry.target.width, 1024);
  assert.equal(entry.target.height, 768);
  assert.equal(entry.target.maxBytes, 1024 * 1024);
});

test('image blocks become wire placeholders in the projected input', () => {
  const block = image();
  const second = image({ attachment: { attachmentId: `sha256:${'cd'.repeat(32)}`, mediaType: 'image/jpeg', bytes: 2, width: 10, height: 5 } });
  const request = input({ messages: [{ role: 'user', content: [block, { type: 'text', text: 'Synthetic prompt' }, second] }] });

  const result = validateInput(request);

  assert.deepEqual(result.input, [{ type: 'message', role: 'user', content: [
    { type: 'input_image', image_url: '', attachmentId: block.attachment.attachmentId },
    { type: 'input_text', text: 'Synthetic prompt' },
    { type: 'input_image', image_url: '', attachmentId: second.attachment.attachmentId },
  ] }]);
});

test('unsupported input shapes are refused before transport', () => {
  for (const overrides of [
    { tools: {} },
    { reasoningEffort: 'Medium' },
    { reasoningEffort: '' },
    { reasoningEffort: 4 },
    { messages: [] },
    { messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Last assistant' }] }] },
    { messages: [{ role: 'user', content: Array(65).fill({ type: 'text', text: '' }) }] },
  ]) assert.throws(() => validateInput(input(overrides)), { code: 'INPUT_UNSUPPORTED' });
});

test('text past the text limit is refused before transport', () => {
  for (const overrides of [
    { system: 'x'.repeat(TEXT_LIMIT + 1) },
    { messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(TEXT_LIMIT + 1) }] }] },
  ]) assert.throws(() => validateInput(input(overrides)), { code: 'INPUT_UNSUPPORTED' });
});

test('messages past the message limit are refused before transport', () => {
  const overrides = { messages: Array(MESSAGE_LIMIT + 1).fill(input().messages[0]) };

  assert.throws(() => validateInput(input(overrides)), { code: 'INPUT_UNSUPPORTED' });
});

test('text exactly at the text limit is accepted', () => {
  const overrides = { messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(TEXT_LIMIT) }] }] };

  assert.doesNotThrow(() => validateInput(input(overrides)));
});

test('messages exactly at the message limit are accepted', () => {
  const overrides = { messages: Array(MESSAGE_LIMIT).fill(input().messages[0]) };

  assert.doesNotThrow(() => validateInput(input(overrides)));
});

test('a generation override forwards temperature', () => {
  const overrides = { temperature: 0.7, maxTokens: 4096 };

  const result = validateInput(input(overrides));

  assert.equal(result.temperature, 0.7);
});

test('temperature stays undefined when only an advisory budget is given', () => {
  const overrides = { maxTokens: 4096 };

  const result = validateInput(input(overrides));

  assert.equal(result.temperature, undefined);
});

test('temperature stays undefined when no generation override is given', () => {
  const result = validateInput(input());

  assert.equal(result.temperature, undefined);
});

test('malformed generation overrides are refused', () => {
  for (const overrides of [
    { temperature: 'warm' },
    { temperature: Number.NaN },
    { temperature: -0.1 },
    { temperature: 2.1 },
    { maxTokens: 0 },
    { maxTokens: 1.5 },
    { maxTokens: 1000001 },
    { maxTokens: 'many' },
    { stop: [] },
    { stop: 'END' },
  ]) assert.throws(() => validateInput(input(overrides)), (error) => error.code === 'UNSUPPORTED_OPTION' && error.diagnostic === 'STOP' ||
    error.code === 'INPUT_UNSUPPORTED' && ['TEMPERATURE', 'MAX_TOKENS'].includes(error.diagnostic),
    `expected refusal for ${JSON.stringify(overrides)}`);
});

test('malformed tool declarations are refused', () => {
  for (const tools of [
    Array(257).fill({ name: 'synthetic-tool' }),
    [{ name: 'space name' }],
    [{ name: 'a'.repeat(65) }],
    [{ name: '' }],
    [{ name: 'synthetic-tool' }, { name: 'synthetic-tool' }],
    [{ name: 'synthetic-tool', description: 'd'.repeat(8193) }],
    [{ name: 'synthetic-tool', parameters: [] }],
    [{ name: 'synthetic-tool', parameters: 'x' }],
    [{ name: 'synthetic-tool', parameters: big(TOOL_PARAMETERS_LIMIT) }],
    [{ name: 'synthetic-tool', deferLoading: 'yes' }],
    Array(300).fill({ name: 'a'.repeat(64), parameters: { type: 'object' } }).map((tool, index) => ({ ...tool, name: `${tool.name}_${index}` })),
  ]) assert.throws(() => validateInput(input({ tools })), { code: 'INPUT_UNSUPPORTED', diagnostic: 'TOOL_INPUT' });
});

test('the aggregate tool payload bound is enforced', () => {
  const aggregate = Array(3).fill({ name: 'x', parameters: big(Math.floor(TOOLS_BYTES_LIMIT / 3) - 60) })
    .map((tool, index) => ({ ...tool, name: `tool_${index}` }));

  assert.throws(() => validateInput(input({ tools: aggregate })), { code: 'INPUT_UNSUPPORTED' });
});

test('a well-formed tool declaration set is accepted', () => {
  const tools = [
    { name: 'synthetic-tool', parameters: { type: 'object' } },
    { name: 'other-tool', description: 'Optional', parameters: { type: 'object', properties: {} } },
    { name: 'third', parameters: { type: 'object' }, deferLoading: true },
  ];

  assert.doesNotThrow(() => validateInput(input({ tools })));
});

test('unpaired tool call history is refused', () => {
  for (const messages of [
    [{ role: 'tool', content: [{ type: 'text', text: 'orphan' }] }],
    [{ role: 'user', content: [call()] }],
    [{ role: 'assistant', content: [call()] }, { role: 'tool', content: [{ type: 'text', text: 'ok' }], toolCallId: 'call-1' }, toolMessage()],
    [{ role: 'assistant', content: [call()] }, { role: 'tool', source: { kind: 'other', callId: 'call-1' }, content: [{ type: 'text', text: 'ok' }] }],
    [{ role: 'assistant', content: [call()] }, { role: 'tool', content: [{ type: 'image', attachment: {} }] }],
    [{ role: 'assistant', content: [call()] }, { role: 'user', content: [{ type: 'text', text: 'Interrupted' }] }],
  ]) assert.throws(() => validateInput(input({ messages })),
    (error) => error.code === 'INPUT_UNSUPPORTED' || error.code === 'LIMIT_EXCEEDED' || error.code === 'UNSUPPORTED_CONTENT');
});

test('malformed tool call blocks are refused', () => {
  for (const messages of [
    [{ role: 'assistant', content: [call({ id: '' })] }],
    [{ role: 'assistant', content: [call({ arguments: 5 })] }],
    [{ role: 'assistant', content: [call(), call()] }],
  ]) assert.throws(() => validateInput(input({ messages })),
    (error) => error.code === 'INPUT_UNSUPPORTED' || error.code === 'LIMIT_EXCEEDED' || error.code === 'UNSUPPORTED_CONTENT');
});

test('tool call history past its byte bound is refused', () => {
  for (const messages of [
    [{ role: 'assistant', content: [call({ id: 'a'.repeat(CALL_ID_LIMIT + 1) })] }],
    [{ role: 'assistant', content: [call()] }, { role: 'tool', content: [{ type: 'text', text: 'x'.repeat(TOOL_BYTES_LIMIT) }] }],
    [{ role: 'assistant', content: [call({ arguments: `"${'x'.repeat(TOOL_BYTES_LIMIT)}"` })] }],
  ]) assert.throws(() => validateInput(input({ messages })),
    (error) => error.code === 'INPUT_UNSUPPORTED' || error.code === 'LIMIT_EXCEEDED' || error.code === 'UNSUPPORTED_CONTENT');
});

test('a well-formed tool call pair is accepted', () => {
  const messages = [
    { role: 'assistant', content: [call({ id: 'call-2', name: 'other-tool', arguments: '{"x":1}' })] },
    { role: 'tool', toolCallId: 'call-2', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
    ...input().messages,
  ];

  assert.doesNotThrow(() => validateInput(input({ messages })));
});

test('malformed image blocks are refused', () => {
  for (const block of [
    { type: 'image' },
    { type: 'image', attachment: {} },
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
});

test('every supported media type is accepted', () => {
  for (const mediaType of IMAGE_MEDIA_TYPES) {
    const block = image({ attachment: { attachmentId: offId(), mediaType, bytes: 1, width: 1, height: 1 } });

    assert.doesNotThrow(() => validateInput(input({ messages: [{ role: 'user', content: [block] }] })));
  }
});

test('an image block on an assistant message is refused', () => {
  assert.throws(() => validateInput(input({ messages: [{ role: 'assistant', content: [image()] }] })), { code: 'UNSUPPORTED_CONTENT', diagnostic: 'IMAGE_PREPARE' });
});

test('a file block is refused', () => {
  assert.throws(() => validateInput(input({ messages: [{ role: 'user', content: [{ type: 'file' }] }] })), { code: 'UNSUPPORTED_CONTENT' });
});

test('disclosed reasoning levels are projected in disclosure order', () => {
  const disclosure = [
    { effort: 'low', description: 'Fast responses with lighter reasoning' },
    { effort: 'medium' },
    { effort: 'xhigh' },
  ];

  assert.deepEqual(reasoningLevels(disclosure), [
    { id: 'low', name: 'Low', description: 'Fast responses with lighter reasoning' },
    { id: 'medium', name: 'Medium' },
    { id: 'xhigh', name: 'Extra high' },
  ]);
});

test('a missing reasoning disclosure is omitted', () => {
  const projected = reasoningLevels(undefined);

  assert.equal(projected, undefined);
});

test('an oversized reasoning note is dropped without dropping the level', () => {
  const disclosure = [{ effort: 'low', description: 'x'.repeat(513) }];

  assert.deepEqual(reasoningLevels(disclosure), [{ id: 'low', name: 'Low' }]);
});

test('a malformed reasoning disclosure is omitted', () => {
  for (const value of [
    null,
    [],
    'low',
    [{ effort: 'Low' }],
    [{ effort: 'low' }, { effort: 'low' }],
    [{}],
    [null],
    Array(REASONING_LEVEL_LIMIT + 1).fill({ effort: 'low' }),
  ]) assert.equal(reasoningLevels(value), undefined, JSON.stringify(value));
});
