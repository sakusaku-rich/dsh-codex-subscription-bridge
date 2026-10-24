import test from 'node:test';
import assert from 'node:assert/strict';

// The client bundle registers itself with the browser module loader, so the test
// stands that loader up, captures the factory, and drives the plugin object the
// way the shell would: through the registries it injects into.
const descriptors = [];
const specifiers = [];
let plugin;
const react = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  memo: (value) => value,
  useState: (value) => [value, () => {}],
  useEffect: () => {},
  useRef: (value) => ({ current: value }),
  useCallback: (value) => value,
  useMemo: (value) => value,
};
globalThis.window = {
  __ModuleLoader__: {
    load: (descriptor) => {
      descriptors.push(descriptor);
      plugin = descriptor.factory((specifier) => {
        specifiers.push(specifier);
        return react;
      });
    },
  },
};
await import('../client.js');

/** A checkpoint event as the conversation registry would receive it. */
const checkpointEvent = ({ seq = 7, key = 'subscriptionCompactionV1', items = 2, model = 'gpt-6-luna' } = {}) => ({
  type: 'assistant/message',
  seq,
  time: 1_700_000_000_000,
  data: {
    message: {
      role: 'assistant',
      source: {
        kind: 'assistant',
        provider: 'codex-subscription',
        model,
        replayState: { response: { [key]: { version: 1, createdAt: 1, items: Array.from({ length: items }, (_, index) => ({ type: 'compaction', index })) } } },
      },
    },
  },
});

/** The plugin driven through fresh stand-in registries, with the disposers they hand back. */
function fixture() {
  const definitions = [];
  const registrations = [];
  const disposers = [];
  const deregister = (entry, entries) => () => { entries.splice(entries.indexOf(entry), 1); };
  const ctx = {
    connection: {},
    slots: {
      inject: (name, register) => { register(); },
      register: (options, view) => {
        const entry = { options, view };
        registrations.push(entry);
        const dispose = deregister(entry, registrations);
        disposers.push(dispose);
        return dispose;
      },
    },
    uiConversation: {
      events: {
        register: (definition) => {
          definitions.push(definition);
          const dispose = deregister(definition, definitions);
          disposers.push(dispose);
          return dispose;
        },
      },
    },
  };
  plugin.apply(ctx);
  return { definitions, registrations, disposers };
}

test('the client bundle registers itself under the published module id', () => {
  assert.deepEqual(descriptors.map((descriptor) => descriptor.id ?? descriptor.ID), ['dsh-codex-subscription-bridge']);
});

test('the plugin factory receives only react', () => {
  assert.deepEqual(specifiers, ['react']);
});

test('the client plugin injects the slots, connection and conversation registries', () => {
  assert.deepEqual(plugin.inject, ['slots', 'connection', 'uiConversation']);
});

test('the client plugin registers one conversation event definition', () => {
  const f = fixture();

  assert.equal(f.definitions.length, 1);

  f.disposers.forEach((dispose) => dispose());
});

test('the event definition is the server-compaction chat node', () => {
  const f = fixture();
  const definition = f.definitions[0];

  assert.equal(definition.kind, 'server-compaction');
  assert.equal(definition.target, 'chat');

  f.disposers.forEach((dispose) => dispose());
});

test('the event definition exposes the node functions', () => {
  const f = fixture();
  const definition = f.definitions[0];

  for (const key of ['match', 'start', 'update', 'buildViewNode']) assert.equal(typeof definition[key], 'function');

  f.disposers.forEach((dispose) => dispose());
});

test('the chat node registration carries the server-compaction key', () => {
  const f = fixture();
  const node = f.registrations.find((entry) => entry.options.name === 'conversation.chat.node');

  assert.equal(node.options.key, 'server-compaction');

  f.disposers.forEach((dispose) => dispose());
});

test('the chat node registration exposes a view function', () => {
  const f = fixture();
  const node = f.registrations.find((entry) => entry.options.name === 'conversation.chat.node');

  assert.equal(typeof node.view, 'function');

  f.disposers.forEach((dispose) => dispose());
});

test('the settings card stays registered alongside the chat node', () => {
  const f = fixture();

  assert.ok(f.registrations.some((entry) => entry.options.name === 'settings.section'), 'the settings card stays registered');

  f.disposers.forEach((dispose) => dispose());
});

test('a checkpoint-carrying assistant message starts the node', () => {
  const f = fixture();
  const definition = f.definitions[0];

  const matched = definition.match(checkpointEvent({ seq: 42 }));

  assert.deepEqual(matched, { id: '42', role: 'start' });

  f.disposers.forEach((dispose) => dispose());
});

test('a checkpoint from another adapter does not start the node', () => {
  const f = fixture();
  const definition = f.definitions[0];

  assert.equal(definition.match(checkpointEvent({ key: 'someOtherAdapterV1' })), null);

  f.disposers.forEach((dispose) => dispose());
});

test('a checkpoint with no items still starts the node', () => {
  const f = fixture();
  const definition = f.definitions[0];

  assert.equal(definition.match(checkpointEvent({ items: 0 })).role, 'start');

  f.disposers.forEach((dispose) => dispose());
});

