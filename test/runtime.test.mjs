import test from 'node:test';
import assert from 'node:assert/strict';
import { assertNodeVersion, assertPlatform } from '../lib/runtime.js';

test('Node 22 runtimes at or above the security-fixed baseline are admitted', () => {
  for (const version of ['22.23.3', '22.23.4', '22.24.0']) assert.doesNotThrow(() => assertNodeVersion(version));
});

test('Node 22 below the security-fixed baseline and other major lines are refused', () => {
  for (const version of ['22.23.2', '22.22.9', '20.0.0', '23.0.0', '24.0.0', '22.23.3-rc.1', '', null])
    assert.throws(() => assertNodeVersion(version), { code: 'NODE_VERSION_UNSUPPORTED' });
});

test('the platform contract admits macOS', () => {
  assert.doesNotThrow(() => assertPlatform('darwin'));
});

test('the platform contract refuses unverified platforms', () => {
  for (const platform of ['linux', 'win32', 'freebsd', ''])
    assert.throws(() => assertPlatform(platform), { code: 'PLATFORM_UNSUPPORTED' });
});

test('the tested Desktop host pair is admitted', () => {
  assert.doesNotThrow(() => assertNodeVersion('24.21.0', '44.7.0'));
});

test('a Desktop runtime outside the tested host pair is refused', () => {
  for (const [node, electron] of [['24.21.0', null], ['24.21.0', '44.0.0'], ['24.18.1', '44.7.0'], ['24.21.1', '44.7.0']])
    assert.throws(() => assertNodeVersion(node, electron), { code: 'NODE_VERSION_UNSUPPORTED' });
});
