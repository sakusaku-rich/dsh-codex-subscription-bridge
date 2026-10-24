import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, access, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const manifest = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8'));
const TAG = `v${manifest.version}`;
const BUNDLE = `${manifest.name}-installer-${manifest.version}.tgz`;
const PACKAGE_ASSET = `${manifest.name}-${manifest.version}.tgz`;
const installer = join(process.cwd(), 'install.sh');

/** Resolve the npm CLI entry point the same way install.sh does so both invocations behave identically. */
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
  execFileSync(process.execPath, [npmCli, 'run', 'prepare:release', '--', '--tag', TAG, '--directory', release], { encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  const digests = (await readFile(join(release, 'SHA256SUMS'), 'utf8')).split('\n').filter(Boolean)
    .map((line) => ({ name: line.slice(66), digest: line.slice(0, 64) }));
  if (corrupt) {
    await writeFile(join(release, 'SHA256SUMS'),
      `${digests.map((entry) => `${entry.name === BUNDLE ? 'f'.repeat(64) : entry.digest}  ${entry.name}`).join('\n')}\n`);
  }
  const digestOf = (name) => digests.find((entry) => entry.name === name).digest;
  return { release, digests, digest: digestOf(BUNDLE), packageDigest: digestOf(PACKAGE_ASSET) };
}

function runInstaller(release, directory, extraArguments = []) {
  return spawnSync('/bin/sh', [installer, '--tag', TAG, '--directory', directory, ...extraArguments], {
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
  const line = result.stdout.split('\n').find((row) => row.startsWith('FACTS'));
  if (line === undefined) return undefined;
  const marked = /\{.*\}/u.exec(line.slice('FACTS'.length));
  if (marked === null) return undefined;
  const facts = JSON.parse(marked[0]);
  return facts.version === '0.2.1-rc.2' && facts.electron === '44.7.0' && facts.node === '24.21.0' ? executable : undefined;
}

const desktopExecutable = installedDesktopExecutable();
const desktopSkip = desktopExecutable === undefined ? 'the verified DeepSeek Harness Desktop is not installed' : false;

/** Build the synthetic release and install it into one fresh destination. */
async function install(root, target, extra = [], { corrupt } = {}) {
  const { release, digests, digest, packageDigest } = await publishSyntheticRelease(root, { corrupt });
  const installation = runInstaller(release, target, extra);
  return { release, target, installation, digests, digest, packageDigest };
}

/** Load a prepared Desktop profile through Desktop's own ASAR resolver, which starts no GUI and contacts no service. */
const loadDesktopProfile = (target) => spawnSync(desktopExecutable, [join(process.cwd(), 'scripts/verify-desktop-release.mjs'), target], {
  encoding: 'utf8',
  timeout: 180_000,
  maxBuffer: 8 * 1024 * 1024,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
});

/** The destination name that exercises the shell quoting the generated launchers depend on. */
const quotedTarget = (root) => join(root, "profile space's");

const manifestOf = async (target) => JSON.parse(await readFile(join(target, 'manifest.json'), 'utf8'));

/** Run the prepared profile's own auth helper. */
const doctorOf = (target) => spawnSync('/bin/sh', [join(target, 'auth.sh'), 'doctor'], { encoding: 'utf8', timeout: 30_000 });

test('the release build publishes the installer bundle and the packaged plugin', { timeout: 180_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-release-assets-'));

  const { digests } = await publishSyntheticRelease(root);

  assert.deepEqual(digests.map((entry) => entry.name).sort(), [BUNDLE, PACKAGE_ASSET].sort());

  await rm(root, { recursive: true, force: true });
});

test('release installer refuses an unknown surface', { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-release-surface-'));
  const target = join(root, 'profile-target');

  const { installation } = await install(root, target, ['--surface', 'native']);

  assert.equal(installation.status, 2);
  assert.match(installation.stderr, /--surface must be web or desktop/u);

  await rm(root, { recursive: true, force: true });
});

test('a refused surface leaves no destination behind', { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-release-surface-'));
  const target = join(root, 'profile-target');

  await install(root, target, ['--surface', 'native']);

  await assert.rejects(access(target), { code: 'ENOENT' });

  await rm(root, { recursive: true, force: true });
});

test('release installer reports success for a synthetic release', { timeout: 600_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-release-install-'));

  const { installation } = await install(root, quotedTarget(root));

  assert.equal(installation.status, 0, installation.stderr);

  await rm(root, { recursive: true, force: true });
});

test('release installer reports the installer bundle it verified', { timeout: 600_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-release-install-'));
  const { installation, digest } = await install(root, quotedTarget(root));

  assert.ok(installation.stdout.includes(BUNDLE), `${BUNDLE} was not reported`);
  assert.ok(installation.stdout.includes(`expected ${digest}`), `${BUNDLE} expected digest missing`);
  assert.ok(installation.stdout.includes(`actual   ${digest}`), `${BUNDLE} actual digest missing`);

  await rm(root, { recursive: true, force: true });
});

test('release installer reports the packaged plugin it verified', { timeout: 600_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-release-install-'));
  const { installation, packageDigest } = await install(root, quotedTarget(root));

  assert.ok(installation.stdout.includes(PACKAGE_ASSET), `${PACKAGE_ASSET} was not reported`);
  assert.ok(installation.stdout.includes(`expected ${packageDigest}`), `${PACKAGE_ASSET} expected digest missing`);
  assert.ok(installation.stdout.includes(`actual   ${packageDigest}`), `${PACKAGE_ASSET} actual digest missing`);

  await rm(root, { recursive: true, force: true });
});

test('the release manifest records the release identity and the installed package digest', { timeout: 600_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-release-install-'));
  const target = quotedTarget(root);
  const { packageDigest } = await install(root, target);

  assert.deepEqual(await manifestOf(target), {
    schema: 1,
    source: 'release',
    release: TAG,
    package: PACKAGE_ASSET,
    sha256: packageDigest,
    node: process.versions.node,
    harness: '0.2.1-rc.2',
    workingTreeMayContainChanges: false,
  });

  await rm(root, { recursive: true, force: true });
});

test('the prepared profile reports a missing store through its auth helper', { timeout: 600_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-release-install-'));
  const target = quotedTarget(root);

  await install(root, target);
  const diagnosis = doctorOf(target);

  assert.equal(diagnosis.status, 1);
  assert.equal(JSON.parse(diagnosis.stdout).store, 'missing');

  await rm(root, { recursive: true, force: true });
});

test('the release installer creates no credential directory', { timeout: 600_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-release-install-'));
  const target = quotedTarget(root);

  await install(root, target);

  await assert.rejects(access(join(target, 'home/.dsh-codex-subscription-bridge')), { code: 'ENOENT' });

  await rm(root, { recursive: true, force: true });
});

test('the prepared profile composes the bridge against the pinned runtime', { timeout: 600_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-release-install-'));
  const target = quotedTarget(root);

  await install(root, target);
  const config = execFileSync(process.execPath, [join(target, 'runtime/node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'subscription-web', '--dump-config'], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { HOME: join(target, 'home'), DSH_HOME: join(target, 'harness'), PATH: '/usr/bin:/bin' },
  });

  assert.ok(config.includes('llm-codex-subscription'));

  await rm(root, { recursive: true, force: true });
});

test('release installer refuses to use an existing destination', { timeout: 600_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-release-install-'));
  const target = quotedTarget(root);
  const { release } = await publishSyntheticRelease(root);
  runInstaller(release, target);

  const second = runInstaller(release, target);

  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /refusing to use an existing destination/u);

  await rm(root, { recursive: true, force: true });
});

test('a refused destination is left unchanged', { timeout: 600_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-release-install-'));
  const target = quotedTarget(root);
  const { release } = await publishSyntheticRelease(root);
  runInstaller(release, target);
  const snapshot = await readFile(join(target, 'manifest.json'), 'utf8');

  runInstaller(release, target);

  assert.equal(await readFile(join(target, 'manifest.json'), 'utf8'), snapshot);

  await rm(root, { recursive: true, force: true });
});

test('release installer refuses a tampered bundle', { timeout: 180_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-release-tamper-'));
  const target = join(root, 'profile-target');

  const { installation } = await install(root, target, [], { corrupt: true });

  assert.notEqual(installation.status, 0);
  assert.match(installation.stderr, /does not match the published checksum/u);

  await rm(root, { recursive: true, force: true });
});

test('a refused bundle leaves no profile behind', { timeout: 180_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-release-tamper-'));
  const target = join(root, 'profile-target');

  await install(root, target, [], { corrupt: true });

  await assert.rejects(access(target), { code: 'ENOENT' });

  await rm(root, { recursive: true, force: true });
});

test('release installer refuses a bundle missing from the checksums file', { timeout: 180_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-release-unlisted-'));
  const target = join(root, 'profile-target');
  const { release, digest } = await publishSyntheticRelease(root);
  await writeFile(join(release, 'SHA256SUMS'), `${digest}  some-other-package-0.0.0.tgz\n`);

  const installation = runInstaller(release, target);

  assert.notEqual(installation.status, 0);
  assert.match(installation.stderr, /is not listed in SHA256SUMS/u);

  await rm(root, { recursive: true, force: true });
});

test('a bundle missing from the checksums file leaves no profile behind', { timeout: 180_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-release-unlisted-'));
  const target = join(root, 'profile-target');
  const { release, digest } = await publishSyntheticRelease(root);
  await writeFile(join(release, 'SHA256SUMS'), `${digest}  some-other-package-0.0.0.tgz\n`);

  runInstaller(release, target);

  await assert.rejects(access(target), { code: 'ENOENT' });

  await rm(root, { recursive: true, force: true });
});

test('release installer refuses a bundle whose packaged plugin is unlisted', { timeout: 180_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-release-inner-'));
  const target = join(root, 'profile-target');
  const { release, digest } = await publishSyntheticRelease(root);
  await writeFile(join(release, 'SHA256SUMS'), `${digest}  ${BUNDLE}\n`);

  const installation = runInstaller(release, target);

  assert.notEqual(installation.status, 0);
  assert.match(installation.stderr, /is not listed in SHA256SUMS/u);

  await rm(root, { recursive: true, force: true });
});

test('a bundle whose packaged plugin is unlisted leaves no profile behind', { timeout: 180_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-release-inner-'));
  const target = join(root, 'profile-target');
  const { release, digest } = await publishSyntheticRelease(root);
  await writeFile(join(release, 'SHA256SUMS'), `${digest}  ${BUNDLE}\n`);

  runInstaller(release, target);

  await assert.rejects(access(target), { code: 'ENOENT' });

  await rm(root, { recursive: true, force: true });
});

test('release installer refuses malformed input as a usage error', { timeout: 180_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-release-inputs-'));
  const target = join(root, 'profile-target');
  const { release } = await publishSyntheticRelease(root);
  const environment = { ...process.env, DSH_INSTALL_SOURCE: `file://${release}` };
  const run = (arguments_, env = environment) => spawnSync('/bin/sh', [installer, ...arguments_], { encoding: 'utf8', env });

  for (const arguments_ of [
    ['--tag', TAG],
    ['--tag', 'main', '--directory', target],
    ['--tag', TAG, '--directory', 'relative/path'],
    ['--tag', TAG, '--directory', target, '--extra'],
  ]) assert.equal(run(arguments_).status, 2);

  await rm(root, { recursive: true, force: true });
});

test('release installer answers help without any arguments', { timeout: 180_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-release-inputs-'));
  const { release } = await publishSyntheticRelease(root);
  const environment = { ...process.env, DSH_INSTALL_SOURCE: `file://${release}` };

  assert.equal(spawnSync('/bin/sh', [installer, '--help'], { encoding: 'utf8', env: environment }).status, 0);

  await rm(root, { recursive: true, force: true });
});

test('release installer refuses an unreviewed transport before downloading', { timeout: 180_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-release-inputs-'));
  const target = join(root, 'profile-target');

  const transport = spawnSync('/bin/sh', [installer, '--tag', TAG, '--directory', target], {
    encoding: 'utf8',
    env: { ...process.env, DSH_INSTALL_SOURCE: 'http://mirror.example/release' },
  });

  assert.equal(transport.status, 2);
  assert.match(transport.stderr, /must be an https origin or a file:\/\/ directory/u);

  await rm(root, { recursive: true, force: true });
});

test('a refused transport creates no destination', { timeout: 180_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-release-inputs-'));
  const target = join(root, 'profile-target');

  spawnSync('/bin/sh', [installer, '--tag', TAG, '--directory', target], {
    encoding: 'utf8',
    env: { ...process.env, DSH_INSTALL_SOURCE: 'http://mirror.example/release' },
  });

  await assert.rejects(access(target), { code: 'ENOENT' });

  await rm(root, { recursive: true, force: true });
});

test('release installer reports success for the Desktop surface', { timeout: 600_000, skip: desktopSkip }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-release-desktop-'));

  const { installation } = await install(root, join(root, 'desktop-profile'), ['--surface', 'desktop']);

  assert.equal(installation.status, 0, installation.stderr);

  await rm(root, { recursive: true, force: true });
});

test('the Desktop manifest records the Desktop surface', { timeout: 600_000, skip: desktopSkip }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-release-desktop-'));
  const { target } = await install(root, join(root, 'desktop-profile'), ['--surface', 'desktop']);

  assert.equal((await manifestOf(target)).surface, 'desktop');

  await rm(root, { recursive: true, force: true });
});

test('the Desktop manifest records the verified host pair', { timeout: 600_000, skip: desktopSkip }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-release-desktop-'));
  const { target } = await install(root, join(root, 'desktop-profile'), ['--surface', 'desktop']);

  const recorded = await manifestOf(target);

  assert.equal(recorded.electron, '44.7.0');
  assert.equal(recorded.hostNode, '24.21.0');

  await rm(root, { recursive: true, force: true });
});

