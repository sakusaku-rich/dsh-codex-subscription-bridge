import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, cp, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * Installing into an existing profile modifies something the user already
 * relies on, so these checks cover the refusal and rollback guarantees rather
 * than only the happy path. They run against a disposable copy of a synthetic
 * profile; no real profile, credential or account store is read or written.
 */
const installer = join(process.cwd(), 'install.sh');
const finder = join(process.cwd(), 'scripts', 'lib', 'find-pnpm.mjs');
// `npm_execpath` is set when this suite runs through an npm script, but a direct
// `node --test` invocation does not provide it. Resolve the npm CLI entry point
// the same way install.sh does so both invocations behave identically.
const npmCli = process.env.npm_execpath
  ?? spawnSync(process.execPath, ['-e', 'console.log(require("node:fs").realpathSync(process.argv[1]))',
    spawnSync('/usr/bin/which', ['npm'], { encoding: 'utf8' }).stdout.trim()], { encoding: 'utf8' }).stdout.trim();

const desktopAvailable = (() => {
  const result = spawnSync(process.execPath, [finder], { encoding: 'utf8', timeout: 60_000 });
  return result.status === 0 ? result.stdout.trim() : undefined;
})();

/** A minimal profile shaped like a Desktop profile with one other plugin. */
async function syntheticProfile(root) {
  const profile = join(root, 'profile');
  await mkdir(profile, { recursive: true });
  await writeFile(join(profile, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-desktop', private: true,
    dependencies: { 'dsh-theme-studio': '0.6.3' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-theme-studio'] } },
  }, null, 2)}\n`);
  await writeFile(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n');
  // A configuration file the installer must leave alone.
  await writeFile(join(profile, 'cordis.patch.yml'), '- id: llm-pi-ai\n  config:\n    providers:\n      local:\n        apiKeyEnv: SYNTHETIC_KEY\n');
  return profile;
}

async function buildRelease(root, { corrupt } = {}) {
  const release = join(root, 'release');
  const manifest = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8'));
  const tag = `v${manifest.version}`;
  const build = spawnSync(process.execPath, [
    npmCli, 'run', 'prepare:release', '--', '--tag', tag, '--directory', release,
  ], { encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(build.status, 0, build.stderr);
  const packageAsset = `${manifest.name}-${manifest.version}.tgz`;
  if (corrupt) {
    const lines = (await readFile(join(release, 'SHA256SUMS'), 'utf8')).split('\n').filter(Boolean)
      .map((line) => line.endsWith(packageAsset) ? `${'f'.repeat(64)}  ${packageAsset}` : line);
    await writeFile(join(release, 'SHA256SUMS'), `${lines.join('\n')}\n`);
  }
  return { release, tag, packageAsset };
}

const runInstaller = (release, profile, tag, extra = []) => spawnSync('/bin/sh', [
  installer, '--tag', tag, '--profile', profile, '--surface', 'desktop', ...extra,
], {
  encoding: 'utf8', timeout: 600_000, maxBuffer: 8 * 1024 * 1024,
  env: { ...process.env, DSH_INSTALL_SOURCE: `file://${release}` },
});

