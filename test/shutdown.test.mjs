import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,access} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DirectBridge} from '../src/direct.js';
import {AuthStore} from '../src/auth.js';
import {Http} from '../src/http.js';
import {BridgeError} from '../src/errors.js';
test('close waits for an owned authentication transaction and lock release',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dsh-shutdown-'));let entered;const ready=new Promise(resolve=>entered=resolve);
 const store=new AuthStore(join(root,'auth'));let settled=false;
 const bridge=new DirectBridge({token:signal=>store.transaction(async()=>{entered();await new Promise(resolve=>setTimeout(resolve,30));throw new BridgeError('ABORTED');},signal)});
 const request=bridge.listModels().catch(()=>{}).finally(()=>{settled=true});
 try{await ready;const first=bridge.close();assert.equal(bridge.close(),first);await first;await request;assert.equal(settled,true);await assert.rejects(access(join(root,'auth/auth.lock')),{code:'ENOENT'});}finally{await request;await rm(root,{recursive:true,force:true})}
});
test('close cancels a paused stream reader without requiring consumer progress',async()=>{
 const token='x.'+Buffer.from(JSON.stringify({exp:Date.now()/1000+3600,'https://api.openai.com/auth':{chatgpt_account_id:'synthetic'}})).toString('base64url')+'.x';let cancelled=false;
 const bridge=new DirectBridge({token:async()=>token},new Http(async url=>url.includes('/models?')?Response.json({models:[{slug:'test',display_name:'Test',visibility:'list'}]}):new Response(new ReadableStream({start(controller){controller.enqueue(Buffer.from('data: '+JSON.stringify({type:'response.output_text.delta',item_id:'item',content_index:0,delta:'Synthetic'})+'\n\n'));},async cancel(){await new Promise(resolve=>setTimeout(resolve,20));cancelled=true;}}))));
 const stream=bridge.stream({provider:'codex-subscription',model:'test',messages:[{role:'user',content:[{type:'text',text:'Synthetic'}]}]});await stream.next();await bridge.close();assert.equal(cancelled,true);assert.equal(bridge.pending.size,0);await stream.return();
});
test('close times out rather than declaring unresponsive cleanup complete',async()=>{
 let finish;const waiting=new Promise(resolve=>finish=resolve);const bridge=new DirectBridge({},undefined,{shutdownTimeoutMs:10});bridge.track(waiting);
 await assert.rejects(bridge.close(),{code:'TIMEOUT'});finish();await waiting;
});
