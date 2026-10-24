import test from 'node:test';
import assert from 'node:assert/strict';
import { AuthUiController, installAuthUi } from '../lib/auth-ui.js';
import { BridgeError } from '../lib/errors.js';

const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';

/** One turn of the event loop, so a settled login reports its phase. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** A store whose login can be announced and completed by the case. */
function storeFixture() {
  let finish;
  let announced;
  let loggedOut = 0;
  const store = {
    doctor: async () => ({ store: 'private', lock: 'absent', auth: 'missing', action: 'login' }),
    login: (announce, signal) => new Promise((resolve, reject) => {
      announced = announce;
      finish = resolve;
      signal.addEventListener('abort', () => reject(new BridgeError('ABORTED')), { once: true });
    }),
    logout: async () => { loggedOut += 1; },
  };
  return {
    store,
    announce: () => announced({ url: 'https://auth.openai.com/codex/device', code: 'SYNTHETIC-CODE' }),
    finish: () => finish(),
    loggedOut: () => loggedOut,
  };
}

/** A store and controller pair driven by the same login seam. */
function fixture() {
  const f = storeFixture();
  return { ...f, controller: new AuthUiController(f.store) };
}

/** A store and controller pair whose observer callback fails. */
function observerFixture() {
  let changed = 0;
  const store = { login: async () => {}, logout: async () => {}, doctor: async () => ({ auth: 'stored' }) };
  const controller = new AuthUiController(store, { onChanged() { changed += 1; throw new Error('synthetic-secret'); } });
  return { controller, changed: () => changed };
}

/** A Gateway install that captures the injected keys, the registered routes and their disposers. */
function routeFixture() {
  const f = storeFixture();
  const routes = [];
  let injected;
  let dispose;
  let removed = 0;
  const child = {
    connection: { fetch: { register(route) { routes.push(route); return async () => { removed += 1; }; } } },
    effect(setup) { dispose = setup(); },
  };
  installAuthUi({ inject(captured, callback) { injected = captured; callback(child); } }, f.store);
  return {
    f,
    injected,
    routes,
    login: routes.find((route) => route.path.endsWith('/login')),
    dispose: () => dispose(),
    removed: () => removed,
  };
}

/** A browser client-request envelope for the login route. */
const loginRequest = (method, payload) => new Request('http://127.0.0.1/api/codex-subscription-auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ type: 'client-request', rpcId: 'test', method, payload }),
});

test('the device code is visible to the originating UI', async () => {
  const f = fixture();
  await f.controller.invoke('login', { clientId: owner });
  f.announce();

  const visible = await f.controller.invoke('status', { clientId: owner });

  assert.equal(visible.device.code, 'SYNTHETIC-CODE');

  await f.controller.close();
});

test('another client sees no attempt for the login it does not own', async () => {
  const f = fixture();
  await f.controller.invoke('login', { clientId: owner });
  f.announce();

  const hidden = await f.controller.invoke('status', { clientId: other });

  assert.equal(hidden.device, undefined);
  assert.equal(hidden.attemptId, undefined);

  await f.controller.close();
});

test('the status for another client carries no device code value', async () => {
  const f = fixture();
  await f.controller.invoke('login', { clientId: owner });
  f.announce();

  const hidden = await f.controller.invoke('status', { clientId: other });

  assert.equal(JSON.stringify(hidden).includes('SYNTHETIC-CODE'), false);

  await f.controller.close();
});

test('a second login from another client is refused as AUTH_BUSY', async () => {
  const f = fixture();
  await f.controller.invoke('login', { clientId: owner });
  f.announce();

  await assert.rejects(f.controller.invoke('login', { clientId: other }), { code: 'AUTH_BUSY' });

  await f.controller.close();
});

test('a cancel from another client is refused as CONFIG_INVALID', async () => {
  const f = fixture();
  await f.controller.invoke('login', { clientId: owner });
  f.announce();
  const visible = await f.controller.invoke('status', { clientId: owner });

  await assert.rejects(f.controller.invoke('cancel', { clientId: other, attemptId: visible.attemptId }), { code: 'CONFIG_INVALID' });

  await f.controller.close();
});

