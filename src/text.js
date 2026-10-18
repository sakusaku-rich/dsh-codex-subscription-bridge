import { BridgeError } from './errors.js';
import { REQUEST_IMAGE_ATTACHMENT_MAX_BYTES, requestImageTarget } from './image.js';

export const PROVIDER = 'codex-subscription';
export const TEXT_LIMIT = 256 * 1024;
export const TOOL_LIMIT = 256;
export const TOOL_UPDATE_LIMIT = 128;
export const TOOL_NAME_LIMIT = 64;
export const TOOL_DESCRIPTION_LIMIT = 8192;
export const TOOL_PARAMETERS_LIMIT = 64 * 1024;
export const TOOLS_BYTES_LIMIT = 256 * 1024;
export const TOOL_BYTES_LIMIT = 2 * 1024 * 1024;
// The request bound expressed in bytes. It stays the floor when the model
// discloses no usable window; a disclosed window raises it through
// `requestLimits` in compaction.js so the bound and the compaction threshold
// come from the same measurement.
export const INPUT_BYTES_FLOOR = TEXT_LIMIT + TOOL_BYTES_LIMIT;
export const RETAINED_TEXT_LIMIT = 4 * 1024 * 1024;
export const RETAINED_TOOL_BYTES_LIMIT = 16 * 1024 * 1024;
export const RETAINED_INPUT_BYTES_FLOOR = RETAINED_TEXT_LIMIT + RETAINED_TOOL_BYTES_LIMIT;
export const RETAINED_MESSAGE_LIMIT = 4096;
export const CALL_ID_LIMIT = 256;
export const BLOCK_LIMIT = 64;
// Agent turns interleave tool calls and results as separate messages; the old
// 128-message cap rejected long working sessions well before byte limits
// bound the request. 1024 items with the unchanged byte limits keeps the wire
// shape bounded while covering any pre-compaction session.
export const MESSAGE_LIMIT = 1024;
export const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const ATTACHMENT_ID = /^sha256:[0-9a-f]{64}$/;
const TOOL_NAME = /^[A-Za-z0-9_-]+$/;

/** Count what a wire input contributes against a bound. */
export function measure(input) {
  let textBytes = 0, toolBytes = 0;
  const attachments = new Set();
  for (const value of input) {
    if (value.type === 'message') for (const part of value.content) {
      if (typeof part.text === 'string') textBytes += Buffer.byteLength(part.text);
      if (part.attachmentId) attachments.add(part.attachmentId);
    }
    if (value.type === 'function_call') toolBytes += Buffer.byteLength(value.arguments);
    if (value.type === 'function_call_output') toolBytes += Buffer.byteLength(value.output);
  }
  return { textBytes, toolBytes, attachments };
}

export const fits = (limits, input, measured) => input.length <= limits.messageLimit &&
  measured.textBytes <= limits.textBytes && measured.toolBytes <= limits.toolBytes &&
  measured.textBytes + measured.toolBytes <= limits.inputBytes;

/**
 * One disclosed reasoning level: a bounded id plus an optional bounded note.
 *
 * The subscription catalog lists each model's own levels, so the adapter
 * declares what the backend discloses instead of a fixed host scale.
 */
export const REASONING_LEVEL_LIMIT = 16;
export const REASONING_LEVEL_ID = /^[a-z][a-z0-9_-]{0,31}$/;
const REASONING_DESCRIPTION_LIMIT = 512;
/** Display names for the levels Codex currently discloses; others are title-cased. */
const REASONING_LEVEL_NAMES = Object.freeze({
  minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High',
  xhigh: 'Extra high', max: 'Max', ultra: 'Ultra',
});

/**
 * Project one catalog entry's `supported_reasoning_levels` into declared efforts.
 *
 * Absent, oversized or malformed disclosure stays omitted rather than
 * advertising an id the route may not accept, so the host simply offers no
 * effort selector for that model.
 * @param value - the entry's `supported_reasoning_levels` field.
 * @returns detached efforts in disclosure order, or `undefined` when unusable.
 */
export function reasoningLevels(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > REASONING_LEVEL_LIMIT) return undefined;
  const seen = new Set();
  const levels = [];
  for (const item of value) {
    const id = item?.effort;
    if (typeof id !== 'string' || !REASONING_LEVEL_ID.test(id) || seen.has(id)) return undefined;
    seen.add(id);
    const description = typeof item.description === 'string' && item.description.length <= REASONING_DESCRIPTION_LIMIT
      ? item.description : undefined;
    levels.push({ id, name: REASONING_LEVEL_NAMES[id] ?? id.charAt(0).toUpperCase() + id.slice(1),
      ...(description === undefined ? {} : { description }) });
  }
  return levels;
}

