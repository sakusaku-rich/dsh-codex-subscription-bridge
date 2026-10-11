import { BridgeError } from './errors.js';
/** Refuse runtimes below the security-fixed, verified Node 22 baseline. */
export function assertNodeVersion(version = process.versions.node) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/u.test(version)) throw new BridgeError('NODE_VERSION_UNSUPPORTED');
  const [major, minor, patch] = version.split('.').map(Number);
  if (major !== 22 || minor < 23 || (minor === 23 && patch < 3)) throw new BridgeError('NODE_VERSION_UNSUPPORTED');
}
