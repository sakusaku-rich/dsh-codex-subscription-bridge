import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readFile,access,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {AuthStore} from '../src/auth.js';
test('doctor is secret-free, read-only, and never steals a lock or refreshes',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dsh-doctor-'));const dir=join(root,'auth');let calls=0;const store=new AuthStore(dir,{open(){calls++;throw new Error('Network must not run')}});
 try{
 assert.equal((await store.doctor()).store,'missing');await assert.rejects(access(dir),{code:'ENOENT'});
 await store.prepare();assert.equal((await store.doctor()).auth,'missing');
 const token='x.'+Buffer.from(JSON.stringify({exp:1,'https://api.openai.com/auth':{chatgpt_account_id:'synthetic-account'}})).toString('base64url')+'.x';
 await store.transaction(()=>store.write({access_token:token,refresh_token:'synthetic-secret'}));
 const original=await readFile(join(dir,'auth.json'),'utf8');const diagnosed=await store.doctor();assert.equal(diagnosed.auth,'expired');assert.equal(JSON.stringify(diagnosed).includes('synthetic'),false);assert.equal(await readFile(join(dir,'auth.json'),'utf8'),original);
 await mkdir(join(dir,'auth.lock'),{mode:0o700});assert.equal((await store.doctor()).lock,'present_owner_unknown');await access(join(dir,'auth.lock'));await rm(join(dir,'auth.lock'),{recursive:true});
 await store.transaction(()=>store.writeState({version:1,mode:'chatgpt',refresh_pending:true}));assert.equal((await store.doctor()).auth,'relogin_required');
 await chmod(join(dir,'auth.json'),0o644);assert.equal((await store.doctor()).auth,'invalid');assert.equal(calls,0);
 }finally{await rm(root,{recursive:true,force:true})}
});
