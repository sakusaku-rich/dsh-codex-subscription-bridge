import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
const runtime = join(dirname(dirname(process.execPath)), 'Resources/app.asar/dsh');
const host = name => import(pathToFileURL(join(runtime, 'node_modules/@deepseek-ai', name, 'lib/index.js')).href);
const { runProfile } = await import(pathToFileURL(join(runtime, 'node_modules/@deepseek-ai/dsh/lib/profile-boot.js')).href);
const { loadProfileDirectory } = await host('dsh-app-boot');
const { createLaunchEnvironmentSnapshot } = await host('dsh-launch-environment');
const root = await mkdtemp('/private/tmp/dsh-installed-desktop-');
try {
  const env = { HOME: root, DSH_HOME: root, ELECTRON_RUN_AS_NODE: '1', DSH_TELEMETRY_DISABLED: 'true', PATH: '/usr/bin:/bin' };
  const npmCli = process.env.npm_execpath;
  const cache = join(root, 'cache');
  const packed = JSON.parse(execFileSync(process.execPath, [npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', root, '--cache', cache], { env, encoding: 'utf8', timeout: 30000 }))[0];
  const profile = join(root, 'profiles/desktop'); await mkdir(profile, { recursive: true });
  await writeFile(join(profile, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: { 'dsh-codex-subscription-bridge': `file:${join(root, packed.filename)}` }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-codex-subscription-bridge'] } } }));
  await writeFile(join(profile, 'cordis.patch.yml'), '- id: hmr\n  disabled: true\n');
  execFileSync(process.execPath, [npmCli, 'install', '--ignore-scripts', '--offline', '--legacy-peer-deps', '--no-audit', '--no-fund', '--cache', cache], { cwd: profile, env, stdio: 'pipe', timeout: 30000 });
  Object.assign(process.env, env);
  const anchor = join(runtime, 'node_modules/@deepseek-ai/dsh/package.json');
  const { ctx, shutdown } = await runProfile({ environment: createLaunchEnvironmentSnapshot([{ source: 'process', values: process.env }]), profile: 'desktop', resolvedProfile: { profile: loadProfileDirectory('dsh', profile, anchor), installAnchor: anchor }, patchFiles: [], args: [] });
  await ctx.get('loader').await();
  assert.ok(ctx.llm.listProviders().some(item => item.id === 'codex-subscription'));
  const module = part => import(pathToFileURL(join(profile, 'node_modules/dsh-codex-subscription-bridge/lib', part + '.js')).href);
  const { AuthStore, authDirectory } = await module('auth'); const { Http } = await module('http');
  const store = new AuthStore(authDirectory(process.env));
  const token = 'x.' + Buffer.from(JSON.stringify({ exp: Date.now() / 1000 + 3600, 'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic' } })).toString('base64url') + '.x';
  await store.transaction(() => store.write({ access_token: token, refresh_token: 'synthetic' }));
  Http.prototype.open = async url => url.includes('/models?') ? Response.json({ models: [{ slug: 'synthetic', display_name: 'Synthetic', visibility: 'list' }] }) : new Response('data: ' + JSON.stringify({ type: 'response.output_text.delta', item_id: 'item', content_index: 0, delta: 'Synthetic' }) + '\n\ndata: ' + JSON.stringify({ type: 'response.completed', response: { status: 'completed' } }) + '\n\n');
  assert.equal((await ctx.llm.listModels('codex-subscription'))[0].id, 'synthetic');
  const chunks = [];
  for await (const chunk of ctx.llm.stream({ provider: 'codex-subscription', model: 'synthetic', messages: [{ role: 'user', content: [{ type: 'text', text: 'Synthetic prompt' }] }] })) chunks.push(chunk);
  assert.equal(chunks.at(-1).reason.kind, 'stop');
  // Exercise the authenticated carrier's exact Fetch seam used by Desktop IPC.
  // The 0.2.1-rc.2 handler resolves the caller's Peer instead of assuming one, so
  // the fixture supplies the owner principal the real admission would carry.
  const { HostConnectionService, Peer } = await host('dsh-client-connection');
  const connection = new HostConnectionService(ctx, [], { isAuthenticated: () => true });
  const peer = new Peer(ctx, { principal: { kind: 'owner' } });
  await new Promise(resolve => setImmediate(resolve));
  const endpoint = 'codex-subscription-auth/status';
  const request = new Request('http://127.0.0.1/api/' + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'fixture', method: endpoint, payload: { clientId: '11111111-1111-4111-8111-111111111111' } }) });
  const response = await connection.createSharedFetchHandler('/api').fetch(request, peer);
  const result = await response.json();
  assert.equal(result.result.ok, true); assert.equal(result.result.value.local.auth, 'stored');
  assert.equal(JSON.stringify(result).includes('synthetic'), false);
  await shutdown.shutdown(0);
  console.log('INSTALLED_DESKTOP_PACKAGED_PROFILE_OK (no real account operations)');
} finally { await rm(root, { recursive: true, force: true }); }
