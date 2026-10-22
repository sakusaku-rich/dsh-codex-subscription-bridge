import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
test('public adapter uses dedicated OAuth and direct HTTPS with synthetic responses', { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-direct-plugin-'));
  try {
    const driver = `import assert from 'node:assert/strict';
import {Context} from ${JSON.stringify(new URL('../node_modules/@deepseek-ai/cordis/lib/index.js', import.meta.url).href)};
import {LlmRuntime} from ${JSON.stringify(new URL('../node_modules/@deepseek-ai/dsh-llm/lib/index.js', import.meta.url).href)};
import * as plugin from ${JSON.stringify(new URL('../lib/index.js', import.meta.url).href)};
import {AuthStore,authDirectory} from ${JSON.stringify(new URL('../lib/auth.js', import.meta.url).href)};
import {Http} from ${JSON.stringify(new URL('../lib/http.js', import.meta.url).href)};
const token='x.'+Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600,'https://api.openai.com/auth':{chatgpt_account_id:'synthetic'}})).toString('base64url')+'.x';
const store=new AuthStore(authDirectory(process.env));await store.transaction(()=>store.write({access_token:token,refresh_token:'synthetic'}));
Http.prototype.open=async url=>url.includes('/models?')?Response.json({models:[{slug:'synthetic-model',display_name:'Synthetic',visibility:'list',context_window:272000}]}):new Response('data: '+JSON.stringify({type:'response.output_text.delta',item_id:'item',content_index:0,delta:'Synthetic response'})+'\\n\\ndata: '+JSON.stringify({type:'response.completed',response:{status:'completed'}})+'\\n\\n',{headers:{'content-type':'text/event-stream'}});
const ctx=new Context();const service=ctx.plugin(LlmRuntime);const fiber=ctx.plugin(plugin);await new Promise(resolve=>setImmediate(resolve));
assert.equal((await ctx.llm.listModels('codex-subscription'))[0].id,'synthetic-model');
const info=await ctx.llm.resolveModelInfo('codex-subscription','synthetic-model');assert.deepEqual(info.context,{contextWindow:272000});
const chunks=[];for await(const chunk of ctx.llm.stream({provider:'codex-subscription',model:'synthetic-model',messages:[{role:'user',content:[{type:'text',text:'Synthetic prompt'}]}]}))chunks.push(chunk);
assert.equal(chunks.at(-1).reason.kind,'stop');assert.equal(chunks.find(chunk=>chunk.type==='text-delta').text,'Synthetic response');
await store.logout();await assert.rejects(ctx.llm.listModels('codex-subscription'),{code:'AUTH_REQUIRED'});
await fiber.dispose();await service.dispose();`;
    await writeFile(join(root, 'driver.mjs'), driver);
    const child = spawn(process.execPath, [join(root, 'driver.mjs')], { env: { HOME: root, LANG: 'C.UTF-8', ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes; }); child.stdout.resume();
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    try { assert.equal(await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }), 0, stderr); }
    finally { clearTimeout(timer); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
