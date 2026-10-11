import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

test('configured public adapter uses the isolated launcher and rejects API-key accounts', { skip: process.platform !== 'darwin', timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-configured-plugin-'));
  try {
    await mkdir(join(root, 'codex')); await mkdir(join(root, 'home'));
    const fixture = await readFile(new URL('./fixtures/codex-cli.mjs', import.meta.url), 'utf8');
    for (const name of ['codex-synthetic', 'codex-apikey']) await writeFile(join(root, name), `#!${process.execPath}\n${fixture}`, { mode: 0o700 });
    const driver = `import assert from 'node:assert/strict';
import {Context} from ${JSON.stringify(new URL('../node_modules/@deepseek-ai/cordis/lib/index.js', import.meta.url).href)};
import {LlmRuntime} from ${JSON.stringify(new URL('../node_modules/@deepseek-ai/dsh-llm/lib/index.js', import.meta.url).href)};
import * as plugin from ${JSON.stringify(new URL('../src/index.js', import.meta.url).href)};
const ctx=new Context();const service=ctx.plugin(LlmRuntime);let fiber=ctx.plugin(plugin,{executable:${JSON.stringify(join(root, 'codex-synthetic'))},credentialStore:'file'});
await new Promise(resolve=>setImmediate(resolve));
assert.equal((await ctx.llm.listModels('codex-subscription'))[0].id,'synthetic-model');
const chunks=[];for await(const chunk of ctx.llm.stream({provider:'codex-subscription',model:'synthetic-model',messages:[{role:'user',content:[{type:'text',text:'Synthetic prompt'}]}]}))chunks.push(chunk);
assert.equal(chunks.at(-1).reason.kind,'stop');assert.equal(chunks.find(chunk=>chunk.type==='text-delta').text,'Synthetic response');
await fiber.dispose();fiber=ctx.plugin(plugin,{executable:${JSON.stringify(join(root, 'codex-apikey'))},credentialStore:'file'});await new Promise(resolve=>setImmediate(resolve));
await assert.rejects(ctx.llm.listModels('codex-subscription'),{code:'AUTH_REQUIRED'});
await fiber.dispose();await service.dispose();`;
    await writeFile(join(root, 'driver.mjs'), driver);
    const child = spawn(process.execPath, [join(root, 'driver.mjs')], { env: { HOME: join(root, 'home'), CODEX_HOME: join(root, 'codex'), LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr.on('data', (chunk) => { stderr += chunk; }); child.stdout.resume();
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    try { assert.equal(await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }), 0, stderr); }
    finally { clearTimeout(timer); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
