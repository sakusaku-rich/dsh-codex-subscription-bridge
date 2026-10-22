import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';

const cli = process.env.DSH_VERIFY_CLI;
const npmCli = process.env.npm_execpath;
if (!cli || !isAbsolute(cli) || !npmCli || !isAbsolute(npmCli)) throw new Error('Run through npm with an absolute DSH_VERIFY_CLI pointing to the pinned Harness lib/bin.js.');
const runtime = dirname(dirname(await realpath(cli)));
const modules = dirname(dirname(runtime));
const manifest = JSON.parse(await readFile(join(runtime, 'package.json'), 'utf8'));
assert.equal(manifest.name, '@deepseek-ai/dsh'); assert.equal(manifest.version, '0.2.1-rc.2');
for (const [name, version] of [['cordis', '4.0.5'], ['dsh-llm', '0.2.1-rc.2']]) {
  assert.equal(JSON.parse(await readFile(join(modules, '@deepseek-ai', name, 'package.json'), 'utf8')).version, version);
}
for (const [name, version] of [['@modelcontextprotocol/client', '2.3.1'], ['@modelcontextprotocol/core', '2.3.1'], ['fflate', '0.8.3']]) {
  assert.equal(JSON.parse(await readFile(join(modules, name, 'package.json'), 'utf8')).version, version, 'Use the locked security-fixed verification runtime.');
}
// The opt-in preset mirrors the pinned Harness composition, and this runtime is
// the one place that copy can be proven current before a profile is composed.
execFileSync(process.execPath, [resolve('scripts', 'sync-preset.mjs'), '--check'], { cwd: process.cwd(), stdio: 'inherit' });
const root = await mkdtemp(join(tmpdir(), 'dsh-packaged-profile-'));
const env = { HOME: join(root, 'home'), DSH_HOME: join(root, 'harness'),
  XDG_CONFIG_HOME: join(root, 'xdg'), XDG_CACHE_HOME: join(root, 'cache'), LANG: 'C.UTF-8',
  PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}), DSH_TELEMETRY_DISABLED: 'true', DSH_PRIMARY_RUNTIME: '' };
