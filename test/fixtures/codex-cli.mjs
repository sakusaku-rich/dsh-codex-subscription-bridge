import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
if (process.argv.includes('--version')) {
  console.log('codex-cli 0.144.6');
} else {
  assert.equal(process.env.OPENAI_API_KEY, undefined);
  if (basename(process.argv[1]).includes('origin')) assert.equal(realpathSync(process.env.CODEX_HOME), realpathSync(join(dirname(process.argv[1]), 'home', '.codex')));
  const threadId = `synthetic-thread-${process.pid}`;
  const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
  createInterface({ input: process.stdin }).on('line', (line) => {
    const message = JSON.parse(line);
    if (message.id === undefined) return;
    let result;
    switch (message.method) {
      case 'initialize': result = { userAgent: 'synthetic-codex/0.144.6' }; break;
      case 'getAuthStatus': result = { authMethod: basename(process.argv[1]).includes('apikey') ? 'apikey' : 'chatgpt', authToken: null, requiresOpenaiAuth: true }; break;
      case 'account/read': result = { account: { type: basename(process.argv[1]).includes('apikey') ? 'apikey' : 'chatgpt' }, requiresOpenaiAuth: true }; break;
      case 'model/list': result = { data: [{ model: 'synthetic-model', displayName: 'Synthetic model', hidden: false }], nextCursor: null }; break;
      case 'thread/start': result = { thread: { id: threadId } }; break;
      case 'thread/inject_items': result = {}; break;
      case 'turn/start':
        result = { turn: { id: 'synthetic-turn' } };
        send({ id: message.id, result });
        send({ method: 'item/agentMessage/delta', params: { threadId, turnId: 'synthetic-turn', itemId: 'synthetic-message', delta: 'Synthetic response' } });
        send({ method: 'turn/completed', params: { threadId, turn: { id: 'synthetic-turn', status: 'completed' } } });
        return;
      case 'turn/interrupt': result = {}; break;
      default: send({ id: message.id, error: { code: -1, message: 'Synthetic unsupported request' } }); return;
    }
    send({ id: message.id, result });
  });
}
