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
test('only inherited HOME is retained; external credential locations and keys are ignored', () => {
  assert.deepEqual(authenticationEnvironment({}, { HOME: '/synthetic/home', CODEX_HOME: '/synthetic/codex', OPENAI_API_KEY: 'synthetic-key' }), { HOME: '/synthetic/home' });
});
test('malformed launch snapshots fail closed', () => {
  assert.throws(() => authenticationEnvironment({ get: () => ({}) }), { code: 'CONFIG_INVALID' });
});
test('Desktop uses launcher-owned Harness home for its separate credential store', async () => {
  const { authDirectory } = await import('../src/auth.js');
  assert.equal(authDirectory({ HOME: '/synthetic/shell-home', DSH_HOME: '/synthetic/desktop-harness' }, '44.0.0'), '/synthetic/desktop-harness/.dsh-codex-subscription-bridge');
  assert.equal(authDirectory({ HOME: '/synthetic/home', DSH_HOME: '/synthetic/harness' }, null), '/synthetic/home/.dsh-codex-subscription-bridge');
  assert.throws(() => authDirectory({ HOME: '/synthetic/home', DSH_HOME: 'relative' }, '44.0.0'), { code: 'CONFIG_INVALID' });
});
