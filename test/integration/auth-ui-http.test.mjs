import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
const run = promisify(execFile);
test('packaged auth routes retain browser trust and the existing Gateway', { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-auth-routes-'));
  const repo = process.cwd(); const npm = process.env.npm_execpath;
  const env = { HOME: join(root, 'home'), DSH_HOME: join(root, 'harness'), PATH: '/usr/bin:/bin', DSH_TELEMETRY_DISABLED: 'true' };
  try {
    await mkdir(env.HOME); const profile = join(env.DSH_HOME, 'profiles/auth-ui-test'); await mkdir(profile, { recursive: true });
    const cache = join(root, 'cache');
    const pack = JSON.parse(execFileSync(process.execPath, [npm, 'pack', '--ignore-scripts', '--json', '--pack-destination', root, '--cache', cache], { env, encoding: 'utf8', timeout: 15000 }))[0];
    await writeFile(join(profile, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: { 'dsh-codex-subscription-bridge': `file:${join(root, pack.filename)}` }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-codex-subscription-bridge'] } } }));
    await writeFile(join(profile, 'cordis.patch.yml'), '- id: hmr\n  disabled: true\n');
    execFileSync(process.execPath, [npm, 'install', '--ignore-scripts', '--offline', '--legacy-peer-deps', '--no-audit', '--no-fund', '--cache', cache], { cwd: profile, env, stdio: 'pipe', timeout: 15000 });
    const url = path => pathToFileURL(path).href;
    const driver = `
import assert from 'node:assert/strict';
import {runProfile} from ${JSON.stringify(url(join(repo, 'verification/runtime/node_modules/@deepseek-ai/dsh/lib/profile-boot.js')))};
import {createLaunchEnvironmentSnapshot} from ${JSON.stringify(url(join(repo, 'verification/runtime/node_modules/@deepseek-ai/dsh-launch-environment/lib/index.js')))};
import {BridgeError} from ${JSON.stringify(url(join(profile, 'node_modules/dsh-codex-subscription-bridge/lib/errors.js')))};
const {ctx,shutdown}=await runProfile({profile:'auth-ui-test',patchFiles:[],args:['--host','127.0.0.1','--port','0','--no-open'],environment:createLaunchEnvironmentSnapshot([{source:'process',values:process.env}])});
await ctx.get('loader').await();
const {AuthStore}=await import(${JSON.stringify(url(join(profile, 'node_modules/dsh-codex-subscription-bridge/lib/auth.js')))});
let approve;
AuthStore.prototype.login=async function(announce,signal){
 announce({url:'https://auth.openai.com/codex/device',code:'SYNTHETIC-CODE'});
 await new Promise((resolve,reject)=>{approve=resolve;signal.addEventListener('abort',()=>reject(new BridgeError('ABORTED')),{once:true})});
 const token='x.'+Buffer.from(JSON.stringify({exp:Date.now()/1000+3600,'https://api.openai.com/auth':{chatgpt_account_id:'synthetic'}})).toString('base64url')+'.x';
 await this.transaction(()=>this.write({access_token:token,refresh_token:'synthetic-refresh'}),signal);
};
const base='http://127.0.0.1:'+ctx.webServer.port;
const owner='11111111-1111-4111-8111-111111111111';const other='22222222-2222-4222-8222-222222222222';
const message=(method,payload)=>JSON.stringify({type:'client-request',rpcId:'fixture',method,payload});
const request=(method,payload,headers={})=>fetch(base+'/api/'+method,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:message(method,payload)});
assert.equal((await request('codex-subscription-auth/status',{clientId:owner})).status,401);
const boot=await fetch(ctx.connection.authenticatedUrl(base+'/'),{redirect:'manual'});
const cookie=boot.headers.getSetCookie().map(value=>value.split(';')[0]).join(';');assert.ok(cookie);
assert.equal((await request('codex-subscription-auth/login',{clientId:owner},{Cookie:cookie,Origin:'https://untrusted.invalid'})).status,403);
const headers={Cookie:cookie,Origin:base};
assert.equal((await(await request('permissionPresets/catalog',{args:{}},headers)).json()).result.ok,true);
const rpc=async(action,args={clientId:owner})=>{const response=await request('codex-subscription-auth/'+action,args,headers);assert.equal(response.headers.get('cache-control'),'no-store');return(await response.json()).result};
assert.equal((await rpc('login')).ok,true);
let current=(await rpc('status')).value;
assert.equal(current.phase,'waiting');assert.equal(current.device.code,'SYNTHETIC-CODE');
const hidden=(await rpc('status',{clientId:other})).value;assert.equal(hidden.device,undefined);assert.equal(hidden.attemptId,undefined);
assert.equal((await rpc('cancel',{clientId:other,attemptId:current.attemptId})).ok,false);
assert.equal((await rpc('cancel',{clientId:owner,attemptId:current.attemptId})).value.phase,'cancelled');
await rpc('login');approve();
for(let n=0;n<100;n++){current=(await rpc('status')).value;if(current.phase==='signed_in')break;await new Promise(resolve=>setTimeout(resolve,10))}
assert.equal(current.phase,'signed_in');assert.equal(current.local.auth,'stored');assert.equal(JSON.stringify(current).includes('synthetic-refresh'),false);
assert.equal((await rpc('logout')).value.local.auth,'missing');
await shutdown.shutdown(0);console.log('AUTH_UI_HTTP_OK');
`;
    await writeFile(join(root, 'driver.mjs'), driver);
    const result = await run(process.execPath, [join(root, 'driver.mjs')], { env, cwd: root, timeout: 20000 });
    assert.ok(result.stdout.includes('AUTH_UI_HTTP_OK'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
