const messages = Object.freeze({
  CONFIG_REQUIRED: 'Configure a trusted absolute Codex executable path and credential store before connecting.',
  AUTH_REQUIRED: 'A dedicated subscription login is required. Run dsh-codex-subscription-auth login.',
  AUTH_STORE_INVALID: 'The dedicated authentication store is invalid or insecure.',
  AUTH_BUSY: 'The authentication store is busy. A crashed owner may require manual lock recovery.',
  RATE_LIMITED: 'The subscription service rate or usage limit was reached.',
  PLATFORM_UNSUPPORTED: 'This bridge currently supports macOS only.',
  VERSION_UNSUPPORTED: 'This Codex version is not supported.',
  CONFIG_INVALID: 'The bridge configuration is invalid.',
  INPUT_UNSUPPORTED: 'Only bounded text conversations without tool execution history or generation overrides are supported.',
  MODEL_UNAVAILABLE: 'The selected subscription model is unavailable.',
  PROTOCOL_INVALID: 'The subscription service returned an unsupported protocol message.',
  UPSTREAM_FAILED: 'The subscription service request failed.',
  PROCESS_FAILED: 'The app-server process failed.',
  LIMIT_EXCEEDED: 'The bridge resource limit was exceeded.',
  TIMEOUT: 'The subscription operation timed out.',
  ABORTED: 'The conversation was cancelled.',
  CLOSED: 'The bridge is closed.',
});
export class BridgeError extends Error {
  constructor(code) {
    super(messages[code] ?? messages.UPSTREAM_FAILED);
    this.name = 'BridgeError';
    this.code = Object.hasOwn(messages, code) ? code : 'UPSTREAM_FAILED';
  }
}
export const failure = (error) => {
  const safe = error instanceof BridgeError ? error : new BridgeError('UPSTREAM_FAILED');
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
