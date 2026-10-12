import test from 'node:test';
import assert from 'node:assert/strict';
import { assetName, assetUrl, digestMatches, expectedDigest, parseChecksums, releaseTag, sha256Hex } from '../scripts/lib/release.mjs';

const DIGEST = 'a'.repeat(64);

test('release tags accept the published shape and reject anything else', () => {
  assert.equal(releaseTag('v0.1.0'), 'v0.1.0');
  assert.equal(releaseTag('v1.2.3-rc.1'), 'v1.2.3-rc.1');
  for (const value of ['0.1.0', 'v1.2', 'v1.2.3.4', 'main', 'v1.2.3/../x', '', 'v1.2.3\n', null, undefined, 1]) {
    assert.throws(() => releaseTag(value), { code: 'CONFIG_INVALID' });
  }
});

test('asset names reject traversal, separators and control characters', () => {
  assert.equal(assetName('dsh-codex-subscription-bridge-0.1.0.tgz'), 'dsh-codex-subscription-bridge-0.1.0.tgz');
  assert.equal(assetName('SHA256SUMS'), 'SHA256SUMS');
  for (const value of ['../escape', 'a/b', '.', '..', '', '-leading', 'a\u0000b', 'a\nb', 'x'.repeat(129), null]) {
    assert.throws(() => assetName(value), { code: 'CONFIG_INVALID' });
  }
});

test('asset URLs stay on the fixed release host and path prefix', () => {
  const url = new URL(assetUrl('v0.1.0', 'pkg.tgz'));
  assert.equal(url.protocol, 'https:');
  assert.equal(url.host, 'github.com');
  assert.equal(url.pathname, '/sakusaku-rich/dsh-codex-subscription-bridge/releases/download/v0.1.0/pkg.tgz');
  // A dot-segment escape must not survive normalization into a different path.
  assert.throws(() => assetUrl('v0.1.0', '..'), { code: 'CONFIG_INVALID' });
  assert.throws(() => assetUrl('../../evil', 'pkg.tgz'), { code: 'CONFIG_INVALID' });
});

test('checksums parse only the published two-space coreutils format', () => {
  const entries = parseChecksums(`${DIGEST}  a.tgz\n${'b'.repeat(64)}  SHA256SUMS\n`);
  assert.equal(entries.size, 2);
  assert.equal(expectedDigest(entries, 'a.tgz'), DIGEST);
  assert.equal(expectedDigest(entries, 'SHA256SUMS'), 'b'.repeat(64));
  // Tolerate the CRLF a text-mode editor may introduce, but nothing else.
  assert.equal(parseChecksums(`${DIGEST}  a.tgz\r\n`).size, 1);
});

test('a malformed, duplicated or empty checksums file is wholly untrusted', () => {
  for (const text of [
    `${DIGEST} a.tgz\n`,                       // one space, not the published format
    `${DIGEST.toUpperCase()}  a.tgz\n`,        // uppercase digest
    `${'a'.repeat(63)}  a.tgz\n`,              // truncated digest
    `md5-${DIGEST}  a.tgz\n`,                  // algorithm prefix
    `${DIGEST}  a.tgz\n${DIGEST}  a.tgz\n`,    // duplicate entry
    '*a.tgz\n',                                // BSD style marker without digest
    '\n',                                      // no entries
    '',
  ]) {
    assert.throws(() => parseChecksums(text), { code: 'PROTOCOL_INVALID' });
  }
  // An unsafe asset name is rejected by the shared name guard, so the file
  // fails as invalid input rather than as a protocol violation.
  assert.throws(() => parseChecksums(`${DIGEST}  ../escape\n`), { code: 'CONFIG_INVALID' });
  assert.throws(() => parseChecksums(`${DIGEST}  a.tgz\n`, 4), { code: 'PROTOCOL_INVALID' });
  assert.throws(() => parseChecksums(`${DIGEST}  a\u0000.tgz\n`), { code: 'PROTOCOL_INVALID' });
});

test('an unlisted asset is refused instead of silently unverified', () => {
  const entries = parseChecksums(`${DIGEST}  a.tgz\n`);
  assert.equal(expectedDigest(entries, 'a.tgz'), DIGEST);
  assert.throws(() => expectedDigest(entries, 'other.tgz'), { code: 'PROTOCOL_INVALID' });
  assert.throws(() => expectedDigest(entries, '../a.tgz'), { code: 'CONFIG_INVALID' });
  assert.throws(() => expectedDigest(null, 'a.tgz'), { code: 'PROTOCOL_INVALID' });
  assert.throws(() => expectedDigest(new Map(), 'a.tgz'), { code: 'PROTOCOL_INVALID' });
});

test('digest comparison accepts only an exact lowercase match', () => {
  assert.equal(digestMatches(DIGEST, DIGEST), true);
  assert.equal(digestMatches(DIGEST, 'b'.repeat(64)), false);
  // A non-digest argument is invalid input, not a failed comparison.
  assert.throws(() => digestMatches(DIGEST, DIGEST.toUpperCase()), { code: 'CONFIG_INVALID' });
  assert.throws(() => digestMatches(DIGEST, DIGEST.slice(0, -1)), { code: 'CONFIG_INVALID' });
  assert.throws(() => digestMatches('not-a-digest', DIGEST), { code: 'CONFIG_INVALID' });
});

test('sha256 hex is normalized to the fixed lowercase form', () => {
  assert.equal(sha256Hex(DIGEST), DIGEST);
  for (const value of [DIGEST.toUpperCase(), DIGEST.slice(0, 63), `${DIGEST}0`, '', null]) {
    assert.throws(() => sha256Hex(value), { code: 'CONFIG_INVALID' });
  }
});
