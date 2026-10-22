import test from 'node:test';
import assert from 'node:assert/strict';
import { AuthUiController, installAuthUi } from '../lib/auth-ui.js';
import { BridgeError } from '../lib/errors.js';
const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  let finish, announced, loggedOut = 0;
  const store = {
    doctor: async () => ({ store: 'private', lock: 'absent', auth: 'missing', action: 'login' }),
    login: (announce, signal) => new Promise((resolve, reject) => {
      announced = announce; finish = resolve;
      signal.addEventListener('abort', () => reject(new BridgeError('ABORTED')), { once: true });
    }),
    logout: async () => { loggedOut++; },
  };
  return { store, controller: new AuthUiController(store), announce: () => announced({ url: 'https://auth.openai.com/codex/device', code: 'SYNTHETIC-CODE' }), finish: () => finish(), loggedOut: () => loggedOut };
}
test('device codes are visible only to the originating UI and erased on completion', async () => {
  const f = fixture();
  await f.controller.invoke('login', { clientId: owner }); f.announce();
  const visible = await f.controller.invoke('status', { clientId: owner });
  assert.equal(visible.device.code, 'SYNTHETIC-CODE');
  const hidden = await f.controller.invoke('status', { clientId: other });
  assert.equal(hidden.device, undefined); assert.equal(hidden.attemptId, undefined);
  assert.equal(JSON.stringify(hidden).includes('SYNTHETIC-CODE'), false);
  await assert.rejects(f.controller.invoke('login', { clientId: other }), { code: 'AUTH_BUSY' });
  await assert.rejects(f.controller.invoke('cancel', { clientId: other, attemptId: visible.attemptId }), { code: 'CONFIG_INVALID' });
  await assert.rejects(f.controller.invoke('logout', { clientId: other }), { code: 'AUTH_BUSY' });
  f.finish(); await tick();
  assert.equal((await f.controller.invoke('status', { clientId: owner })).phase, 'signed_in');
  assert.equal(f.controller.view(owner).device, undefined); await f.controller.close();
});
test('cancel and logout join the login owner and never expose raw failures', async () => {
  const f = fixture(); await f.controller.invoke('login', { clientId: owner }); f.announce();
  const state = f.controller.view(owner);
  const cancelled = await f.controller.invoke('cancel', { clientId: owner, attemptId: state.attemptId });
  assert.equal(cancelled.phase, 'cancelled'); assert.equal(cancelled.device, undefined);
  await f.controller.invoke('logout', { clientId: owner }); assert.equal(f.loggedOut(), 1);
  f.store.login = async () => { throw new Error('synthetic-refresh-token-secret'); };
  await f.controller.invoke('login', { clientId: owner }); await tick();
  const failed = await f.controller.invoke('status', { clientId: owner });
  assert.equal(failed.phase, 'failed'); assert.equal(JSON.stringify(failed).includes('synthetic-refresh-token-secret'), false);
  await f.controller.close();
});
test('unknown payloads, tokens and pre-aborted requests cannot start account operations', async () => {
  const f = fixture(); const abort = new AbortController(); abort.abort();
  for (const args of [null, [], { clientId: 'not-an-id' }, { clientId: owner, token: 'synthetic-secret' }]) await assert.rejects(f.controller.invoke('login', args), { code: 'CONFIG_INVALID' });
  await assert.rejects(f.controller.invoke('unsupported', { clientId: owner }), { code: 'CONFIG_INVALID' });
  await assert.rejects(f.controller.invoke('login', { clientId: owner }, abort.signal), { code: 'ABORTED' });
  assert.equal(f.controller.operation, undefined); await f.controller.close();
});
test('shutdown waits for RPC work and reports unresponsive cleanup honestly', async () => {
  let finish;
  const controller = new AuthUiController({ doctor: () => new Promise(resolve => finish = resolve) }, { shutdownMs: 10 });
  const pending = controller.invoke('status', { clientId: owner });
  await assert.rejects(controller.close(), { code: 'TIMEOUT' });
  await assert.rejects(controller.invoke('status', { clientId: owner }), { code: 'CLOSED' });
  finish({ auth: 'missing' }); await pending;
});
test('exact authenticated routes preserve Gateway ownership and refuse malformed envelopes', async () => {
  const f = fixture(); const routes = []; let dispose; let removed = 0;
  const child = { connection: { fetch: { register(route) { routes.push(route); return async () => { removed++; }; } } }, effect(setup) { dispose = setup(); } };
  installAuthUi({ inject(keys, callback) { assert.deepEqual(keys, ['connection']); callback(child); } }, f.store);
  assert.equal(routes.length, 4);
  const login = routes.find(route => route.path.endsWith('/login'));
  assert.deepEqual(login.methods, ['POST']); assert.equal(login.requestBody, 'buffered');
  const request = body => new Request('http://127.0.0.1/api/codex-subscription-auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const denied = await login.fetch(request({ type: 'client-request', rpcId: 'test', method: 'wrong', payload: { clientId: owner } }));
  assert.equal((await denied.json()).result.error.code, 'CONFIG_INVALID');
  const started = await login.fetch(request({ type: 'client-request', rpcId: 'test', method: 'codex-subscription-auth/login', payload: { clientId: owner } }));
  assert.equal(started.headers.get('cache-control'), 'no-store');
  assert.equal((await started.json()).result.ok, true);
  const oversized = await login.fetch(request({ type: 'client-request', rpcId: 'test', method: 'codex-subscription-auth/login', payload: { clientId: owner, token: 'x'.repeat(5000) } }));
  assert.equal((await oversized.json()).result.error.code, 'LIMIT_EXCEEDED');
  await dispose(); assert.equal(removed, 4);
});
test('successful login and logout notify model observers without leaking callback failures', async () => {
  let changed = 0;
  const controller = new AuthUiController({ login: async () => {}, logout: async () => {}, doctor: async () => ({ auth: 'stored' }) }, { onChanged() { changed++; throw new Error('synthetic-secret'); } });
  await controller.invoke('login', { clientId: owner }); await tick();
  assert.equal(controller.view(owner).phase, 'signed_in');
  await controller.invoke('logout', { clientId: owner }); assert.equal(changed, 2);
  assert.equal(JSON.stringify(controller.view(owner)).includes('synthetic-secret'), false);
  await controller.close();
});