const profileName = 'subscription-bridge-verification';
const profile = join(env.DSH_HOME, 'profiles', profileName);
const children = new Set();
function launch(command, args) {
  const child = spawn(command, args, { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  children.add(child); return child;
}
async function finish(child) {
  const code = await new Promise((resolve, reject) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    child.once('error', reject); child.once('exit', resolve);
  });
  assert.equal(code, 0); children.delete(child);
}
function output(child) {
  let stdout = '', stderr = '';
  child.stdout.on('data', (bytes) => { stdout += bytes; if (stdout.length > 1024 * 1024) child.kill('SIGKILL'); });
  child.stderr.on('data', (bytes) => { stderr += bytes; if (stderr.length > 1024 * 1024) child.kill('SIGKILL'); });
  return { stdout: () => stdout, stderr: () => stderr };
}
const deadline = setTimeout(() => {
  for (const child of children) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
}, 30_000);
try {
  await mkdir(profile, { recursive: true });
  for (const key of ['HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) await mkdir(env[key], { recursive: true });
  await mkdir(join(env.HOME, '.codex'));
  await writeFile(join(root, '.env'), `CODEX_HOME=${join(root, 'adversarial-codex-home')}\nOPENAI_API_KEY=synthetic-project-key\n`);
  const cache = join(root, 'npm-cache');
  const packed = JSON.parse(execFileSync(process.execPath, [npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', root, '--cache', cache], { encoding: 'utf8', env }))[0];
  assert.ok(packed.files.some((file) => file.path === 'src/auth-cli.js'));
  assert.equal(packed.files.some((file) => /^(assets|test|scripts|verification)\//u.test(file.path)), false);
  await writeFile(join(profile, 'package.json'), JSON.stringify({ private: true, type: 'module',
    dependencies: { 'dsh-codex-subscription-bridge': `file:${join(root, packed.filename)}` },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-codex-subscription-bridge'] } } }));
  await writeFile(join(profile, 'cordis.patch.yml'), '- id: hmr\n  disabled: true\n');
  execFileSync(process.execPath, [npmCli, 'install', '--ignore-scripts', '--offline', '--legacy-peer-deps', '--no-audit', '--no-fund', '--cache', cache], { cwd: profile, env, stdio: 'pipe', timeout: 20_000 });
  // A packaged host supplies its pinned peers; use those exact installed modules.
  await mkdir(join(profile, 'node_modules/@deepseek-ai'), { recursive: true });
  for (const name of ['cordis', 'dsh-llm']) await symlink(join(modules, '@deepseek-ai', name), join(profile, 'node_modules/@deepseek-ai', name), 'dir');
  const driver = join(root, 'driver.mjs');
  await writeFile(driver, `import assert from 'node:assert/strict';
import {runProfile} from ${JSON.stringify(pathToFileURL(join(runtime, 'lib/profile-boot.js')).href)};
import {createLaunchEnvironmentSnapshot} from ${JSON.stringify(pathToFileURL(join(modules, '@deepseek-ai/dsh-launch-environment/lib/index.js')).href)};
const {ctx,shutdown}=await runProfile({profile:${JSON.stringify(profileName)},patchFiles:[],args:[],environment:createLaunchEnvironmentSnapshot([{source:'process',values:process.env}])});
await ctx.get('loader').await();
assert.ok(ctx.llm.listProviders().some(provider=>provider.id==='codex-subscription'));
await assert.rejects(ctx.llm.listModels('codex-subscription'),{code:'AUTH_REQUIRED'});
const chunks=[];for await(const chunk of ctx.llm.stream({provider:'codex-subscription',model:'synthetic',messages:[{role:'user',content:[{type:'text',text:'Synthetic request'}]}]}))chunks.push(chunk);
assert.equal(chunks.at(-1).reason.failure.code,'AUTH_REQUIRED');
await shutdown.shutdown(0);
process.stdout.write('PACKAGED_PROFILE_OK\\n');
`);
  const direct = launch(process.execPath, [driver]); const directOutput = output(direct);
  await finish(direct);
  assert.ok(directOutput.stdout().includes('PACKAGED_PROFILE_OK'), directOutput.stderr());
  // Exercise the public CLI + SDK handshake, not just the profile API.
  const profileManifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'));
  profileManifest.dsh.profile.bundles.splice(1, 0, '@deepseek-ai/dsh-sdk-app');
  await writeFile(join(profile, 'package.json'), JSON.stringify(profileManifest));
  const sdk = launch(process.execPath, [cli, '--profile', profileName]); const sdkOutput = output(sdk);
  const replies = new Map();
  createInterface({ input: sdk.stdout }).on('line', (line) => {
    try { const message = JSON.parse(line); replies.get(message.id)?.(message); replies.delete(message.id); } catch {}
  });
  function request(id, method, params = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('SDK request timed out.')), 10_000);
      replies.set(id, (message) => { clearTimeout(timer); resolve(message); });
      sdk.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  const initialized = await request(1, 'initialize', { provider: 'codex-subscription', model: 'synthetic', cwd: root });
  assert.ok(initialized.error?.message.includes('A dedicated subscription login is required'), sdkOutput.stderr());
  const stopped = await request(2, 'shutdown'); assert.equal(stopped.error, undefined);
  sdk.stdin.end(); await finish(sdk);
  // The preload only exists inside this disposable verification process.
  // It replaces HTTPS with deterministic in-memory responses, never real auth.
  const preload = join(root, 'synthetic-http.mjs');
  await writeFile(preload, `import {AuthStore,authDirectory} from ${JSON.stringify(pathToFileURL(join(profile, 'node_modules/dsh-codex-subscription-bridge/src/auth.js')).href)};
import {Http} from ${JSON.stringify(pathToFileURL(join(profile, 'node_modules/dsh-codex-subscription-bridge/src/http.js')).href)};
const store=new AuthStore(authDirectory(process.env));
const token='x.'+Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600,'https://api.openai.com/auth':{chatgpt_account_id:'synthetic'}})).toString('base64url')+'.x';
await store.transaction(()=>store.write({access_token:token,refresh_token:'synthetic'}));
Http.prototype.open=async url=>url.includes('/models?')?Response.json({models:[{slug:'synthetic-model',display_name:'Synthetic',visibility:'list'}]}):new Response('data: '+JSON.stringify({type:'response.output_text.delta',item_id:'item',content_index:0,delta:'Synthetic response'})+'\\n\\ndata: '+JSON.stringify({type:'response.completed',response:{status:'completed'}})+'\\n\\n',{headers:{'content-type':'application/octet-stream'}});
`);
  const configured = launch(process.execPath, ['--import', preload, cli, '--profile', profileName]); const configuredOutput = output(configured);
  const configuredReplies = new Map(); const notifications = [];
  createInterface({ input: configured.stdout }).on('line', (line) => {
    try {
      const message = JSON.parse(line);
      if (message.id !== undefined) { configuredReplies.get(message.id)?.(message); configuredReplies.delete(message.id); }
      else notifications.push(message);
    } catch {}
  });
  const configuredRequest = (id, method, params = {}) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Configured SDK request timed out.')), 10_000);
    configuredReplies.set(id, (message) => { clearTimeout(timer); resolve(message); });
    configured.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const ready = await configuredRequest(1, 'initialize', { provider: 'codex-subscription', model: 'synthetic-model', cwd: root });
  assert.equal(ready.error, undefined, configuredOutput.stderr());
  const prompt = await configuredRequest(2, 'session/prompt', { sessionId: 'synthetic-session', contentBlocks: [{ type: 'text', text: 'Synthetic prompt' }] });
  assert.equal(prompt.error, undefined, configuredOutput.stderr());
  const idleDeadline = Date.now() + 10_000;
  while (!notifications.some((message) => message.method === 'session.status' && message.params.status === 'idle')) {
    if (Date.now() > idleDeadline) throw new Error('Configured conversation did not settle.');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(notifications.some((message) => message.method === 'session.event' && message.params.event.type === 'assistant/message' && JSON.stringify(message.params.event.data).includes('Synthetic response')), 'No successful assistant message was emitted by the configured SDK conversation.');
  assert.equal((await configuredRequest(3, 'shutdown')).error, undefined);
  configured.stdin.end(); await finish(configured);
  console.log(JSON.stringify({ harness: manifest.version, packagedProfile: 'passed', publicCli: 'passed', providerRegistration: 'passed', refusalPropagation: 'passed', configuredConversation: 'passed (synthetic direct HTTPS)', authenticationOrigin: 'dedicated disposable HOME', shutdown: 'passed', realAccount: 'not tested' }));

} finally {
  clearTimeout(deadline);
  for (const child of children) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
  await rm(root, { recursive: true, force: true });
}
