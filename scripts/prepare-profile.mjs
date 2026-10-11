import {mkdir,readFile,writeFile,symlink} from 'node:fs/promises';
import {isAbsolute,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {assertNodeVersion,assertPlatform} from '../src/runtime.js';
assertNodeVersion();assertPlatform();
const args=process.argv.slice(2);const root=args[1];const npmCli=process.env.npm_execpath;
if(args.length!==2 || args[0]!=='--directory' || !isAbsolute(root??'') || /[\x00\r\n]/u.test(root) || !isAbsolute(npmCli??''))throw new Error('Run npm run prepare:profile -- --directory <absolute new directory>. Its parent must exist.');
const repo=dirname(dirname(fileURLToPath(import.meta.url)));const modules=join(repo,'verification/runtime/node_modules');
for(const [name,version] of [['@deepseek-ai/dsh','0.2.0-rc.2'],['@deepseek-ai/cordis','4.0.4'],['@deepseek-ai/dsh-llm','0.2.0-rc.2'],['@modelcontextprotocol/client','2.2.0'],['@modelcontextprotocol/core','2.2.0'],['fflate','0.8.3']]){
 const manifest=JSON.parse(await readFile(join(modules,name,'package.json'),'utf8'));if(manifest.version!==version)throw new Error('Install the pinned verification runtime before preparing a profile.');
}
// Never overwrite an existing profile or copy the caller's HOME/authentication.
await mkdir(root,{mode:0o700});
const home=join(root,'home');const harness=join(root,'harness');const profile=join(harness,'profiles','subscription-web');
for(const path of [home,profile,join(root,'workspace'),join(root,'cache'),join(root,'xdg')])await mkdir(path,{recursive:true,mode:0o700});
const env={HOME:home,DSH_HOME:harness,XDG_CONFIG_HOME:join(root,'xdg'),XDG_CACHE_HOME:join(root,'cache'),LANG:'C.UTF-8',PATH:`${dirname(process.execPath)}:/usr/bin:/bin`,DSH_TELEMETRY_DISABLED:'true',DSH_PRIMARY_RUNTIME:''};
const packed=JSON.parse(execFileSync(process.execPath,[npmCli,'pack','--ignore-scripts','--json','--pack-destination',root,'--cache',join(root,'cache')],{cwd:repo,env,encoding:'utf8',timeout:30_000,maxBuffer:1024*1024}))[0];
await writeFile(join(profile,'package.json'),JSON.stringify({private:true,type:'module',dependencies:{'dsh-codex-subscription-bridge':`file:${join(root,packed.filename)}`},dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','dsh-codex-subscription-bridge']}}},null,2));
execFileSync(process.execPath,[npmCli,'install','--ignore-scripts','--offline','--legacy-peer-deps','--no-audit','--no-fund','--cache',join(root,'cache')],{cwd:profile,env,stdio:'pipe',timeout:30_000});
await mkdir(join(profile,'node_modules/@deepseek-ai'),{recursive:true,mode:0o700});
for(const name of ['cordis','dsh-llm'])await symlink(join(modules,'@deepseek-ai',name),join(profile,'node_modules/@deepseek-ai',name));
await writeFile(join(profile,'cordis.patch.yml'),'- id: hmr\n  disabled: true\n- id: llm-codex-subscription\n  config: {}\n');
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
const environment=Object.entries(env).map(([key,value])=>`${key}=${quote(value)}`).join(' ');
const node=quote(process.execPath);const auth=quote(join(profile,'node_modules/dsh-codex-subscription-bridge/src/auth-cli.js'));
await writeFile(join(root,'auth.sh'),`#!/bin/sh\nexec env -i ${environment} ${node} ${auth} "$@"\n`,{mode:0o700});
await writeFile(join(root,'start.sh'),`#!/bin/sh\ncd ${quote(join(root,'workspace'))} || exit 1\nexec env -i ${environment} ${node} ${quote(join(modules,'@deepseek-ai/dsh/lib/bin.js'))} --profile subscription-web --host 127.0.0.1 --port 0 --no-open\n`,{mode:0o700});
await writeFile(join(root,'manifest.json'),JSON.stringify({schema:1,repositoryCommit:execFileSync('/usr/bin/git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),package:packed.filename,integrity:packed.integrity,node:process.versions.node,harness:'0.2.0-rc.2',workingTreeMayContainChanges:true},null,2));
console.log(`Prepared an isolated Web profile at ${root}.\nStart: sh ${quote(join(root,'start.sh'))}\nDiagnose: sh ${quote(join(root,'auth.sh'))} doctor\nLogin is explicit: sh ${quote(join(root,'auth.sh'))} login`);