test('a logout from another client is refused as AUTH_BUSY', async () => {
  const f = fixture();
  await f.controller.invoke('login', { clientId: owner });
  f.announce();

  await assert.rejects(f.controller.invoke('logout', { clientId: other }), { code: 'AUTH_BUSY' });

  await f.controller.close();
});

test('the login owner reports the completed phase', async () => {
  const f = fixture();
  await f.controller.invoke('login', { clientId: owner });
  f.announce();
  f.finish();
  await tick();

  const completed = await f.controller.invoke('status', { clientId: owner });

  assert.equal(completed.phase, 'signed_in');

  await f.controller.close();
});

test('the device code is erased from the owner view on completion', async () => {
  const f = fixture();
  await f.controller.invoke('login', { clientId: owner });
  f.announce();
  f.finish();
  await tick();

  await f.controller.invoke('status', { clientId: owner });

  assert.equal(f.controller.view(owner).device, undefined);

  await f.controller.close();
});

test('cancel by the login owner reports the cancelled phase', async () => {
  const f = fixture();
  await f.controller.invoke('login', { clientId: owner });
  f.announce();
  const state = f.controller.view(owner);

  const cancelled = await f.controller.invoke('cancel', { clientId: owner, attemptId: state.attemptId });

  assert.equal(cancelled.phase, 'cancelled');

  await f.controller.close();
});

test('cancel by the login owner erases the device code', async () => {
  const f = fixture();
  await f.controller.invoke('login', { clientId: owner });
  f.announce();
  const state = f.controller.view(owner);

  const cancelled = await f.controller.invoke('cancel', { clientId: owner, attemptId: state.attemptId });

  assert.equal(cancelled.device, undefined);

  await f.controller.close();
});

test('logout by the login owner runs the store logout', async () => {
  const f = fixture();
  await f.controller.invoke('login', { clientId: owner });
  f.announce();

  await f.controller.invoke('logout', { clientId: owner });

  assert.equal(f.loggedOut(), 1);

  await f.controller.close();
});

test('a failed login reports the failed phase', async () => {
  const f = fixture();
  f.store.login = async () => { throw new Error('synthetic-refresh-token-secret'); };
  await f.controller.invoke('login', { clientId: owner });
  await tick();

  const failed = await f.controller.invoke('status', { clientId: owner });

  assert.equal(failed.phase, 'failed');

  await f.controller.close();
});

test('a failed login does not expose the raw failure', async () => {
  const f = fixture();
  f.store.login = async () => { throw new Error('synthetic-refresh-token-secret'); };
  await f.controller.invoke('login', { clientId: owner });
  await tick();

  const failed = await f.controller.invoke('status', { clientId: owner });

  assert.equal(JSON.stringify(failed).includes('synthetic-refresh-token-secret'), false);

  await f.controller.close();
});

test('unknown payloads are refused as CONFIG_INVALID', async () => {
  const f = fixture();

  for (const args of [null, [], { clientId: 'not-an-id' }, { clientId: owner, token: 'synthetic-secret' }]) {
    await assert.rejects(f.controller.invoke('login', args), { code: 'CONFIG_INVALID' });
  }

  await f.controller.close();
});

test('an unsupported action is refused as CONFIG_INVALID', async () => {
  const f = fixture();

  await assert.rejects(f.controller.invoke('unsupported', { clientId: owner }), { code: 'CONFIG_INVALID' });

  await f.controller.close();
});

test('a pre-aborted request is refused as ABORTED', async () => {
  const f = fixture();
  const abort = new AbortController();
  abort.abort();

  await assert.rejects(f.controller.invoke('login', { clientId: owner }, abort.signal), { code: 'ABORTED' });

  await f.controller.close();
});

