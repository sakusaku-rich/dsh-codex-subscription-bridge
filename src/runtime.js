import { BridgeError } from './errors.js';
/** Refuse runtimes below the security-fixed, verified Node 22 baseline or the tested Desktop host. */
export function assertNodeVersion(version = process.versions.node, electron = process.versions.electron) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/u.test(version)) throw new BridgeError('NODE_VERSION_UNSUPPORTED');
  const [major, minor, patch] = version.split('.').map(Number);
  const standalone = major === 22 && (minor > 23 || (minor === 23 && patch >= 3));
  const desktop = version === '24.18.1' && electron === '44.0.0';
  if (!standalone && !desktop) throw new BridgeError('NODE_VERSION_UNSUPPORTED');
}

export function assertPlatform(platform = process.platform) {
  if (platform !== 'darwin') throw new BridgeError('PLATFORM_UNSUPPORTED');
}
