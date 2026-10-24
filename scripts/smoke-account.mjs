import { Context } from '@deepseek-ai/cordis';
import { LlmRuntime } from '@deepseek-ai/dsh-llm';
import * as plugin from '../lib/index.js';
import { BridgeError, failure } from '../lib/errors.js';

// Preparation only: never run this without the owner's explicit authorization.
const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
if (!args.includes('--allow-real-account') || args.some((argument, index) => !['--allow-real-account', '--model'].includes(argument) && args[index - 1] !== '--model')) {
  throw new Error('Explicit authorization with --allow-real-account is required. Optional: --model <id>.');
}
const ctx = new Context();
const service = ctx.plugin(LlmRuntime);
const fiber = ctx.plugin(plugin);
const controller = new AbortController();
let timedOut = false;
const timer = setTimeout(() => { timedOut = true; controller.abort(); void fiber.dispose(); }, 30_000);
try {
  await new Promise((resolve) => setImmediate(resolve));
  const models = await ctx.llm.listModels('codex-subscription');
  const model = args.includes('--model') ? value('--model') : models[0]?.id;
  if (!model) throw new BridgeError('MODEL_UNAVAILABLE');
  let text = '', finished = false;
  for await (const chunk of ctx.llm.stream({ provider: 'codex-subscription', model, signal: controller.signal,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with exactly BRIDGE_OK and nothing else.' }] }] })) {
    if (chunk.type === 'text-delta') {
      text += chunk.text;
      if (Buffer.byteLength(text) > 256) { controller.abort(); throw new BridgeError('LIMIT_EXCEEDED'); }
    }
    if (chunk.type === 'finish') {
      if (chunk.reason.kind !== 'stop') throw new BridgeError(chunk.reason.failure?.code);
      finished = true;
    }
  }
  if (!finished || text.trim() !== 'BRIDGE_OK') throw new BridgeError('UPSTREAM_FAILED');
  console.log(JSON.stringify({ result: 'passed', model, replyMatched: true, realAccountUsed: true }));
} catch (error) {
  // Do not expose unexpected model output or upstream diagnostics.
  console.log(JSON.stringify({ result: 'failed', failure: failure(timedOut ? new BridgeError('TIMEOUT') : error) }));
  process.exitCode = 1;
} finally {
  clearTimeout(timer); await fiber.dispose(); await service.dispose();
}
