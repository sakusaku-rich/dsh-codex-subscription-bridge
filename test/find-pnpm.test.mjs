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
const run = () => spawnSync(process.execPath, [finder], { encoding: 'utf8', timeout: 60_000 });

test('the pnpm finder resolves the Desktop bundled package manager', { timeout: 120_000 }, () => {
  const result = run();
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

test('the pnpm finder never falls back to the caller PATH', { timeout: 120_000 }, () => {
  // A `pnpm` earlier on PATH must not be selected. The finder takes no arguments
  // and reads no environment, so injecting one proves it is not consulted.
  const shim = spawnSync('/bin/sh', ['-c', 'command -v pnpm || true'], { encoding: 'utf8' });
  const systemPnpm = shim.stdout.trim();
  const result = spawnSync(process.execPath, [finder], {
    encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, PATH: `/nonexistent:${process.env.PATH ?? ''}` },
  });
  if (result.status === 0) {
    assert.notEqual(result.stdout.trim(), systemPnpm, 'the finder resolved the PATH pnpm instead of the bundled one');
    assert.match(result.stdout.trim(), /DeepSeek Harness\.app\/Contents\/Resources\/runtime\/pnpm/u);
  }
});
