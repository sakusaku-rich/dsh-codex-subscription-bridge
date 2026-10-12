import { mkdir, rm, readFile, writeFile, copyFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { isAbsolute, join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { assertNodeVersion, assertPlatform } from '../src/runtime.js';

assertNodeVersion(); assertPlatform();

// The installer bundle is a separate release asset from the published npm
// package: the package stays minimal (it ships no development tooling), while
// the bundle carries exactly what `install.sh` needs to prepare a profile.
const usage = 'Run node scripts/build-release-asset.mjs --tag <vX.Y.Z> --directory <absolute output directory>. Its parent must exist.';
const flags = ['--tag', '--directory'];
const args = process.argv.slice(2);
if (args.length !== flags.length * 2 || flags.some((flag, index) => args[index * 2] !== flag)) throw new Error(usage);
const [, tag, , outputDirectory] = args;
if (!isAbsolute(outputDirectory ?? '') || /[\x00\r\n]/u.test(outputDirectory)) throw new Error(`--directory must be an absolute path. ${usage}`);
const npmCli = process.env.npm_execpath;
if (!isAbsolute(npmCli ?? '')) throw new Error('Run this script through npm so the pinned package manager is used.');
if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(tag)) throw new Error(`--tag must look like v1.2.3. ${usage}`);

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
// The version baked into the plugin must match the release tag, so a tagged
// release can never carry a package whose own version disagrees with it.
const manifest = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'));
const expectedVersion = tag.slice(1);
if (manifest.version !== expectedVersion) throw new Error(`package.json version ${manifest.version} does not match tag ${tag}.`);
const pluginName = manifest.name;
const pluginAsset = `${pluginName}-${expectedVersion}.tgz`;

await stat(dirname(outputDirectory));
try { await stat(outputDirectory); throw new Error(`Refusing to use an existing output directory: ${outputDirectory}`); } catch (error) {
  if (error.message.startsWith('Refusing')) throw error;
  if (error.code !== 'ENOENT') throw error;
}
await mkdir(outputDirectory, { mode: 0o700 });
const staging = join(outputDirectory, 'bundle');
await mkdir(staging, { mode: 0o700 });

// The plugin tarball is the reviewed npm pack output for this version.
const packed = JSON.parse(execFileSync(process.execPath, [
  npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', staging, '--cache', join(outputDirectory, 'cache'),
], { cwd: repo, encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }))[0];
if (packed.filename !== pluginAsset) throw new Error(`npm pack produced ${packed.filename}, expected ${pluginAsset}.`);
// The published package deliberately excludes development tooling; assert it so
// the bundle never becomes a way to smuggle those files into distribution.
if (packed.files.some((file) => /^(assets|test|scripts|verification)\//u.test(file.path))) {
  throw new Error('The published package unexpectedly contains development tooling.');
}

// Only the release-relevant sources are copied into the bundle. `install.sh`
// runs before any package is installed, so the prepare script and its two
// shared modules must be present in the bundle itself; `src/runtime.js` is the
// Node/platform gate and `src/errors.js` supplies the fixed error codes.
await mkdir(join(staging, 'scripts/lib'), { recursive: true, mode: 0o700 });
await mkdir(join(staging, 'src'), { recursive: true, mode: 0o700 });
for (const [source, destination] of [
  ['install.sh', join(staging, 'install.sh')],
  ['scripts/prepare-release-profile.mjs', join(staging, 'scripts/prepare-release-profile.mjs')],
  ['scripts/lib/release.mjs', join(staging, 'scripts/lib/release.mjs')],
  ['src/runtime.js', join(staging, 'src/runtime.js')],
  ['src/errors.js', join(staging, 'src/errors.js')],
]) await copyFile(join(repo, source), destination);
await writeFile(join(staging, 'README.md'), releaseNotes(tag, pluginAsset));

// `tar` with fixed flags keeps the archive byte-reproducible for the same
// inputs, so a rebuilt bundle can be compared with the published one.
const bundleAsset = `${pluginName}-installer-${expectedVersion}.tgz`;
execFileSync('/usr/bin/tar', ['--format=ustar', '--owner=0', '--group=0', '--numeric-owner', '-czf', join(outputDirectory, bundleAsset), '-C', staging, '.'], { timeout: 60_000 });

const digests = [];
// The plugin package is published as its own release asset as well, so the
// artifact inside the bundle can be compared against the released package.
await copyFile(join(staging, pluginAsset), join(outputDirectory, pluginAsset));

for (const [asset, source] of [[bundleAsset, join(outputDirectory, bundleAsset)], [pluginAsset, join(outputDirectory, pluginAsset)]]) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(source)) hash.update(chunk);
  digests.push(`${hash.digest('hex')}  ${asset}`);
}
await rm(staging, { recursive: true, force: true });
await writeFile(join(outputDirectory, 'SHA256SUMS'), `${digests.join('\n')}\n`);

console.log(`Release ${tag} prepared in ${outputDirectory}:\n${digests.join('\n')}\nAttach install.sh, ${bundleAsset}, ${pluginAsset} and SHA256SUMS to the release.`);

/** Human-readable release notes shipped inside the bundle for the installing user. */
function releaseNotes(tag, pluginAsset) {
  return `# ${tag} installer bundle\n\n` +
    `This archive is the release asset that \`install.sh\` downloads. It contains:\n\n` +
    `- \`install.sh\` — the reviewed one-command installer.\n` +
    `- \`scripts/prepare-release-profile.mjs\` — prepares the isolated profile.\n` +
    `- \`scripts/lib/release.mjs\` — the checksum and release-name guards.\n` +
    `- \`${pluginAsset}\` — the published plugin package, the artifact that is installed.\n\n` +
    `Verify the bundle against the release \`SHA256SUMS\` before unpacking it. See\n` +
    `docs/INSTALL.md in the ${tag} source tree for the full procedure.\n`;
}
