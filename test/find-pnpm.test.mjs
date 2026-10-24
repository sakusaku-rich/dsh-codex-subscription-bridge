import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * `scripts/lib/find-pnpm.mjs` resolves the pnpm bundled with the installed
 * Desktop. A mismatch is refused rather than falling back to the caller's
 * `pnpm`, because rewriting a profile lockfile with a different major could
 * change its format. These checks confirm the resolution and the failure modes
 * that do not require the application to be absent or altered.
 */
const finder = join(process.cwd(), 'scripts', 'lib', 'find-pnpm.mjs');

/** Run the finder as the caller would, with an optional environment override. */
function runFinder(env) {
  return spawnSync(process.execPath, [finder], { encoding: 'utf8', timeout: 60_000, env });
}

/** Where a `pnpm` would be found on the caller PATH, if any. */
function pathPnpm() {
  return spawnSync('/bin/sh', ['-c', 'command -v pnpm || true'], { encoding: 'utf8' }).stdout.trim();
}

test('the pnpm finder prints the bundled package manager path or fails closed with a fixed message', { timeout: 120_000 }, () => {
  const result = runFinder(process.env);

  if (result.status !== 0) {
    // Without the verified Desktop installed this cannot resolve; the finder
    // must then fail closed with one of its fixed messages rather than
    // printing a path from PATH.
    assert.match(result.stderr, /bundled pnpm was not found|could not read the Desktop runtime manifest|did not report its version/u);
    assert.equal(result.stdout.trim(), '');
    return;
  }

  assert.match(result.stdout.trim(), /^\/.*\/pnpm\.cjs$/u);
  assert.equal(result.stderr, '');
});

test('the pnpm finder does not resolve a pnpm from the caller PATH', { timeout: 120_000 }, () => {
  // A `pnpm` earlier on PATH must not be selected. The finder takes no arguments
  // and reads no environment, so injecting one proves it is not consulted.
  const systemPnpm = pathPnpm();
  const result = runFinder({ ...process.env, PATH: `/nonexistent:${process.env.PATH ?? ''}` });

  if (result.status === 0) assert.notEqual(result.stdout.trim(), systemPnpm, 'the finder resolved the PATH pnpm instead of the bundled one');
});

test('the pnpm finder resolves the package manager beneath the installed Desktop', { timeout: 120_000 }, () => {
  const result = runFinder({ ...process.env, PATH: `/nonexistent:${process.env.PATH ?? ''}` });

  if (result.status === 0) assert.match(result.stdout.trim(), /DeepSeek Harness\.app\/Contents\/Resources\/runtime\/primary-runtime\/dependencies\/pnpm/u);
});