test('the Desktop manifest records the release tag it installed', { timeout: 600_000, skip: desktopSkip }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-release-desktop-'));
  const { target } = await install(root, join(root, 'desktop-profile'), ['--surface', 'desktop']);

  assert.equal((await manifestOf(target)).release, TAG);

  await rm(root, { recursive: true, force: true });
});

test('the Desktop manifest records the digest of the package it installed', { timeout: 600_000, skip: desktopSkip }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-release-desktop-'));
  const { target, packageDigest } = await install(root, join(root, 'desktop-profile'), ['--surface', 'desktop']);

  assert.equal((await manifestOf(target)).sha256, packageDigest);

  await rm(root, { recursive: true, force: true });
});

test('the Desktop manifest states that no working tree contributed', { timeout: 600_000, skip: desktopSkip }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-release-desktop-'));
  const { target } = await install(root, join(root, 'desktop-profile'), ['--surface', 'desktop']);

  assert.equal((await manifestOf(target)).workingTreeMayContainChanges, false);

  await rm(root, { recursive: true, force: true });
});

test('the Desktop installer creates the profile directory', { timeout: 600_000, skip: desktopSkip }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-release-desktop-'));
  const { target } = await install(root, join(root, 'desktop-profile'), ['--surface', 'desktop']);

  assert.ok(await stat(join(target, 'harness/profiles/desktop')));

  await rm(root, { recursive: true, force: true });
});

