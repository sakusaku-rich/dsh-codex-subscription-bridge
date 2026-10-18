import test from 'node:test';
import assert from 'node:assert/strict';

// The client bundle registers itself with the browser module loader, so the test
// stands that loader up, captures the factory, and drives the plugin object the
// way the shell would: through the registries it injects into.
const definitions = [];
const registrations = [];
let plugin;
const react = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  memo: value => value,
  useState: value => [value, () => {}],
  useEffect: () => {},
  useRef: value => ({ current: value }),
  useCallback: value => value,
  useMemo: value => value,
};
globalThis.window = {
  __ModuleLoader__: {
    load: ({ ID, id, factory }) => {
      assert.equal(id ?? ID, 'dsh-codex-subscription-bridge');
      plugin = factory(specifier => {
        assert.equal(specifier, 'react');
        return react;
      });
    },
  },
};
await import('../client.js');

const ctx = {
  connection: {},
  slots: {
    inject: (_name, register) => { register(); },
    register: (options, view) => { registrations.push({ options, view }); return () => {}; },
  },
  uiConversation: {
    events: { register: definition => { definitions.push(definition); return () => {}; } },
  },
};

const checkpointEvent = ({ seq = 7, key = 'subscriptionCompactionV1', count = 2, model = 'gpt-6-luna' } = {}) => ({
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
        replayState: { response: { [key]: { version: 1, createdAt: 1, count } } },
      },
    },
  },
});

test('the client plugin registers a chat node for the published checkpoint', () => {
  assert.deepEqual(plugin.inject, ['slots', 'connection', 'uiConversation']);
  plugin.apply(ctx);
  assert.equal(definitions.length, 1);
  const definition = definitions[0];
  assert.equal(definition.kind, 'server-compaction');
  assert.equal(definition.target, 'chat');
  for (const key of ['match', 'start', 'update', 'buildViewNode']) assert.equal(typeof definition[key], 'function');
  const node = registrations.find(entry => entry.options.name === 'conversation.chat.node');
  assert.equal(node?.options.key, 'server-compaction');
  assert.equal(typeof node?.view, 'function');
  assert.ok(registrations.some(entry => entry.options.name === 'settings.section'), 'the settings card stays registered');
});

test('only a checkpoint-carrying assistant message starts the node', () => {
  const definition = definitions[0];
  const matched = definition.match(checkpointEvent({ seq: 42 }));
  assert.deepEqual(matched, { id: '42', role: 'start' });
  assert.equal(definition.match(checkpointEvent({ key: 'someOtherAdapterV1' })), null);
  assert.equal(definition.match(checkpointEvent({ items: 0 })).role, 'start');
  assert.equal(definition.match({ type: 'user/message', seq: 1, data: {} }), null);
  assert.equal(definition.match({ type: 'assistant/message', seq: 1, data: { message: { source: {} } } }), null);
  assert.equal(definition.match({ type: 'assistant/message', seq: 1, data: { message: { source: { replayState: { response: null } } } } }), null);
  assert.equal(definition.match({ type: 'assistant/message', seq: 1, data: { message: { source: { replayState: { response: { subscriptionCompactionV1: [] } } } } } }), null);
  assert.equal(definition.match(null), null);
  assert.equal(definition.match(undefined), null);
});

test('the node state and view node carry the window facts the marker shows', () => {
  const definition = definitions[0];
  const event = checkpointEvent({ seq: 42, count: 3, model: 'gpt-5.6-terra' });
  const state = definition.start({}, { event });
  assert.equal(state.seq, 42);
  assert.equal(state.items, 3);
  assert.equal(state.model, 'gpt-5.6-terra');
  assert.deepEqual(definition.update({ state }, { event }), state);
  const node = definition.buildViewNode({
    key: 'chat:1', id: 'server-compaction:42', state, start: { location: { kind: 'turn', turn: 4 } },
  });
  assert.equal(node.kind, 'server-compaction');
  assert.equal(node.target, 'chat');
  assert.equal(node.anchorSeq, 42);
  assert.equal(node.visibility, 'visible');
  assert.deepEqual(node.location, { kind: 'turn', turn: 4 });
  assert.equal(node.data.seq, undefined, 'the anchor sequence travels on the node, not in its data');
  assert.equal(node.data.items, 3);
  assert.equal(node.data.model, 'gpt-5.6-terra');
  assert.equal(definition.buildViewNode({ key: 'chat:1', id: 'x', state: undefined, start: undefined }), null);
  assert.throws(() => definition.start({}, { event: { type: 'assistant/message', seq: 1, data: {} } }), /checkpoint/u);
});

test('the marker renders a quiet, model-aware row', () => {
  const view = registrations.find(entry => entry.options.name === 'conversation.chat.node').view;
  const render = data => view({ node: { data } });
  const element = render({ items: 2, model: 'gpt-6-luna' });
  assert.equal(element.type, 'div');
  assert.equal(element.props.role, 'note');
  assert.match(element.props.title, /encrypted window/u);
  const [label, detail] = element.children;
  assert.equal(label.children[0], 'Server-side compaction');
  assert.match(detail.children[0], /encrypted window, 2 items/u);
  assert.match(detail.children[0], /gpt-6-luna/u);
  assert.match(render({ items: 1, model: '' }).children[1].children[0], /1 item(?!s)/u);
  assert.match(render({}).children[1].children[0], /^encrypted window$/u);
});