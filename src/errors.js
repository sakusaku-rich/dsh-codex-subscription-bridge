const messages = Object.freeze({
  AUTH_REQUIRED: 'A dedicated subscription login is required. Open ChatGPT subscription in Harness settings or run dsh-codex-subscription-auth login.',
  AUTH_STORE_INVALID: 'The dedicated authentication store is invalid or insecure.',
  AUTH_BUSY: 'The authentication store is busy. A crashed owner may require manual lock recovery.',
  // Canonical transient rate-limit code from the shared failure taxonomy.
  RATE_LIMIT: 'The subscription service rate limit was reached.',
  // Plan usage cap recognized from structured upstream usage-limit codes; the
  // optional reset hint below is the only message part derived from upstream
  // data, and it is a validated integer, never upstream text.
  QUOTA: 'The ChatGPT plan usage limit was reached.',
  UNSUPPORTED_OPTION: 'The request option is not supported by this subscription route.',
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
  'COMPACTION', 'HTTP_REQUEST', 'HTTP_JSON_BODY', 'MODEL_CATALOG', 'AUTH_REFRESH',
  'AUTH_REFRESH_UNCERTAIN', 'SSE_FRAME', 'SSE_EVENT_TYPE',
  'SSE_EVENT_UNSUPPORTED', 'SSE_TEXT_DELTA', 'SSE_TEXT_COMPLETION',
  'SSE_OUTPUT_ITEM', 'SSE_TOOL_CALL', 'SSE_TERMINAL', 'SSE_INCOMPLETE',
  'TOOL_INPUT', 'IMAGE_PREPARE', 'IMAGE_OFFLOAD', 'STOP', 'TEMPERATURE', 'MAX_TOKENS',
]);
// Longest reset hint the classifier may derive, in minutes (one week).
const RESET_MINUTES_LIMIT = 10080;
export class BridgeError extends Error {
  constructor(code, diagnostic, extras) {
    const safeCode = Object.hasOwn(messages, code) ? code : 'UPSTREAM_FAILED';
    const label = diagnostics.has(diagnostic) ? diagnostic : undefined;
    // A reset hint is a validated integer count, not upstream text, so it can
    // join the fixed message without leaking request or response content.
    const resetMinutes = extras !== null && typeof extras === 'object' &&
      Number.isSafeInteger(extras.resetMinutes) && extras.resetMinutes >= 1 && extras.resetMinutes <= RESET_MINUTES_LIMIT
      ? extras.resetMinutes : undefined;
    super(messages[safeCode] + (resetMinutes !== undefined
      ? ` Try again in about ${resetMinutes} minute${resetMinutes === 1 ? '' : 's'}.` : '') + (label ? ` [${label}]` : ''));
    this.diagnostic = label;
    this.name = 'BridgeError';
    this.code = safeCode;
    // The Harness runtime reads this positive safe integer to offload the
    // oldest conversation images and retry the request; it stays out of the
    // fixed message so no request detail leaks into error text.
    this.offloadImages = extras !== null && typeof extras === 'object' &&
      Number.isSafeInteger(extras.offloadImages) && extras.offloadImages > 0 ? extras.offloadImages : undefined;
    this.resetMinutes = resetMinutes;
  }
}
/** Reconstruct from fixed code/label allowlists; never trust a mutable message. */
export function classified(error, diagnostic) {
  const safe = error instanceof BridgeError ? error : undefined;
  return new BridgeError(safe ? safe.code : 'UPSTREAM_FAILED',
    safe && diagnostics.has(safe.diagnostic) ? safe.diagnostic : diagnostic,
    safe ? { offloadImages: safe.offloadImages, resetMinutes: safe.resetMinutes } : undefined);
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
