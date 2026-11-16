import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Monitor } from '../src/monitor.js';
import { createApp } from '../src/server.js';

const YAML_A = `
title: Test Hub
groups:
  - name: Apps
    services:
      - { name: Up, url: "https://up.example.net", check: "http://10.0.0.1:1" }
      - { name: Down, url: "https://down.example.net", check: "http://10.0.0.2:1" }
      - { name: Docker, url: "https://docker.example.net", check: "http://10.0.0.3:1", containers: ["*thing*"] }
`;

function tmpConfig(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-cfg-'));
  const file = path.join(dir, 'services.yaml');
  fs.writeFileSync(file, text);
  return { dir, file };
}

const fakeCheck = async (check) =>
  check.url.includes('10.0.0.2')
    ? { status: 'down', detail: 'Connection refused', ms: 3 }
    : { status: 'up', detail: 'HTTP 200', code: 200, ms: 12 };

const fakeStats = { read: async () => ({ memory: { total: 100, used: 40, cache: null }, disks: [] }) };

test('tick builds a snapshot with statuses, summary and container health', async () => {
  const { file } = tmpConfig(YAML_A);
  const m = new Monitor({
    configPath: file,
    check: fakeCheck,
    containers: async () => [{ name: 'a-thing-1', project: 'a', service: 'thing', health: 'healthy', state: 'running' }],
    statsReader: fakeStats,
    dockerHost: 'fake'
  });
  await m.tick();
  const snap = m.snapshot();
  assert.equal(snap.title, 'Test Hub');
  assert.deepEqual(snap.summary, { up: 2, down: 1, unknown: 0, total: 3 });
  const [up, down, docker] = snap.groups[0].services;
  assert.equal(up.status, 'up');
  assert.deepEqual([down.status, down.detail], ['down', 'Connection refused']);
  assert.equal(docker.containers.state, 'healthy');
  assert.equal(up.containers, null);
  assert.equal(snap.stats.memory.used, 40);
  assert.ok(!JSON.stringify(snap).includes('10.0.0.1'), 'check targets must not leak into the API');
});

test('before the first check, services are "pending"', () => {
  const { file } = tmpConfig(YAML_A);
  const m = new Monitor({ configPath: file, check: fakeCheck, statsReader: fakeStats });
  m.reloadConfig();
  assert.equal(m.snapshot().groups[0].services[0].status, 'pending');
});

test('a broken edit keeps the last good config and reports the errors; fixing it recovers', async () => {
  const { file } = tmpConfig(YAML_A);
  const m = new Monitor({ configPath: file, check: fakeCheck, statsReader: fakeStats });
  await m.tick();
  assert.equal(m.snapshot().configError, null);

  fs.writeFileSync(file, 'groups:\n  - name: [oops\n');
  await m.tick();
  let snap = m.snapshot();
  assert.equal(snap.groups[0].services.length, 3, 'still shows the old services');
  assert.match(snap.configError.message, /last working version/);
  assert.match(snap.configError.lines[0], /YAML syntax error/);

  fs.writeFileSync(file, YAML_A.replace('Test Hub', 'Fixed Hub'));
  await m.tick();
  snap = m.snapshot();
  assert.equal(snap.configError, null);
  assert.equal(snap.title, 'Fixed Hub');
});

test('a broken config on first start shows the error and no services', async () => {
  const { file } = tmpConfig('title: nothing else');
  const m = new Monitor({ configPath: file, check: fakeCheck, statsReader: fakeStats });
  await m.tick();
  const snap = m.snapshot();
  assert.equal(snap.groups.length, 0);
  assert.match(snap.configError.message, /nothing to show/);
});