test('the Desktop profile lists the web application bundle', { timeout: 600_000, skip: desktopSkip }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-release-desktop-'));
  const { target } = await install(root, join(root, 'desktop-profile'), ['--surface', 'desktop']);

  const bundles = JSON.parse(await readFile(join(target, 'harness/profiles/desktop/package.json'), 'utf8')).dsh.profile.bundles;

  assert.deepEqual(bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-codex-subscription-bridge']);

  await rm(root, { recursive: true, force: true });
});

test('the Desktop profile has no standalone launcher', { timeout: 600_000, skip: desktopSkip }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-release-desktop-'));
  const { target } = await install(root, join(root, 'desktop-profile'), ['--surface', 'desktop']);

  await assert.rejects(access(join(target, 'start.sh')), { code: 'ENOENT' });

  await rm(root, { recursive: true, force: true });
});

test('the Desktop profile has no auth helper', { timeout: 600_000, skip: desktopSkip }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-release-desktop-'));
  const { target } = await install(root, join(root, 'desktop-profile'), ['--surface', 'desktop']);

  await assert.rejects(access(join(target, 'auth.sh')), { code: 'ENOENT' });

  await rm(root, { recursive: true, force: true });
});

test('the Desktop profile has no standalone runtime', { timeout: 600_000, skip: desktopSkip }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-release-desktop-'));
  const { target } = await install(root, join(root, 'desktop-profile'), ['--surface', 'desktop']);

  await assert.rejects(access(join(target, 'runtime')), { code: 'ENOENT' });

  await rm(root, { recursive: true, force: true });
});

