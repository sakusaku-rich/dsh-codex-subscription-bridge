import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { assertNodeVersion, assertPlatform } from '../../src/runtime.js';

/**
 * Resolve the pnpm entry point bundled with the installed Desktop.
 *
 * The application uses its own pinned pnpm, and the system copy may be a
 * different major, so a version mismatch could rewrite the profile's lockfile
 * in an incompatible format. This refuses rather than falling back to whatever
 * `pnpm` happens to be on the caller's PATH.
 *
 * Prints the resolved path and exits non-zero with a fixed message otherwise.
 */
assertNodeVersion(); assertPlatform();

const DESKTOP_APP = '/Applications/DeepSeek Harness.app';
const EXECUTABLE = join(DESKTOP_APP, 'Contents/MacOS/DeepSeek Harness');
const BUNDLED_PNPM = join(DESKTOP_APP, 'Contents/Resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.cjs');

try {
  await access(BUNDLED_PNPM);
} catch {
  console.error('install.sh: the bundled pnpm was not found beneath the installed Desktop; refusing to use another package manager');
  process.exit(1);
}

// The runtime manifest records the exact pnpm the application ships, so the
// resolved binary is checked against it instead of being trusted by path.
const runtimeManifest = join(DESKTOP_APP, 'Contents/Resources/app.asar/dsh/desktop-runtime.json');
let expected;
try {
  const probe = `JSON.stringify(require(${JSON.stringify(runtimeManifest)}).release)`;
  expected = JSON.parse(execFileSync(EXECUTABLE, ['-p', probe], {
    env: { ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
  }));
} catch {
  console.error('install.sh: could not read the Desktop runtime manifest; refusing to guess a package manager');
  process.exit(1);
}
if (typeof expected.pnpmVersion !== 'string' || !/^\d+\.\d+\.\d+$/u.test(expected.pnpmVersion)) {
  console.error('install.sh: the Desktop runtime manifest does not name a usable pnpm version');
  process.exit(1);
}

let actual;
try {
  actual = execFileSync(EXECUTABLE, [BUNDLED_PNPM, '--version'], {
    env: { ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
} catch {
  console.error('install.sh: the bundled pnpm did not report its version');
  process.exit(1);
}
if (actual !== expected.pnpmVersion) {
  console.error(`install.sh: the bundled pnpm reports ${actual} but the runtime manifest names ${expected.pnpmVersion}`);
  process.exit(1);
}
console.log(BUNDLED_PNPM);
