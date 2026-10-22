import { BridgeError } from './errors.js';
/** Refuse runtimes below the security-fixed, verified Node 22 baseline or the tested Desktop host. */
export function assertNodeVersion(version: string = process.versions.node, electron: string | undefined = process.versions.electron): void {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/u.test(version)) throw new BridgeError('NODE_VERSION_UNSUPPORTED');
  // The pattern test above guarantees exactly three numeric parts.
  const [major, minor, patch] = version.split('.').map(Number) as [number, number, number];
  const standalone = major === 22 && (minor > 23 || (minor === 23 && patch >= 3));
  const desktop = version === '24.21.0' && electron === '44.7.0';
  if (!standalone && !desktop) throw new BridgeError('NODE_VERSION_UNSUPPORTED');
}

export function assertPlatform(platform: string = process.platform): void {
  if (platform !== 'darwin') throw new BridgeError('PLATFORM_UNSUPPORTED');
}
