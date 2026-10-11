import { BridgeError } from './errors.js';

export const PROVIDER = 'codex-subscription';
export const TEXT_LIMIT = 256 * 1024;
export function validateInput(options) {
  if (options.provider !== PROVIDER || !Array.isArray(options.messages) || options.messages.length > 128 || !options.messages.length ||
      options.temperature !== undefined || options.maxTokens !== undefined ||
      options.stop !== undefined || options.reasoningEffort !== undefined) throw new BridgeError('INPUT_UNSUPPORTED');
  // Harness includes declarations in ordinary text requests. They grant no
  // execution authority and are never serialized into direct model input.
  if (options.tools !== undefined && (!Array.isArray(options.tools) || options.tools.length > 256)) throw new BridgeError('INPUT_UNSUPPORTED');
  if (options.toolHistory !== undefined && (!options.toolHistory || typeof options.toolHistory !== 'object' ||
      !Array.isArray(options.toolHistory.tools) || options.toolHistory.tools.length > 256 ||
      !Array.isArray(options.toolHistory.updates) || options.toolHistory.updates.length > 128)) throw new BridgeError('INPUT_UNSUPPORTED');
  let bytes = 0;
  const history = [];
  if (options.system !== undefined) {
    if (typeof options.system !== 'string') throw new BridgeError('INPUT_UNSUPPORTED');
    history.push({ type: 'message', role: 'developer', content: [{ type: 'input_text', text: options.system }] });
    bytes += Buffer.byteLength(options.system);
  }
  for (const message of options.messages) {
    if (!message || !['system', 'developer', 'user', 'assistant'].includes(message.role) || !Array.isArray(message.content)) throw new BridgeError('INPUT_UNSUPPORTED');
    const content = [];
    for (const block of message.content) {
      if (!block || block.type !== 'text' || typeof block.text !== 'string') throw new BridgeError('INPUT_UNSUPPORTED');
      bytes += Buffer.byteLength(block.text);
      if (bytes > TEXT_LIMIT || content.length >= 64) throw new BridgeError('INPUT_UNSUPPORTED');
      content.push({ type: message.role === 'assistant' ? 'output_text' : 'input_text', text: block.text });
    }
    history.push({ type: 'message', role: message.role === 'system' ? 'developer' : message.role, content });
  }
  if (bytes > TEXT_LIMIT || history.at(-1).role !== 'user') throw new BridgeError('INPUT_UNSUPPORTED');
  return history;
}
