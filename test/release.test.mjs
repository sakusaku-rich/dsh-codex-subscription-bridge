import test from 'node:test';
import assert from 'node:assert/strict';
import { assetName, assetUrl, digestMatches, expectedDigest, parseChecksums, releaseTag, sha256Hex } from '../scripts/lib/release.mjs';

const DIGEST = 'a'.repeat(64);

test('release tags accept the published tag shape', () => {
  for (const value of ['v0.1.0', 'v1.2.3-rc.1']) assert.equal(releaseTag(value), value);
});

test('release tags reject anything outside the published tag shape', () => {
  for (const value of ['0.1.0', 'v1.2', 'v1.2.3.4', 'main', 'v1.2.3/../x', '', 'v1.2.3\n', null, undefined, 1]) {
    assert.throws(() => releaseTag(value), { code: 'CONFIG_INVALID' });
  }
});

test('asset names accept the published asset name form', () => {
  for (const value of ['dsh-codex-subscription-bridge-0.1.0.tgz', 'SHA256SUMS']) assert.equal(assetName(value), value);
});

test('asset names reject traversal, separators and control characters', () => {
  for (const value of ['../escape', 'a/b', '.', '..', '', '-leading', 'a\u0000b', 'a\nb', 'x'.repeat(129), null]) {
    assert.throws(() => assetName(value), { code: 'CONFIG_INVALID' });
  }
});

test('asset URLs stay on the fixed release host and path prefix', () => {
  const url = new URL(assetUrl('v0.1.0', 'pkg.tgz'));

  assert.equal(url.protocol, 'https:');
  assert.equal(url.host, 'github.com');
  assert.equal(url.pathname, '/sakusaku-rich/dsh-codex-subscription-bridge/releases/download/v0.1.0/pkg.tgz');
});

test('a dot-segment escape in the asset name is refused', () => {
  assert.throws(() => assetUrl('v0.1.0', '..'), { code: 'CONFIG_INVALID' });
});

test('a dot-segment escape in the release tag is refused', () => {
  assert.throws(() => assetUrl('../../evil', 'pkg.tgz'), { code: 'CONFIG_INVALID' });
});

test('the published two-space coreutils format parses to its entries', () => {
  const entries = parseChecksums(`${DIGEST}  a.tgz\n${'b'.repeat(64)}  SHA256SUMS\n`);

  assert.equal(entries.size, 2);
});

test('a parsed entry answers for the asset it lists', () => {
  const entries = parseChecksums(`${DIGEST}  a.tgz\n${'b'.repeat(64)}  SHA256SUMS\n`);

  assert.equal(expectedDigest(entries, 'a.tgz'), DIGEST);
  assert.equal(expectedDigest(entries, 'SHA256SUMS'), 'b'.repeat(64));
});

test('the checksums parser tolerates the CRLF a text-mode editor may introduce', () => {
  const entries = parseChecksums(`${DIGEST}  a.tgz\r\n`);

  assert.equal(entries.size, 1);
});

test('a malformed, duplicated or empty checksums file is wholly untrusted', () => {
  for (const text of [
    `${DIGEST} a.tgz\n`,
    `${DIGEST.toUpperCase()}  a.tgz\n`,
    `${'a'.repeat(63)}  a.tgz\n`,
    `md5-${DIGEST}  a.tgz\n`,
    `${DIGEST}  a.tgz\n${DIGEST}  a.tgz\n`,
    '*a.tgz\n',
    '\n',
    '',
  ]) assert.throws(() => parseChecksums(text), { code: 'PROTOCOL_INVALID' });
});

test('an unsafe asset name in a checksums file fails as invalid input', () => {
  assert.throws(() => parseChecksums(`${DIGEST}  ../escape\n`), { code: 'CONFIG_INVALID' });
});

test('a checksums file past its size bound is refused', () => {
  assert.throws(() => parseChecksums(`${DIGEST}  a.tgz\n`, 4), { code: 'PROTOCOL_INVALID' });
});

test('a control character in a checksums entry is refused', () => {
  assert.throws(() => parseChecksums(`${DIGEST}  a\u0000.tgz\n`), { code: 'PROTOCOL_INVALID' });
});

test('a checksums entry answers for the asset it lists', () => {
  const entries = parseChecksums(`${DIGEST}  a.tgz\n`);

  assert.equal(expectedDigest(entries, 'a.tgz'), DIGEST);
});

test('an unlisted asset is refused instead of silently unverified', () => {
  const entries = parseChecksums(`${DIGEST}  a.tgz\n`);

  assert.throws(() => expectedDigest(entries, 'other.tgz'), { code: 'PROTOCOL_INVALID' });
});

test('an unsafe asset name is refused as invalid input', () => {
  const entries = parseChecksums(`${DIGEST}  a.tgz\n`);

  assert.throws(() => expectedDigest(entries, '../a.tgz'), { code: 'CONFIG_INVALID' });
});

test('a missing or empty checksums map is refused', () => {
  for (const entries of [null, new Map()]) assert.throws(() => expectedDigest(entries, 'a.tgz'), { code: 'PROTOCOL_INVALID' });
});

test('digest comparison accepts an exact lowercase match', () => {
  const matched = digestMatches(DIGEST, DIGEST);

  assert.equal(matched, true);
});

test('digest comparison rejects a different digest', () => {
  const matched = digestMatches(DIGEST, 'b'.repeat(64));

  assert.equal(matched, false);
});

test('a non-digest argument is invalid input rather than a failed comparison', () => {
  assert.throws(() => digestMatches(DIGEST, DIGEST.toUpperCase()), { code: 'CONFIG_INVALID' });
  assert.throws(() => digestMatches(DIGEST, DIGEST.slice(0, -1)), { code: 'CONFIG_INVALID' });
  assert.throws(() => digestMatches('not-a-digest', DIGEST), { code: 'CONFIG_INVALID' });
});

test('sha256 hex accepts the fixed lowercase form', () => {
  const normalized = sha256Hex(DIGEST);

  assert.equal(normalized, DIGEST);
});

test('sha256 hex refuses anything outside the fixed lowercase form', () => {
  for (const value of [DIGEST.toUpperCase(), DIGEST.slice(0, 63), `${DIGEST}0`, '', null]) {
    assert.throws(() => sha256Hex(value), { code: 'CONFIG_INVALID' });
  }
});
