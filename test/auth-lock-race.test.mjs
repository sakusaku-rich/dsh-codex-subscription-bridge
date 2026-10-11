import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);

test('lock-release interleaving retries without bypassing safety, cancellation or deadline checks', async () => {
  const moduleUrl = new URL('../src/auth.js', import.meta.url).href;
  const driver = `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {join} from 'node:path';
const original=fs.promises.mkdir;let hook;
fs.promises.mkdir=async(path,options)=>{try{return await original(path,options)}catch(error){if(path.endsWith('/auth.lock')&&error.code==='EEXIST')await hook?.(path);throw error}};
syncBuiltinESMExports();
const {AuthStore}=await import(${JSON.stringify(moduleUrl)});
const root=await fs.promises.mkdtemp('/private/tmp/dsh-lock-regression-');
const originalNow=Date.now;
try{
 for(const scenario of ['released','insecure','symlink','aborted','deadline']){
  let release,entered,ownerDone;const controller=new AbortController();const directory=join(root,scenario);const store=new AuthStore(directory);
  const ready=new Promise(resolve=>entered=resolve);const wait=new Promise(resolve=>release=resolve);
  ownerDone=store.transaction(async()=>{entered();await wait});await ready;
  hook=async(path)=>{hook=undefined;release();await ownerDone;
   if(scenario==='insecure')await original(path,{mode:0o777}).then(()=>fs.promises.chmod(path,0o777));
   if(scenario==='symlink')await fs.promises.symlink(directory,path);
   if(scenario==='aborted')controller.abort();
   if(scenario==='deadline')Date.now=()=>originalNow()+60000;
  };
  let ran=false;const attempt=new AuthStore(directory).transaction(async()=>{ran=true},controller.signal);
  if(scenario==='released'){await attempt;assert.equal(ran,true)}
  else{await assert.rejects(attempt,{code:scenario==='aborted'?'ABORTED':scenario==='deadline'?'AUTH_BUSY':'AUTH_STORE_INVALID'});assert.equal(ran,false)}
  Date.now=originalNow;
 }
}finally{Date.now=originalNow;fs.promises.mkdir=original;syncBuiltinESMExports();await fs.promises.rm(root,{recursive:true,force:true})}
console.log('LOCK_RACE_OK');
`;
  const result = await run(process.execPath, ['--input-type=module', '-e', driver], { timeout: 5000 });
  assert.ok(result.stdout.includes('LOCK_RACE_OK'));
});
