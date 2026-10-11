const messages = Object.freeze({
  AUTH_REQUIRED: 'A dedicated subscription login is required. Run dsh-codex-subscription-auth login.',
  AUTH_STORE_INVALID: 'The dedicated authentication store is invalid or insecure.',
  AUTH_BUSY: 'The authentication store is busy. A crashed owner may require manual lock recovery.',
  RATE_LIMITED: 'The subscription service rate or usage limit was reached.',
  PLATFORM_UNSUPPORTED: 'This bridge currently supports macOS only.',
  NODE_VERSION_UNSUPPORTED: 'Use the supported Node.js 22 runtime, version 22.23.3 or newer.',
  CONFIG_INVALID: 'The bridge configuration is invalid.',
  INPUT_UNSUPPORTED: 'Only bounded text conversations without tool execution history or generation overrides are supported.',
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
  'SSE_OUTPUT_ITEM', 'SSE_TERMINAL', 'SSE_INCOMPLETE',
]);
export class BridgeError extends Error {
  constructor(code, diagnostic) {
    const safeCode = Object.hasOwn(messages, code) ? code : 'UPSTREAM_FAILED';
    const label = diagnostics.has(diagnostic) ? diagnostic : undefined;
    super(messages[safeCode] + (label ? ` [${label}]` : ''));
    this.diagnostic = label;
    this.name = 'BridgeError';
    this.code = safeCode;
  }
}
/** Reconstruct from fixed code/label allowlists; never trust a mutable message. */
export function classified(error, diagnostic) {
  return new BridgeError(error instanceof BridgeError ? error.code : 'UPSTREAM_FAILED',
    error instanceof BridgeError && diagnostics.has(error.diagnostic) ? error.diagnostic : diagnostic);
}
export const failure = (error) => {
  const safe = classified(error);
  return { code: safe.code, message: safe.message };
};
export function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BridgeError('PROTOCOL_INVALID');
  return value;
}
export function string(value, max = 256) {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > max) throw new BridgeError('PROTOCOL_INVALID');
  return value;
}
