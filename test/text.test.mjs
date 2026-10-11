import test from 'node:test';
import assert from 'node:assert/strict';
import { validateInput, PROVIDER, TEXT_LIMIT } from '../src/text.js';
const input = (overrides = {}) => ({ provider: PROVIDER, messages: [{ role: 'user', content: [{ type: 'text', text: 'Synthetic prompt' }] }], ...overrides });

test('text history drops tool declarations, execution metadata, and replay identifiers', () => {
  const result = validateInput(input({ tools: [{ name: 'synthetic-tool' }],
    toolHistory: { tools: [{ name: 'synthetic-tool' }], updates: [] }, sessionId: 'synthetic-session',
    messages: [{ role: 'assistant', source: { replayState: { response: { id: 'synthetic-replay' } } }, content: [{ type: 'text', text: 'Previous answer' }] }, ...input().messages] }));
  assert.deepEqual(result, [
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Previous answer' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Synthetic prompt' }] },
  ]);
});

test('unsupported inputs and text bounds are refused before transport', () => {
  for (const overrides of [
    { tools: {} }, { temperature: 0 }, { maxTokens: 10 }, { stop: [] }, { reasoningEffort: 'high' },
    { messages: [] }, { messages: Array(129).fill(input().messages[0]) },
    { messages: [{ role: 'user', content: [{ type: 'image' }] }] },
    { messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Last assistant' }] }] },
    { messages: [{ role: 'tool', content: [{ type: 'text', text: 'Executed result' }] }] },
    { messages: [{ role: 'user', content: Array(65).fill({ type: 'text', text: '' }) }] },
    { system: 'x'.repeat(TEXT_LIMIT + 1) },
  ]) assert.throws(() => validateInput(input(overrides)), { code: 'INPUT_UNSUPPORTED' });
  assert.doesNotThrow(() => validateInput(input({ messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(TEXT_LIMIT) }] }] })));
});
