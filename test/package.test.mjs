import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, mkdir, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Context } from '@deepseek-ai/cordis';
import { LlmRuntime } from '@deepseek-ai/dsh-llm';
import * as plugin from '../lib/index.js';

/**
 * Environment for a child that must run this package in isolation.
 *
 * `process.execPath` is the Electron binary on the Desktop lane, so the child
 * needs ELECTRON_RUN_AS_NODE or it starts a GUI and exits silently. The rest of
 * the caller's environment is deliberately not inherited: the plugin prefers
 * DSH_HOME over HOME on that lane, so a real value would point the child at the
 * actual store instead of the fixture.
 */
function childEnvironment(directory) {
  return {
    PATH: '/usr/bin:/bin', LANG: 'C.UTF-8',
    HOME: directory, DSH_HOME: directory,
    ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
  };
}

test('real Harness service registers the guarded provider and disposes it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-public-plugin-'));
  const ctx = new Context(); ctx.provide('launchEnvironment', { getFrom: name => name === 'HOME' ? { value: root } : undefined }); const service = ctx.plugin(LlmRuntime); const fiber = ctx.plugin(plugin);
  await new Promise((resolve) => setImmediate(resolve));
  try {
    assert.deepEqual(ctx.llm.listProviders(), [{ id: 'codex-subscription', name: 'Codex (ChatGPT subscription)' }]);
    // The settings page reads the authentication posture from the directory, not
    // from provider info, so the entry is asserted as the bridge declares it.
    assert.deepEqual(ctx.llm.listConfigurableProviders(), [{
      provider: 'codex-subscription', displayName: 'Codex (ChatGPT subscription)',
      settingsNs: 'llm-codex-subscription', settingsPath: [], declared: false,
      nativeAuth: { env: [], oauth: true },
    }]);
    // The namespace is the profile entry id the shipped patch declares, because the
    // bridge registers no settings namespace of its own; the two cannot drift apart.
    const patchId = (await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')).match(/- id: (\S+)/u)[1];
    assert.equal(ctx.llm.listConfigurableProviders()[0].settingsNs, patchId, 'the settings namespace must match the profile entry id');
    await assert.rejects(ctx.llm.listModels('codex-subscription'), { code: 'AUTH_REQUIRED' });
    const chunks = [];
    for await (const chunk of ctx.llm.stream({ provider: 'codex-subscription', model: 'test-model', messages: [{ role: 'user', content: [{ type: 'text', text: 'Synthetic message' }] }] })) chunks.push(chunk);
    assert.equal(chunks.at(-1).reason.failure.code, 'AUTH_REQUIRED');
  } finally { await fiber.dispose(); }
  assert.deepEqual(ctx.llm.listProviders(), []);
  assert.deepEqual(ctx.llm.listConfigurableProviders(), []);
  await service.dispose(); await rm(root, { recursive: true, force: true });
});
test('plugin rejects credential and safety override configuration', () => {
  for (const config of [{ accessToken: 'secret-test-value' }, { allowApiKey: true }, { command: '/bin/sh' }, { enableLive: true }]) {
    assert.throws(() => plugin.apply({}, config), { code: 'CONFIG_INVALID' });
  }
});
test('tarball installs and composes in an isolated Harness service fixture', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-subscription-fixture-'));
  try {
    const metadata = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temp, '--cache', join(temp, 'cache')], { encoding: 'utf8' }))[0];
    assert.ok(metadata.files.some((file) => file.path === 'lib/index.js'));
    assert.ok(metadata.files.some((file) => file.path === 'lib/types/index.d.ts'));
    assert.ok(metadata.files.some((file) => file.path === 'cordis.patch.yml'));
    assert.ok(metadata.files.some((file) => file.path === 'LICENSE'));
    assert.equal(metadata.files.some((file) => /^(test|work)\//u.test(file.path) || (file.path.startsWith('node_modules/') && !file.path.startsWith('node_modules/undici/'))), false);
    const profile = join(temp, 'profile'); await mkdir(profile);
    await writeFile(join(profile, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: { 'dsh-codex-subscription-bridge': `file:${join(temp, metadata.filename)}` } }));
    execFileSync('npm', ['install', '--ignore-scripts', '--offline', '--legacy-peer-deps', '--no-audit', '--no-fund', '--cache', join(temp, 'cache')], { cwd: profile, stdio: 'pipe', timeout: 30_000 });
    await mkdir(join(profile, 'node_modules/@deepseek-ai'), { recursive: true });
    for (const name of ['cordis', 'dsh-llm']) {
      await symlink(resolve(`node_modules/@deepseek-ai/${name}`), join(profile, 'node_modules/@deepseek-ai', name), 'dir');
    }
    const code = `import {Context} from '@deepseek-ai/cordis';
import {LlmRuntime} from '@deepseek-ai/dsh-llm';
import * as plugin from 'dsh-codex-subscription-bridge';
const ctx = new Context(); const service = ctx.plugin(LlmRuntime); const fiber = ctx.plugin(plugin);
await new Promise(resolve => setImmediate(resolve));
try { await ctx.llm.listModels('codex-subscription'); process.exitCode=1; }
catch(error) { if(error.code !== 'AUTH_REQUIRED') process.exitCode=1; }
await fiber.dispose(); await service.dispose();`;
    execFileSync(process.execPath, ['--input-type=module', '-e', code], {
      cwd: profile, env: childEnvironment(temp), stdio: 'pipe', timeout: 15_000,
    });
    const manifest = JSON.parse(await readFile(join(profile, 'node_modules/dsh-codex-subscription-bridge/package.json'), 'utf8'));
    assert.equal(manifest.private, true);
    assert.equal(manifest.license, 'MIT');
    assert.deepEqual(manifest.dsh.bundle.patch, ['./cordis.patch.yml', './presets/codex-subscription.patch.yml']);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('the plugin selects its store from the environment it is handed', async () => {
  // The package lane failed because its child inherited the caller environment
  // and so selected the real store instead of the fixture. This pins the
  // selection directly: the plugin creates its private store beneath whichever
  // directory the environment names, so giving a fresh directory and observing
  // the store appear inside it proves the caller's environment was not used.
  const temp = await mkdtemp(join(tmpdir(), 'dsh-store-isolation-'));
  try {
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
    // DSH_HOME is what the Desktop host prefers, and HOME is what standalone
    // Node uses; both name the same fresh directory so either host proves the
    // same thing.
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', code], {
      cwd: process.cwd(), env: childEnvironment(handed),
      encoding: 'utf8', stdio: 'pipe', timeout: 15_000,
    });
    // A signed-out store is the expected refusal, which also shows the store was
    // consulted rather than skipped.
    assert.match(output, /REFUSED AUTH_REQUIRED/u);
    // The store was created under the directory the child was handed. If the
    // plugin had used the caller's environment it would have appeared elsewhere,
    // and the real store would have been touched instead.
    await stat(join(handed, '.dsh-codex-subscription-bridge'));
  } finally { await rm(temp, { recursive: true, force: true }); }
});
