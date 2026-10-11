import { BridgeError } from './errors.js';
export const BASE = 'https://chatgpt.com/backend-api/codex';
export const ISSUER = 'https://auth.openai.com';
export const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export function statusError(status) {
  return new BridgeError(status === 401 || status === 403 ? 'AUTH_REQUIRED' : status === 429 ? 'RATE_LIMITED' : 'UPSTREAM_FAILED');
}
export async function readBytes(response, limit = 1024 * 1024) {
  if (!response.body) throw new BridgeError('PROTOCOL_INVALID');
  const reader = response.body.getReader(); let bytes = 0; const chunks = [];
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > limit) throw new BridgeError('LIMIT_EXCEEDED');
      chunks.push(Buffer.from(part.value));
    }
    return Buffer.concat(chunks);
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export async function readJson(response, limit) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBytes(response, limit))); }
  catch (error) { if (error instanceof BridgeError) throw error; throw new BridgeError('PROTOCOL_INVALID'); }
}
/** Fixed destinations only; private fetch injection is a synthetic-test seam. */
export class Http {
  constructor(fetcher = globalThis.fetch) { this.fetcher = fetcher; }
  async open(url, options, signal) {
    const parsed = new URL(url);
    if (![BASE, ISSUER].some(base => url === base || url.startsWith(base + '/') || url.startsWith(base + '?')) || parsed.username || parsed.password) throw new BridgeError('CONFIG_INVALID');
    try { return await this.fetcher(url, { ...options, signal, redirect: 'error' }); }
    catch { throw new BridgeError(signal?.aborted ? 'ABORTED' : 'UPSTREAM_FAILED'); }
  }
  async json(url, options = {}, signal, limit = 1024 * 1024) {
    const timeout = AbortSignal.timeout(15_000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response;
    try {
      response = await this.open(url, options, combined);
      if (!response.ok) { await response.body?.cancel(); throw statusError(response.status); }
      return await readJson(response, limit);
    } catch (error) { if (timeout.aborted) throw new BridgeError('TIMEOUT'); throw error; }
    finally { await response?.body?.cancel().catch(() => {}); }
  }
}
