import { spawn } from 'node:child_process';
import { realpath, stat, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { TextDecoder } from 'node:util';
import { isAbsolute } from 'node:path';
import { BridgeError, object } from './errors.js';

export const CODEX_VERSION = '0.144.6';
export const MAX_FRAME = 1024 * 1024;
export function childEnvironment(source = process.env) {
  const result = { LANG: 'C.UTF-8' };
  for (const key of ['HOME', 'CODEX_HOME', 'SYSTEMROOT']) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  return result;
}
export async function executablePath(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || /[\x00\r\n]/u.test(path)) throw new BridgeError('CONFIG_INVALID');
  try {
    const resolved = await realpath(path);
    const info = await stat(resolved);
    if (!info.isFile() || (info.mode & 0o022) !== 0 || (process.getuid && info.uid !== process.getuid() && info.uid !== 0)) throw new Error();
    await access(resolved, constants.X_OK);
    return resolved;
  } catch { throw new BridgeError('CONFIG_INVALID'); }
}

/** Private transport seam. Production never calls this until the authority gate is resolved. */
export class RpcProcess {
  constructor(command, args, { cwd, env, timeoutMs = 30_000, shutdownMs = 200 } = {}) {
    this.timeoutMs = timeoutMs;
    this.shutdownMs = shutdownMs;
    this.pending = new Map();
    this.events = [];
    this.eventBytes = 0;
    this.waiter = undefined;
    this.serial = 0;
    this.buffer = Buffer.alloc(0);
    this.child = spawn(command, args, { cwd, env, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child.stdout.on('data', (bytes) => this.read(bytes));
    // Drain without decoding or logging diagnostic bodies.
    let diagnosticBytes = 0;
    this.child.stderr.on('data', (bytes) => {
      diagnosticBytes += bytes.length;
      if (diagnosticBytes > MAX_FRAME) this.fail(new BridgeError('LIMIT_EXCEEDED'));
    });
    this.child.stdin.on('error', () => this.fail(new BridgeError('PROCESS_FAILED')));
    this.child.on('error', () => this.fail(new BridgeError('PROCESS_FAILED')));
    this.exited = new Promise((resolve) => this.child.once('close', () => {
      this.fail(new BridgeError('PROCESS_FAILED'));
      resolve();
    }));
    this.child.on('exit', () => this.fail(new BridgeError('PROCESS_FAILED')));
  }
  fail(error) {
    if (this.error) return;
    this.error = error;
    this.events.length = 0;
    this.eventBytes = 0;
    this.buffer = Buffer.alloc(0);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.waiter?.reject(error);
    this.waiter = undefined;
    // Stop a malformed or unresponsive peer even when its consumer is paused.
    void this.close();
  }
  read(bytes) {
    if (this.error) return;
    let start = 0;
    while (start < bytes.length) {
      const newline = bytes.indexOf(10, start);
      const end = newline < 0 ? bytes.length : newline;
      const fragment = bytes.subarray(start, end);
      if (this.buffer.length + fragment.length > MAX_FRAME) {
        this.fail(new BridgeError('LIMIT_EXCEEDED')); return;
      }
      this.buffer = Buffer.concat([this.buffer, fragment]);
      if (newline < 0) return;
      const frame = this.buffer;
      this.buffer = Buffer.alloc(0);
      try { this.dispatch(object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame)))); }
      catch (error) {
        this.fail(error instanceof BridgeError ? error : new BridgeError('PROTOCOL_INVALID')); return;
      }
      if (this.error) return;
      start = newline + 1;
    }
  }
  dispatch(message) {
    const stack = [[message, 0]];
    let nodes = 0;
    while (stack.length) {
      const [value, depth] = stack.pop();
      if (++nodes > 20_000 || depth > 32) throw new BridgeError('LIMIT_EXCEEDED');
      if (value && typeof value === 'object') {
        for (const child of Object.values(value)) stack.push([child, depth + 1]);
      }
    }
    if (Object.hasOwn(message, 'id')) {
      if (!Number.isSafeInteger(message.id) || typeof message.method === 'string') throw new BridgeError('PROTOCOL_INVALID');
      const pending = this.pending.get(message.id);
      if (!pending) throw new BridgeError('PROTOCOL_INVALID');
      if (Object.hasOwn(message, 'error')) pending.reject(new BridgeError('UPSTREAM_FAILED'));
      else if (Object.hasOwn(message, 'result')) pending.resolve(message.result);
      else throw new BridgeError('PROTOCOL_INVALID');
      this.pending.delete(message.id);
      return;
    }
    if (typeof message.method !== 'string' || message.method.length > 128) throw new BridgeError('PROTOCOL_INVALID');
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter.resolve(message);
    } else {
      const bytes = Buffer.byteLength(JSON.stringify(message));
      if (this.events.length >= 128 || this.eventBytes + bytes > MAX_FRAME) throw new BridgeError('LIMIT_EXCEEDED');
      this.events.push(message);
      this.eventBytes += bytes;
    }
  }
  write(message) {
    if (this.error) throw this.error;
    const bytes = Buffer.from(JSON.stringify(message) + '\n');
    if (bytes.length > MAX_FRAME || this.child.stdin.writableLength > MAX_FRAME) throw new BridgeError('LIMIT_EXCEEDED');
    this.child.stdin.write(bytes);
  }
  notify(method, params = {}) { this.write({ method, params }); }
  async request(method, params = {}, signal) {
    if (signal?.aborted) throw new BridgeError('ABORTED');
    if (this.error) throw this.error;
    if (this.pending.size >= 8) throw new BridgeError('LIMIT_EXCEEDED');
    const id = ++this.serial;
    let timer;
    const abort = () => this.fail(new BridgeError('ABORTED'));
    try {
      return await new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        timer = setTimeout(() => this.fail(new BridgeError('TIMEOUT')), this.timeoutMs);
        signal?.addEventListener('abort', abort, { once: true });
        try { this.write({ id, method, params }); }
        catch (error) { this.fail(error); }
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      this.pending.delete(id);
    }
  }
  async next(signal) {
    if (signal?.aborted) throw new BridgeError('ABORTED');
    if (this.error) throw this.error;
    if (this.events.length) {
      const message = this.events.shift();
      this.eventBytes -= Buffer.byteLength(JSON.stringify(message));
      return message;
    }
    if (this.waiter) throw new BridgeError('LIMIT_EXCEEDED');
    let timer;
    const abort = () => this.fail(new BridgeError('ABORTED'));
    try {
      return await new Promise((resolve, reject) => {
        this.waiter = { resolve, reject };
        timer = setTimeout(() => this.fail(new BridgeError('TIMEOUT')), this.timeoutMs);
        signal?.addEventListener('abort', abort, { once: true });
      });
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  stop(signal) {
    if (!this.child.pid) return;
    try {
      if (process.platform === 'win32') this.child.kill(signal);
      else process.kill(-this.child.pid, signal);
    } catch (error) {
      if (error.code !== 'ESRCH') this.child.kill(signal);
    }
  }
  close() {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      // Promise callbacks execute after this.closing is assigned.
      await Promise.resolve();
      this.fail(new BridgeError('CLOSED'));
      this.child.stdin.destroy();
      this.stop('SIGTERM');
      let timer;
      await Promise.race([this.exited, new Promise((resolve) => { timer = setTimeout(resolve, this.shutdownMs); })]);
      clearTimeout(timer);
      this.stop('SIGKILL');
      await Promise.race([this.exited, new Promise((resolve) => { timer = setTimeout(resolve, this.shutdownMs); })]);
      clearTimeout(timer);
    })();
    return this.closing;
  }
}

export function createProductionSession() {
  // No opt-in setting can bypass this gate. Resolve inherited MCP, hooks,
  // extensions, provider endpoints, and effective authority before removing it.
  throw new BridgeError('AUTHORITY_UNVERIFIED');
}
