import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { BridgeError, object, string } from './errors.js';
import { Http, ISSUER, CLIENT_ID, readJson, statusError } from './http.js';

const MAX_AUTH = 64 * 1024;
export function authDirectory(environment) {
  const home = environment.HOME;
  if (typeof home !== 'string' || !isAbsolute(home) || /[\x00\r\n]/u.test(home)) throw new BridgeError('CONFIG_INVALID');
  return join(home, '.dsh-codex-subscription-bridge');
}
function privateInfo(info, directory = false) {
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) ||
      (process.getuid && info.uid !== process.getuid()) || (info.mode & 0o077)) throw new BridgeError('AUTH_STORE_INVALID');
}
export function claims(token) {
  string(token, 16 * 1024);
  try {
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(token)) throw new Error();
    const parts = token.split('.'); if (parts.length !== 3) throw new Error();
    const result = object(JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')));
    if (!Number.isFinite(result.exp)) throw new Error();
    return result;
  } catch { throw new BridgeError('AUTH_REQUIRED'); }
}
function credentials(value) {
  object(value); string(value.refresh_token, 16 * 1024);
  const parsed = claims(value.access_token);
  const auth = object(parsed['https://api.openai.com/auth']);
  if (typeof auth.chatgpt_account_id !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/u.test(auth.chatgpt_account_id)) throw new BridgeError('AUTH_REQUIRED');
  return { access_token: value.access_token, refresh_token: value.refresh_token };
}
export function accountHeaders(token) {
  const auth = object(claims(token)['https://api.openai.com/auth']);
  const headers = { 'ChatGPT-Account-ID': string(auth.chatgpt_account_id, 256) };
  const residency = auth.chatgpt_data_residency ?? auth.chatgpt_compute_residency;
  if (residency !== undefined) {
    if (typeof residency !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/u.test(residency)) throw new BridgeError('AUTH_REQUIRED');
    headers['x-openai-internal-codex-residency'] = residency;
  }
  return headers;
}
export class AuthStore {
  constructor(directory, http = new Http()) { this.directory = directory; this.http = http; }
  async prepare() {
    if (!isAbsolute(this.directory)) throw new BridgeError('CONFIG_INVALID');
    try { await mkdir(this.directory, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw new BridgeError('AUTH_STORE_INVALID'); }
    privateInfo(await lstat(this.directory), true);
  }
  async transaction(task, signal) {
    await this.prepare(); const lock = join(this.directory, 'auth.lock');
    const deadline = Date.now() + 30_000;
    for (;;) {
      if (signal?.aborted) throw new BridgeError('ABORTED');
      try { await mkdir(lock, { mode: 0o700 }); break; }
      catch (error) { if (error.code !== 'EEXIST') throw new BridgeError('AUTH_STORE_INVALID'); }
      privateInfo(await lstat(lock), true);
      if (Date.now() >= deadline) throw new BridgeError('AUTH_BUSY');
      await delay(50, undefined, { signal }).catch(() => { throw new BridgeError('ABORTED'); });
    }
    try { return await task(); }
    finally { await rm(lock, { recursive: true, force: true }); }
  }
  async read() {
    let file;
    try {
      file = await open(join(this.directory, 'auth.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await file.stat(); privateInfo(info);
      if (info.size > MAX_AUTH) throw new BridgeError('AUTH_STORE_INVALID');
      const buffer = Buffer.alloc(MAX_AUTH + 1); const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_AUTH) throw new BridgeError('AUTH_STORE_INVALID');
      const state = object(JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')));
      if (state.version !== 1 || state.mode !== 'chatgpt') throw new BridgeError('AUTH_REQUIRED');
      if (state.quarantined || state.refresh_pending) throw new BridgeError('AUTH_REQUIRED');
      return credentials(state);
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      if (error.code === 'ENOENT') throw new BridgeError('AUTH_REQUIRED');
      throw new BridgeError('AUTH_STORE_INVALID');
    } finally { await file?.close(); }
  }
  async write(tokens) {
    return this.writeState({ version: 1, mode: 'chatgpt', ...credentials(tokens) });
  }
  async writeState(state) {
    const target = join(this.directory, 'auth.json'); const temp = join(this.directory, `.auth-${randomUUID()}`);
    let file;
    try {
      file = await open(temp, 'wx', 0o600); await file.writeFile(JSON.stringify(state)); await file.sync(); await file.close(); file = undefined;
      await rename(temp, target);
      const directory = await open(this.directory, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { await directory.sync(); } finally { await directory.close(); }
    } catch { throw new BridgeError('AUTH_STORE_INVALID'); }
    finally { await file?.close(); await rm(temp, { force: true }); }
  }
  async token(signal) {
    return this.transaction(async () => {
      const stored = await this.read();
      if (claims(stored.access_token).exp * 1000 > Date.now() + 120_000) return stored.access_token;
      if (signal?.aborted) throw new BridgeError('ABORTED');
      // Persist intent before dispatch: a crash, lost reply, or failed save must
      // never cause a consumed refresh grant to be sent again. Login clears it.
      await this.writeState({ version: 1, mode: 'chatgpt', ...stored, refresh_pending: true });
      const timeout = AbortSignal.timeout(15_000); const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let response;
      try {
        response = await this.http.open(`${ISSUER}/oauth/token`, { method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: stored.refresh_token, client_id: CLIENT_ID }) }, combined);
        if (!response.ok) {
          // A definite rate-limit rejection did not perform rotation. All
          // ambiguous outcomes keep durable intent and require reauthentication.
          if (response.status === 429) { await this.write(stored); throw statusError(429); }
          // Quarantine only terminal OAuth grant failures, never quota or transient failures.
          if ([400, 401, 403].includes(response.status)) {
            const payload = await readJson(response, MAX_AUTH).catch(() => ({}));
            const code = typeof payload.error === 'string' ? payload.error : payload.error?.code;
            if (['invalid_grant', 'invalid_token', 'refresh_token_reused', 'refresh_token_expired', 'refresh_token_invalid'].includes(code)) {
              await this.writeState({ version: 1, mode: 'chatgpt', quarantined: true });
              throw new BridgeError('AUTH_REQUIRED');
            }
          }
          throw statusError(response.status);
        }
        const data = object(await readJson(response, MAX_AUTH));
        const updated = credentials({ access_token: data.access_token, refresh_token: data.refresh_token ?? stored.refresh_token });
        if (claims(updated.access_token).exp * 1000 <= Date.now()) throw new BridgeError('AUTH_REQUIRED');
        if (accountHeaders(updated.access_token)['ChatGPT-Account-ID'] !== accountHeaders(stored.access_token)['ChatGPT-Account-ID']) throw new BridgeError('AUTH_REQUIRED');
        await this.write(updated); return updated.access_token;
      } catch (error) { if (timeout.aborted) throw new BridgeError('TIMEOUT'); throw error; }
      finally { await response?.body?.cancel().catch(() => {}); }
    }, signal);
  }
  async logout(signal) { return this.transaction(() => rm(join(this.directory, 'auth.json'), { force: true }), signal); }
  async login(announce, signal) {
    // Explicit login owns the store lock, so a concurrent logout cannot be undone.
    return this.transaction(async () => {
      const device = object(await this.http.json(`${ISSUER}/api/accounts/deviceauth/usercode`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: CLIENT_ID }) }, signal, MAX_AUTH));
      string(device.device_auth_id, 1024); string(device.user_code, 128);
      if (!/^[A-Za-z0-9-]{1,128}$/u.test(device.user_code)) throw new BridgeError('PROTOCOL_INVALID');
      const interval = Number(device.interval ?? 5);
      if (!Number.isFinite(interval) || interval < 0 || interval > 60) throw new BridgeError('PROTOCOL_INVALID');
      announce({ url: `${ISSUER}/codex/device`, code: device.user_code });
      const timeout = AbortSignal.timeout(15 * 60_000); const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      for (;;) {
        await delay(Math.max(3, interval) * 1000, undefined, { signal: combined }).catch(() => { throw new BridgeError(timeout.aborted ? 'TIMEOUT' : 'ABORTED'); });
        const pollTimeout = AbortSignal.timeout(15_000);
        const response = await this.http.open(`${ISSUER}/api/accounts/deviceauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ device_auth_id: device.device_auth_id, user_code: device.user_code }) }, AbortSignal.any([combined, pollTimeout]));
        if ([403, 404].includes(response.status)) { await response.body?.cancel(); continue; }
        if (!response.ok) { await response.body?.cancel(); throw statusError(response.status); }
        const code = object(await readJson(response, MAX_AUTH));
        const tokens = await this.http.json(`${ISSUER}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'authorization_code', code: string(code.authorization_code, 8192), code_verifier: string(code.code_verifier, 8192),
            redirect_uri: `${ISSUER}/deviceauth/callback`, client_id: CLIENT_ID }) }, combined, MAX_AUTH);
        if (claims(tokens.access_token).exp * 1000 <= Date.now()) throw new BridgeError('AUTH_REQUIRED');
        await this.write(tokens); return;
      }
    }, signal);
  }
}
