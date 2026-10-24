import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, readdir, access } from 'node:fs/promises';
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

/** Resolve the npm CLI entry point the same way install.sh does so both invocations behave identically. */
const npmCli = process.env.npm_execpath
  ?? spawnSync(process.execPath, ['-e', 'console.log(require("node:fs").realpathSync(process.argv[1]))',
    spawnSync('/usr/bin/which', ['npm'], { encoding: 'utf8' }).stdout.trim()], { encoding: 'utf8' }).stdout.trim();

/** Whether the verified Desktop is installed; the Desktop surface checks are skipped there rather than weakened. */
const desktopAvailable = (() => {
  const result = spawnSync(process.execPath, [finder], { encoding: 'utf8', timeout: 60_000 });
  return result.status === 0 ? result.stdout.trim() : undefined;
})();

const skip = desktopAvailable === undefined ? 'the verified Desktop is not installed' : false;

/** A minimal profile shaped like a Desktop profile with one other plugin. */
async function syntheticProfile(root) {
  const profile = join(root, 'profile');
  await mkdir(profile, { recursive: true });
  await writeFile(join(profile, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-desktop',
    private: true,
    dependencies: { 'dsh-theme-studio': '0.6.3' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-theme-studio'] } },
  }, null, 2)}\n`);
  await writeFile(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n');
  await writeFile(join(profile, 'cordis.patch.yml'), '- id: llm-pi-ai\n  config:\n    providers:\n      local:\n        apiKeyEnv: SYNTHETIC_KEY\n');
  return profile;
}

/** Build a synthetic release the installer can verify; `corrupt` rewrites the package digest in the manifest. */
async function buildRelease(root, { corrupt } = {}) {
  const release = join(root, 'release');
  const manifest = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8'));
  const tag = `v${manifest.version}`;
  const build = spawnSync(process.execPath, [npmCli, 'run', 'prepare:release', '--', '--tag', tag, '--directory', release], { encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
  if (build.status !== 0) throw new Error(`the release build failed: ${build.stderr}`);
  const packageAsset = `${manifest.name}-${manifest.version}.tgz`;
  if (corrupt) {
    const lines = (await readFile(join(release, 'SHA256SUMS'), 'utf8')).split('\n').filter(Boolean)
      .map((line) => line.endsWith(packageAsset) ? `${'f'.repeat(64)}  ${packageAsset}` : line);
    await writeFile(join(release, 'SHA256SUMS'), `${lines.join('\n')}\n`);
  }
  return { release, tag, packageAsset };
}

/** Run the installer against that release and profile. */
const runInstaller = (release, profile, tag, extra = []) => spawnSync('/bin/sh', [
  installer, '--tag', tag, '--profile', profile, '--surface', 'desktop', ...extra,
], {
  encoding: 'utf8',
  timeout: 600_000,
  maxBuffer: 8 * 1024 * 1024,
  env: { ...process.env, DSH_INSTALL_SOURCE: `file://${release}` },
});

/** The rollback directory the installer wrote, if any. */
const backupOf = async (profile) => (await readdir(profile)).find((name) => name.startsWith('.bridge-backup-'));

test('profile install reports success for a synthetic profile', { timeout: 600_000, skip }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-profile-install-'));
  const profile = await syntheticProfile(root);
  const { release, tag } = await buildRelease(root);

  const result = runInstaller(release, profile, tag);

  assert.equal(result.status, 0, result.stderr);

  await rm(root, { recursive: true, force: true });
});

test('profile install keeps the existing dependency alongside the bridge', { timeout: 600_000, skip }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-profile-install-'));
  const profile = await syntheticProfile(root);
  const { release, tag } = await buildRelease(root);

  runInstaller(release, profile, tag);
  const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'));

  assert.deepEqual(Object.keys(manifest.dependencies).sort(), ['dsh-codex-subscription-bridge', 'dsh-theme-studio']);

  await rm(root, { recursive: true, force: true });
});

