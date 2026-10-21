import test from 'node:test';
import assert from 'node:assert/strict';
import {events} from '../src/sse.js';
const collect=async(body,signal=new AbortController().signal)=>{const result=[];for await(const value of events(body,signal))result.push(value);return result};
test('incremental framing preserves split UTF-8, multiline data and mixed newline delimiters',async()=>{
 const bytes=Buffer.from('data: {"type":"test",\r\ndata: "text":"Hello 🌍"}\r\n\n: comment\n\ndata: {"type":"second"}\n\r\n');
 const body=new ReadableStream({start(controller){for(const byte of bytes)controller.enqueue(Uint8Array.of(byte));controller.close()}});
 assert.deepEqual(await collect(body),[{type:'test',text:'Hello 🌍'},{type:'second'}]);
});
test('ready one-byte and empty fragments yield so cancellation timers run',async()=>{
 for(const empty of [false,true]){
  let remaining=131072;const controller=new AbortController();
  const body=new ReadableStream({pull(stream){if(!remaining--){stream.close();return}stream.enqueue(empty?new Uint8Array():Uint8Array.of(120))}});
  const timer=setTimeout(()=>controller.abort(),0);
  try{await assert.rejects(collect(body,controller.signal),{code:'ABORTED'})}finally{clearTimeout(timer)}
 }
});
test('one-byte malformed input remains bounded and rejects incomplete frames',async()=>{
 let remaining=32768;const body=new ReadableStream({pull(controller){if(!remaining--){controller.close();return}controller.enqueue(Uint8Array.of(120))}});
 await assert.rejects(collect(body),{code:'PROTOCOL_INVALID'});
 await assert.rejects(collect(new Response('x'.repeat(1024*1024+1)).body),{code:'LIMIT_EXCEEDED'});
});
test('frame-byte and frame-count limits remain enforced at their boundaries',async()=>{
 const limit=1024*1024;const prefix='data: {"type":"test","text":"';const suffix='"}';
 const text=prefix+'x'.repeat(limit-Buffer.byteLength(prefix+suffix))+suffix;
 assert.equal((await collect(new Response(text+'\r\n\r\n').body)).length,1);
 await assert.rejects(collect(new Response(prefix+'x'.repeat(limit)+suffix+'\n\n').body),{code:'LIMIT_EXCEEDED'});
 await assert.rejects(collect(new Response('data: {}\n\n'.repeat(4097)).body),{code:'LIMIT_EXCEEDED'});
});
const collectWith=async(body,limits)=>{const result=[];for await(const value of events(body,new AbortController().signal,undefined,limits))result.push(value);return result};
const frame=text=>new Response(text+'\r\n\r\n').body;
test('a raised frame limit admits one oversized event and stays bounded itself',async()=>{
 const raised=1024*1024+65536;const prefix='data: {"type":"test","text":"';const suffix='"}';
 const text=length=>prefix+'x'.repeat(length-Buffer.byteLength(prefix+suffix))+suffix;
 assert.equal((await collectWith(frame(text(raised-64)),{frameLimit:raised})).length,1);
 assert.equal((await collectWith(frame(text(raised)),{frameLimit:raised})).length,1);
 await assert.rejects(collectWith(frame(text(raised+1)),{frameLimit:raised}),{code:'LIMIT_EXCEEDED'});
 // Passing no limits object keeps the default bounds for the same payload.
 await assert.rejects(collectWith(frame(text(raised-64)),undefined),{code:'LIMIT_EXCEEDED'});
});
test('a raised total limit admits more framed bytes while the default stays enforced',async()=>{
 const prefix='data: {"type":"test","text":"';const suffix='"}';
 const one=length=>{const text=prefix+'x'.repeat(length-Buffer.byteLength(prefix+suffix))+suffix;return text+'\r\n\r\n'};
 const body=lengths=>new Response(lengths.map(one).join('')).body;
 const raised={frameLimit:1024*1024+65536};
 assert.equal((await collectWith(body([1100000,1100000,1100000]),raised)).length,3);
 await assert.rejects(collectWith(body([1100000,1100000,1100000,1100000]),raised),{code:'LIMIT_EXCEEDED'});
 assert.equal((await collectWith(body([1100000,1100000,1100000,1100000]),{...raised,totalLimit:6*1024*1024})).length,4);
});
test('a raised event limit admits more events while the default stays enforced',async()=>{
 const raised={frameLimit:8*1024*1024,totalLimit:64*1024*1024,eventLimit:65536};
 const smallDeltas=10000;
 assert.equal((await collectWith(new Response('data: {}\n\n'.repeat(smallDeltas)).body,raised)).length,smallDeltas);
 // A raised event count alone also lifts the bound, within the default totals.
 assert.equal((await collectWith(new Response('data: {}\n\n'.repeat(smallDeltas)).body,{eventLimit:16384})).length,smallDeltas);
 // Raised framing alone keeps the default count: the 4097th event fails with
 // the fixed label and the structured numbers name the bound.
 await assert.rejects(collectWith(new Response('data: {}\n\n'.repeat(4097)).body,{frameLimit:8*1024*1024,totalLimit:64*1024*1024}),
  error=>{assert.equal(error.code,'LIMIT_EXCEEDED');assert.match(error.message,/SSE_FRAME:EVENTS/);assert.equal(error.sseCount,4097);assert.equal(error.sseLimit,4096);return true});
 // Default limits reject the same stream of small deltas outright.
 await assert.rejects(collectWith(new Response('data: {}\n\n'.repeat(smallDeltas)).body,undefined),
  error=>{assert.equal(error.code,'LIMIT_EXCEEDED');assert.match(error.message,/SSE_FRAME:EVENTS/);return true});
});
test('framing limits only raise: lowering or corrupting them is a programming error',async()=>{
 for(const limits of [{frameLimit:1024*1024-1},{frameLimit:1.5},{frameLimit:'big'},{totalLimit:4*1024*1024-1},
   {eventLimit:4096-1},{eventLimit:1.5},{eventLimit:'big'},{eventLimit:65536+1}]){
  await assert.rejects(collectWith(frame('data: {}'),limits),error=>{assert.equal(error.code,undefined);assert.match(error.message,/framing limits/);return true});
 }
 // Limits exactly at the defaults or the cap are valid, and no limits object means defaults.
 assert.equal((await collectWith(frame('data: {}'),{frameLimit:1024*1024,totalLimit:4*1024*1024,eventLimit:4096})).length,1);
 assert.equal((await collectWith(frame('data: {}'),{eventLimit:65536})).length,1);
 assert.equal((await collectWith(frame('data: {}'),undefined)).length,1);
});