function reasoningEffort(value) {
  // The host offers only levels this adapter declared from the backend's own
  // disclosure, and dispatch rechecks the choice against it, so the id travels
  // verbatim after a bounded local shape check.
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !REASONING_LEVEL_ID.test(value)) throw new BridgeError('INPUT_UNSUPPORTED');
  return { effort: value };
}

function requestTemperature(value) {
  // Forwarded verbatim as the Responses `temperature` field, like the
  // subscription route's own adapter. The Responses API documents 0..2.
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 2) {
    throw new BridgeError('INPUT_UNSUPPORTED', 'TEMPERATURE');
  }
  return value;
}

function requestMaxTokens(value) {
  // Accepted and shape-checked but not forwarded: the subscription route's own
  // adapter omits `max_output_tokens` for this route, so a turn token budget
  // stays advisory. Values that the runtime itself would reject are still
  // refused so a caller cannot mistake silence for acceptance.
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000) {
    throw new BridgeError('INPUT_UNSUPPORTED', 'MAX_TOKENS');
  }
}

function validateToolHistory(value) {
  // The Harness runtime sends the complete current tool list on every request
  // for routes without incremental tool updates; history content is never
  // serialized. Validation is purely defensive against oversized inputs.
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || !Array.isArray(value.tools) || value.tools.length > TOOL_LIMIT ||
      !Array.isArray(value.updates) || value.updates.length > TOOL_UPDATE_LIMIT) throw new BridgeError('INPUT_UNSUPPORTED', 'TOOL_INPUT');
}

function serializeTools(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > TOOL_LIMIT) throw new BridgeError('INPUT_UNSUPPORTED', 'TOOL_INPUT');
  const names = new Set();
  const tools = [];
  for (const tool of value) {
    if (!tool || typeof tool !== 'object' || Array.isArray(tool)) throw new BridgeError('INPUT_UNSUPPORTED', 'TOOL_INPUT');
    // The Harness runtime strips `deferLoading` for routes without incremental
    // tool updates, so it cannot reach this bridge; accept a boolean defensively
    // and never serialize it.
    if (tool.deferLoading !== undefined && typeof tool.deferLoading !== 'boolean') throw new BridgeError('INPUT_UNSUPPORTED', 'TOOL_INPUT');
    if (typeof tool.name !== 'string' || tool.name.length === 0 || tool.name.length > TOOL_NAME_LIMIT ||
        !TOOL_NAME.test(tool.name) || names.has(tool.name)) throw new BridgeError('INPUT_UNSUPPORTED', 'TOOL_INPUT');
    names.add(tool.name);
    if (tool.description !== undefined && (typeof tool.description !== 'string' ||
        Buffer.byteLength(tool.description) > TOOL_DESCRIPTION_LIMIT)) throw new BridgeError('INPUT_UNSUPPORTED', 'TOOL_INPUT');
    if (!tool.parameters || typeof tool.parameters !== 'object' || Array.isArray(tool.parameters)) throw new BridgeError('INPUT_UNSUPPORTED', 'TOOL_INPUT');
    if (Buffer.byteLength(JSON.stringify(tool.parameters)) > TOOL_PARAMETERS_LIMIT) throw new BridgeError('INPUT_UNSUPPORTED', 'TOOL_INPUT');
    tools.push({ type: 'function', name: tool.name, ...(tool.description === undefined ? {} : { description: tool.description }),
      strict: false, parameters: tool.parameters });
  }
  if (Buffer.byteLength(JSON.stringify(tools)) > TOOLS_BYTES_LIMIT) throw new BridgeError('INPUT_UNSUPPORTED', 'TOOL_INPUT');
  return tools;
}

