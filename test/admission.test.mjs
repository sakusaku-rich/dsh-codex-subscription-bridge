import test from 'node:test';
import assert from 'node:assert/strict';
import {DirectBridge} from '../src/direct.js';
import {AuthStore} from '../src/auth.js';
import {BridgeError} from '../src/errors.js';
test('pre-aborted discovery never enters authentication or store preparation',async()=>{
 let called=0;const store=new AuthStore('/unused-synthetic-path');store.prepare=async()=>{called++};
 const bridge=new DirectBridge(store);const controller=new AbortController();controller.abort();
 const results=await Promise.allSettled(Array.from({length:32},()=>bridge.listModels(controller.signal)));
 assert.equal(results.every(value=>value.reason?.code==='ABORTED'),true);assert.equal(called,0);
 await assert.rejects(store.token(controller.signal),{code:'ABORTED'});assert.equal(called,0);await bridge.close();
});
test('aborted in-flight authentication retains capacity until ownership settles',async()=>{
 let live=0,peak=0;const finishers=[];const bridge=new DirectBridge({token:async()=>{
  live++;peak=Math.max(peak,live);await new Promise(resolve=>finishers.push(resolve));live--;throw new BridgeError('ABORTED');
 }});
 const controllers=Array.from({length:4},()=>new AbortController());
 const first=controllers.map(controller=>bridge.listModels(controller.signal).catch(error=>error.code));
 await new Promise(resolve=>setImmediate(resolve));assert.equal(live,4);controllers.forEach(controller=>controller.abort());
 await new Promise(resolve=>setImmediate(resolve));
 const rejected=await Promise.all(Array.from({length:32},()=>bridge.listModels(new AbortController().signal).catch(error=>error.code)));
 assert.equal(rejected.every(code=>code==='LIMIT_EXCEEDED'),true);assert.equal(peak,4);assert.equal(bridge.active.size,4);
 finishers.forEach(resolve=>resolve());await Promise.all(first);assert.equal(bridge.active.size,0);await bridge.close();
});
