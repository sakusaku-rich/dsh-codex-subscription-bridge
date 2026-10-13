import { mkdir, readFile, writeFile, symlink, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { isAbsolute, join, dirname, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { assertNodeVersion, assertPlatform } from '../src/runtime.js';
import { assetName, createDigest, digestMatches, expectedDigest, parseChecksums, releaseTag, sha256Hex } from './lib/release.mjs';

assertNodeVersion(); assertPlatform();

const HARNESS_VERSION = '0.2.0-rc.2';
const PLUGIN_NAME = 'dsh-codex-subscription-bridge';
// The verification baseline is a fixed leaf set. `overrides` in this script
// pins the same security-fixed versions the committed verification runtime uses.
const LEAF_VERSIONS = [['@modelcontextprotocol/client', '2.2.0'], ['@modelcontextprotocol/core', '2.2.0'], ['fflate', '0.8.3']];
const INSTALL_TIMEOUT = 300_000;

const usage = 'Run node scripts/prepare-release-profile.mjs --directory <absolute new directory> --artifact <downloaded tgz> --checksums <downloaded SHA256SUMS> --tag <vX.Y.Z> --npm-cli <absolute npm-cli.js> --surface <web|desktop>. Its parent must exist.';
const flags = ['--directory', '--artifact', '--checksums', '--tag', '--npm-cli', '--surface'];
const args = process.argv.slice(2);
if (args.length !== flags.length * 2 || flags.some((flag, index) => args[index * 2] !== flag)) throw new Error(usage);
const [, root, , artifactPath, , checksumsPath, , tag, , npmCli, , surface] = args;
// The npm CLI entry point is passed explicitly rather than read from the
// environment: `npm_execpath` is absent when the installer invokes this script
// with a bare Node binary, and a guessed package manager is not reviewable.
for (const [label, value] of [['--directory', root], ['--artifact', artifactPath], ['--checksums', checksumsPath], ['--npm-cli', npmCli]]) {
  if (!isAbsolute(value ?? '') || /[\x00\r\n]/u.test(value)) throw new Error(`${label} must be an absolute path. ${usage}`);
}
const npmStat = await stat(npmCli);
if (!npmStat.isFile()) throw new Error('--npm-cli must name the npm CLI entry point file.');
// The surface selects two different verified hosts. `web` runs the pinned
// standalone runtime; `desktop` uses the installed application's Electron host
// and takes its exact peers from the app's ASAR tree instead of a runtime copy.
if (surface !== 'web' && surface !== 'desktop') throw new Error(`--surface must be web or desktop. ${usage}`);
const desktop = surface === 'desktop' ? await installedDesktop() : undefined;
// The tag is recorded in the manifest, so it is normalized to a fixed release
// tag shape rather than copied as caller-supplied text.
const release = releaseTag(tag);

// The artifact must be a regular file, and its name must be a publishable asset
// name so a caller cannot point the installer at an arbitrary local path.
const artifact = assetName(basename(artifactPath));
const artifactStat = await stat(artifactPath);
if (!artifactStat.isFile()) throw new Error('The downloaded release artifact must be a regular file.');

// Verify the artifact against the published checksums before any unpacking or
// execution. The digest is computed by streaming, so an oversized or unexpected
// artifact is never buffered whole.
const published = parseChecksums(await readFile(checksumsPath, 'utf8'));
const expected = expectedDigest(published, artifact);
const hash = createDigest();
for await (const chunk of createReadStream(artifactPath)) hash.update(chunk);
const actual = hash.digest('hex');
if (!digestMatches(actual, expected)) throw new Error(`Refusing to install ${artifact}: the downloaded file does not match the published SHA-256 checksum.`);

// Never overwrite an existing profile or copy the caller's HOME/authentication.
// The Desktop profile uses the same name the source Desktop installer uses, so
// the app selects it by profile name exactly as the verified flow does.
await mkdir(root, { mode: 0o700 });
const home = join(root, 'home');
const harness = join(root, 'harness');
const profileName = desktop === undefined ? 'subscription-web' : 'desktop';
const profile = join(harness, 'profiles', profileName);
const directories = [home, profile, join(root, 'workspace'), join(root, 'cache'), join(root, 'xdg')];
// The standalone Web surface also needs the pinned runtime tree it launches from.
if (desktop === undefined) directories.push(join(root, 'runtime'));
for (const path of directories) {
  await mkdir(path, { recursive: true, mode: 0o700 });
}
const env = {
  HOME: home, DSH_HOME: harness, XDG_CONFIG_HOME: join(root, 'xdg'), XDG_CACHE_HOME: join(root, 'cache'),
  LANG: 'C.UTF-8', PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
  DSH_TELEMETRY_DISABLED: 'true', DSH_PRIMARY_RUNTIME: '',
};

// The pinned Harness runtime is fetched with lifecycle scripts disabled. The
// lockfile cannot be shipped for a moving registry, so integrity here rests on
// the exact version pins plus npm's own published integrity metadata. A Desktop
// profile skips this: its host and peers come from the installed application,
// whose exact pair was verified before the download was unpacked.
const runtimeModules = join(root, 'runtime/node_modules');
if (desktop === undefined) {
  await writeFile(join(root, 'runtime/package.json'), JSON.stringify({
    name: 'dsh-bridge-release-runtime', version: '0.0.0', private: true, type: 'module',
    dependencies: { '@deepseek-ai/dsh': HARNESS_VERSION },
    overrides: Object.fromEntries(LEAF_VERSIONS),
    engines: { node: '>=22.23.3 <23' },
  }, null, 2));
  execFileSync(process.execPath, [npmCli, 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', join(root, 'cache')], {
    cwd: join(root, 'runtime'), env, stdio: 'pipe', timeout: INSTALL_TIMEOUT,
  });
  // Every pinned package is asserted after resolution, so a registry change that
  // silently drifts off the verified leaf versions stops the install instead of
  // producing a profile that was never verified.
  for (const [name, version] of [['@deepseek-ai/dsh', HARNESS_VERSION], ...LEAF_VERSIONS]) {
    const manifest = JSON.parse(await readFile(join(runtimeModules, name, 'package.json'), 'utf8'));
    if (manifest.version !== version) throw new Error(`The resolved ${name} does not match the pinned ${version}.`);
  }
}

// Install the already-verified plugin artifact from the local file, offline, so
// no network fetch can substitute a different package for the reviewed one.
// Both surfaces list the web application bundle: the Desktop host boots through
// `ctx.connection` and `ctx.webServer`, which that bundle provides, so omitting
// it makes the Desktop host fail during startup before any profile loads.
await writeFile(join(profile, 'package.json'), JSON.stringify({
  private: true, type: 'module',
  dependencies: { [PLUGIN_NAME]: `file:${artifactPath}` },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', PLUGIN_NAME] } },
}, null, 2));
execFileSync(process.execPath, [npmCli, 'install', '--ignore-scripts', '--offline', '--legacy-peer-deps', '--no-audit', '--no-fund', '--cache', join(root, 'cache')], {
  cwd: profile, env, stdio: 'pipe', timeout: INSTALL_TIMEOUT,
});

// The pinned peers come from the verified runtime tree, exactly as the source
// installer wires them, so the profile composes against one reviewed copy. The
// Desktop host instead supplies its own exact peers from the application's ASAR
// tree, so the runtime peers must be absent rather than shadowing them.
await mkdir(join(profile, 'node_modules/@deepseek-ai'), { recursive: true, mode: 0o700 });
for (const name of ['cordis', 'dsh-llm']) {
  const link = join(profile, 'node_modules/@deepseek-ai', name);
  if (desktop === undefined) await symlink(join(runtimeModules, '@deepseek-ai', name), link);
}
await writeFile(join(profile, 'cordis.patch.yml'), '- id: hmr\n  disabled: true\n- id: llm-codex-subscription\n  config: {}\n');

const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
// The Desktop launcher uses the installed application's environment, which
// supplies its own PATH; the standalone one reuses the prepared runtime's Node.
const launchEnv = desktop === undefined ? env : { ...env, PATH: '/usr/bin:/bin' };
const environment = Object.entries(launchEnv).map(([key, value]) => `${key}=${quote(value)}`).join(' ');
const authPath = quote(join(profile, `node_modules/${PLUGIN_NAME}/src/auth-cli.js`));
if (desktop === undefined) {
  const node = quote(process.execPath);
  await writeFile(join(root, 'auth.sh'), `#!/bin/sh\nexec env -i ${environment} ${node} ${authPath} "$@"\n`, { mode: 0o700 });
  await writeFile(join(root, 'start.sh'), `#!/bin/sh\ncd ${quote(join(root, 'workspace'))} || exit 1\nexec env -i ${environment} ${node} ${quote(join(runtimeModules, '@deepseek-ai/dsh/lib/bin.js'))} --profile subscription-web --host 127.0.0.1 --port 0 --no-open\n`, { mode: 0o700 });
} else {
  const executable = quote(desktop.executable);
  await writeFile(join(root, 'auth.sh'), `#!/bin/sh\nexec env -i ${environment} ELECTRON_RUN_AS_NODE=1 ${executable} ${authPath} "$@"\n`, { mode: 0o700 });
  await writeFile(join(root, 'desktop.sh'), `#!/bin/sh\ncd ${quote(join(root, 'workspace'))} || exit 1\nexec env -i ${environment} ${executable}\n`, { mode: 0o700 });
}

// A released artifact has no working tree, so the honesty flag that the source
// installer sets to true is recorded false here and the release identity
// replaces the commit. The verified digest is recorded so the profile can be
// audited against the published checksum later. A Desktop profile additionally
// records the host pair it was prepared against, matching the source installer.
const host = desktop === undefined ? {} : {
  surface: 'desktop', desktop: desktop.version, electron: desktop.electron,
  hostNode: desktop.node, desktopBuildCommit: desktop.buildCommit,
};
await writeFile(join(root, 'manifest.json'), JSON.stringify({
  schema: 1, source: 'release', release, package: artifact, sha256: sha256Hex(actual),
  node: process.versions.node, harness: HARNESS_VERSION, workingTreeMayContainChanges: false, ...host,
}, null, 2));
const start = desktop === undefined
  ? `Start: sh ${quote(join(root, 'start.sh'))}\nAfter starting Web, sign in inside Settings -> ChatGPT subscription -> Log in.`
  : `Close all existing Desktop instances, then start: sh ${quote(join(root, 'desktop.sh'))}\nSign in inside Settings -> ChatGPT subscription -> Log in.`;
console.log(`Prepared an isolated ${desktop === undefined ? 'Web' : 'Desktop'} profile at ${root} from release ${release}.\n${start}\nDiagnose: sh ${quote(join(root, 'auth.sh'))} doctor\nThe auth helper remains optional for recovery.`);

/**
 * Facts about the installed DeepSeek Harness Desktop, verified before use. The
 * exact host pair is required: Desktop's resolver supplies the host peers, so a
 * different build was never verified with this plugin. Nothing here modifies
 * the application, and a mismatch refuses instead of being worked around.
 */
async function installedDesktop() {
  const app = '/Applications/DeepSeek Harness.app';
  const executable = join(app, 'Contents/MacOS/DeepSeek Harness');
  const resources = join(app, 'Contents/Resources');
  const modules = join(resources, 'app.asar/dsh/node_modules');
  const probe = `JSON.stringify({versions:process.versions,app:require(${JSON.stringify(join(resources, 'app.asar/package.json'))}),cordis:require(${JSON.stringify(join(modules, '@deepseek-ai/cordis/package.json'))}).version,llm:require(${JSON.stringify(join(modules, '@deepseek-ai/dsh-llm/package.json'))}).version})`;
  const facts = JSON.parse(execFileSync(executable, ['-p', probe], {
    env: { ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
  }));
  if (facts.app.version !== HARNESS_VERSION || facts.versions.electron !== '44.0.0' || facts.versions.node !== '24.18.1' ||
      facts.cordis !== '4.0.4' || facts.llm !== HARNESS_VERSION) {
    throw new Error('The installed Desktop does not match the verified host pair; refusing to prepare a Desktop profile.');
  }
  return { executable, version: facts.app.version, electron: facts.versions.electron, node: facts.versions.node, buildCommit: facts.app.dshBuildCommit };
}