test('removing a service drops its result; changing the YAML is picked up live', async () => {
  const { file } = tmpConfig(YAML_A);
  const m = new Monitor({ configPath: file, check: fakeCheck, statsReader: fakeStats });
  await m.tick();
  fs.writeFileSync(file, YAML_A.replace(/      - \{ name: Down.*\n/, ''));
  await m.tick();
  assert.equal(m.snapshot().summary.total, 2);
});

test('docker or stats problems are reported without breaking the checks', async () => {
  const { file } = tmpConfig(YAML_A);
  const m = new Monitor({
    configPath: file,
    check: fakeCheck,
    containers: async () => { throw new Error('Docker API refused the connection'); },
    statsReader: { read: async () => { throw new Error('cannot read /proc/meminfo'); } },
    dockerHost: 'fake'
  });
  await m.tick();
  const snap = m.snapshot();
  assert.equal(snap.summary.up, 2);
  assert.equal(snap.dockerError, 'Docker API refused the connection');
  assert.equal(snap.statsError, 'cannot read /proc/meminfo');
  assert.equal(snap.stats, null);
  assert.equal(snap.groups[0].services[2].watchContainers, true);
  assert.equal(snap.groups[0].services[2].containers, null);
});

test('first start copies the bundled example into an empty config folder', async () => {
  const bundled = tmpConfig(YAML_A);
  const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-new-')), 'sub', 'services.yaml');
  const m = new Monitor({ configPath: target, defaultConfigPath: bundled.file, check: fakeCheck, statsReader: fakeStats });
  await m.tick();
  assert.ok(fs.existsSync(target));
  assert.equal(m.snapshot().summary.total, 3);
});

test('HTTP: page, status API, containers API, healthz, 404 and path traversal', async () => {
  const { file } = tmpConfig(YAML_A);
  const m = new Monitor({ configPath: file, check: fakeCheck, statsReader: fakeStats });
  await m.tick();
  const server = createApp({ monitor: m });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await fetch(base + '/');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<title>Homelab Hub<\/title>/);
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);

    const status = await (await fetch(base + '/api/status')).json();
    assert.equal(status.summary.total, 3);
    assert.equal((await fetch(base + '/api/status')).headers.get('cache-control'), 'no-store');

    assert.deepEqual(await (await fetch(base + '/healthz')).json(), { ok: true });
    assert.equal((await fetch(base + '/api/containers')).status, 200);
    const missing = await fetch(base + '/nope.txt');
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get('cache-control'), 'no-store', 'a 404 must not be kept by browsers');
    // icon versions: every real icon file is listed with a hash; names without a file are absent
    assert.match(status.icons['uptime-kuma'], /^[0-9a-f]{10}$/);
    assert.match(status.icons.default, /^[0-9a-f]{10}$/);
    assert.equal(status.icons['no-such-icon'], undefined);
    assert.equal((await fetch(`${base}/icons/uptime-kuma.svg?v=${status.icons['uptime-kuma']}`)).status, 200);
    assert.equal((await fetch(base + '/style.css')).headers.get('content-type'), 'text/css; charset=utf-8');

    // raw request so the client doesn't normalise the path
    const traversal = await new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port: server.address().port, path: '/..%2f..%2fpackage.json' }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
    });
    assert.ok([403, 404].includes(traversal), `traversal got ${traversal}`);

    const post = await fetch(base + '/api/status', { method: 'POST' });
    assert.equal(post.status, 405);
  } finally {
    server.close();
  }
});

test('autoContainers: cards of a group get a badge only when a container matches their name', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-auto-'));
  const file = path.join(dir, 'services.yaml');
  fs.writeFileSync(file, `
groups:
  - name: NAS
    autoContainers: true
    services:
      - { name: Todo Sync, url: "https://todo.example.net" }
      - { name: n8n, url: "https://n8n.example.net" }
      - { name: NAS UI, url: "https://nas.example.net" }
      - { name: Immich, url: "https://immich.example.net", containers: ["*immich*"] }
  - name: Other
    services:
      - { name: Portainer, url: "https://p.example.net" }
`);
  const c = (name, project, health) => ({ name, project, service: name, state: 'running', health });
  const monitor = new Monitor({
    configPath: file,
    check: async () => ({ status: 'up', detail: 'HTTP 200', ms: 1 }),
    statsReader: { read: async () => ({ memory: { total: 1, used: 1, cache: null }, disks: [] }) },
    containers: async () => [c('ix-todo-sync-todo-sync-1', 'ix-todo-sync', 'healthy'), c('ix-n8n-n8n-1', 'ix-n8n', 'unhealthy'), c('ix-portainer-portainer-1', 'ix-portainer', 'healthy'), c('ix-immich-server-1', 'ix-immich', 'healthy')]
  });
  monitor.dockerHost = 'http://fake';
  await monitor.tick();
  const [nas, other] = monitor.snapshot().groups;
  const by = Object.fromEntries(nas.services.map((s) => [s.name, s]));
  assert.equal(by['Todo Sync'].watchContainers, true, 'matched by name (todo-sync)');
  assert.equal(by['Todo Sync'].containers.state, 'healthy');
  assert.equal(by.n8n.containers.state, 'unhealthy');
  assert.equal(by['NAS UI'].watchContainers, false, 'no container, no badge, and no red "not found"');
  assert.equal(by.Immich.containers.state, 'healthy', 'explicit patterns still work');
  assert.equal(other.services[0].watchContainers, false, 'groups without autoContainers are untouched');
});

