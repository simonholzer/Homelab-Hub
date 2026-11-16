// Plain links (check: none), descriptions, and the files for "install as app".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Monitor } from '../src/monitor.js';
import { createApp } from '../src/server.js';
import { createAuth, PUBLIC_PATHS } from '../src/auth.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, '..', 'public');

function hub(yaml, check = async () => ({ status: 'up', detail: 'HTTP 200', ms: 1 })) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-links-'));
  const file = path.join(dir, 'services.yaml');
  fs.writeFileSync(file, yaml);
  return new Monitor({ configPath: file, check, statsReader: { read: async () => null } });
}

test('a service with check: none is a plain link: no status, not counted, description passed on', async () => {
  const monitor = hub(`groups:
  - name: Mixed
    services:
      - { name: Checked, url: "https://one.example.com" }
      - { name: Router, description: "Port forwarding and Wi-Fi", local: "http://192.168.1.1", check: none }
  - name: Links
    services:
      - { name: Docs, url: "https://docs.example.com", check: false }
`);
  await monitor.tick();
  const snap = monitor.snapshot();
  const [checked, router] = snap.groups[0].services;
  assert.equal(checked.status, 'up');
  assert.equal(router.status, 'none');
  assert.equal(router.description, 'Port forwarding and Wi-Fi');
  assert.equal(snap.groups[1].services[0].status, 'none');
  assert.deepEqual(snap.summary, { up: 1, down: 0, unknown: 0, total: 1 });
});

test('install as app: the manifest and its icons exist, are served with the right type, and need no login', async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(publicDir, 'manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, '/');
  assert.ok(manifest.icons.some((i) => i.sizes === '192x192') && manifest.icons.some((i) => i.sizes === '512x512'));
  assert.ok(manifest.icons.some((i) => i.purpose === 'maskable'));
  const files = ['/manifest.webmanifest', '/apple-touch-icon.png', ...manifest.icons.map((i) => i.src)];
  for (const f of files) {
    assert.ok(fs.existsSync(path.join(publicDir, f)), `${f} exists`);
    assert.ok(PUBLIC_PATHS.has(f), `${f} is reachable without the login`);
  }
  // PNG files of the size the manifest promises
  for (const icon of manifest.icons) {
    const png = fs.readFileSync(path.join(publicDir, icon.src));
    assert.equal(png.toString('latin1', 1, 4), 'PNG');
    assert.equal(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`, icon.sizes);
  }
  for (const page of ['index.html', 'login.html']) {
    const html = fs.readFileSync(path.join(publicDir, page), 'utf8');
    assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest">/, page);
    assert.match(html, /<link rel="apple-touch-icon"/, page);
  }

  const monitor = hub('title: x\n');
  await monitor.tick();
  const server = createApp({ monitor, auth: createAuth({ password: 'a test password' }) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/manifest.webmanifest`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^application\/manifest\+json/);
    for (const f of files) assert.equal((await fetch(base + f)).status, 200, f);
    assert.equal((await fetch(`${base}/api/status`)).status, 401, 'everything else still needs the login');
  } finally {
    await new Promise((r) => server.close(r));
  }
});
