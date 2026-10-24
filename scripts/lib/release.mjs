import { createHash, timingSafeEqual } from 'node:crypto';
import { BridgeError } from '../../lib/errors.js';

/** Release host and repository are fixed; an installer never takes an origin override. */
export const RELEASE_HOST = 'github.com';
export const RELEASE_OWNER = 'sakusaku-rich';
export const RELEASE_REPOSITORY = 'dsh-codex-subscription-bridge';
export const CHECKSUMS_ASSET = 'SHA256SUMS';
export const INSTALL_ASSET = 'install.sh';

// A release tag is a v-prefixed semver triple. Prereleases of the prototype are
// allowed so a candidate can be installed without pretending it is final.
const TAG_PATTERN = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
// Assets are flat file names; separators, dot segments and control characters
// would let a manifest reach outside its own release.
const ASSET_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

/** Normalize a caller-supplied release tag and reject anything that is not a fixed tag name. */
export function releaseTag(value) {
  if (typeof value !== 'string' || !TAG_PATTERN.test(value)) throw new BridgeError('CONFIG_INVALID');
  return value;
}

/** Reject asset names that could traverse or name a non-release path. */
export function assetName(value) {
  if (typeof value !== 'string' || !ASSET_PATTERN.test(value) || value === '.' || value === '..') {
    throw new BridgeError('CONFIG_INVALID');
  }
  return value;
}

/** Lowercase SHA-256 hex only; no algorithm prefixes, whitespace or length drift. */
export function sha256Hex(value) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) throw new BridgeError('CONFIG_INVALID');
  return value;
}

/**
 * Fixed download URL for one release asset. The parsed URL is re-checked after
 * WHATWG normalization so dot-segment escapes cannot leave the fixed prefix.
 */
export function assetUrl(tag, asset) {
  const path = `/${RELEASE_OWNER}/${RELEASE_REPOSITORY}/releases/download/${releaseTag(tag)}/${assetName(asset)}`;
  const url = new URL(path, `https://${RELEASE_HOST}`);
  if (url.protocol !== 'https:' || url.host !== RELEASE_HOST || !url.pathname.startsWith(path)) {
    throw new BridgeError('CONFIG_INVALID');
  }
  return url.toString();
}

/**
 * Parse a published `SHA256SUMS` file into a name-to-digest map. The accepted
 * subset is the coreutils format this project publishes: one lowercase digest,
 * two spaces, and a bare asset name. Any other line, duplicate, or unreadable
 * byte makes the whole file untrusted rather than partially trusted.
 */
export function parseChecksums(text, limit = 64 * 1024) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > limit || /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) {
    throw new BridgeError('PROTOCOL_INVALID');
  }
  const entries = new Map();
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line === '') continue;
    const match = /^([0-9a-f]{64}) {2}(.+)$/u.exec(line);
    if (!match) throw new BridgeError('PROTOCOL_INVALID');
    const name = assetName(match[2]);
    if (entries.has(name)) throw new BridgeError('PROTOCOL_INVALID');
    entries.set(name, match[1]);
  }
  if (entries.size === 0) throw new BridgeError('PROTOCOL_INVALID');
  return entries;
}

/**
 * The digest an asset must match, or a refusal. A missing entry is a refusal,
 * not a silent skip: an unlisted asset was never integrity-verified.
 */
export function expectedDigest(entries, asset) {
  if (!(entries instanceof Map)) throw new BridgeError('PROTOCOL_INVALID');
  const digest = entries.get(assetName(asset));
  if (digest === undefined) throw new BridgeError('PROTOCOL_INVALID');
  return sha256Hex(digest);
}

/**
 * Compare a computed digest with the published one in constant time. The
 * comparison is length-independent because both sides are already validated
 * lowercase SHA-256 hex, so a mismatch reveals nothing about the expected value.
 */
export function digestMatches(actual, expected) {
  const left = Buffer.from(sha256Hex(actual), 'utf8');
  const right = Buffer.from(sha256Hex(expected), 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Streaming SHA-256 over bounded chunks; the caller never needs a whole file in memory. */
export function createDigest() {
  return createHash('sha256');
}
