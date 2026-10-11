import { setImmediate as yieldLoop } from 'node:timers/promises';
import { Agent, fetch as subscriptionFetch } from 'undici';
// Do not inherit a dispatcher created by the host's older bundled Undici.
const subscriptionDispatcher = new Agent({ connections: 4, pipelining: 1 });
import { BridgeError, classified } from './errors.js';
export const BASE = 'https://chatgpt.com/backend-api/codex';
export const ISSUER = 'https://auth.openai.com';
export const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
// Fixed destinations with their normalized forms. The fence is re-asserted on
// the parsed URL after WHATWG normalization so dot-segment escapes cannot
// leave the fixed path prefix.
const FENCES = [BASE, ISSUER].map(base => ({ base, normalized: new URL(base) }));
export function statusError(status) {
  return new BridgeError(status === 401 || status === 403 ? 'AUTH_REQUIRED' : status === 429 ? 'RATE_LIMITED' : 'UPSTREAM_FAILED');
}
export function abortFailure(signal) {
  return new BridgeError(signal?.reason?.name === 'TimeoutError' ? 'TIMEOUT' : 'ABORTED', 'HTTP_REQUEST');
}
export async function readBytes(response, limit = 1024 * 1024, signal) {
  if (!response.body) throw new BridgeError('PROTOCOL_INVALID');
  if (signal?.aborted) { await response.body.cancel().catch(() => {}); throw abortFailure(signal); }
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  // Retain bounded payload storage, independent of network fragmentation.
  const buffer = Buffer.alloc(limit);
  let bytes = 0, readWork = 0, byteWork = 0;
  try {
    for (;;) {
      if (signal?.aborted) throw abortFailure(signal);
      if (++readWork >= 256 || byteWork >= 4096) {
        readWork = 0; byteWork = 0;
        await yieldLoop();
        if (signal?.aborted) throw abortFailure(signal);
      }
      const part = await reader.read();
      if (signal?.aborted) throw abortFailure(signal);
      if (part.done) break;
      const length = part.value.byteLength;
      if (length > limit - bytes) throw new BridgeError('LIMIT_EXCEEDED');
      if (length) { buffer.set(part.value, bytes); bytes += length; byteWork += length; }
    }
    return buffer.subarray(0, bytes);
  } finally { signal?.removeEventListener('abort', cancel); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export async function readJson(response, limit, signal) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBytes(response, limit, signal))); }
  catch (error) { if (signal?.aborted) throw abortFailure(signal); if (error instanceof BridgeError) throw classified(error, 'HTTP_JSON_BODY'); throw new BridgeError('PROTOCOL_INVALID', 'HTTP_JSON_BODY'); }
}
/** Fixed destinations only; private fetch injection is a synthetic-test seam. */
export class Http {
  constructor(fetcher = subscriptionFetch) { this.fetcher = fetcher; }
  async open(url, options, signal) {
    const parsed = new URL(url);
    const fenced = FENCES.some(({ base, normalized }) => parsed.origin === normalized.origin
      && parsed.pathname.startsWith(normalized.pathname)
      && (url === base || url.startsWith(base + '/') || url.startsWith(base + '?')));
    if (!fenced || parsed.username || parsed.password) throw new BridgeError('CONFIG_INVALID');
    try { return await this.fetcher(url, { ...options, signal, redirect: 'error', dispatcher: subscriptionDispatcher }); }
    catch { if (signal?.aborted) throw abortFailure(signal); throw new BridgeError('UPSTREAM_FAILED', 'HTTP_REQUEST'); }
  }
  async json(url, options = {}, signal, limit = 1024 * 1024) {
    const timeout = AbortSignal.timeout(15_000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response;
    try {
      response = await this.open(url, options, combined);
      if (!response.ok) { await response.body?.cancel(); throw statusError(response.status); }
      return await readJson(response, limit, combined);
    } catch (error) {
      if (combined.aborted) throw abortFailure(combined);
      throw error;
    }
    finally { await response?.body?.cancel().catch(() => {}); }
  }
}
