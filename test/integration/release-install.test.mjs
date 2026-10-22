import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const manifest = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8'));
const TAG = `v${manifest.version}`;
const BUNDLE = `${manifest.name}-installer-${manifest.version}.tgz`;
const PACKAGE_ASSET = `${manifest.name}-${manifest.version}.tgz`;

// `npm_execpath` is set when this suite runs through an npm script, but a direct
// `node --test` invocation does not provide it. Resolve the npm CLI entry point
// the same way install.sh does so both invocations behave identically.
const npmCli = process.env.npm_execpath
  ?? execFileSync(process.execPath, ['-e', 'console.log(require("node:fs").realpathSync(process.argv[1]))',
    execFileSync('/usr/bin/which', ['npm'], { encoding: 'utf8' }).trim()], { encoding: 'utf8' }).trim();

/**
 * Build a synthetic release in the layout `install.sh` expects, using the real
 * release build script. This exercises the bundle the project would actually
 * publish: the installer bundle asset, the plugin package asset and a
 * SHA256SUMS manifest. Nothing here contacts the network or the real
 * repository, and no credentials or model requests are involved.
 */
async function publishSyntheticRelease(root, { corrupt } = {}) {
  const release = join(root, 'release');
  execFileSync(process.execPath, [
    npmCli, 'run', 'prepare:release', '--', '--tag', TAG, '--directory', release,
  ], { encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  const digests = (await readFile(join(release, 'SHA256SUMS'), 'utf8')).split('\n').filter(Boolean)
    .map((line) => ({ name: line.slice(66), digest: line.slice(0, 64) }));
  assert.deepEqual(digests.map((entry) => entry.name).sort(), [BUNDLE, PACKAGE_ASSET].sort());
  if (corrupt) {
    // Corrupt only the bundle's published digest, leaving the packaged plugin
    // entry intact, so the failure is attributable to the downloaded bundle.
    await writeFile(join(release, 'SHA256SUMS'),
      `${digests.map((entry) => `${entry.name === BUNDLE ? 'f'.repeat(64) : entry.digest}  ${entry.name}`).join('\n')}\n`);
  }
  const digestOf = (name) => digests.find((entry) => entry.name === name).digest;
  return { release, digest: digestOf(BUNDLE), packageDigest: digestOf(PACKAGE_ASSET) };
}

function runInstaller(release, directory, extraArguments = []) {
  return spawnSync('/bin/sh', [join(process.cwd(), 'install.sh'), '--tag', TAG, '--directory', directory, ...extraArguments], {
    encoding: 'utf8',
    timeout: 600_000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, DSH_INSTALL_SOURCE: `file://${release}` },
  });
}

/**
 * Whether the verified Desktop host is installed. CI has no Harness Desktop, so
 * the Desktop surface assertions are skipped there rather than weakened.
 */
function installedDesktopExecutable() {
  const app = '/Applications/DeepSeek Harness.app';
  const executable = join(app, 'Contents/MacOS/DeepSeek Harness');
  const probe = `const p=require(${JSON.stringify(join(app, 'Contents/Resources/app.asar/package.json'))});` +
    `process.stdout.write('FACTS'+JSON.stringify({version:p.version,electron:process.versions.electron,node:process.versions.node}))`;
  const result = spawnSync(executable, ['-p', probe], { encoding: 'utf8', env: { ELECTRON_RUN_AS_NODE: '1' }, timeout: 20_000 });
  if (result.status !== 0) return undefined;
  // Electron may emit warnings on the same stream, so only the marked line is
  // read rather than parsing whatever happened to be printed.
  const line = result.stdout.split('\n').find((row) => row.startsWith('FACTS'));
  if (line === undefined) return undefined;
  // Electron also prints the expression's own return value, so the marked JSON
  // object is extracted rather than assuming it ends the line.
  const marked = /\{.*\}/u.exec(line.slice('FACTS'.length));
  if (marked === null) return undefined;
  const facts = JSON.parse(marked[0]);
  return facts.version === '0.2.1-rc.2' && facts.electron === '44.7.0' && facts.node === '24.21.0' ? executable : undefined;
}

test('release installer refuses an unknown surface', { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-release-surface-'));
  const target = join(root, 'profile-target');
  try {
    const { release } = await publishSyntheticRelease(root);
    const installation = runInstaller(release, target, ['--surface', 'native']);
    assert.equal(installation.status, 2);
    assert.match(installation.stderr, /--surface must be web or desktop/u);
    await assert.rejects(access(target), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('release installer prepares a signed-out Desktop profile from the released artifact', { timeout: 600_000, skip: installedDesktopExecutable() === undefined ? 'the verified DeepSeek Harness Desktop is not installed' : false }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-release-desktop-'));
  const target = join(root, 'desktop-profile');
  try {
    const { release, packageDigest } = await publishSyntheticRelease(root);
    const installation = runInstaller(release, target, ['--surface', 'desktop']);
    assert.equal(installation.status, 0, installation.stderr);

    // The Desktop profile uses the name and host the source Desktop installer
    // verifies, and records the host pair rather than a runtime copy.
    const manifest = JSON.parse(await readFile(join(target, 'manifest.json'), 'utf8'));
    assert.equal(manifest.surface, 'desktop');
    assert.equal(manifest.electron, '44.7.0');
    assert.equal(manifest.hostNode, '24.21.0');
    assert.equal(manifest.release, TAG);
    assert.equal(manifest.sha256, packageDigest);
    assert.equal(manifest.workingTreeMayContainChanges, false);
    await access(join(target, 'harness/profiles/desktop'));
    // The Desktop host boots through ctx.connection and ctx.webServer, so the
    // web application bundle must be listed even though the host supplies its
    // own peers. Omitting it fails host startup before any profile is served.
    const bundles = JSON.parse(await readFile(join(target, 'harness/profiles/desktop/package.json'), 'utf8')).dsh.profile.bundles;
    assert.deepEqual(bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-codex-subscription-bridge']);
    // The standalone launcher and the auth helper belong to the Web surface.
    // The helper is omitted here because it launches the plugin outside the
    // application, where the host peers it imports cannot be resolved.
    await assert.rejects(access(join(target, 'start.sh')), { code: 'ENOENT' });
    await assert.rejects(access(join(target, 'auth.sh')), { code: 'ENOENT' });
    await assert.rejects(access(join(target, 'runtime')), { code: 'ENOENT' });
    // Desktop's resolver supplies the host peers from its ASAR tree, so the
    // profile must not shadow them with a standalone copy.
    await assert.rejects(access(join(target, 'harness/profiles/desktop/node_modules/@deepseek-ai/cordis')), { code: 'ENOENT' });
    await assert.rejects(access(join(target, 'harness/profiles/desktop/node_modules/@deepseek-ai/dsh-llm')), { code: 'ENOENT' });
    // Preparation alone creates no credential store at all.
    await assert.rejects(access(join(target, 'harness/.dsh-codex-subscription-bridge')), { code: 'ENOENT' });

    // Loading the profile through Desktop's own ASAR resolver registers the
    // bridge. This is the path the application uses; it starts no GUI, performs
    // no login, and contacts no service.
    const load = spawnSync(installedDesktopExecutable(), [join(process.cwd(), 'scripts/verify-desktop-release.mjs'), target], {
      encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    assert.equal(load.status, 0, load.stderr);
    assert.match(load.stdout, /RELEASE_DESKTOP_PROFILE_OK/u);

    // Preparation and the unauthenticated catalog read create no grant. The
    // store's private directory may appear as its 0700 home, but no credential
    // file is written, so the profile stays signed out.
    await assert.rejects(access(join(target, 'harness/.dsh-codex-subscription-bridge/auth.json')), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('release installer verifies a synthetic release and prepares a signed-out profile', { timeout: 600_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-release-install-'));
  // A destination containing a space and an apostrophe exercises the shell
  // quoting the generated launchers depend on.
  const target = join(root, "profile space's");
  try {
    const { release, digest, packageDigest } = await publishSyntheticRelease(root);
    const installation = runInstaller(release, target);
    assert.equal(installation.status, 0, installation.stderr);

    // Both the bundle and the packaged plugin inside it are verified, and both
    // digests are printed so the user can compare them against the release page.
    for (const [name, value] of [[BUNDLE, digest], [PACKAGE_ASSET, packageDigest]]) {
      assert.ok(installation.stdout.includes(name), `${name} was not reported`);
      assert.ok(installation.stdout.includes(`expected ${value}`), `${name} expected digest missing`);
      assert.ok(installation.stdout.includes(`actual   ${value}`), `${name} actual digest missing`);
    }

    // The manifest records the release identity and the digest of the package
    // that was actually installed, not the enclosing bundle. Unlike the source
    // installer, it states that no working tree contributed to the artifact.
    assert.deepEqual(JSON.parse(await readFile(join(target, 'manifest.json'), 'utf8')), {
      schema: 1, source: 'release', release: TAG, package: PACKAGE_ASSET, sha256: packageDigest,
      node: process.versions.node, harness: '0.2.1-rc.2', workingTreeMayContainChanges: false,
    });

    // Preparation is signed out: doctor reports a missing store and no
    // credential directory was created by the installer.
    const diagnosis = spawnSync('/bin/sh', [join(target, 'auth.sh'), 'doctor'], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(diagnosis.status, 1);
    assert.equal(JSON.parse(diagnosis.stdout).store, 'missing');
    await assert.rejects(access(join(target, 'home/.dsh-codex-subscription-bridge')), { code: 'ENOENT' });

    // The prepared profile composes the bridge against the pinned runtime.
    const config = execFileSync(process.execPath, [
      join(target, 'runtime/node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'subscription-web', '--dump-config',
    ], {
      encoding: 'utf8', timeout: 60_000,
      env: { HOME: join(target, 'home'), DSH_HOME: join(target, 'harness'), PATH: '/usr/bin:/bin' },
    });
    assert.ok(config.includes('llm-codex-subscription'));

    // An existing destination is never overwritten or mutated.
    const snapshot = await readFile(join(target, 'manifest.json'), 'utf8');
    const second = runInstaller(release, target);
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /refusing to use an existing destination/u);
    assert.equal(await readFile(join(target, 'manifest.json'), 'utf8'), snapshot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('release installer refuses a tampered bundle before creating anything', { timeout: 180_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-release-tamper-'));
  const target = join(root, 'profile-target');
  try {
    const { release } = await publishSyntheticRelease(root, { corrupt: true });
    const installation = runInstaller(release, target);
    assert.notEqual(installation.status, 0);
    assert.match(installation.stderr, /does not match the published checksum/u);
    // A refusal must not leave a partially prepared profile behind.
    await assert.rejects(access(target), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('release installer refuses a bundle missing from the checksums file', { timeout: 180_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-release-unlisted-'));
  const target = join(root, 'profile-target');
  try {
    const { release, digest } = await publishSyntheticRelease(root);
    // Replace the manifest with one that lists a different, unrelated asset.
    await writeFile(join(release, 'SHA256SUMS'), `${digest}  some-other-package-0.0.0.tgz\n`);
    const installation = runInstaller(release, target);
    assert.notEqual(installation.status, 0);
    assert.match(installation.stderr, /is not listed in SHA256SUMS/u);
    await assert.rejects(access(target), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('release installer refuses to install when the packaged plugin is unlisted', { timeout: 180_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-release-inner-'));
  const target = join(root, 'profile-target');
  try {
    const { release, digest } = await publishSyntheticRelease(root);
    // List only the bundle. The bundle verifies, but the plugin package it
    // carries is unlisted, so the install must stop before preparing a profile.
    await writeFile(join(release, 'SHA256SUMS'), `${digest}  ${BUNDLE}\n`);
    const installation = runInstaller(release, target);
    assert.notEqual(installation.status, 0);
    assert.match(installation.stderr, /is not listed in SHA256SUMS/u);
    await assert.rejects(access(target), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('release installer rejects malformed input and an unreviewed transport before downloading', { timeout: 180_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-release-inputs-'));
  const target = join(root, 'profile-target');
  const installer = join(process.cwd(), 'install.sh');
  try {
    const { release } = await publishSyntheticRelease(root);
    const environment = { ...process.env, DSH_INSTALL_SOURCE: `file://${release}` };
    const run = (arguments_, env = environment) => spawnSync('/bin/sh', [installer, ...arguments_], { encoding: 'utf8', env });
    // A missing or relative destination, a malformed tag and an unknown
    // argument fail as usage errors rather than reaching the download step.
    assert.equal(run(['--tag', TAG]).status, 2);
    assert.equal(run(['--tag', 'main', '--directory', target]).status, 2);
    assert.equal(run(['--tag', TAG, '--directory', 'relative/path']).status, 2);
    assert.equal(run(['--tag', TAG, '--directory', target, '--extra']).status, 2);
    // The help text is available without any arguments.
    assert.equal(run(['--help']).status, 0);
    // An unreviewed transport is refused before any transfer is attempted.
    const transport = run(['--tag', TAG, '--directory', target], { ...process.env, DSH_INSTALL_SOURCE: 'http://mirror.example/release' });
    assert.equal(transport.status, 2);
    assert.match(transport.stderr, /must be an https origin or a file:\/\/ directory/u);
    await assert.rejects(access(target), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