test('the Desktop profile does not shadow the host cordis peer', { timeout: 600_000, skip: desktopSkip }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-release-desktop-'));
  const { target } = await install(root, join(root, 'desktop-profile'), ['--surface', 'desktop']);

  await assert.rejects(access(join(target, 'harness/profiles/desktop/node_modules/@deepseek-ai/cordis')), { code: 'ENOENT' });

  await rm(root, { recursive: true, force: true });
});

test('the Desktop profile does not shadow the host dsh-llm peer', { timeout: 600_000, skip: desktopSkip }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-release-desktop-'));
  const { target } = await install(root, join(root, 'desktop-profile'), ['--surface', 'desktop']);

  await assert.rejects(access(join(target, 'harness/profiles/desktop/node_modules/@deepseek-ai/dsh-llm')), { code: 'ENOENT' });

  await rm(root, { recursive: true, force: true });
});

test('the Desktop preparation creates no credential store', { timeout: 600_000, skip: desktopSkip }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-release-desktop-'));
  const { target } = await install(root, join(root, 'desktop-profile'), ['--surface', 'desktop']);

  await assert.rejects(access(join(target, 'harness/.dsh-codex-subscription-bridge')), { code: 'ENOENT' });

  await rm(root, { recursive: true, force: true });
});

test('Desktop loads the prepared profile through its own ASAR resolver', { timeout: 600_000, skip: desktopSkip }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-release-desktop-'));
  const { target } = await install(root, join(root, 'desktop-profile'), ['--surface', 'desktop']);

  const load = loadDesktopProfile(target);

  assert.equal(load.status, 0, load.stderr);
  assert.match(load.stdout, /RELEASE_DESKTOP_PROFILE_OK/u);

  await rm(root, { recursive: true, force: true });
});

test('the unauthenticated catalog read creates no grant', { timeout: 600_000, skip: desktopSkip }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-release-desktop-'));
  const { target } = await install(root, join(root, 'desktop-profile'), ['--surface', 'desktop']);

  loadDesktopProfile(target);

  await assert.rejects(access(join(target, 'harness/.dsh-codex-subscription-bridge/auth.json')), { code: 'ENOENT' });

  await rm(root, { recursive: true, force: true });
});