test('the page links its script and style with a version that changes with their content (Cloudflare caches them for 4 h)', async () => {
  const pub = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-pub-'));
  fs.writeFileSync(path.join(pub, 'index.html'), '<link rel="stylesheet" href="/style.css"><script type="module" src="/app.js"></script><a href="/api/status">x</a>');
  fs.writeFileSync(path.join(pub, 'app.js'), 'one');
  fs.writeFileSync(path.join(pub, 'style.css'), 'a{}');
  const cfg = path.join(pub, 'services.yaml');
  fs.writeFileSync(cfg, 'groups:\n  - name: G\n    services:\n      - { name: S, url: "https://s.example.net", check: none }\n');
  const monitor = new Monitor({ configPath: cfg, check: async () => ({ status: 'up' }), statsReader: { read: async () => ({ memory: { total: 1, used: 1, cache: null }, disks: [] }) } });
  const server = createApp({ monitor, publicDir: pub });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const get = async () => (await fetch(`http://127.0.0.1:${server.address().port}/`)).text();
  try {
    const a = await get();
    assert.match(a, /href="\/style\.css\?v=[0-9a-f]{10}"/);
    assert.match(a, /src="\/app\.js\?v=[0-9a-f]{10}"/);
    assert.ok(a.includes('href="/api/status"'), 'other links are untouched');
    assert.equal(await get(), a, 'same content, same version');
    fs.writeFileSync(path.join(pub, 'app.js'), 'two');
    assert.notEqual(await get(), a, 'changed script, new version');
    const asset = await fetch(`http://127.0.0.1:${server.address().port}/app.js?v=abc`);
    assert.equal(await asset.text(), 'two', 'the query string does not break serving the file');
  } finally {
    server.close();
    fs.rmSync(pub, { recursive: true, force: true });
  }
});

test('stats run on their own, faster timer (statsIntervalSeconds), apart from the service checks', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-fast-'));
  const cfg = path.join(dir, 'services.yaml');
  fs.writeFileSync(cfg, 'settings: { checkIntervalSeconds: 3600, statsIntervalSeconds: 1 }\ngroups:\n  - name: G\n    services:\n      - { name: S, url: "https://s.example.net", check: none }\n');
  let reads = 0;
  let checks = 0;
  const monitor = new Monitor({
    configPath: cfg,
    check: async () => { checks++; return { status: 'up' }; },
    statsReader: { read: async () => ({ memory: { total: 1, used: 1, cache: null }, cpuPercent: ++reads, disks: [] }) }
  });
  await monitor.start();
  await new Promise((r) => setTimeout(r, 2600));
  monitor.stop();
  try {
    assert.ok(reads >= 3, `stats were read ${reads} times in 2.6 s`);
    assert.equal(checks, 1, 'the service check ran once (its own interval is an hour)');
    const snap = monitor.snapshot();
    assert.ok(snap.stats.cpuPercent >= 3, 'the snapshot carries the newest reading');
    assert.equal(snap.statsIntervalSeconds, 1);
    assert.ok(snap.statsAt > 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('refreshStats does not overlap itself and reports errors', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-busy-'));
  const cfg = path.join(dir, 'services.yaml');
  fs.writeFileSync(cfg, 'groups:\n  - name: G\n    services:\n      - { name: S, url: "https://s.example.net", check: none }\n');
  let running = 0;
  let maxRunning = 0;
  let fail = false;
  const monitor = new Monitor({
    configPath: cfg,
    check: async () => ({ status: 'up' }),
    statsReader: {
      read: async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((r) => setTimeout(r, 80));
        running--;
        if (fail) throw new Error('cannot read /proc');
        return { memory: { total: 1, used: 1, cache: null }, disks: [] };
      }
    }
  });
  await Promise.all([monitor.refreshStats(), monitor.refreshStats(), monitor.refreshStats()]);
  assert.equal(maxRunning, 1, 'a second read is skipped while one is running');
  fail = true;
  await monitor.refreshStats();
  assert.equal(monitor.stats, null);
  assert.match(monitor.statsError, /cannot read/);
  fs.rmSync(dir, { recursive: true, force: true });
});
