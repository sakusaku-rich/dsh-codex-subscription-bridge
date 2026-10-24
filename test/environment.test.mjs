import test from 'node:test';
import assert from 'node:assert/strict';
import { authenticationEnvironment } from '../lib/environment.js';
import { authDirectory } from '../lib/auth.js';

/** A launch-environment snapshot that answers only from the process source. */
function snapshot(values, asked) {
  return { get: () => ({ getFrom: (name, sources) => {
    asked.push(sources);
    return values[name] === undefined ? undefined : { value: values[name], source: 'process' };
  } }) };
}

test('authenticationEnvironment reads only the process source', async () => {
  const asked = [];
  const ctx = snapshot({ HOME: '/synthetic/inherited-home' }, asked);

  authenticationEnvironment(ctx, { HOME: '/flattened' });

  assert.ok(asked.length >= 1);
  for (const sources of asked) assert.deepEqual(sources, ['process']);
});

test('project and user dotenv locations cannot replace inherited authentication home', async () => {
  const ctx = snapshot({ HOME: '/synthetic/inherited-home' }, []);

  const result = authenticationEnvironment(ctx, { HOME: '/flattened', CODEX_HOME: '/synthetic/project-home' });

  assert.deepEqual(result, { HOME: '/synthetic/inherited-home' });
});

test('external credential locations and keys are ignored when no snapshot answers', async () => {
  const result = authenticationEnvironment({}, { HOME: '/synthetic/home', CODEX_HOME: '/synthetic/codex', OPENAI_API_KEY: 'synthetic-key' });

  assert.deepEqual(result, { HOME: '/synthetic/home' });
});

test('malformed launch snapshots fail closed', async () => {
  assert.throws(() => authenticationEnvironment({ get: () => ({}) }), { code: 'CONFIG_INVALID' });
});

test('Desktop uses the launcher-owned Harness home for its separate credential store', async () => {
  const result = authDirectory({ HOME: '/synthetic/shell-home', DSH_HOME: '/synthetic/desktop-harness' }, '44.7.0');

  assert.equal(result, '/synthetic/desktop-harness/.dsh-codex-subscription-bridge');
});

test('the standalone store falls back to the shell home when the launcher owns none', async () => {
  const result = authDirectory({ HOME: '/synthetic/home', DSH_HOME: '/synthetic/harness' }, null);

  assert.equal(result, '/synthetic/home/.dsh-codex-subscription-bridge');
});

test('a relative credential store path is refused', async () => {
  assert.throws(() => authDirectory({ HOME: '/synthetic/home', DSH_HOME: 'relative' }, '44.7.0'), { code: 'CONFIG_INVALID' });
});
