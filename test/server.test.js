import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import http from 'node:http';
import { createApp } from '../src/server.js';

/** Plain http.get: fetch() would unpack gzip and hide the headers this is about. */
function get(base, url, headers = {}) {
  return new Promise((resolve, reject) => {
    http
      .get(base + url, { headers }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      })
      .on('error', reject);
  });
}

test('files: kept for good under their versioned address, "not changed" otherwise, gzip for text', async () => {
  const pub = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-pub-'));
  fs.mkdirSync(path.join(pub, 'icons'));
  const script = `// ${'x'.repeat(3000)}\n`;
  fs.writeFileSync(path.join(pub, 'app.js'), script);
  fs.writeFileSync(path.join(pub, 'index.html'), '<script type="module" src="/app.js" data-editor-js="/app.js"></script>');
  fs.writeFileSync(path.join(pub, 'icons', 'a.svg'), '<svg/>');
  const monitor = { snapshot: () => ({ big: 'y'.repeat(3000) }), containers: () => ({}) };
  const server = createApp({ monitor, publicDir: pub });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // the page: links carry the version (also the ones in data- attributes), the page itself is checked each time
    const page = await get(base, '/');
    const version = /src="\/app\.js\?v=([0-9a-f]+)"/.exec(page.body.toString())?.[1];
    assert.ok(version);
    assert.match(page.body.toString(), new RegExp(`data-editor-js="/app\\.js\\?v=${version}"`));
    assert.equal(page.headers['cache-control'], 'no-cache');

    // current version in the address: keep for good; compressed when the browser takes gzip
    const kept = await get(base, `/app.js?v=${version}`, { 'accept-encoding': 'gzip, br' });
    assert.match(kept.headers['cache-control'], /immutable/);
    assert.equal(kept.headers['content-encoding'], 'gzip');
    assert.equal(zlib.gunzipSync(kept.body).toString(), script);
    assert.ok(kept.body.length < script.length / 5);

    // no version or an old one: checked each time, answered with 304 when unchanged
    const plain = await get(base, '/app.js?v=old');
    assert.equal(plain.headers['cache-control'], 'no-cache');
    assert.equal(plain.headers['content-encoding'], undefined);
    assert.equal(plain.body.toString(), script);
    assert.equal(plain.headers.etag, `"${version}"`);
    const again = await get(base, '/app.js', { 'if-none-match': plain.headers.etag });
    assert.equal(again.status, 304);
    assert.equal(again.body.length, 0);

    // a changed file is noticed without a restart
    fs.writeFileSync(path.join(pub, 'app.js'), `${script}// more\n`);
    const changed = await get(base, '/app.js', { 'if-none-match': plain.headers.etag });
    assert.equal(changed.status, 200);
    assert.notEqual(changed.headers.etag, plain.headers.etag);
    assert.doesNotMatch((await get(base, `/app.js?v=${version}`)).headers['cache-control'], /immutable/);

    // small files are not compressed; the status data is, and is never kept
    assert.equal((await get(base, '/icons/a.svg', { 'accept-encoding': 'gzip' })).headers['content-encoding'], undefined);
    const status = await get(base, '/api/status', { 'accept-encoding': 'gzip' });
    assert.equal(status.headers['cache-control'], 'no-store');
    assert.equal(status.headers['content-encoding'], 'gzip');
    assert.equal(JSON.parse(zlib.gunzipSync(status.body)).big.length, 3000);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(pub, { recursive: true, force: true });
  }
});
