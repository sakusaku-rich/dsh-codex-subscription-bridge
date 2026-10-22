import { mkdir, readFile, writeFile, rename, copyFile, access, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { isAbsolute, join, dirname, basename, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { assertNodeVersion, assertPlatform } from '../src/runtime.js';
import { assetName, createDigest, digestMatches, expectedDigest, parseChecksums, releaseTag, sha256Hex } from './lib/release.mjs';

/**
 * Install the bridge into an existing Desktop profile.
 *
 * This is the non-isolated path: the profile is the application's own, so the
 * existing configuration and other plugins stay in place. Because a mistake
 * here damages a working environment, every mutation is staged behind a
 * backup and rolled back on failure, and the profile is refused rather than
 * modified when it does not look like a profile this script understands.
 */
assertNodeVersion(); assertPlatform();

const PLUGIN_NAME = 'dsh-codex-subscription-bridge';
const DESKTOP_APP = '/Applications/DeepSeek Harness.app';
const HARNESS_VERSION = '0.2.1-rc.2';
const CORDIS_VERSION = '4.0.5';
const DESKTOP_NODE = '24.21.0';
const DESKTOP_ELECTRON = '44.7.0';

const usage = 'Run node scripts/install-into-profile.mjs --profile <absolute profile directory> --artifact <downloaded tgz> --checksums <downloaded SHA256SUMS> --tag <vX.Y.Z> --pnpm-cli <absolute pnpm entry point>.';
const flags = ['--profile', '--artifact', '--checksums', '--tag', '--pnpm-cli'];
const args = process.argv.slice(2);
if (args.length !== flags.length * 2 || flags.some((flag, index) => args[index * 2] !== flag)) throw new Error(usage);
const [, profileArgument, , artifactPath, , checksumsPath, , tag, , pnpmCli] = args;
for (const [label, value] of [['--profile', profileArgument], ['--artifact', artifactPath], ['--checksums', checksumsPath], ['--pnpm-cli', pnpmCli]]) {
  if (!isAbsolute(value ?? '') || /[\x00\r\n]/u.test(value)) throw new Error(`${label} must be an absolute path. ${usage}`);
}
const release = releaseTag(tag);
const profile = resolve(profileArgument);

// The artifact is verified before anything is written, exactly as the isolated
// path does. Both the bundle and this package were checked by install.sh
// already; this repeats it so the script is safe to run on its own.
const artifact = assetName(basename(artifactPath));
if (!(await stat(artifactPath)).isFile()) throw new Error('The downloaded release artifact must be a regular file.');
const published = parseChecksums(await readFile(checksumsPath, 'utf8'));
const hash = createDigest();
for await (const chunk of createReadStream(artifactPath)) hash.update(chunk);
const actual = hash.digest('hex');
if (!digestMatches(actual, expectedDigest(published, artifact))) {
  throw new Error(`Refusing to install ${artifact}: it does not match the published SHA-256 checksum.`);
}

const desktop = await installedDesktop();

// A profile this script will modify must already look like a Desktop profile.
// Anything else is refused rather than normalised, because guessing at the
// intended shape risks the caller's working environment.
const manifestPath = join(profile, 'package.json');
try {
  await access(manifestPath);
} catch {
  throw new Error(`Refusing to modify ${profile}: it has no package.json, so it is not a prepared profile.`);
}
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('The profile package.json is not an object.');
const bundles = manifest.dsh?.profile?.bundles;
if (!Array.isArray(bundles) || !bundles.every((name) => typeof name === 'string')) {
  throw new Error('Refusing to modify the profile: it has no dsh.profile.bundles list to extend.');
}
const dependencies = manifest.dependencies;
if (dependencies === undefined ? false : (typeof dependencies !== 'object' || Array.isArray(dependencies))) {
  throw new Error('The profile dependency list is not an object.');
}
// Reinstalling over an existing entry would silently repoint it, so a profile
// that already lists the bridge is reported as already installed instead.
if (bundles.includes(PLUGIN_NAME) || (dependencies ?? {})[PLUGIN_NAME] !== undefined) {
  throw new Error(`The bridge is already listed in ${profile}. Remove it before installing a different version.`);
}

// Everything the pnpm run needs, without inheriting the caller's environment.
const env = {
  HOME: process.env.HOME ?? '', PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
  LANG: 'C.UTF-8', DSH_TELEMETRY_DISABLED: 'true',
  npm_config_ignore_scripts: 'true', CI: 'true',
};

const stamp = new Date().toISOString().replaceAll(/[:.]/gu, '-');
const backupDirectory = join(profile, `.bridge-backup-${stamp}`);
const touched = ['package.json', 'pnpm-lock.yaml'];

// Back up every file this script may rewrite, so a failure can restore the
// profile byte for byte instead of approximating its previous state.
await mkdir(backupDirectory, { mode: 0o700 });
const backedUp = [];
for (const name of touched) {
  const source = join(profile, name);
  try {
    await stat(source);
  } catch {
    continue;
  }
  await copyFile(source, join(backupDirectory, name));
  backedUp.push(name);
}

async function restore() {
  for (const name of backedUp) await copyFile(join(backupDirectory, name), join(profile, name));
  // A lockfile that did not exist before the run must not be left behind.
  if (!backedUp.includes('pnpm-lock.yaml')) {
    try { await rename(join(profile, 'pnpm-lock.yaml'), join(backupDirectory, 'pnpm-lock.yaml.rejected')); } catch {}
  }
}

const nextManifest = {
  ...manifest,
  dependencies: { ...(dependencies ?? {}), [PLUGIN_NAME]: `file:${artifactPath}` },
  dsh: { ...manifest.dsh, profile: { ...manifest.dsh.profile, bundles: [...bundles, PLUGIN_NAME] } },
};

try {
  await writeFile(manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`);
  execFileSync(process.execPath, [pnpmCli, 'install', '--ignore-scripts', '--no-frozen-lockfile', '--reporter', 'silent'], {
    cwd: profile, env, stdio: 'pipe', timeout: 300_000,
  });
} catch (error) {
  await restore();
  throw new Error(`Installing into ${profile} failed and the profile was restored: ${error instanceof Error ? error.message : String(error)}`);
}

// The bridge resolves its host peers from the application tree, so a copy in
// the profile would shadow them. Report the profile's own wiring either way.
const installedManifest = JSON.parse(await readFile(join(profile, 'node_modules', PLUGIN_NAME, 'package.json'), 'utf8'));
if (installedManifest.name !== PLUGIN_NAME) throw new Error('The installed package is not the bridge.');

const record = {
  schema: 1, source: 'release', release, package: artifact, sha256: sha256Hex(actual),
  profile, surface: 'desktop', desktop: desktop.version, electron: desktop.electron,
  hostNode: desktop.node, desktopBuildCommit: desktop.buildCommit, backup: basename(backupDirectory),
};
await writeFile(join(backupDirectory, 'installed.json'), `${JSON.stringify(record, null, 2)}\n`);

console.log(`Installed ${PLUGIN_NAME} ${installedManifest.version} into ${profile} from release ${release}.`);
console.log(`Restart the application to load it. The previous package.json and lockfile are kept in ${backupDirectory}.`);
console.log(`To undo: copy those files back over the profile and run the same pnpm install again.`);

/**
 * Facts about the installed Desktop. Its bundled pnpm is the package manager
 * the application itself uses; the system copy may be a different major, so
 * this refuses unless the installed application matches the verified pair.
 */
async function installedDesktop() {
  const executable = join(DESKTOP_APP, 'Contents/MacOS/DeepSeek Harness');
  const resources = join(DESKTOP_APP, 'Contents/Resources');
  const modules = join(resources, 'app.asar/dsh/node_modules');
  const probe = `JSON.stringify({versions:process.versions,app:require(${JSON.stringify(join(resources, 'app.asar/package.json'))}),cordis:require(${JSON.stringify(join(modules, '@deepseek-ai/cordis/package.json'))}).version,llm:require(${JSON.stringify(join(modules, '@deepseek-ai/dsh-llm/package.json'))}).version})`;
  const facts = JSON.parse(execFileSync(executable, ['-p', probe], {
    env: { ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
  }));
  if (facts.app.version !== HARNESS_VERSION || facts.versions.electron !== DESKTOP_ELECTRON || facts.versions.node !== DESKTOP_NODE ||
      facts.cordis !== CORDIS_VERSION || facts.llm !== HARNESS_VERSION) {
    throw new Error('The installed Desktop does not match the verified host pair; refusing to modify its profile.');
  }
  return { executable, version: facts.app.version, electron: facts.versions.electron, node: facts.versions.node, buildCommit: facts.app.dshBuildCommit };
}
