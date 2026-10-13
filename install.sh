#!/bin/sh
# One-command install of the isolated ChatGPT subscription bridge profile.
#
# This file is published as a release asset and is meant to be read before it
# runs. It performs three visible steps and never pipes a download into a shell:
#   1. download the release installer bundle and its SHA256SUMS into a private
#      temporary directory
#   2. verify the bundle digest, unpack it, then verify the plugin package it
#      carries against the same manifest
#   3. run the unpacked prepare script against that verified plugin package
#
# It never touches a normal Harness profile, never reads Codex credentials, and
# installs with lifecycle scripts disabled throughout.
set -eu

TAG=""
DIRECTORY=""
SURFACE="web"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --tag) TAG="${2:-}"; shift 2 ;;
    --directory) DIRECTORY="${2:-}"; shift 2 ;;
    --surface) SURFACE="${2:-}"; shift 2 ;;
    -h|--help)
      cat <<'USAGE'
Usage: sh install.sh --tag <vX.Y.Z> --directory <absolute new directory> [--surface web|desktop]

Downloads the pinned release installer bundle for <vX.Y.Z>, verifies its
published SHA-256 checksum, and prepares an isolated signed-out Harness profile
in <absolute new directory>. The parent directory must already exist and the
destination must not. Sign-in happens afterwards inside Harness.

Options:
  --tag <vX.Y.Z>          The released tag to install. Required.
  --directory <path>      An absolute, not-yet-existing destination. Required.
  --surface <web|desktop> Which verified host to prepare for. Defaults to web.
                          Desktop requires the installed DeepSeek Harness
                          Desktop 0.2.0-rc.2 at /Applications and uses its own
                          Electron host; a different build is refused.

Environment:
  DSH_INSTALL_SOURCE   Override the download source for an offline or mirrored
                       install. Must be an https origin, or a file:// directory
                       that already contains the assets and SHA256SUMS. The
                       published checksum is enforced either way.
  DSH_INSTALL_ASSET    Override the bundle asset name. Defaults to the name
                       derived from --tag.
  TMPDIR               Where the private staging directory is created.
USAGE
      exit 0 ;;
    *) echo "install.sh: unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ -n "$TAG" ] || { echo "install.sh: --tag is required (for example --tag v0.1.0)" >&2; exit 2; }
[ -n "$DIRECTORY" ] || { echo "install.sh: --directory is required" >&2; exit 2; }
case "$SURFACE" in
  web|desktop) : ;;
  *) echo "install.sh: --surface must be web or desktop" >&2; exit 2 ;;
esac

