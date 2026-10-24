import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const id = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';

/** The server state the settings card renders from, one copy per case. */
const serverState = () => ({
  phase: 'waiting',
  active: true,
  owned: true,
  attemptId: id,
  device: { url: 'https://untrusted.invalid', code: 'SYNTHETIC-CODE' },
  local: { auth: 'missing' },
  error: { message: 'synthetic-token-secret' },
});

/** A stand-in sessionStorage backed by a map shared across reloads. */
const storageFrom = (stored) => ({
  getItem: (key) => stored.get(key),
  setItem: (key, value) => stored.set(key, value),
});

/** The client bundle evaluated against a stand-in loader, React and a connection that refuses account calls during render. */
async function renderFixture(state) {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
  const descriptors = [];
  const specifiers = [];
  const definitions = [];
  const registrations = [];
  const cleanups = [];
  let plugin;
  let component;
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (value) => [value === null ? state : value, () => {}],
    useRef: (value) => ({ current: value }),
    useEffect: () => {},
  };
  runInNewContext(source, {
    window: { __ModuleLoader__: { load: (descriptor) => { descriptors.push(descriptor); plugin = descriptor.factory((name) => { specifiers.push(name); return react; }); } } },
    crypto: { randomUUID: () => id },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    AbortController,
  });
  const connection = { isLoopback: true, rpc: { call: () => { throw new Error('No automatic account operations are permitted during render'); } } };
  const deregister = (entry, entries) => () => { entries.splice(entries.indexOf(entry), 1); };
  plugin.apply({
    connection,
    uiConversation: { events: { register: (definition) => { definitions.push(definition); return deregister(definition, definitions); } } },
    slots: {
      inject: (slot, callback) => { if (slot === 'settings.section') callback(); },
      register: (options, view) => {
        const entry = { options, view };
        registrations.push(entry);
        if (options.name === 'settings.section') component = view;
        return deregister(entry, registrations);
      },
    },
  });
  return { descriptors, specifiers, definitions, registrations, component, connection, cleanups };
}

/** The client bundle evaluated against a stand-in loader that records the calls the settings card makes. */
async function loadClient({ crypto, storage, local = true }) {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
  const calls = [];
  const cleanups = [];
  let plugin;
  let component;
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (value) => [value, () => {}],
    useRef: (value) => ({ current: value }),
    useEffect: (setup) => { const cleanup = setup(); if (cleanup) cleanups.push(cleanup); },
  };
  runInNewContext(source, {
    window: { sessionStorage: storage, __ModuleLoader__: { load: (descriptor) => { plugin = descriptor.factory(() => react); } } },
    crypto,
    setTimeout,
    clearTimeout,
    setInterval: () => 1,
    clearInterval: () => {},
    AbortController,
  });
  const connection = { isLoopback: local, rpc: { call: async (channel, action, args) => { calls.push({ channel, action, args }); return { ok: true, value: { phase: 'idle' } }; } } };
  plugin.apply({
    connection,
    uiConversation: { events: { register: () => {} } },
    slots: {
      inject: (slot, callback) => { callback(); },
      register: (options, view) => { if (options.name === 'settings.section') component = view; },
    },
  });
  const tree = component({ connection });
  await new Promise((resolve) => setImmediate(resolve));
  return { tree, calls, cleanups };
}

test('the client bundle registers itself under the published module id', async () => {
  const f = await renderFixture(serverState());

  assert.equal(f.descriptors.length, 1);
  assert.equal(f.descriptors[0].id, 'dsh-codex-subscription-bridge');

  f.cleanups.forEach((cleanup) => cleanup());
});

test('the plugin factory receives only react', async () => {
  const f = await renderFixture(serverState());

  assert.deepEqual(f.specifiers, ['react']);

  f.cleanups.forEach((cleanup) => cleanup());
});

test('the client plugin registers a settings section under its own id', async () => {
  const f = await renderFixture(serverState());

  assert.equal(f.registrations.length, 1);
  assert.equal(f.registrations[0].options.id, 'codex-subscription');

  f.cleanups.forEach((cleanup) => cleanup());
});