test('profile install keeps the existing plugins, config and a rollback copy', { timeout: 600_000, skip: desktopAvailable === undefined ? 'the verified Desktop is not installed' : false }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-profile-install-'));
  try {
    const profile = await syntheticProfile(root);
    const { release, tag, packageAsset } = await buildRelease(root);
    const before = await readFile(join(profile, 'package.json'), 'utf8');
    const patchBefore = await readFile(join(profile, 'cordis.patch.yml'), 'utf8');

    const result = runInstaller(release, profile, tag);
    assert.equal(result.status, 0, result.stderr);

    // The existing dependency and bundle survive alongside the bridge.
    const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'));
    assert.deepEqual(Object.keys(manifest.dependencies).sort(), ['dsh-codex-subscription-bridge', 'dsh-theme-studio']);
    assert.deepEqual(manifest.dsh.profile.bundles,
      ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-theme-studio', 'dsh-codex-subscription-bridge']);
    // The dependency points at the verified artifact this run was given.
    assert.match(manifest.dependencies['dsh-codex-subscription-bridge'], new RegExp(`${packageAsset.replaceAll('.', '\\.')}$`, 'u'));

    // The user's own patch layer is never rewritten.
    assert.equal(await readFile(join(profile, 'cordis.patch.yml'), 'utf8'), patchBefore);

    // The verified package is what actually landed in the profile.
    const installed = JSON.parse(await readFile(join(profile, 'node_modules/dsh-codex-subscription-bridge/package.json'), 'utf8'));
    assert.equal(installed.name, 'dsh-codex-subscription-bridge');

    // Restoring the backup returns the profile to exactly its previous text.
    const { readdir } = await import('node:fs/promises');
    const backupName = (await readdir(profile)).find((name) => name.startsWith('.bridge-backup-'));
    assert.ok(backupName, 'no backup directory was written');
    assert.equal(await readFile(join(profile, backupName, 'package.json'), 'utf8'), before);
    const record = JSON.parse(await readFile(join(profile, backupName, 'installed.json'), 'utf8'));
    assert.equal(record.release, tag);
    assert.equal(record.surface, 'desktop');
    assert.match(record.sha256, /^[0-9a-f]{64}$/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('profile install refuses a second install and leaves the profile alone', { timeout: 600_000, skip: desktopAvailable === undefined ? 'the verified Desktop is not installed' : false }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-profile-again-'));
  try {
    const profile = await syntheticProfile(root);
    const { release, tag } = await buildRelease(root);
    assert.equal(runInstaller(release, profile, tag).status, 0);
    const after = await readFile(join(profile, 'package.json'), 'utf8');

    const second = runInstaller(release, profile, tag);
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /already listed/u);
    assert.equal(await readFile(join(profile, 'package.json'), 'utf8'), after);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('profile install refuses a tampered artifact without touching the profile', { timeout: 600_000, skip: desktopAvailable === undefined ? 'the verified Desktop is not installed' : false }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-profile-tamper-'));
  try {
    const profile = await syntheticProfile(root);
    const { release, tag } = await buildRelease(root, { corrupt: true });
    const before = await readFile(join(profile, 'package.json'), 'utf8');

    const result = runInstaller(release, profile, tag);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /does not match the published checksum/u);
    assert.equal(await readFile(join(profile, 'package.json'), 'utf8'), before);
    // No backup is written when the run refuses before mutating anything.
    const { readdir } = await import('node:fs/promises');
    assert.equal((await readdir(profile)).some((name) => name.startsWith('.bridge-backup-')), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('profile install rejects a web surface, a missing profile and a non-profile', { timeout: 300_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-profile-inputs-'));
  try {
    const profile = await syntheticProfile(root);
    // --profile is Desktop-only, and a profile that lacks package.json is not a
    // profile this installer will modify.
    const web = spawnSync('/bin/sh', [installer, '--tag', 'v0.0.1', '--profile', profile], { encoding: 'utf8' });
    assert.equal(web.status, 2);
    assert.match(web.stderr, /--profile requires --surface desktop/u);
    const both = spawnSync('/bin/sh', [installer, '--tag', 'v0.0.1', '--directory', join(root, 'new'), '--profile', profile], { encoding: 'utf8' });
    assert.equal(both.status, 2);
    assert.match(both.stderr, /cannot be combined/u);
    const missing = spawnSync('/bin/sh', [installer, '--tag', 'v0.0.1', '--profile', join(root, 'absent'), '--surface', 'desktop'], { encoding: 'utf8' });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /must name an existing directory/u);
    const empty = join(root, 'empty');
    await mkdir(empty);
    const notProfile = spawnSync('/bin/sh', [installer, '--tag', 'v0.0.1', '--profile', empty, '--surface', 'desktop'], { encoding: 'utf8' });
    assert.equal(notProfile.status, 1);
    assert.match(notProfile.stderr, /no package\.json/u);
    await assert.rejects(access(join(empty, 'package.json')), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