test('a refused request starts no account operation', async () => {
  const f = fixture();

  for (const args of [null, [], { clientId: 'not-an-id' }, { clientId: owner, token: 'synthetic-secret' }]) {
    await assert.rejects(f.controller.invoke('login', args), { code: 'CONFIG_INVALID' });
  }

  assert.equal(f.controller.operation, undefined);

  await f.controller.close();
});

test('shutdown reports unresponsive RPC cleanup as TIMEOUT', async () => {
  let finish;
  const controller = new AuthUiController({ doctor: () => new Promise((resolve) => finish = resolve) }, { shutdownMs: 10 });
  const pending = controller.invoke('status', { clientId: owner });

  await assert.rejects(controller.close(), { code: 'TIMEOUT' });

  finish({ auth: 'missing' });
  await pending;
});

test('a call after close is refused as CLOSED', async () => {
  let finish;
  const controller = new AuthUiController({ doctor: () => new Promise((resolve) => finish = resolve) }, { shutdownMs: 10 });
  const pending = controller.invoke('status', { clientId: owner });

  await assert.rejects(controller.close(), { code: 'TIMEOUT' });

  await assert.rejects(controller.invoke('status', { clientId: owner }), { code: 'CLOSED' });

  finish({ auth: 'missing' });
  await pending;
});

test('installAuthUi injects only the connection key', async () => {
  const f = routeFixture();

  assert.deepEqual(f.injected, ['connection']);

  await f.dispose();
});

test('installAuthUi registers the four exact routes', async () => {
  const f = routeFixture();

  assert.equal(f.routes.length, 4);

  await f.dispose();
});

test('the login route is a POST with a buffered body', async () => {
  const f = routeFixture();

  assert.deepEqual(f.login.methods, ['POST']);
  assert.equal(f.login.requestBody, 'buffered');

  await f.dispose();
});

test('a malformed rpc method is refused as CONFIG_INVALID', async () => {
  const f = routeFixture();

  const denied = await f.login.fetch(loginRequest('wrong', { clientId: owner }));

  assert.equal((await denied.json()).result.error.code, 'CONFIG_INVALID');

  await f.dispose();
});

test('the login response carries no-store cache control', async () => {
  const f = routeFixture();

  const started = await f.login.fetch(loginRequest('codex-subscription-auth/login', { clientId: owner }));

  assert.equal(started.headers.get('cache-control'), 'no-store');

  await f.dispose();
});

test('a valid login request answers ok', async () => {
  const f = routeFixture();

  const started = await f.login.fetch(loginRequest('codex-subscription-auth/login', { clientId: owner }));

  assert.equal((await started.json()).result.ok, true);

  await f.dispose();
});

test('an oversized login payload is refused as LIMIT_EXCEEDED', async () => {
  const f = routeFixture();

  const oversized = await f.login.fetch(loginRequest('codex-subscription-auth/login', { clientId: owner, token: 'x'.repeat(5000) }));

  assert.equal((await oversized.json()).result.error.code, 'LIMIT_EXCEEDED');

  await f.dispose();
});

test('disposing the install removes every registered route', async () => {
  const f = routeFixture();

  await f.dispose();

  assert.equal(f.removed(), 4);
});

test('a successful login reports the signed_in phase', async () => {
  const f = observerFixture();

  await f.controller.invoke('login', { clientId: owner });
  await tick();

  assert.equal(f.controller.view(owner).phase, 'signed_in');

  await f.controller.close();
});

test('login and logout both notify the model observer', async () => {
  const f = observerFixture();

  await f.controller.invoke('login', { clientId: owner });
  await tick();
  await f.controller.invoke('logout', { clientId: owner });

  assert.equal(f.changed(), 2);

  await f.controller.close();
});

test('a failing observer callback does not leak its error into the view', async () => {
  const f = observerFixture();

  await f.controller.invoke('login', { clientId: owner });
  await tick();
  await f.controller.invoke('logout', { clientId: owner });

  assert.equal(JSON.stringify(f.controller.view(owner)).includes('synthetic-secret'), false);

  await f.controller.close();
});