test('anything without a checkpoint does not start the node', () => {
  const f = fixture();
  const definition = f.definitions[0];

  for (const event of [
    { type: 'user/message', seq: 1, data: {} },
    { type: 'assistant/message', seq: 1, data: { message: { source: {} } } },
    { type: 'assistant/message', seq: 1, data: { message: { source: { replayState: { response: null } } } } },
    { type: 'assistant/message', seq: 1, data: { message: { source: { replayState: { response: { subscriptionCompactionV1: [] } } } } } },
    null,
    undefined,
  ]) assert.equal(definition.match(event), null);

  f.disposers.forEach((dispose) => dispose());
});

test('the node state carries the window facts', () => {
  const f = fixture();
  const definition = f.definitions[0];
  const event = checkpointEvent({ seq: 42, items: 3, model: 'gpt-5.6-terra' });

  const state = definition.start({}, { event });

  assert.equal(state.seq, 42);
  assert.equal(state.items, 3);
  assert.equal(state.model, 'gpt-5.6-terra');

  f.disposers.forEach((dispose) => dispose());
});

test('update keeps the node state unchanged', () => {
  const f = fixture();
  const definition = f.definitions[0];
  const event = checkpointEvent({ seq: 42, items: 3, model: 'gpt-5.6-terra' });
  const state = definition.start({}, { event });

  const updated = definition.update({ state }, { event });

  assert.deepEqual(updated, state);

  f.disposers.forEach((dispose) => dispose());
});

test('the view node is the chat marker anchored at the checkpoint', () => {
  const f = fixture();
  const definition = f.definitions[0];
  const event = checkpointEvent({ seq: 42, items: 3, model: 'gpt-5.6-terra' });
  const state = definition.start({}, { event });

  const node = definition.buildViewNode({ key: 'chat:1', id: 'server-compaction:42', state, start: { location: { kind: 'turn', turn: 4 } } });

  assert.equal(node.kind, 'server-compaction');
  assert.equal(node.target, 'chat');
  assert.equal(node.anchorSeq, 42);
  assert.equal(node.visibility, 'visible');
  assert.deepEqual(node.location, { kind: 'turn', turn: 4 });

  f.disposers.forEach((dispose) => dispose());
});

test('the view node data carries the window facts without the anchor sequence', () => {
  const f = fixture();
  const definition = f.definitions[0];
  const event = checkpointEvent({ seq: 42, items: 3, model: 'gpt-5.6-terra' });
  const state = definition.start({}, { event });

  const node = definition.buildViewNode({ key: 'chat:1', id: 'server-compaction:42', state, start: { location: { kind: 'turn', turn: 4 } } });

  assert.equal(node.data.seq, undefined, 'the anchor sequence travels on the node, not in its data');
  assert.equal(node.data.items, 3);
  assert.equal(node.data.model, 'gpt-5.6-terra');

  f.disposers.forEach((dispose) => dispose());
});

test('a view node without state is refused', () => {
  const f = fixture();
  const definition = f.definitions[0];

  assert.equal(definition.buildViewNode({ key: 'chat:1', id: 'x', state: undefined, start: undefined }), null);

  f.disposers.forEach((dispose) => dispose());
});

test('starting the node without a checkpoint is refused', () => {
  const f = fixture();
  const definition = f.definitions[0];

  assert.throws(() => definition.start({}, { event: { type: 'assistant/message', seq: 1, data: {} } }), /checkpoint/u);

  f.disposers.forEach((dispose) => dispose());
});

test('the marker renders as a note element', () => {
  const f = fixture();
  const view = f.registrations.find((entry) => entry.options.name === 'conversation.chat.node').view;

  const element = view({ node: { data: { items: 2, model: 'gpt-6-luna' } } });

  assert.equal(element.type, 'div');
  assert.equal(element.props.role, 'note');

  f.disposers.forEach((dispose) => dispose());
});

test('the marker title names the encrypted window', () => {
  const f = fixture();
  const view = f.registrations.find((entry) => entry.options.name === 'conversation.chat.node').view;

  const element = view({ node: { data: { items: 2, model: 'gpt-6-luna' } } });

  assert.match(element.props.title, /encrypted window/u);

  f.disposers.forEach((dispose) => dispose());
});

test('the marker label names server-side compaction', () => {
  const f = fixture();
  const view = f.registrations.find((entry) => entry.options.name === 'conversation.chat.node').view;

  const element = view({ node: { data: { items: 2, model: 'gpt-6-luna' } } });

  assert.equal(element.children[0].children[0], 'Server-side compaction');

  f.disposers.forEach((dispose) => dispose());
});

test('the marker detail carries the item count and the model', () => {
  const f = fixture();
  const view = f.registrations.find((entry) => entry.options.name === 'conversation.chat.node').view;

  const element = view({ node: { data: { items: 2, model: 'gpt-6-luna' } } });

  assert.match(element.children[1].children[0], /encrypted window, 2 items/u);
  assert.match(element.children[1].children[0], /gpt-6-luna/u);

  f.disposers.forEach((dispose) => dispose());
});

test('the marker detail uses the singular for one item', () => {
  const f = fixture();
  const view = f.registrations.find((entry) => entry.options.name === 'conversation.chat.node').view;

  const element = view({ node: { data: { items: 1, model: '' } } });

  assert.match(element.children[1].children[0], /1 item(?!s)/u);

  f.disposers.forEach((dispose) => dispose());
});

test('the marker detail without a model names only the window', () => {
  const f = fixture();
  const view = f.registrations.find((entry) => entry.options.name === 'conversation.chat.node').view;

  const element = view({ node: { data: {} } });

  assert.match(element.children[1].children[0], /^encrypted window$/u);

  f.disposers.forEach((dispose) => dispose());
});
