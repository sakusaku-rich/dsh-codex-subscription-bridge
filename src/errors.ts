/** Fixed message vocabulary for every failure the bridge can report. */
const messages: Readonly<Record<string, string>> = Object.freeze({
  AUTH_REQUIRED: 'A dedicated subscription login is required. Open ChatGPT subscription in Harness settings or run dsh-codex-subscription-auth login.',
  AUTH_STORE_INVALID: 'The dedicated authentication store is invalid or insecure.',
  AUTH_BUSY: 'The authentication store is busy. A crashed owner may require manual lock recovery.',
  // Canonical transient rate-limit code from the shared failure taxonomy.
  RATE_LIMIT: 'The subscription service rate limit was reached.',
  // Plan usage cap recognized from structured upstream usage-limit codes; the
  // optional reset hint below is the only message part derived from upstream
  // data, and it is a validated integer, never upstream text.
  QUOTA: 'The ChatGPT plan usage limit was reached.',
  UNSUPPORTED_OPTION: 'The request option is not supported by this subscription endpoint.',
  PLATFORM_UNSUPPORTED: 'This bridge currently supports macOS only.',
  NODE_VERSION_UNSUPPORTED: 'Use Node.js 22 >=22.23.3 or the supported Electron 44.7.0 Desktop host.',
  CONFIG_INVALID: 'The bridge configuration is invalid.',
  INPUT_UNSUPPORTED: 'The conversation does not match the bounded request shape this subscription endpoint accepts.',
  COMPACTION_UNAVAILABLE: 'The encrypted server-side compaction state cannot be reused, and the full conversation is too large to send. Start a new conversation.',
  CONTEXT_LIMIT: 'The conversation is larger than the context this subscription model can carry. Start a new conversation.',
  UNSUPPORTED_CONTENT: 'The conversation contains content this subscription endpoint cannot carry.',
  IMAGE_OFFLOAD_REQUIRED: 'The conversation images exceed the image budget for a single subscription request. The oldest conversation images must be offloaded before retrying.',
  MODEL_UNAVAILABLE: 'The selected subscription model is unavailable.',
  PROTOCOL_INVALID: 'The subscription service returned an unsupported protocol message.',
  UPSTREAM_FAILED: 'The subscription service request failed.',
  LIMIT_EXCEEDED: 'The bridge resource limit was exceeded.',
  TIMEOUT: 'The subscription operation timed out.',
  ABORTED: 'The conversation was cancelled.',
  CLOSED: 'The bridge is closed.',
});
const diagnostics: Set<string | undefined> = new Set([
  'INPUT', 'COMPACTION', 'HTTP_REQUEST', 'HTTP_JSON_BODY', 'MODEL_CATALOG', 'AUTH_REFRESH',
  'AUTH_REFRESH_UNCERTAIN', 'SSE_FRAME', 'SSE_FRAME:FRAME', 'SSE_FRAME:TOTAL', 'SSE_FRAME:EVENTS',
  'SSE_EVENT_TYPE',
  'SSE_TEXT_DELTA', 'SSE_TEXT_COMPLETION',
  'SSE_OUTPUT_ITEM', 'SSE_TOOL_CALL', 'SSE_TERMINAL', 'SSE_INCOMPLETE',
  'TOOL_INPUT', 'IMAGE_PREPARE', 'IMAGE_OFFLOAD', 'IMAGE_TARGET', 'STOP', 'TEMPERATURE', 'MAX_TOKENS',
]);
// Longest reset hint the classifier may derive, in minutes (one week).
const RESET_MINUTES_LIMIT = 10080;
/** Structured extras a BridgeError may carry; every field is re-validated here. */
export interface ErrorExtras {
  resetMinutes?: number | undefined;
  offloadImages?: number | undefined;
  sseCount?: number | undefined;
  sseLimit?: number | undefined;
}
/** An unvalidated parsed JSON object; each field stays unknown until checked. */
export type JsonObject = Record<string, unknown>;
export class BridgeError extends Error {
  code: string;
  diagnostic: string | undefined;
  offloadImages: number | undefined;
  resetMinutes: number | undefined;
  sseCount: number | undefined;
  sseLimit: number | undefined;
  /** Failing stage in the compaction vocabulary; set by compaction.ts. */
  stage: string | undefined;
  constructor(code: string, diagnostic?: string, extras?: ErrorExtras) {
    const safeCode = Object.hasOwn(messages, code) ? code : 'UPSTREAM_FAILED';
    const label = diagnostics.has(diagnostic) ? diagnostic : undefined;
    // A reset hint is a validated integer count, not upstream text, so it can
    // join the fixed message without leaking request or response content.
    // `Number.isSafeInteger` does not narrow, so each guard asserts the checked type.
    const resetMinutes = extras !== null && typeof extras === 'object' &&
      Number.isSafeInteger(extras.resetMinutes) && (extras.resetMinutes as number) >= 1 && (extras.resetMinutes as number) <= RESET_MINUTES_LIMIT
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
      Number.isSafeInteger(extras.offloadImages) && (extras.offloadImages as number) > 0 ? extras.offloadImages : undefined;
    this.resetMinutes = resetMinutes;
    // Structured SSE resource-limit numbers stay out of the fixed message: the
    // label above names the bound, and the owner's log receives the numbers.
    this.sseCount = extras !== null && typeof extras === 'object' &&
      Number.isSafeInteger(extras.sseCount) && (extras.sseCount as number) > 0 ? extras.sseCount : undefined;
    this.sseLimit = extras !== null && typeof extras === 'object' &&
      Number.isSafeInteger(extras.sseLimit) && (extras.sseLimit as number) > 0 ? extras.sseLimit : undefined;
  }
}
/** Reconstruct from fixed code/label allowlists; never trust a mutable message. */
export function classified(error: unknown, diagnostic?: string): BridgeError {
  const safe = error instanceof BridgeError ? error : undefined;
  return new BridgeError(safe ? safe.code : 'UPSTREAM_FAILED',
    safe && diagnostics.has(safe.diagnostic) ? safe.diagnostic : diagnostic,
    safe ? { offloadImages: safe.offloadImages, resetMinutes: safe.resetMinutes,
      sseCount: safe.sseCount, sseLimit: safe.sseLimit } : undefined);
}
export const failure = (error: unknown): { code: string; message: string; offloadImages?: number } => {
  const safe = classified(error);
  return { code: safe.code, message: safe.message,
    ...(safe.offloadImages === undefined ? {} : { offloadImages: safe.offloadImages }) };
};
/**
 * Read the structured fields of a subscription error body. Only fixed codes and
 * the fixed parameter name are recognized; upstream message text is never kept,
 * so the fixed messages above remain the only user-visible text.
 */
