import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const run = promisify(execFile);
const repo = process.cwd();

const npmCli = process.env.npm_execpath;

/** The module url form the driver needs. */
const url = (path) => pathToFileURL(path).href;

const environment = (root) => ({ HOME: join(root, 'home'), DSH_HOME: join(root, 'harness'), PATH: '/usr/bin:/bin', DSH_TELEMETRY_DISABLED: 'true' });

/**
 * Install the bridge into a disposable profile, boot it with a synthetic login
 * and answer with the observations the case asserts. The driver keeps the whole
 * transfer path in one file so the case can assert one guarantee from it.
 */
async function drive(root) {
  const env = environment(root);
  const profile = join(env.DSH_HOME, 'profiles', 'auth-ui-test');
  const cache = join(root, 'cache');
  await mkdir(env.HOME);
  await mkdir(profile, { recursive: true });
  const pack = JSON.parse(execFileSync(process.execPath, [npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', root, '--cache', cache], { env, encoding: 'utf8', timeout: 15000 }))[0];
  await writeFile(join(profile, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: { 'dsh-codex-subscription-bridge': `file:${join(root, pack.filename)}` }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-codex-subscription-bridge'] } } }));
  await writeFile(join(profile, 'cordis.patch.yml'), '- id: hmr\n  disabled: true\n');
  execFileSync(process.execPath, [npmCli, 'install', '--ignore-scripts', '--offline', '--legacy-peer-deps', '--no-audit', '--no-fund', '--cache', cache], { cwd: profile, env, stdio: 'pipe', timeout: 15000 });

  const driver = `
import {runProfile} from ${JSON.stringify(url(join(repo, 'verification/runtime/node_modules/@deepseek-ai/dsh/lib/profile-boot.js')))};
import {createLaunchEnvironmentSnapshot} from ${JSON.stringify(url(join(repo, 'verification/runtime/node_modules/@deepseek-ai/dsh-launch-environment/lib/index.js')))};
import {BridgeError} from ${JSON.stringify(url(join(profile, 'node_modules/dsh-codex-subscription-bridge/lib/errors.js')))};
const {ctx, shutdown} = await runProfile({profile: 'auth-ui-test', patchFiles: [], args: ['--host', '127.0.0.1', '--port', '0', '--no-open'], environment: createLaunchEnvironmentSnapshot([{source: 'process', values: process.env}])});
await ctx.get('loader').await();
const {AuthStore} = await import(${JSON.stringify(url(join(profile, 'node_modules/dsh-codex-subscription-bridge/lib/auth.js')))});
let approve;
AuthStore.prototype.login = async function (announce, signal) {
  announce({url: 'https://auth.openai.com/codex/device', code: 'SYNTHETIC-CODE'});
  await new Promise((resolve, reject) => {
    approve = resolve;
    signal.addEventListener('abort', () => reject(new BridgeError('ABORTED')), {once: true});
  });
  const token = 'x.' + Buffer.from(JSON.stringify({exp: Date.now() / 1000 + 3600, 'https://api.openai.com/auth': {chatgpt_account_id: 'synthetic'}})).toString('base64url') + '.x';
  await this.transaction(() => this.write({access_token: token, refresh_token: 'synthetic-refresh'}), signal);
};
const base = 'http://127.0.0.1:' + ctx.webServer.port;
const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const message = (method, payload) => JSON.stringify({type: 'client-request', rpcId: 'fixture', method, payload});
const request = (method, payload, headers = {}) => fetch(base + '/api/' + method, {method: 'POST', headers: {'Content-Type': 'application/json', ...headers}, body: message(method, payload)});
const observations = {cacheControl: []};
observations.unauthenticated = (await request('codex-subscription-auth/status', {clientId: owner})).status;
const boot = await fetch(ctx.connection.authenticatedUrl(base + '/'), {redirect: 'manual'});
const cookie = boot.headers.getSetCookie().map((value) => value.split(';')[0]).join(';');
observations.cookie = Boolean(cookie);
observations.untrustedOrigin = (await request('codex-subscription-auth/login', {clientId: owner}, {Cookie: cookie, Origin: 'https://untrusted.invalid'})).status;
const headers = {Cookie: cookie, Origin: base};
observations.catalog = (await (await request('permissionPresets/catalog', {args: {}}, headers)).json()).result.ok;
const rpc = async (action, args = {clientId: owner}) => {
  const response = await request('codex-subscription-auth/' + action, args, headers);
  observations.cacheControl.push(response.headers.get('cache-control'));
  return (await response.json()).result;
};
observations.login = (await rpc('login')).ok;
const current = (await rpc('status')).value;
observations.ownerCode = current.device.code;
observations.otherStatus = (await rpc('status', {clientId: other})).value;
observations.cancelByOther = (await rpc('cancel', {clientId: other, attemptId: current.attemptId})).ok;
observations.cancelByOwner = (await rpc('cancel', {clientId: owner, attemptId: current.attemptId})).value.phase;
await rpc('login');
approve();
for (let n = 0; n < 100; n++) {
  observations.signedIn = (await rpc('status')).value;
  if (observations.signedIn.phase === 'signed_in') break;
  await new Promise((resolve) => setTimeout(resolve, 10));
}
observations.leak = JSON.stringify(observations.signedIn).includes('synthetic-refresh');
observations.logout = (await rpc('logout')).value.local.auth;
await shutdown.shutdown(0);
console.log('OBSERVATIONS ' + JSON.stringify(observations));
`;
  await writeFile(join(root, 'driver.mjs'), driver);
  const result = await run(process.execPath, [join(root, 'driver.mjs')], { env, cwd: root, timeout: 20000 });
  const line = result.stdout.split('\n').find((row) => row.startsWith('OBSERVATIONS '));
  return JSON.parse(line.slice('OBSERVATIONS '.length));
}

test('an unauthenticated auth route request is refused as 401', { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-auth-routes-'));
  const observations = await drive(root);

  assert.equal(observations.unauthenticated, 401);

  await rm(root, { recursive: true, force: true });
});

test('the authenticated carrier provides a cookie for the auth routes', { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-auth-routes-'));
  const observations = await drive(root);

  assert.ok(observations.cookie);

  await rm(root, { recursive: true, force: true });
});

test('a login from an untrusted origin is refused as 403', { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-auth-routes-'));
  const observations = await drive(root);

  assert.equal(observations.untrustedOrigin, 403);

  await rm(root, { recursive: true, force: true });
});

test('the permission preset catalog still answers through the authenticated carrier', { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-auth-routes-'));
  const observations = await drive(root);

  assert.equal(observations.catalog, true);

  await rm(root, { recursive: true, force: true });
});

test('every auth response carries no-store cache control', { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-auth-routes-'));
  const observations = await drive(root);

  assert.ok(observations.cacheControl.every((value) => value === 'no-store'));

  await rm(root, { recursive: true, force: true });
});

test('the login route answers ok for the owning client', { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-auth-routes-'));
  const observations = await drive(root);

  assert.equal(observations.login, true);

  await rm(root, { recursive: true, force: true });
});

test('the owning client sees the device code it announced', { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-auth-routes-'));
  const observations = await drive(root);

  assert.equal(observations.ownerCode, 'SYNTHETIC-CODE');

  await rm(root, { recursive: true, force: true });
});

test('another client sees no attempt for the login it does not own', { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-auth-routes-'));
  const observations = await drive(root);

  assert.equal(observations.otherStatus.device, undefined);
  assert.equal(observations.otherStatus.attemptId, undefined);

  await rm(root, { recursive: true, force: true });
});

test('a cancel from another client is refused', { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-auth-routes-'));
  const observations = await drive(root);

  assert.equal(observations.cancelByOther, false);

  await rm(root, { recursive: true, force: true });
});

test('a cancel by the login owner reports the cancelled phase', { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-auth-routes-'));
  const observations = await drive(root);

  assert.equal(observations.cancelByOwner, 'cancelled');

  await rm(root, { recursive: true, force: true });
});

test('the completed login reports the signed_in phase', { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-auth-routes-'));
  const observations = await drive(root);

  assert.equal(observations.signedIn.phase, 'signed_in');

  await rm(root, { recursive: true, force: true });
});

test('the completed login reports the local store as stored', { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-auth-routes-'));
  const observations = await drive(root);

  assert.equal(observations.signedIn.local.auth, 'stored');

  await rm(root, { recursive: true, force: true });
});

test('the status does not carry the raw refresh token', { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-auth-routes-'));
  const observations = await drive(root);

  assert.equal(observations.leak, false);

  await rm(root, { recursive: true, force: true });
});

test('logout reports the store as missing', { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-auth-routes-'));
  const observations = await drive(root);

  assert.equal(observations.logout, 'missing');

  await rm(root, { recursive: true, force: true });
});
