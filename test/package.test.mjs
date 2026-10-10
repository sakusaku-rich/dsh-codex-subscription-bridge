import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Context } from '@deepseek-ai/cordis';
import { LlmRuntime } from '@deepseek-ai/dsh-llm';
import * as plugin from '../src/index.js';

test('real Harness service registers the guarded provider and disposes it', async () => {
  const ctx = new Context(); const service = ctx.plugin(LlmRuntime); const fiber = ctx.plugin(plugin);
  await new Promise((resolve) => setImmediate(resolve));
  try {
    assert.deepEqual(ctx.llm.listProviders(), [{ id: 'codex-subscription', name: 'Codex (ChatGPT subscription)' }]);
    await assert.rejects(ctx.llm.listModels('codex-subscription'), { code: 'AUTHORITY_UNVERIFIED' });
    const chunks = [];
    for await (const chunk of ctx.llm.stream({ provider: 'codex-subscription', model: 'test-model', messages: [{ role: 'user', content: [{ type: 'text', text: 'Synthetic message' }] }] })) chunks.push(chunk);
    assert.equal(chunks.at(-1).reason.failure.code, 'AUTHORITY_UNVERIFIED');
  } finally { await fiber.dispose(); }
  assert.deepEqual(ctx.llm.listProviders(), []);
  await service.dispose();
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
    assert.ok(metadata.files.some((file) => file.path === 'src/index.js'));
    assert.ok(metadata.files.some((file) => file.path === 'cordis.patch.yml'));
    assert.equal(metadata.files.some((file) => /^(test|node_modules|work)\//u.test(file.path)), false);
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
catch(error) { if(error.code !== 'AUTHORITY_UNVERIFIED') process.exitCode=1; }
await fiber.dispose(); await service.dispose();`;
    execFileSync(process.execPath, ['--input-type=module', '-e', code], { cwd: profile, stdio: 'pipe', timeout: 5000 });
    const manifest = JSON.parse(await readFile(join(profile, 'node_modules/dsh-codex-subscription-bridge/package.json'), 'utf8'));
    assert.equal(manifest.private, true);
    assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  } finally { await rm(temp, { recursive: true, force: true }); }
});
