import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,access} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync,spawnSync} from 'node:child_process';
test('source installer creates a fresh pinned profile, exposes doctor, and refuses overwrite',{timeout:30000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'dsh-guide-'));const target=join(root,"profile space's");const npmCli=process.env.npm_execpath;
 if(!npmCli)throw new Error('Run the suite through npm.');
 try{
 const args=[npmCli,'run','prepare:profile','--','--directory',target];execFileSync(process.execPath,args,{stdio:'pipe',timeout:20000});
 const manifest=JSON.parse(await readFile(join(target,'manifest.json'),'utf8'));assert.equal(manifest.harness,'0.2.1-rc.2');assert.ok(manifest.integrity.startsWith('sha512-'));
 const diagnosis=spawnSync('/bin/sh',[join(target,'auth.sh'),'doctor'],{encoding:'utf8',timeout:5000});assert.equal(diagnosis.status,1);assert.equal(JSON.parse(diagnosis.stdout).store,'missing');
 await assert.rejects(access(join(target,'home/.dsh-codex-subscription-bridge')),{code:'ENOENT'});
 const snapshot=await readFile(join(target,'manifest.json'),'utf8');assert.throws(()=>execFileSync(process.execPath,args,{stdio:'pipe',timeout:5000}));assert.equal(await readFile(join(target,'manifest.json'),'utf8'),snapshot);
 const repo=process.cwd();const cli=join(repo,'verification/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js');
 const config=execFileSync(process.execPath,[cli,'--profile','subscription-web','--dump-config'],{env:{HOME:join(target,'home'),DSH_HOME:join(target,'harness'),PATH:dirname(process.execPath)+':/usr/bin:/bin'},encoding:'utf8',timeout:5000});assert.ok(config.includes('llm-codex-subscription'));
 }finally{await rm(root,{recursive:true,force:true})}
});
