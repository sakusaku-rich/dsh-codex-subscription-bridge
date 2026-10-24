import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, mkdir, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Context } from '@deepseek-ai/cordis';
import { LlmRuntime } from '@deepseek-ai/dsh-llm';
import * as plugin from '../lib/index.js';

/** The guarded request the plugin must refuse without a stored grant. */
const request = { provider: 'codex-subscription', model: 'test-model', messages: [{ role: 'user', content: [{ type: 'text', text: 'Synthetic message' }] }] };

/** Environment for a child that must run this package in isolation, without the caller's home. */
function childEnvironment(directory) {
  return { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: directory, DSH_HOME: directory, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) };
}

/** A real Harness service with the plugin mounted against a fresh home. */
function serviceFixture(root) {
  const ctx = new Context();
  ctx.provide('launchEnvironment', { getFrom: (name) => name === 'HOME' ? { value: root } : undefined });
  const service = ctx.plugin(LlmRuntime);
  const fiber = ctx.plugin(plugin);
  return { ctx, service, fiber };
}

/** Pack this package into a tarball and return npm's metadata for it. */
function packed(temp) {
  return JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temp, '--cache', join(temp, 'cache')], { encoding: 'utf8' }))[0];
}

/** A profile that installs the packed tarball and links the pinned Harness packages into it. */
async function installedProfile(temp, metadata) {
  const profile = join(temp, 'profile');
  await mkdir(profile);
  await writeFile(join(profile, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: { 'dsh-codex-subscription-bridge': `file:${join(temp, metadata.filename)}` } }));
  execFileSync('npm', ['install', '--ignore-scripts', '--offline', '--legacy-peer-deps', '--no-audit', '--no-fund', '--cache', join(temp, 'cache')], { cwd: profile, stdio: 'pipe', timeout: 30_000 });
  await mkdir(join(profile, 'node_modules/@deepseek-ai'), { recursive: true });
  for (const name of ['cordis', 'dsh-llm']) await symlink(resolve(`node_modules/@deepseek-ai/${name}`), join(profile, 'node_modules/@deepseek-ai', name), 'dir');
  return profile;
}

/** Run a child that composes the installed package with a real Harness service. */
function compose(profile, home, code) {
  return execFileSync(process.execPath, ['--input-type=module', '-e', code], { cwd: profile, env: childEnvironment(home), encoding: 'utf8', stdio: 'pipe', timeout: 15_000 });
}

test('the plugin registers the guarded provider in a real Harness service', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-public-plugin-'));
  const { ctx, service, fiber } = serviceFixture(root);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(ctx.llm.listProviders(), [{ id: 'codex-subscription', name: 'Codex (ChatGPT subscription)' }]);

  await fiber.dispose();
  await service.dispose();
  await rm(root, { recursive: true, force: true });
});

test('the guarded provider refuses model listing with AUTH_REQUIRED', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-public-plugin-'));
  const { ctx, service, fiber } = serviceFixture(root);
  await new Promise((resolve) => setImmediate(resolve));

  await assert.rejects(ctx.llm.listModels('codex-subscription'), { code: 'AUTH_REQUIRED' });

  await fiber.dispose();
  await service.dispose();
  await rm(root, { recursive: true, force: true });
});

test('the guarded provider refuses streaming with AUTH_REQUIRED', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-public-plugin-'));
  const { ctx, service, fiber } = serviceFixture(root);
  await new Promise((resolve) => setImmediate(resolve));

  const chunks = [];
  for await (const chunk of ctx.llm.stream(request)) chunks.push(chunk);

  assert.equal(chunks.at(-1).reason.failure.code, 'AUTH_REQUIRED');

  await fiber.dispose();
  await service.dispose();
  await rm(root, { recursive: true, force: true });
});

test('disposing the fiber withdraws the provider from the service', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-public-plugin-'));
  const { ctx, service, fiber } = serviceFixture(root);
  await new Promise((resolve) => setImmediate(resolve));

  await fiber.dispose();

  assert.deepEqual(ctx.llm.listProviders(), []);

  await service.dispose();
  await rm(root, { recursive: true, force: true });
});

test('the configurable-provider entry is declared as the bridge owns it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-public-plugin-'));
  const { ctx, service, fiber } = serviceFixture(root);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(ctx.llm.listConfigurableProviders(), [{
    provider: 'codex-subscription', displayName: 'Codex (ChatGPT subscription)',
    settingsNs: 'llm-codex-subscription', settingsPath: [], declared: false,
    nativeAuth: { env: [], oauth: true },
  }]);

  await fiber.dispose();
  await service.dispose();
  await rm(root, { recursive: true, force: true });
});

test('the settings namespace matches the shipped profile patch id', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-public-plugin-'));
  const { ctx, service, fiber } = serviceFixture(root);
  await new Promise((resolve) => setImmediate(resolve));
  const patchId = (await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')).match(/- id: (\S+)/u)[1];

  assert.equal(ctx.llm.listConfigurableProviders()[0].settingsNs, patchId, 'the settings namespace must match the profile entry id');

  await fiber.dispose();
  await service.dispose();
  await rm(root, { recursive: true, force: true });
});

test('disposing the fiber withdraws the configurable-provider entry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-public-plugin-'));
  const { ctx, service, fiber } = serviceFixture(root);
  await new Promise((resolve) => setImmediate(resolve));

  await fiber.dispose();

  assert.deepEqual(ctx.llm.listConfigurableProviders(), []);

  await service.dispose();
  await rm(root, { recursive: true, force: true });
});

test('the plugin rejects credential and safety override configuration', () => {
  for (const config of [{ accessToken: 'secret-test-value' }, { allowApiKey: true }, { command: '/bin/sh' }, { enableLive: true }]) {
    assert.throws(() => plugin.apply({}, config), { code: 'CONFIG_INVALID' });
  }
});