case "$DIRECTORY" in
  /*) : ;;
  *) echo "install.sh: --directory must be an absolute path" >&2; exit 2 ;;
esac
[ ! -e "$DIRECTORY" ] || { echo "install.sh: refusing to use an existing destination: $DIRECTORY" >&2; exit 1; }
[ -d "$(dirname "$DIRECTORY")" ] || { echo "install.sh: the parent of --directory must already exist" >&2; exit 2; }

# A tag becomes a URL path segment and drives the default asset name, so it is
# held to the same v-prefixed semver shape the build and prepare scripts use.
case "$TAG" in
  v[0-9]*.[0-9]*.[0-9]*) : ;;
  *) echo "install.sh: --tag must look like v1.2.3" >&2; exit 2 ;;
esac
case "$TAG" in
  *[!0-9A-Za-z.+-]*) echo "install.sh: --tag contains unsupported characters" >&2; exit 2 ;;
esac
case "$TAG" in
  *..*) echo "install.sh: --tag contains an unsupported dot sequence" >&2; exit 2 ;;
esac

# Baseline checks run before the download so an unsupported host fails fast.
NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "install.sh: Node.js is required; install Node 22.23.3" >&2; exit 1; }
"$NODE" -e '
const version = process.versions.node;
const [major, minor, patch] = version.split(".").map(Number);
const ok = major === 22 && (minor > 23 || (minor === 23 && patch >= 3));
if (!ok) { console.error(`install.sh: Node ${version} is unsupported; use Node 22.23.3`); process.exit(1); }
'
[ "$(uname -s)" = "Darwin" ] || { echo "install.sh: macOS is the only supported platform" >&2; exit 1; }

# The pinned package manager is resolved up front: the prepare script refuses to
# run without an absolute npm CLI path, so a missing npm fails here rather than
# after the download. `npm` is a symlink to npm-cli.js, and resolving it gives
# the exact entry point npm itself reports in npm_execpath.
NPM_BIN="$(command -v npm || true)"
[ -n "$NPM_BIN" ] || { echo "install.sh: npm is required; install Node 22.23.3 with npm" >&2; exit 1; }
NPM_EXECPATH="$("$NODE" -e 'console.log(require("node:fs").realpathSync(process.argv[1]))' "$NPM_BIN")"
[ -f "$NPM_EXECPATH" ] || { echo "install.sh: could not resolve the npm CLI entry point from $NPM_BIN" >&2; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/dsh-bridge-install.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT INT TERM
chmod 700 "$WORK"

# The downloaded unit is the installer bundle for the released version, not the
# published npm package: the package stays minimal and ships no development
# tooling, while the bundle carries install.sh and the prepare script. The name
# is derived from the tag and can be overridden; the checksum lookup fails closed
# on any mismatch, so a wrong name stops the install instead of degrading it.
BUNDLE="${DSH_INSTALL_ASSET:-dsh-codex-subscription-bridge-installer-${TAG#v}.tgz}"
SOURCE="${DSH_INSTALL_SOURCE:-https://github.com/sakusaku-rich/dsh-codex-subscription-bridge/releases/download/$TAG}"
# Only the two reviewed transports are accepted. A plain path or an http origin
# would let a caller point the installer at an unverified mirror.
case "$SOURCE" in
  file://*|https://*) : ;;
  *) echo "install.sh: DSH_INSTALL_SOURCE must be an https origin or a file:// directory" >&2; exit 2 ;;
esac

# The downloader is written next to the downloads so the whole transfer path is
# inspectable. It refuses redirects, so a moved asset cannot change origin, and
# it handles the offline file:// mirror used by the synthetic install checks.
cat > "$WORK/fetch.mjs" <<'FETCH'
import { writeFile, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const [url, destination] = process.argv.slice(2);
if (url.startsWith('file://')) {
  await copyFile(fileURLToPath(url), destination);
} else {
  const response = await fetch(url, { redirect: 'error' });
  if (!response.ok) { console.error(`install.sh: download failed with HTTP ${response.status}`); process.exit(1); }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > 64 * 1024 * 1024) { console.error('install.sh: download was empty or oversized'); process.exit(1); }
  await writeFile(destination, bytes, { mode: 0o600 });
}
FETCH

download() {
  name="$1"
  "$NODE" "$WORK/fetch.mjs" "$SOURCE/$name" "$WORK/$name"
}

echo "Downloading $BUNDLE and its checksums from $SOURCE"
download "$BUNDLE"
download "SHA256SUMS"

# Verification is explicit and prints both digests, so the user can compare them
# against the release page before the artifact is used. Unpacking happens only
# after the digest matches, and the check itself is one inspectable file.
cat > "$WORK/verify.mjs" <<'VERIFY'
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
const [checksumsPath, assetPath, assetName] = process.argv.slice(2);
// Accept only the coreutils format this project publishes: one lowercase
// digest, two spaces, one bare asset name. Refuse a duplicate or malformed file
// rather than trusting part of it.
const entries = new Map();
for (const raw of (await readFile(checksumsPath, 'utf8')).split('\n')) {
  const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
  if (line === '') continue;
  const match = /^([0-9a-f]{64}) {2}([0-9A-Za-z][0-9A-Za-z._-]{0,127})$/u.exec(line);
  if (!match || entries.has(match[2])) { console.error('install.sh: SHA256SUMS is malformed; refusing to install'); process.exit(1); }
  entries.set(match[2], match[1]);
}
const expected = entries.get(assetName);
if (expected === undefined) { console.error(`install.sh: ${assetName} is not listed in SHA256SUMS; refusing to install`); process.exit(1); }
const hash = createHash('sha256');
for await (const chunk of createReadStream(assetPath)) hash.update(chunk);
const actual = hash.digest('hex');
console.log(`  ${assetName}`);
console.log(`    expected ${expected}`);
console.log(`    actual   ${actual}`);
if (actual !== expected) { console.error('install.sh: the downloaded artifact does not match the published checksum; refusing to install'); process.exit(1); }
VERIFY

echo "Verifying the published SHA-256 checksum"
"$NODE" "$WORK/verify.mjs" "$WORK/SHA256SUMS" "$WORK/$BUNDLE" "$BUNDLE"

# Refuse an archive that could escape the staging directory before extracting
# it: every member must be a regular file or directory, with no absolute path
# and no parent traversal.
cat > "$WORK/inspect.mjs" <<'INSPECT'
import { execFileSync } from 'node:child_process';
const [archive] = process.argv.slice(2);
const listing = execFileSync('/usr/bin/tar', ['-tzvf', archive], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
for (const line of listing.split('\n')) {
  if (line === '') continue;
  const kind = line[0];
  const name = line.split(/\s+/u).slice(8).join(' ');
  if (kind !== '-' && kind !== 'd') { console.error(`install.sh: the artifact contains a non-file entry (${kind}); refusing to install`); process.exit(1); }
  if (name.startsWith('/') || name.split('/').includes('..')) { console.error('install.sh: the artifact contains an unsafe path; refusing to install'); process.exit(1); }
}
INSPECT

"$NODE" "$WORK/inspect.mjs" "$WORK/$BUNDLE"

mkdir -p "$WORK/unpacked/package"
tar -xzf "$WORK/$BUNDLE" -C "$WORK/unpacked/package"
PREPARE="$WORK/unpacked/package/scripts/prepare-release-profile.mjs"
PLUGIN="$WORK/unpacked/package/dsh-codex-subscription-bridge-${TAG#v}.tgz"
[ -f "$PREPARE" ] || { echo "install.sh: the bundle does not contain scripts/prepare-release-profile.mjs" >&2; exit 1; }
[ -f "$PLUGIN" ] || { echo "install.sh: the bundle does not contain the plugin package for $TAG" >&2; exit 1; }

# The bundle is verified, and so is the plugin package inside it: the digest is
# checked against the same published manifest before it becomes the installed
# artifact, so a bundle cannot smuggle in a different package.
echo "Verifying the packaged plugin artifact"
"$NODE" "$WORK/verify.mjs" "$WORK/SHA256SUMS" "$PLUGIN" "$(basename "$PLUGIN")"

# The prepare script installs the pinned runtime and the verified artifact with
# lifecycle scripts disabled, then writes the profile, its manifest and its
# launchers. It receives the artifact we already verified, not a fresh download,
# and the resolved npm CLI path, so it never has to guess a package manager.
echo "Preparing the isolated $SURFACE profile at $DIRECTORY"
"$NODE" "$PREPARE" --directory "$DIRECTORY" --artifact "$PLUGIN" --checksums "$WORK/SHA256SUMS" --tag "$TAG" --npm-cli "$NPM_EXECPATH" --surface "$SURFACE"