function serializeImage(block, images, imageBlocks) {
  // The stream layer projects offloaded occurrences into text placeholders
  // before validation; one arriving here means the projection was skipped.
  if (block.offloaded === true) throw new BridgeError('INPUT_UNSUPPORTED');
  const attachment = block.attachment;
  if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment) ||
      typeof attachment.attachmentId !== 'string' || !ATTACHMENT_ID.test(attachment.attachmentId) ||
      !IMAGE_MEDIA_TYPES.has(attachment.mediaType) || !Number.isSafeInteger(attachment.bytes) ||
      attachment.bytes <= 0 || attachment.bytes > REQUEST_IMAGE_ATTACHMENT_MAX_BYTES ||
      !Number.isSafeInteger(attachment.width) || attachment.width <= 0 ||
      !Number.isSafeInteger(attachment.height) || attachment.height <= 0 ||
      (attachment.name !== undefined && typeof attachment.name !== 'string')) throw new BridgeError('UNSUPPORTED_CONTENT', 'IMAGE_PREPARE');
  // One durable attachment may occur several times; all occurrences share the
  // same request version.
  if (!images.has(attachment.attachmentId)) {
    images.set(attachment.attachmentId, { ref: attachment, target: requestImageTarget(attachment.width, attachment.height) });
  }
  imageBlocks.push(block);
}

// One shared byte counter so the combined request bound and the per-part bound
// are checked against the same measurement. Text overflow stays the shape
// failure it was; tool payload overflow stays a bound breach.
function addBytes(bytesRef, kind, size) {
  bytesRef[kind] += size;
  if (bytesRef[kind] > bytesRef.limits[kind === 'text' ? 'textBytes' : 'toolBytes']) {
    throw new BridgeError(kind === 'text' ? 'INPUT_UNSUPPORTED' : 'LIMIT_EXCEEDED');
  }
  if (bytesRef.text + bytesRef.tool > bytesRef.limits.inputBytes) throw new BridgeError('LIMIT_EXCEEDED');
}

export function defaultLimits(retained = false) {
  return {
    inputBytes: retained ? RETAINED_INPUT_BYTES_FLOOR : INPUT_BYTES_FLOOR,
    textBytes: retained ? RETAINED_TEXT_LIMIT : TEXT_LIMIT,
    toolBytes: retained ? RETAINED_TOOL_BYTES_LIMIT : TOOL_BYTES_LIMIT,
    messageLimit: retained ? RETAINED_MESSAGE_LIMIT : MESSAGE_LIMIT,
  };
}

function serializeToolCall(block, calls, pendingCalls, bytesRef) {
  if (typeof block.id !== 'string' || block.id.length === 0 || block.id.length > CALL_ID_LIMIT ||
      typeof block.name !== 'string' || block.name.length === 0 || Buffer.byteLength(block.name) > TOOL_NAME_LIMIT ||
      typeof block.arguments !== 'string' || calls.has(block.id)) throw new BridgeError('INPUT_UNSUPPORTED');
  addBytes(bytesRef, 'tool', Buffer.byteLength(block.arguments));
  pendingCalls.push({ type: 'function_call', call_id: block.id, name: block.name, arguments: block.arguments });
}

function serializeToolResult(message, calls, results, bytesRef) {
  const callId = message.toolCallId ?? message.source?.callId;
  if (typeof callId !== 'string' || callId.length === 0 || callId.length > CALL_ID_LIMIT ||
      !calls.has(callId) || results.has(callId)) throw new BridgeError('INPUT_UNSUPPORTED');
  if (message.source !== undefined && (message.source === null || typeof message.source !== 'object' ||
      message.source.kind !== 'tool')) throw new BridgeError('INPUT_UNSUPPORTED');
  const text = [];
  for (const block of message.content) {
    if (!block || block.type !== 'text' || typeof block.text !== 'string') throw new BridgeError('UNSUPPORTED_CONTENT');
    text.push(block.text);
  }
  const output = text.join('\n');
  addBytes(bytesRef, 'tool', Buffer.byteLength(output));
  results.add(callId);
  return { type: 'function_call_output', call_id: callId, output };
}

