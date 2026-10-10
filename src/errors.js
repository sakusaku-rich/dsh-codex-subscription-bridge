const messages = Object.freeze({
  AUTHORITY_UNVERIFIED: 'Live Codex access is disabled: native tool and inherited configuration isolation is not verified.',
  AUTH_REQUIRED: 'An existing managed ChatGPT login is required.',
  VERSION_UNSUPPORTED: 'This Codex version is not supported.',
  CONFIG_INVALID: 'The bridge configuration is invalid.',
  INPUT_UNSUPPORTED: 'Only bounded text conversations without tools or generation overrides are supported.',
  MODEL_UNAVAILABLE: 'The selected subscription model is unavailable.',
  PROTOCOL_INVALID: 'The app-server returned an unsupported protocol message.',
  UPSTREAM_FAILED: 'The app-server request failed.',
  PROCESS_FAILED: 'The app-server process failed.',
  LIMIT_EXCEEDED: 'The bridge resource limit was exceeded.',
  TIMEOUT: 'The app-server operation timed out.',
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
