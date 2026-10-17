import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
const id = '11111111-1111-4111-8111-111111111111';
test('client registers a settings section and renders only safe state and the fixed login link', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
  let plugin, component, registration;
  const serverState = { phase: 'waiting', active: true, owned: true, attemptId: id,
    device: { url: 'https://untrusted.invalid', code: 'SYNTHETIC-CODE' },
    local: { auth: 'missing' }, error: { message: 'synthetic-token-secret' } };
  const React = { createElement(type, props, ...children) { return { type, props, children }; },
    useState(value) { return [value === null ? serverState : value, () => {}]; }, useRef(value) { return { current: value }; }, useEffect() {} };
  runInNewContext(source, { window: { __ModuleLoader__: { load(descriptor) { assert.equal(descriptor.id, 'dsh-codex-subscription-bridge'); plugin = descriptor.factory(name => { assert.equal(name, 'react'); return React; }); } } }, crypto: { randomUUID: () => id }, setTimeout, clearTimeout, setInterval, clearInterval, AbortController });
  const connection = { isLoopback: true, rpc: { call() { throw new Error('No automatic account operations are permitted during render'); } } };
  // The plugin also registers a Chat node; this test drives the settings card,
  // so only that slot is materialized here.
  plugin.apply({ connection, uiConversation: { events: { register() {} } },
    slots: { inject(slot, callback) { if (slot === 'settings.section') callback(); },
      register(options, view) { registration = options; component = view; } } });
  assert.equal(registration.id, 'codex-subscription');
  const tree = component({ connection }); const serialized = JSON.stringify(tree);
  assert.equal(serialized.includes('synthetic-token-secret'), false);
  assert.equal(serialized.includes('untrusted.invalid'), false);
  assert.ok(serialized.includes('SYNTHETIC-CODE'));
  assert.ok(serialized.includes('https://auth.openai.com/codex/device'));
  assert.ok(serialized.includes('Copy the one-time sign-in code'));
  assert.ok(serialized.includes('Click the code to copy it'));
  assert.equal(serialized.includes('Enter this code'), false);
  serverState.owned = false;
  assert.equal(JSON.stringify(component({ connection })).includes('SYNTHETIC-CODE'), false);
});
test('only a random tab identifier persists across reload; insecure contexts degrade safely', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
  const stored = new Map(); const calls = []; const cleanups = [];
  async function load(crypto, storage, local = true) {
    let plugin, component;
    const React = { createElement(type, props, ...children) { return { type, props, children }; },
      useState(value) { return [value, () => {}]; }, useRef(value) { return { current: value }; }, useEffect(setup) { const cleanup = setup(); if (cleanup) cleanups.push(cleanup); } };
    runInNewContext(source, { window: { sessionStorage: storage, __ModuleLoader__: { load(descriptor) { plugin = descriptor.factory(() => React); } } }, crypto, setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {}, AbortController });
    const connection = { isLoopback: local, rpc: { async call(channel, action, args) { calls.push({ channel, action, args }); return { ok: true, value: { phase: 'idle' } }; } } };
    plugin.apply({ connection, uiConversation: { events: { register() {} } },
      slots: { inject(slot, callback) { callback(); }, register(options, view) { if (options.name === 'settings.section') component = view; } } });
    const tree = component({ connection }); await new Promise(resolve => setImmediate(resolve)); return tree;
  }
  const storage = { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) };
  await load({ randomUUID: () => id }, storage);
  await load({ randomUUID: () => '22222222-2222-4222-8222-222222222222' }, storage);
  assert.equal(calls.length, 2); assert.ok(calls.every(call => call.action.endsWith('/status') && call.args.clientId === id));
  assert.deepEqual([...stored.values()], [id]);
  const tree = await load(undefined, undefined, false);
  assert.ok(JSON.stringify(tree).includes('secure randomness')); assert.equal(calls.length, 2);
  cleanups.forEach(cleanup => cleanup());
});