test('profile install keeps the existing bundle list and appends the bridge', { timeout: 600_000, skip }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-profile-install-'));
  const profile = await syntheticProfile(root);
  const { release, tag } = await buildRelease(root);

  runInstaller(release, profile, tag);
  const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'));

  assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-theme-studio', 'dsh-codex-subscription-bridge']);

  await rm(root, { recursive: true, force: true });
});

test('profile install points the dependency at the verified artifact it was given', { timeout: 600_000, skip }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-profile-install-'));
  const profile = await syntheticProfile(root);
  const { release, tag, packageAsset } = await buildRelease(root);

  runInstaller(release, profile, tag);
  const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'));

  assert.match(manifest.dependencies['dsh-codex-subscription-bridge'], new RegExp(`${packageAsset.replaceAll('.', '\\.')}$`, 'u'));

  await rm(root, { recursive: true, force: true });
});

test('profile install leaves the user patch layer alone', { timeout: 600_000, skip }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-profile-install-'));
  const profile = await syntheticProfile(root);
  const { release, tag } = await buildRelease(root);
  const patchBefore = await readFile(join(profile, 'cordis.patch.yml'), 'utf8');

  runInstaller(release, profile, tag);

  assert.equal(await readFile(join(profile, 'cordis.patch.yml'), 'utf8'), patchBefore);

  await rm(root, { recursive: true, force: true });
});

test('profile install puts the verified package in the profile', { timeout: 600_000, skip }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-profile-install-'));
  const profile = await syntheticProfile(root);
  const { release, tag } = await buildRelease(root);

  runInstaller(release, profile, tag);
  const installed = JSON.parse(await readFile(join(profile, 'node_modules/dsh-codex-subscription-bridge/package.json'), 'utf8'));

  assert.equal(installed.name, 'dsh-codex-subscription-bridge');

  await rm(root, { recursive: true, force: true });
});

test('profile install writes a rollback copy for a successful run', { timeout: 600_000, skip }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-profile-install-'));
  const profile = await syntheticProfile(root);
  const { release, tag } = await buildRelease(root);

  runInstaller(release, profile, tag);

  assert.ok(await backupOf(profile), 'no backup directory was written');

  await rm(root, { recursive: true, force: true });
});

test('restoring the rollback copy returns the profile to its previous text', { timeout: 600_000, skip }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-profile-install-'));
  const profile = await syntheticProfile(root);
  const { release, tag } = await buildRelease(root);
  const before = await readFile(join(profile, 'package.json'), 'utf8');

  runInstaller(release, profile, tag);
  const backupName = await backupOf(profile);

  assert.equal(await readFile(join(profile, backupName, 'package.json'), 'utf8'), before);

  await rm(root, { recursive: true, force: true });
});

test('the rollback record names the release it installed', { timeout: 600_000, skip }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-profile-install-'));
  const profile = await syntheticProfile(root);
  const { release, tag } = await buildRelease(root);

  runInstaller(release, profile, tag);
  const record = JSON.parse(await readFile(join(profile, await backupOf(profile), 'installed.json'), 'utf8'));

  assert.equal(record.release, tag);

  await rm(root, { recursive: true, force: true });
});

test('the rollback record names the surface it installed', { timeout: 600_000, skip }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-profile-install-'));
  const profile = await syntheticProfile(root);
  const { release, tag } = await buildRelease(root);

  runInstaller(release, profile, tag);
  const record = JSON.parse(await readFile(join(profile, await backupOf(profile), 'installed.json'), 'utf8'));

  assert.equal(record.surface, 'desktop');

  await rm(root, { recursive: true, force: true });
});

test('the rollback record carries the verified digest', { timeout: 600_000, skip }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-profile-install-'));
  const profile = await syntheticProfile(root);
  const { release, tag } = await buildRelease(root);

  runInstaller(release, profile, tag);
  const record = JSON.parse(await readFile(join(profile, await backupOf(profile), 'installed.json'), 'utf8'));

  assert.match(record.sha256, /^[0-9a-f]{64}$/u);

  await rm(root, { recursive: true, force: true });
});

