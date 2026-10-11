import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {AuthStore} from '../src/auth.js';
import {Http,readJson} from '../src/http.js';
test('login polling body cancellation is ABORTED and cannot replace the stored login', async()=>{
 const root=await mkdtemp(join(tmpdir(),'dsh-login-abort-'));const controller=new AbortController();
 try{const store=new AuthStore(join(root,'auth'),new Http(async(url,options)=>{
  if(url.endsWith('/usercode'))return Response.json({device_auth_id:'synthetic',user_code:'ABCD-EFGH',interval:0});
  return new Response(new ReadableStream({start(stream){stream.enqueue(Buffer.from('{'));options.signal.addEventListener('abort',()=>stream.error(new DOMException('Synthetic abort','AbortError')),{once:true});setTimeout(()=>controller.abort(),5);}}));
 }));await assert.rejects(store.login(()=>{},controller.signal),{code:'ABORTED'});
 await assert.rejects(readFile(join(root,'auth/auth.json')),{code:'ENOENT'});
 await assert.rejects(readFile(join(root,'auth/auth.lock')),{code:'ENOENT'});
 }finally{await rm(root,{recursive:true,force:true})}
});
test('signal-aware body reads distinguish deadline from caller cancellation',async()=>{
 for(const deadline of [false,true]){
  const controller=new AbortController();const signal=deadline?AbortSignal.timeout(10):controller.signal;
  const response=new Response(new ReadableStream({start(stream){stream.enqueue(Buffer.from('{'));signal.addEventListener('abort',()=>stream.error(new DOMException('Synthetic abort','AbortError')),{once:true});}}));
  const keepAlive=setTimeout(()=>controller.abort(),10);
  try{await assert.rejects(readJson(response,1024,signal),{code:deadline?'TIMEOUT':'ABORTED'})}finally{clearTimeout(keepAlive)}
 }
});
