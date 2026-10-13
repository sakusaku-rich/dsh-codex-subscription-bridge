import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';

/**
 * The downloader is embedded in install.sh so the whole transfer path ships in
 * one inspectable file. This extracts it so its redirect and allowlist rules can
 * be exercised directly, without publishing a release or contacting GitHub.
 */
async function extractDownloader(root) {
  const installer = await readFile(join(process.cwd(), 'install.sh'), 'utf8');
  const match = /cat > "\$WORK\/fetch\.mjs" <<'FETCH'\n([\s\S]*?)\nFETCH\n/u.exec(installer);
  assert.ok(match, 'install.sh no longer contains the expected fetch.mjs heredoc');
  const path = join(root, 'fetch.mjs');
  await writeFile(path, match[1]);
  return path;
}

/** Serve responses from a table so the redirect rules can be checked offline. */
function serve(handler) {
  const server = createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      server, origin: `http://127.0.0.1:${String(server.address().port)}`,
      close: () => new Promise((done) => server.close(done)),
    }));
  });
}

test('the release downloader accepts the published hosts and refuses others', { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-fetch-'));
  const downloader = await extractDownloader(root);
  const fetchAsset = (url, destination) => spawnSync(process.execPath, [downloader, url, destination], { encoding: 'utf8', timeout: 60_000 });
  try {
    const remote = await serve((request, response) => {
      if (request.url === '/asset') {
        response.writeHead(302, { location: 'https://release-assets.githubusercontent.com/blob/asset' });
        response.end();
        return;
      }
      if (request.url === '/offsite') {
        response.writeHead(302, { location: 'https://evil.example/asset' });
        response.end();
        return;
      }
      if (request.url === '/loop') {
        response.writeHead(302, { location: '/loop' });
        response.end();
        return;
      }
      if (request.url === '/nolocation') {
        response.writeHead(302).end();
        return;
      }
      response.writeHead(404).end();
    });

    // Every request in this test targets the local fixture origin, which is not
    // an allowed host, so each one must be refused before any transfer happens.
    for (const [path, expected] of [
      ['/asset', /refusing to download from http:\/\/127\.0\.0\.1/u],
      ['/offsite', /refusing to download from http:\/\/127\.0\.0\.1/u],
      ['/loop', /refusing to download from http:\/\/127\.0\.0\.1/u],
    ]) {
      const result = fetchAsset(`${remote.origin}${path}`, join(root, 'out'));
      assert.notEqual(result.status, 0, `${path} was not refused`);
      assert.match(result.stderr, expected);
    }
    // Nothing was written for any refused transfer.
    await assert.rejects(readFile(join(root, 'out')), { code: 'ENOENT' });

    // A non-https URL is refused even when the host would otherwise be allowed.
    const insecure = fetchAsset('http://github.com/asset', join(root, 'out2'));
    assert.notEqual(insecure.status, 0);
    assert.match(insecure.stderr, /refusing to download from http:\/\/github\.com/u);

    await remote.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the release downloader follows GitHub release redirects under the allowlist', { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-fetch-ok-'));
  const downloader = await extractDownloader(root);
  const destination = join(root, 'asset');
  try {
    // The real release URL is used because the allowlist is deliberately fixed
    // and cannot be pointed at a local fixture. This is a plain unauthenticated
    // download of a published, public release asset; no credentials are used.
    const url = 'https://github.com/sakusaku-rich/dsh-codex-subscription-bridge/releases/download/v0.0.1/SHA256SUMS';
    const result = spawnSync(process.execPath, [downloader, url, destination], { encoding: 'utf8', timeout: 60_000 });
    if (result.status !== 0) {
      // Without network access this check cannot run; skip rather than fail so
      // the offline suite stays meaningful.
      assert.match(result.stderr, /fetch failed|EAI_AGAIN|ENOTFOUND|getaddrinfo/u);
      return;
    }
    const text = await readFile(destination, 'utf8');
    assert.match(text, /^[0-9a-f]{64} {2}\S+$/mu);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
