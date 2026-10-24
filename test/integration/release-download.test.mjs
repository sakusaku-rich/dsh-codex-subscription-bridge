import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';

/** Extract the downloader source install.sh carries into one inspectable file. */
async function extractDownloader(root) {
  const installer = await readFile(join(process.cwd(), 'install.sh'), 'utf8');
  const match = /cat > "\$WORK\/fetch\.mjs" <<'FETCH'\n([\s\S]*?)\nFETCH\n/u.exec(installer);
  if (match === null) throw new Error('install.sh no longer contains the expected fetch.mjs heredoc');
  const path = join(root, 'fetch.mjs');
  await writeFile(path, match[1]);
  return path;
}

/** Serve responses from a table so the redirect rules can be checked offline. */
function serve(handler) {
  const server = createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      origin: `http://127.0.0.1:${String(server.address().port)}`,
      close: () => new Promise((done) => server.close(done)),
    }));
  });
}

/** Run the extracted downloader for one url. */
const fetchAsset = (downloader, url, destination) => spawnSync(process.execPath, [downloader, url, destination], { encoding: 'utf8', timeout: 60_000 });

/** A redirect table whose every route answers from the local fixture origin. */
const redirectTable = (request, response) => {
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
};

test('the release downloader refuses a host outside the allowlist', { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-fetch-'));
  const downloader = await extractDownloader(root);
  const remote = await serve(redirectTable);

  const refused = ['/asset', '/offsite', '/loop'].map((path) => fetchAsset(downloader, `${remote.origin}${path}`, join(root, 'out')));

  for (const result of refused) {
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /refusing to download from http:\/\/127\.0\.0\.1/u);
  }

  await remote.close();
  await rm(root, { recursive: true, force: true });
});

test('the release downloader writes nothing for a refused transfer', { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-fetch-'));
  const downloader = await extractDownloader(root);
  const remote = await serve(redirectTable);

  for (const path of ['/asset', '/offsite', '/loop']) fetchAsset(downloader, `${remote.origin}${path}`, join(root, 'out'));

  await assert.rejects(readFile(join(root, 'out')), { code: 'ENOENT' });

  await remote.close();
  await rm(root, { recursive: true, force: true });
});

test('the release downloader refuses a non-https url even for an allowed host', { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-fetch-'));
  const downloader = await extractDownloader(root);

  const insecure = fetchAsset(downloader, 'http://github.com/asset', join(root, 'out2'));

  assert.notEqual(insecure.status, 0);
  assert.match(insecure.stderr, /refusing to download from http:\/\/github\.com/u);

  await rm(root, { recursive: true, force: true });
});

test('the release downloader follows GitHub release redirects under the allowlist', { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-fetch-ok-'));
  const downloader = await extractDownloader(root);
  const destination = join(root, 'asset');

  // The real release URL is used because the allowlist is deliberately fixed
  // and cannot be pointed at a local fixture. This is a plain unauthenticated
  // download of a published, public release asset; no credentials are used.
  const url = 'https://github.com/sakusaku-rich/dsh-codex-subscription-bridge/releases/download/v0.0.1/SHA256SUMS';
  const result = fetchAsset(downloader, url, destination);
  if (result.status !== 0) {
    // Without network access this check cannot run; skip rather than fail so
    // the offline suite stays meaningful.
    assert.match(result.stderr, /fetch failed|EAI_AGAIN|ENOTFOUND|getaddrinfo/u);
    await rm(root, { recursive: true, force: true });
    return;
  }

  assert.match(await readFile(destination, 'utf8'), /^[0-9a-f]{64} {2}\S+$/mu);

  await rm(root, { recursive: true, force: true });
});