test('profile install refuses a second install', { timeout: 600_000, skip }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-profile-again-'));
  const profile = await syntheticProfile(root);
  const { release, tag } = await buildRelease(root);
  runInstaller(release, profile, tag);

  const second = runInstaller(release, profile, tag);

  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /already listed/u);

  await rm(root, { recursive: true, force: true });
});

test('a refused second install leaves the profile alone', { timeout: 600_000, skip }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-profile-again-'));
  const profile = await syntheticProfile(root);
  const { release, tag } = await buildRelease(root);
  runInstaller(release, profile, tag);
  const after = await readFile(join(profile, 'package.json'), 'utf8');

  runInstaller(release, profile, tag);

  assert.equal(await readFile(join(profile, 'package.json'), 'utf8'), after);

  await rm(root, { recursive: true, force: true });
});

test('profile install refuses a tampered artifact', { timeout: 600_000, skip }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-profile-tamper-'));
  const profile = await syntheticProfile(root);
  const { release, tag } = await buildRelease(root, { corrupt: true });

  const result = runInstaller(release, profile, tag);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not match the published checksum/u);

  await rm(root, { recursive: true, force: true });
});

test('a refused install leaves the profile alone', { timeout: 600_000, skip }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-profile-tamper-'));
  const profile = await syntheticProfile(root);
  const { release, tag } = await buildRelease(root, { corrupt: true });
  const before = await readFile(join(profile, 'package.json'), 'utf8');

  runInstaller(release, profile, tag);

  assert.equal(await readFile(join(profile, 'package.json'), 'utf8'), before);

  await rm(root, { recursive: true, force: true });
});

test('a refused install writes no rollback copy', { timeout: 600_000, skip }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-profile-tamper-'));
  const profile = await syntheticProfile(root);
  const { release, tag } = await buildRelease(root, { corrupt: true });

  runInstaller(release, profile, tag);

  assert.equal(await backupOf(profile), undefined);

  await rm(root, { recursive: true, force: true });
});

test('profile install rejects a web surface', { timeout: 300_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-profile-inputs-'));
  const profile = await syntheticProfile(root);

  const web = spawnSync('/bin/sh', [installer, '--tag', 'v0.0.1', '--profile', profile], { encoding: 'utf8' });

  assert.equal(web.status, 2);
  assert.match(web.stderr, /--profile requires --surface desktop/u);

  await rm(root, { recursive: true, force: true });
});

test('profile install rejects combining a profile with a destination', { timeout: 300_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-profile-inputs-'));
  const profile = await syntheticProfile(root);

  const both = spawnSync('/bin/sh', [installer, '--tag', 'v0.0.1', '--directory', join(root, 'new'), '--profile', profile], { encoding: 'utf8' });

  assert.equal(both.status, 2);
  assert.match(both.stderr, /cannot be combined/u);

  await rm(root, { recursive: true, force: true });
});

test('profile install rejects a profile that does not exist', { timeout: 300_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-profile-inputs-'));

  const missing = spawnSync('/bin/sh', [installer, '--tag', 'v0.0.1', '--profile', join(root, 'absent'), '--surface', 'desktop'], { encoding: 'utf8' });

  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /must name an existing directory/u);

  await rm(root, { recursive: true, force: true });
});

test('profile install rejects a directory that is not a profile', { timeout: 300_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-profile-inputs-'));
  const empty = join(root, 'empty');
  await mkdir(empty);

  const notProfile = spawnSync('/bin/sh', [installer, '--tag', 'v0.0.1', '--profile', empty, '--surface', 'desktop'], { encoding: 'utf8' });

  assert.equal(notProfile.status, 1);
  assert.match(notProfile.stderr, /no package\.json/u);

  await rm(root, { recursive: true, force: true });
});

test('a refused non-profile leaves the directory without a package file', { timeout: 300_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-profile-inputs-'));
  const empty = join(root, 'empty');
  await mkdir(empty);

  spawnSync('/bin/sh', [installer, '--tag', 'v0.0.1', '--profile', empty, '--surface', 'desktop'], { encoding: 'utf8' });

  await assert.rejects(access(join(empty, 'package.json')), { code: 'ENOENT' });

  await rm(root, { recursive: true, force: true });
});
