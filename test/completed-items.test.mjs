import test from 'node:test';
import assert from 'node:assert/strict';
import {DirectBridge} from '../lib/direct.js';
import {Http} from '../lib/http.js';
const token='x.'+Buffer.from(JSON.stringify({exp:Date.now()/1000+3600,'https://api.openai.com/auth':{chatgpt_account_id:'synthetic'}})).toString('base64url')+'.x';
const item={type:'message',id:'message',role:'assistant',content:[{type:'output_text',text:'Complete text'}]};
const collect=async events=>{const bridge=new DirectBridge({token:async()=>token},new Http(async url=>url.includes('/models?')?Response.json({models:[{slug:'test',display_name:'Test',visibility:'list'}]}):new Response(events.map(event=>'data: '+JSON.stringify(event)+'\n\n').join(''))));
try{const chunks=[];for await(const chunk of bridge.stream({provider:'codex-subscription',model:'test',messages:[{role:'user',content:[{type:'text',text:'Synthetic'}]}]}))chunks.push(chunk);return chunks;}finally{await bridge.close()}};
test('completed item restores text when terminal output is null',async()=>{
 const chunks=await collect([{type:'response.output_item.done',item},{type:'response.completed',response:{status:'completed',output:null}}]);
 assert.equal(chunks.find(chunk=>chunk.type==='block-end').block.text,'Complete text');assert.equal(chunks.at(-1).reason.kind,'stop');
});
test('text, item, and terminal completions do not duplicate emission',async()=>{
 const chunks=await collect([{type:'response.output_text.done',item_id:'message',content_index:0,text:'Complete text'},{type:'response.output_item.done',item},{type:'response.completed',response:{status:'completed',output:[item]}}]);
 assert.equal(chunks.filter(chunk=>chunk.type==='block-start').length,1);assert.equal(chunks.filter(chunk=>chunk.type==='block-end').length,1);assert.equal(chunks.filter(chunk=>chunk.type==='text-delta').map(chunk=>chunk.text).join(''),'Complete text');
});
test('completed item rejects contradiction, unsupported content, and oversized text',async()=>{
 for(const invalid of [{...item,content:[{type:'output_text',text:'Different'}]},{...item,role:'user'},{...item,status:'incomplete'},{...item,content:[{type:'refusal',refusal:'Synthetic'}]},{...item,content:[{type:'output_text',text:'x'.repeat(256*1024+1)}]}]){
 await assert.rejects(collect([{type:'response.output_text.delta',item_id:'message',content_index:0,delta:'Complete'},{type:'response.output_item.done',item:invalid},{type:'response.completed',response:{status:'completed'}}]),error=>['PROTOCOL_INVALID','LIMIT_EXCEEDED'].includes(error.code));
 }
});