test('the tarball ships the runtime entry, the types, the patch and the license', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-subscription-fixture-'));
  const metadata = packed(temp);

  for (const path of ['lib/index.js', 'lib/types/index.d.ts', 'cordis.patch.yml', 'LICENSE']) assert.ok(metadata.files.some((file) => file.path === path), `${path} must ship`);

  await rm(temp, { recursive: true, force: true });
});

test('the tarball excludes test, work and stray node_modules', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-subscription-fixture-'));
  const metadata = packed(temp);

  assert.equal(metadata.files.some((file) => /^(test|work)\//u.test(file.path) || (file.path.startsWith('node_modules/') && !file.path.startsWith('node_modules/undici/'))), false);

  await rm(temp, { recursive: true, force: true });
});

test('the packed tarball installs into an isolated profile', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-subscription-fixture-'));
  const metadata = packed(temp);

  const profile = await installedProfile(temp, metadata);

  assert.ok(await stat(join(profile, 'node_modules/dsh-codex-subscription-bridge')));

  await rm(temp, { recursive: true, force: true });
});

test('the installed package composes in an isolated Harness service', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-subscription-fixture-'));
  const metadata = packed(temp);
  const profile = await installedProfile(temp, metadata);
  const code = `import {Context} from '@deepseek-ai/cordis';
import {LlmRuntime} from '@deepseek-ai/dsh-llm';
import * as plugin from 'dsh-codex-subscription-bridge';
const ctx = new Context(); const service = ctx.plugin(LlmRuntime); const fiber = ctx.plugin(plugin);
await new Promise(resolve => setImmediate(resolve));
try { await ctx.llm.listModels('codex-subscription'); process.exitCode=1; }
catch(error) { if(error.code !== 'AUTH_REQUIRED') process.exitCode=1; else console.log('AUTH_REQUIRED'); }
await fiber.dispose(); await service.dispose();`;

  const output = compose(profile, temp, code);

  assert.equal(output.trim(), 'AUTH_REQUIRED');

  await rm(temp, { recursive: true, force: true });
});

test('the installed manifest stays private', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-subscription-fixture-'));
  const metadata = packed(temp);
  const profile = await installedProfile(temp, metadata);

  const manifest = JSON.parse(await readFile(join(profile, 'node_modules/dsh-codex-subscription-bridge/package.json'), 'utf8'));

  assert.equal(manifest.private, true);

  await rm(temp, { recursive: true, force: true });
});

test('the installed manifest declares the MIT license', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-subscription-fixture-'));
  const metadata = packed(temp);
  const profile = await installedProfile(temp, metadata);

  const manifest = JSON.parse(await readFile(join(profile, 'node_modules/dsh-codex-subscription-bridge/package.json'), 'utf8'));

  assert.equal(manifest.license, 'MIT');

  await rm(temp, { recursive: true, force: true });
});

test('the installed manifest names both bundle patches', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-subscription-fixture-'));
  const metadata = packed(temp);
  const profile = await installedProfile(temp, metadata);

  const manifest = JSON.parse(await readFile(join(profile, 'node_modules/dsh-codex-subscription-bridge/package.json'), 'utf8'));

  assert.deepEqual(manifest.dsh.bundle.patch, ['./cordis.patch.yml', './presets/codex-subscription.patch.yml']);

  await rm(temp, { recursive: true, force: true });
});

test('the plugin refuses with AUTH_REQUIRED from the environment it is handed', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-store-isolation-'));
  const handed = join(temp, 'handed');
  await mkdir(handed, { mode: 0o700 });
  const code = `import {Context} from '@deepseek-ai/cordis';
import {LlmRuntime} from '@deepseek-ai/dsh-llm';
import * as plugin from ${JSON.stringify(resolve('lib/index.js'))};
const ctx = new Context(); const service = ctx.plugin(LlmRuntime); const fiber = ctx.plugin(plugin);
await new Promise(resolve => setImmediate(resolve));
try { await ctx.llm.listModels('codex-subscription'); console.log('NONE'); }
catch (error) { console.log('REFUSED ' + error.code); }
await fiber.dispose(); await service.dispose();`;

  const output = execFileSync(process.execPath, ['--input-type=module', '-e', code], { cwd: process.cwd(), env: childEnvironment(handed), encoding: 'utf8', stdio: 'pipe', timeout: 15_000 });

  assert.match(output, /REFUSED AUTH_REQUIRED/u);

  await rm(temp, { recursive: true, force: true });
});

test('the plugin creates its store under the directory the environment names', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-store-isolation-'));
  const handed = join(temp, 'handed');
  await mkdir(handed, { mode: 0o700 });
  const code = `import {Context} from '@deepseek-ai/cordis';
import {LlmRuntime} from '@deepseek-ai/dsh-llm';
import * as plugin from ${JSON.stringify(resolve('lib/index.js'))};
const ctx = new Context(); const service = ctx.plugin(LlmRuntime); const fiber = ctx.plugin(plugin);
await new Promise(resolve => setImmediate(resolve));
try { await ctx.llm.listModels('codex-subscription'); console.log('NONE'); }
catch (error) { console.log('REFUSED ' + error.code); }
await fiber.dispose(); await service.dispose();`;

  execFileSync(process.execPath, ['--input-type=module', '-e', code], { cwd: process.cwd(), env: childEnvironment(handed), encoding: 'utf8', stdio: 'pipe', timeout: 15_000 });

  assert.ok(await stat(join(handed, '.dsh-codex-subscription-bridge')));

  await rm(temp, { recursive: true, force: true });
});
