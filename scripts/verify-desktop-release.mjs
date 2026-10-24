import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertNodeVersion, assertPlatform } from '../lib/runtime.js';

/**
 * Load a prepared Desktop profile through the installed application's own ASAR
 * resolver and assert the bridge registers. This is the path the application
 * uses; it starts no GUI, performs no login, and contacts no service.
 *
 * Run it with the installed Electron binary and ELECTRON_RUN_AS_NODE=1, because
 * only that runtime resolves the host peers from the application tree.
 */
assertNodeVersion(); assertPlatform();
const [root] = process.argv.slice(2);
if (root === undefined) throw new Error('Usage: ELECTRON_RUN_AS_NODE=1 <Desktop executable> scripts/verify-desktop-release.mjs <prepared directory>');

const runtime = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh';
const host = (name) => import(pathToFileURL(join(runtime, 'node_modules/@deepseek-ai', name, 'lib/index.js')).href);
const { runProfile } = await import(pathToFileURL(join(runtime, 'node_modules/@deepseek-ai/dsh/lib/profile-boot.js')).href);
const { loadProfileDirectory } = await host('dsh-app-boot');
const { createLaunchEnvironmentSnapshot } = await host('dsh-launch-environment');

// The profile's own generated HOME/DSH_HOME select its isolated store.
process.env.HOME = join(root, 'home');
process.env.DSH_HOME = join(root, 'harness');
process.env.DSH_TELEMETRY_DISABLED = 'true';
const profile = join(root, 'harness/profiles/desktop');
const anchor = join(runtime, 'node_modules/@deepseek-ai/dsh/package.json');
const { ctx, shutdown } = await runProfile({
  environment: createLaunchEnvironmentSnapshot([{ source: 'process', values: process.env }]),
  profile: 'desktop',
  resolvedProfile: { profile: loadProfileDirectory('dsh', profile, anchor), installAnchor: anchor },
  patchFiles: [],
  args: [],
});
await ctx.get('loader').await();
const providers = ctx.llm.listProviders();
assert.ok(providers.some((item) => item.id === 'codex-subscription'), 'the bridge provider did not register');
// The Desktop host reads `ctx.connection.authenticatedUrl` and `ctx.webServer`
// while booting, before any profile is served. Assert both exist, because a
// profile missing the bundle that provides them fails exactly there.
assert.equal(typeof ctx.connection?.authenticatedUrl, 'function', 'the profile did not provide ctx.connection');
assert.ok(Number.isSafeInteger(ctx.webServer?.port), 'the profile did not provide ctx.webServer');
assert.ok(ctx.connection.authenticatedUrl(`http://127.0.0.1:${String(ctx.webServer.port)}`).includes('token='), 'the authenticated url was not produced');
// An unauthenticated catalog read is the expected refusal for a signed-out
// profile, which also proves the store was not created by preparation.
await assert.rejects(ctx.llm.listModels('codex-subscription'), { code: 'AUTH_REQUIRED' });
await shutdown.shutdown(0);
console.log(`RELEASE_DESKTOP_PROFILE_OK providers=${providers.length} connection=present webServer=present realAccount=not tested`);
