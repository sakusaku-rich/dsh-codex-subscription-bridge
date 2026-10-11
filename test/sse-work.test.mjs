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