test('the rendered settings card does not carry the server error message', async () => {
  const f = await renderFixture(serverState());

  const serialized = JSON.stringify(f.component({ connection: f.connection }));

  assert.equal(serialized.includes('synthetic-token-secret'), false);

  f.cleanups.forEach((cleanup) => cleanup());
});

test('the rendered settings card does not carry the untrusted device url', async () => {
  const f = await renderFixture(serverState());

  const serialized = JSON.stringify(f.component({ connection: f.connection }));

  assert.equal(serialized.includes('untrusted.invalid'), false);

  f.cleanups.forEach((cleanup) => cleanup());
});

test('the rendered settings card shows the device code to the owning client', async () => {
  const f = await renderFixture(serverState());

  const serialized = JSON.stringify(f.component({ connection: f.connection }));

  assert.ok(serialized.includes('SYNTHETIC-CODE'));

  f.cleanups.forEach((cleanup) => cleanup());
});

test('the rendered settings card links only the fixed login page', async () => {
  const f = await renderFixture(serverState());

  const serialized = JSON.stringify(f.component({ connection: f.connection }));

  assert.ok(serialized.includes('https://auth.openai.com/codex/device'));

  f.cleanups.forEach((cleanup) => cleanup());
});

test('the rendered settings card explains that the code is copied from the card', async () => {
  const f = await renderFixture(serverState());

  const serialized = JSON.stringify(f.component({ connection: f.connection }));

  assert.ok(serialized.includes('Copy the one-time sign-in code'));
  assert.ok(serialized.includes('Click the code to copy it'));

  f.cleanups.forEach((cleanup) => cleanup());
});

test('the rendered settings card does not ask the user to enter the code', async () => {
  const f = await renderFixture(serverState());

  const serialized = JSON.stringify(f.component({ connection: f.connection }));

  assert.equal(serialized.includes('Enter this code'), false);

  f.cleanups.forEach((cleanup) => cleanup());
});

test('the settings card hides the device code from a client that does not own the attempt', async () => {
  const state = serverState();
  const f = await renderFixture(state);
  state.owned = false;

  const serialized = JSON.stringify(f.component({ connection: f.connection }));

  assert.equal(serialized.includes('SYNTHETIC-CODE'), false);

  f.cleanups.forEach((cleanup) => cleanup());
});

test('only the first random tab identifier persists across reload', async () => {
  const stored = new Map();
  const storage = storageFrom(stored);
  const first = await loadClient({ crypto: { randomUUID: () => id }, storage });
  const second = await loadClient({ crypto: { randomUUID: () => other }, storage });

  assert.deepEqual([...stored.values()], [id]);

  first.cleanups.forEach((cleanup) => cleanup());
  second.cleanups.forEach((cleanup) => cleanup());
});

test('each load reports status once for the persisted tab identifier', async () => {
  const stored = new Map();
  const storage = storageFrom(stored);
  const first = await loadClient({ crypto: { randomUUID: () => id }, storage });
  const second = await loadClient({ crypto: { randomUUID: () => other }, storage });

  assert.equal(first.calls.length, 1);
  assert.equal(second.calls.length, 1);
  assert.ok(first.calls.every((call) => call.action.endsWith('/status') && call.args.clientId === id));
  assert.ok(second.calls.every((call) => call.action.endsWith('/status') && call.args.clientId === id));

  first.cleanups.forEach((cleanup) => cleanup());
  second.cleanups.forEach((cleanup) => cleanup());
});

test('an insecure context renders the secure randomness notice', async () => {
  const insecure = await loadClient({ crypto: undefined, storage: undefined, local: false });

  assert.ok(JSON.stringify(insecure.tree).includes('secure randomness'));

  insecure.cleanups.forEach((cleanup) => cleanup());
});

test('an insecure context makes no account call', async () => {
  const insecure = await loadClient({ crypto: undefined, storage: undefined, local: false });

  assert.equal(insecure.calls.length, 0);

  insecure.cleanups.forEach((cleanup) => cleanup());
});
