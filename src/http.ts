import { setImmediate as yieldLoop } from 'node:timers/promises';
import { Agent, fetch as subscriptionFetch, type RequestInit, type Response } from 'undici';
// Do not inherit a dispatcher created by the host's older bundled Undici.
const subscriptionDispatcher = new Agent({ connections: 4, pipelining: 1 });
import { BridgeError, classified, errorFields, type JsonObject } from './errors.js';
import { isQuotaExceededError } from '@deepseek-ai/dsh-llm';

export const BASE = 'https://chatgpt.com/backend-api/codex';
export const ISSUER = 'https://auth.openai.com';
export const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
// Fixed destinations with their normalized forms. The fence is re-asserted on
// the parsed URL after WHATWG normalization so dot-segment escapes cannot
// leave the fixed path prefix.
const FENCES = [BASE, ISSUER].map(base => ({ base, normalized: new URL(base) }));

export function statusError(status: number): BridgeError {
  return new BridgeError(status === 401 || status === 403 ? 'AUTH_REQUIRED' : status === 429 ? 'RATE_LIMIT' : 'UPSTREAM_FAILED');
}
// Structured usage-limit codes of the subscription endpoint, from the same
// body family the official adapter recognizes, plus the shared quota wording.
const USAGE_LIMIT_CODES: Set<string | undefined> = new Set(['usage_limit_reached', 'usage_not_included']);
const USAGE_LIMIT_BODY_LIMIT = 16 * 1024;

/**
 * Terminal status to safe fixed error, reading a bounded 429 error body only
 * to recognize a plan usage limit. The body itself is discarded: messages stay
 * fixed and the only derived part is an integer reset hint, never upstream
 * text. Any unreadable or unrecognized body falls back to the status mapping.
 */
export async function classifyStatusError(status: number, response: BodyCarrier, signal?: AbortSignal): Promise<BridgeError> {
  if (status !== 429) return statusError(status);
  let bytes: Buffer, body: unknown;
  try {
    bytes = await readBytes(response, USAGE_LIMIT_BODY_LIMIT, signal);
  } catch (error) {
    // Oversized or undecodable error bodies still fail with the fixed code.
    if (error instanceof BridgeError && (error.code === 'LIMIT_EXCEEDED' || error.code === 'PROTOCOL_INVALID')) return statusError(status);
    throw error;
  }
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { return statusError(status); }
  // The guards below prove a non-array object; its fields stay unknown, so each
  // access asserts the shape the guard has already established.
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      !(body as JsonObject).error || typeof (body as JsonObject).error !== 'object' ||
      Array.isArray((body as JsonObject).error)) return statusError(status);
  const detail = errorFields((body as JsonObject).error);
  const kind = detail.code || detail.type;
  // `errorFields` always answers with strings for these three fields.
  if (!USAGE_LIMIT_CODES.has(kind) && !isQuotaExceededError(kind as string)) return statusError(status);
  // `resets_at` is an epoch-seconds integer; a bounded, validated count joins
  // the fixed message as a hint. Absent, past, or implausible values omit it.
  const resetsAt = ((body as JsonObject).error as JsonObject).resets_at;
  const resetMinutes = Number.isSafeInteger(resetsAt) && (resetsAt as number) > 0 && (resetsAt as number) <= 1e12
    ? Math.round(((resetsAt as number) * 1000 - Date.now()) / 60_000) : undefined;
  return new BridgeError('QUOTA', undefined, resetMinutes !== undefined && resetMinutes >= 1
    ? { resetMinutes: Math.min(resetMinutes, 10080) } : undefined);
}

export function abortFailure(signal?: AbortSignal): BridgeError {
  return new BridgeError(signal?.reason?.name === 'TimeoutError' ? 'TIMEOUT' : 'ABORTED', 'HTTP_REQUEST');
}

export async function readBytes(response: BodyCarrier, limit = 1024 * 1024, signal?: AbortSignal): Promise<Buffer> {
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

export async function readJson(response: BodyCarrier, limit: number, signal?: AbortSignal): Promise<unknown> {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBytes(response, limit, signal))); }
  catch (error) { if (signal?.aborted) throw abortFailure(signal); if (error instanceof BridgeError) throw classified(error, 'HTTP_JSON_BODY'); throw new BridgeError('PROTOCOL_INVALID', 'HTTP_JSON_BODY'); }
}

/** A response-like carrier with a readable body; the readers also serve request bodies. */
export type BodyCarrier = { body: ReadableStream<Uint8Array> | null };

/** The private fetch seam the tests inject; one fixed dispatcher per request. */
type Fetcher = typeof subscriptionFetch;

/** Fixed destinations only; private fetch injection is a synthetic-test seam. */
export class Http {
  fetcher: Fetcher;
  constructor(fetcher: Fetcher = subscriptionFetch) { this.fetcher = fetcher; }
  async open(url: string, options: RequestInit, signal: AbortSignal): Promise<Response> {
    const parsed = new URL(url);
    const fenced = FENCES.some(({ base, normalized }) => parsed.origin === normalized.origin
      && parsed.pathname.startsWith(normalized.pathname)
      && (url === base || url.startsWith(base + '/') || url.startsWith(base + '?')));
    if (!fenced || parsed.username || parsed.password) throw new BridgeError('CONFIG_INVALID');
    try { return await this.fetcher(url, { ...options, signal, redirect: 'error', dispatcher: subscriptionDispatcher }); }
    catch { if (signal?.aborted) throw abortFailure(signal); throw new BridgeError('UPSTREAM_FAILED', 'HTTP_REQUEST'); }
  }
  async json(url: string, options: RequestInit = {}, signal?: AbortSignal, limit = 1024 * 1024): Promise<unknown> {
    const timeout = AbortSignal.timeout(15_000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response | undefined;
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
