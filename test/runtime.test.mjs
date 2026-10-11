import test from 'node:test';
import assert from 'node:assert/strict';
import { assertNodeVersion } from '../src/runtime.js';
test('security-fixed Node 22 runtimes are admitted and older/unverified runtimes are refused', () => {
  for (const version of ['22.23.3', '22.23.4', '22.24.0']) assert.doesNotThrow(() => assertNodeVersion(version));
  for (const version of ['22.23.2', '22.22.9', '20.0.0', '23.0.0', '24.0.0', '22.23.3-rc.1', '', null]) assert.throws(() => assertNodeVersion(version), { code: 'NODE_VERSION_UNSUPPORTED' });
});