const FIELD_LIMIT = 256;
/** The fixed fields recognized in a subscription error body. */
export interface ErrorFields {
  code?: string;
  type?: string;
  param?: string;
}
export function errorFields(error: unknown): ErrorFields {
  if (!error || typeof error !== 'object' || Array.isArray(error)) return {};
  // The guard above proves an object; its fields stay unknown until `field` checks them.
  const body = error as JsonObject;
  const field = (value: unknown): string => typeof value === 'string' && Buffer.byteLength(value) <= FIELD_LIMIT ? value : '';
  return { code: field(body.code), type: field(body.type), param: field(body.param) };
}
// The only parameter the bridge may drop and resend without.
export const REJECTED_PARAMETER = 'context_management';
const PARAM_REJECTION_CODES: Set<string | undefined> = new Set(['unsupported_parameter', 'unknown_parameter']);
export const parameterRejection = (fields: ErrorFields): boolean => fields.param === REJECTED_PARAMETER && PARAM_REJECTION_CODES.has(fields.code);
// Structured context-limit codes the subscription endpoint reports.
const CONTEXT_LIMIT_CODES: Set<string | undefined> = new Set(['context_length_exceeded']);
export const classifyErrorFields = (fields: ErrorFields): BridgeError => new BridgeError(
  CONTEXT_LIMIT_CODES.has(fields.code || fields.type) ? 'CONTEXT_LIMIT' : 'UPSTREAM_FAILED', 'SSE_TERMINAL');
export function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BridgeError('PROTOCOL_INVALID');
  // The guard above proves a non-array object; the fields themselves stay unknown.
  return value as JsonObject;
}
export function string(value: unknown, max = 256): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > max) throw new BridgeError('PROTOCOL_INVALID');
  return value;
}
