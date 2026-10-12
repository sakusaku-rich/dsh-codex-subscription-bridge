const messages = Object.freeze({
  AUTH_REQUIRED: 'A dedicated subscription login is required. Open ChatGPT subscription in Harness settings or run dsh-codex-subscription-auth login.',
  AUTH_STORE_INVALID: 'The dedicated authentication store is invalid or insecure.',
  AUTH_BUSY: 'The authentication store is busy. A crashed owner may require manual lock recovery.',
  RATE_LIMITED: 'The subscription service rate or usage limit was reached.',
  PLATFORM_UNSUPPORTED: 'This bridge currently supports macOS only.',
  NODE_VERSION_UNSUPPORTED: 'Use Node.js 22 >=22.23.3 or the supported Electron 44.0.0 Desktop host.',
  CONFIG_INVALID: 'The bridge configuration is invalid.',
  INPUT_UNSUPPORTED: 'The conversation does not match the bounded request shape this subscription route accepts.',
  UNSUPPORTED_CONTENT: 'The conversation contains content this subscription route cannot carry.',
  IMAGE_OFFLOAD_REQUIRED: 'The conversation images exceed the subscription route request image budget. The oldest conversation images must be offloaded before retrying.',
  MODEL_UNAVAILABLE: 'The selected subscription model is unavailable.',
  PROTOCOL_INVALID: 'The subscription service returned an unsupported protocol message.',
  UPSTREAM_FAILED: 'The subscription service request failed.',
  LIMIT_EXCEEDED: 'The bridge resource limit was exceeded.',
  TIMEOUT: 'The subscription operation timed out.',
  ABORTED: 'The conversation was cancelled.',
  CLOSED: 'The bridge is closed.',
});
const diagnostics = new Set([
  'HTTP_REQUEST', 'HTTP_JSON_BODY', 'MODEL_CATALOG', 'AUTH_REFRESH',
  'AUTH_REFRESH_UNCERTAIN', 'SSE_FRAME', 'SSE_EVENT_TYPE',
  'SSE_EVENT_UNSUPPORTED', 'SSE_TEXT_DELTA', 'SSE_TEXT_COMPLETION',
  'SSE_OUTPUT_ITEM', 'SSE_TOOL_CALL', 'SSE_TERMINAL', 'SSE_INCOMPLETE',
  'TOOL_INPUT', 'IMAGE_PREPARE', 'IMAGE_OFFLOAD',
]);
export class BridgeError extends Error {
  constructor(code, diagnostic, extras) {
    const safeCode = Object.hasOwn(messages, code) ? code : 'UPSTREAM_FAILED';
    const label = diagnostics.has(diagnostic) ? diagnostic : undefined;
    super(messages[safeCode] + (label ? ` [${label}]` : ''));
    this.diagnostic = label;
    this.name = 'BridgeError';
    this.code = safeCode;
    // The Harness runtime reads this positive safe integer to offload the
    // oldest conversation images and retry the request; it stays out of the
    // fixed message so no request detail leaks into error text.
    this.offloadImages = extras !== null && typeof extras === 'object' &&
      Number.isSafeInteger(extras.offloadImages) && extras.offloadImages > 0 ? extras.offloadImages : undefined;
  }
}
/** Reconstruct from fixed code/label allowlists; never trust a mutable message. */
export function classified(error, diagnostic) {
  return new BridgeError(error instanceof BridgeError ? error.code : 'UPSTREAM_FAILED',
    error instanceof BridgeError && diagnostics.has(error.diagnostic) ? error.diagnostic : diagnostic,
    error instanceof BridgeError ? { offloadImages: error.offloadImages } : undefined);
}
export const failure = (error) => {
  const safe = classified(error);
  return { code: safe.code, message: safe.message,
    ...(safe.offloadImages === undefined ? {} : { offloadImages: safe.offloadImages }) };
};
export function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BridgeError('PROTOCOL_INVALID');
  return value;
}
export function string(value, max = 256) {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > max) throw new BridgeError('PROTOCOL_INVALID');
  return value;
}
