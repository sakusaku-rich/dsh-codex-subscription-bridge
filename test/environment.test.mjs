import test from 'node:test';
import assert from 'node:assert/strict';
import { authenticationEnvironment } from '../src/environment.js';
test('project and user dotenv locations cannot replace inherited authentication home', () => {
  const ctx = { get() { return { getFrom(name, sources) {
    assert.deepEqual(sources, ['process']);
    return name === 'HOME' ? { value: '/synthetic/inherited-home', source: 'process' } : undefined;
  } }; } };
  assert.deepEqual(authenticationEnvironment(ctx, { HOME: '/flattened', CODEX_HOME: '/synthetic/project-home' }), { HOME: '/synthetic/inherited-home' });
});
test('explicit inherited Codex home is retained without forwarding tokens', () => {
  assert.deepEqual(authenticationEnvironment({}, { HOME: '/synthetic/home', CODEX_HOME: '/synthetic/codex', OPENAI_API_KEY: 'synthetic-key' }), { HOME: '/synthetic/home', CODEX_HOME: '/synthetic/codex' });
});
test('malformed launch snapshots fail closed', () => {
  assert.throws(() => authenticationEnvironment({ get: () => ({}) }), { code: 'CONFIG_INVALID' });
});
