import { randomUUID } from 'node:crypto';
import { BridgeError, failure } from './errors.js';
import { readJson } from './http.js';
export const AUTH_UI_PREFIX = 'codex-subscription-auth/';
const identifier = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value);
function payload(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key)) || !identifier(value.clientId)) throw new BridgeError('CONFIG_INVALID');
}
/** One bounded device-login task; only its originating UI can retrieve the code. */
export class AuthUiController {
  constructor(store, { shutdownMs = 5000, onChanged = () => {} } = {}) {
    this.onChanged = onChanged;
    this.store = store; this.shutdownMs = shutdownMs; this.closed = false; this.requests = 0; this.changing = false;
    this.abort = new AbortController(); this.pending = new Set();
  }
  view(clientId) {
    const op = this.operation;
    const owner = op?.clientId === clientId;
    return {
      phase: op?.phase ?? 'idle', active: Boolean(op && !op.settled), owned: Boolean(owner),
      ...(owner ? { attemptId: op.id } : {}),
      ...(owner && op.phase === 'waiting' ? { device: { url: 'https://auth.openai.com/codex/device', code: op.code } } : {}),
      ...(op?.error ? { error: op.error } : {}),
    };
  }
  notify() {
    // A UI refresh failure must not misreport a successfully persisted grant.
    try { this.onChanged(); } catch {}
  }
  async snapshot(clientId) {
    const op = this.operation; const wasActive = op && !op.settled;
    let local = await this.store.doctor();
    if (wasActive && op.settled) local = await this.store.doctor();
    return { ...this.view(clientId), local };
  }
  async join(op) {
    if (!op || op.settled) return;
    let timer;
    try {
      await Promise.race([op.work, new Promise((_, reject) => { timer = setTimeout(() => reject(new BridgeError('TIMEOUT')), this.shutdownMs); })]);
    } finally { clearTimeout(timer); }
  }
  invoke(action, args, signal) {
    const combined = signal ? AbortSignal.any([signal, this.abort.signal]) : this.abort.signal;
    const work = this.run(action, args, combined); this.pending.add(work);
    const settled = () => this.pending.delete(work); work.then(settled, settled);
    return work;
  }
  async run(action, args, signal) {
    if (this.closed) throw new BridgeError('CLOSED');
    if (signal?.aborted) throw new BridgeError('ABORTED');
    payload(args, action === 'cancel' ? ['clientId', 'attemptId'] : ['clientId']);
    if (!['status', 'login', 'cancel', 'logout'].includes(action)) throw new BridgeError('CONFIG_INVALID');
    if (this.requests >= 4) throw new BridgeError('LIMIT_EXCEEDED');
    this.requests++;
    try {
      if (action === 'status') return this.snapshot(args.clientId);
      if (this.changing) throw new BridgeError('AUTH_BUSY');
      this.changing = true;
      try {
        if (action === 'login') {
          if (this.operation && !this.operation.settled) throw new BridgeError('AUTH_BUSY');
          const op = { id: randomUUID(), clientId: args.clientId, phase: 'starting', controller: new AbortController(), settled: false };
          this.operation = op;
          op.work = Promise.resolve().then(() => {
            if (op.controller.signal.aborted) throw new BridgeError('ABORTED');
            return this.store.login(({ code }) => {
              if (!op.controller.signal.aborted) { op.code = code; op.phase = 'waiting'; }
            }, op.controller.signal);
          }).then(() => { op.phase = 'signed_in'; this.notify(); }, error => {
            const safe = failure(error);
            op.phase = safe.code === 'ABORTED' ? 'cancelled' : 'failed';
            if (op.phase === 'failed') op.error = safe;
          }).finally(() => { op.code = undefined; op.settled = true; });
        } else {
          const op = this.operation;
          if (action === 'cancel') {
            if (!identifier(args.attemptId) || op?.id !== args.attemptId || op.clientId !== args.clientId) throw new BridgeError('CONFIG_INVALID');
          } else if (op && !op.settled && op.clientId !== args.clientId) throw new BridgeError('AUTH_BUSY');
          if (op && !op.settled) { op.code = undefined; op.phase = 'cancelling'; op.controller.abort(); await this.join(op); }
          if (action === 'logout') { await this.store.logout(signal); this.operation = undefined; this.notify(); }
        }
        return await this.snapshot(args.clientId);
      } finally { this.changing = false; }
    } finally { this.requests--; }
  }
  close() {
    this.closing ??= this.shutdown(); return this.closing;
  }
  async shutdown() {
    this.closed = true; this.abort.abort();
    const op = this.operation;
    if (op) { op.code = undefined; op.controller.abort(); }
    let timer;
    try {
      await Promise.race([Promise.allSettled([...this.pending, ...(op ? [op.work] : [])]), new Promise((_, reject) => { timer = setTimeout(() => reject(new BridgeError('TIMEOUT')), this.shutdownMs); })]);
    } finally { clearTimeout(timer); }
  }
}
/** Exact routes preserve the sole Gateway interceptor and its authenticated carriers. */
export function installAuthUi(ctx, store, onChanged) {
  ctx.inject(['connection'], child => {
    const controller = new AuthUiController(store, { onChanged });
    child.effect(() => {
      const disposers = ['status', 'login', 'cancel', 'logout'].map(action => child.connection.fetch.register({
        path: '/api/' + AUTH_UI_PREFIX + action, methods: ['POST'], requestBody: 'buffered',
        async fetch(request) {
          let rpcId = 'invalid-request';
          let result;
          try {
            if (request.method !== 'POST' || request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') throw new BridgeError('CONFIG_INVALID');
            const bounded = AbortSignal.any([request.signal, AbortSignal.timeout(5000)]);
            const message = await readJson(request, 4096, bounded);
            if (!message || typeof message !== 'object' || Array.isArray(message) ||
                Object.keys(message).some(key => !['type', 'rpcId', 'method', 'payload'].includes(key)) ||
                message.type !== 'client-request' || typeof message.rpcId !== 'string' ||
                !/^[A-Za-z0-9:_.-]{1,128}$/u.test(message.rpcId) || message.method !== AUTH_UI_PREFIX + action) throw new BridgeError('CONFIG_INVALID');
            rpcId = message.rpcId;
            result = { ok: true, value: await controller.invoke(action, message.payload, bounded) };
          } catch (error) {
            const safe = failure(error); result = { ok: false, error: { ...safe, details: {} } };
          }
          return Response.json({ type: 'server-response', rpcId, result }, { headers: { 'Cache-Control': 'no-store' } });
        },
      }));
      return async () => { try { await Promise.all(disposers.map(remove => remove())); } finally { await controller.close(); } };
    }, 'codex-subscription: authenticated settings operations');
  });
}