/**
* Validate one request and derive the Responses wire items for it.
* @param options - Harness generate options for this provider.
* @param retained - Apply larger bounded transcript limits before checkpoint selection.
*   The caller must still validate the selected wire window or the ordinary fallback.
 * @param limits - Byte and message bounds for this request, derived from the disclosed
 *   window when one is available and otherwise the fixed floor.
* @returns a plan: `input` wire items with image placeholders, `tools` wire
*   declarations, `reasoning` effort mapping, a validated `temperature` when
*   the request carries one, and per-attachment image entries
*   with their durable references, request targets, and original blocks.
*/
export function validateInput(options, retained = false, limits = defaultLimits(retained)) {
  if (options.provider !== PROVIDER || !Array.isArray(options.messages) || options.messages.length > limits.messageLimit || !options.messages.length) {
    throw new BridgeError('INPUT_UNSUPPORTED');
  }
  // Generation overrides: temperature is forwarded, a turn token budget is
  // accepted but not forwarded (documented exception), stop sequences stay
  // unsupported like the route's own adapter.
  const temperature = requestTemperature(options.temperature);
  requestMaxTokens(options.maxTokens);
  if (options.stop !== undefined) throw new BridgeError('UNSUPPORTED_OPTION', 'STOP');
  const reasoning = reasoningEffort(options.reasoningEffort);
  const tools = serializeTools(options.tools);
  validateToolHistory(options.toolHistory);
  const bytesRef = { text: 0, tool: 0, limits };
  const spans = [];
  const input = [];
  const images = new Map();
  const imageBlocks = [];
  const calls = new Set();
  const results = new Set();
  if (options.system !== undefined) {
    if (typeof options.system !== 'string') throw new BridgeError('INPUT_UNSUPPORTED');
    addBytes(bytesRef, 'text', Buffer.byteLength(options.system));
    input.push({ type: 'message', role: 'developer', content: [{ type: 'input_text', text: options.system }] });
  }
  for (const message of options.messages) {
    const span = { start: input.length, end: input.length, imageEnd: imageBlocks.length };
    spans.push(span);
    if (!message || !Array.isArray(message.content) ||
        !['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role)) throw new BridgeError('INPUT_UNSUPPORTED');
    if (message.role === 'tool') {
      const item = serializeToolResult(message, calls, results, bytesRef);
      input.push(item);
      span.end = input.length;
      continue;
    }
    const content = [];
    const pendingCalls = [];
    const total = () => content.length + pendingCalls.length;
    for (const block of message.content) {
      if (!block || typeof block !== 'object' || Array.isArray(block)) throw new BridgeError('INPUT_UNSUPPORTED');
      if (block.type === 'text') {
        if (typeof block.text !== 'string') throw new BridgeError('INPUT_UNSUPPORTED');
        addBytes(bytesRef, 'text', Buffer.byteLength(block.text));
        if (total() >= BLOCK_LIMIT) throw new BridgeError('INPUT_UNSUPPORTED');
        content.push({ type: message.role === 'assistant' ? 'output_text' : 'input_text', text: block.text });
      } else if (block.type === 'image') {
        if (message.role !== 'user') throw new BridgeError('UNSUPPORTED_CONTENT', 'IMAGE_PREPARE');
        if (total() >= BLOCK_LIMIT) throw new BridgeError('INPUT_UNSUPPORTED');
        serializeImage(block, images, imageBlocks);
        content.push({ type: 'input_image', image_url: '', attachmentId: block.attachment.attachmentId });
      } else if (block.type === 'tool-call') {
        if (message.role !== 'assistant') throw new BridgeError('INPUT_UNSUPPORTED');
        serializeToolCall(block, calls, pendingCalls, bytesRef);
      } else if (block.type === 'reasoning') {
        // Reasoning history replay has no wire representation on this route
        // and is dropped, matching the DeepSeek adapter's documented exception
        // to reject-unknown handling.
      } else if ((block.type === 'tool-addition' || block.type === 'tool-removal') &&
          (message.role === 'system' || message.role === 'developer')) {
        // The Harness runtime drops developer tool-registry messages for this
        // route; defensively skip registry blocks if any still arrive.
      } else if (block.type === 'file') {
        throw new BridgeError('UNSUPPORTED_CONTENT');
      } else {
        throw new BridgeError('INPUT_UNSUPPORTED');
      }
    }
    for (const item of pendingCalls) calls.add(item.call_id);
    if (content.length) input.push({ type: 'message', role: message.role === 'system' || message.role === 'developer' ? 'developer' : message.role, content });
    input.push(...pendingCalls);
    span.end = input.length;
    span.imageEnd = imageBlocks.length;
  }
  for (const callId of calls) if (!results.has(callId)) throw new BridgeError('INPUT_UNSUPPORTED');
  const last = input.at(-1);
  if (!last || !((last.type === 'message' && last.role === 'user') || last.type === 'function_call_output')) throw new BridgeError('INPUT_UNSUPPORTED');
  return { input, tools, reasoning, temperature, images, imageBlocks, spans };
}
