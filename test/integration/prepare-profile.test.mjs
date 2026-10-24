import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';

/** Resolve the npm CLI entry point the same way install.sh does, so a direct `node --test` run behaves as an npm script run. */
function resolveNpmCli() {
  const found = spawnSync('/usr/bin/which', ['npm'], { encoding: 'utf8' }).stdout.trim();
  return execFileSync(process.execPath, ['-e', 'console.log(require("node:fs").realpathSync(process.argv[1]))', found], { encoding: 'utf8' }).trim();
}

const npmCli = process.env.npm_execpath ?? resolveNpmCli();
const repo = process.cwd();
const runtimeCli = join(repo, 'verification/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js');

/** Run the source installer into a fresh destination. */
function installInto(target) {
  return execFileSync(process.execPath, [npmCli, 'run', 'prepare:profile', '--', '--directory', target], { stdio: 'pipe', timeout: 20000 });
}

/** Read the manifest the installer wrote for that destination. */
const manifestOf = async (target) => JSON.parse(await readFile(join(target, 'manifest.json'), 'utf8'));

/** Run the prepared profile's own auth helper. */
const doctorOf = (target) => spawnSync('/bin/sh', [join(target, 'auth.sh'), 'doctor'], { encoding: 'utf8', timeout: 5000 });

/** The destination name that exercises the shell quoting the generated launchers depend on. */
const targetOf = (root) => join(root, "profile space's");

test('the source installer pins the harness it prepares', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-guide-'));
  const target = targetOf(root);

  installInto(target);

  assert.equal((await manifestOf(target)).harness, '0.2.1-rc.2');

  await rm(root, { recursive: true, force: true });
});

test('the source installer records an integrity digest for the pinned harness', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-guide-'));
  const target = targetOf(root);

  installInto(target);

  assert.ok((await manifestOf(target)).integrity.startsWith('sha512-'));

  await rm(root, { recursive: true, force: true });
});

test('the prepared profile reports a missing store through its auth helper', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-guide-'));
  const target = targetOf(root);

  installInto(target);
  const diagnosis = doctorOf(target);

  assert.equal(diagnosis.status, 1);
  assert.equal(JSON.parse(diagnosis.stdout).store, 'missing');

  await rm(root, { recursive: true, force: true });
});

test('the source installer creates no credential store', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-guide-'));
  const target = targetOf(root);

  installInto(target);

  await assert.rejects(access(join(target, 'home/.dsh-codex-subscription-bridge')), { code: 'ENOENT' });

  await rm(root, { recursive: true, force: true });
});

test('the source installer refuses to overwrite an existing destination', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-guide-'));
  const target = targetOf(root);
  installInto(target);
  const snapshot = await readFile(join(target, 'manifest.json'), 'utf8');

  assert.throws(() => installInto(target));

  assert.equal(await readFile(join(target, 'manifest.json'), 'utf8'), snapshot);

  await rm(root, { recursive: true, force: true });
});

test('the prepared profile composes the bridge against the pinned runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-guide-'));
  const target = targetOf(root);

  installInto(target);
  const config = execFileSync(process.execPath, [runtimeCli, '--profile', 'subscription-web', '--dump-config'], {
    env: { HOME: join(target, 'home'), DSH_HOME: join(target, 'harness'), PATH: dirname(process.execPath) + ':/usr/bin:/bin' },
    encoding: 'utf8',
    timeout: 5000,
  });

  assert.ok(config.includes('llm-codex-subscription'));

  await rm(root, { recursive: true, force: true });
});
