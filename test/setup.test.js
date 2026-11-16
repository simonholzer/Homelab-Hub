// Password set on the page, services found in Docker, import from other dashboards, update notice, backups.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAuth } from '../src/auth.js';
import { parseConfigText } from '../src/config.js';
import { normalizeContainer } from '../src/docker.js';
import { suggestServices } from '../src/discover.js';
import { importServices, iconName } from '../src/import.js';
import { createUpdateChecker, isNewer, parseVersion } from '../src/update.js';
import { keepBackup, BACKUPS_KEPT } from '../src/editor.js';
import { Monitor } from '../src/monitor.js';
import { createApp, VERSION } from '../src/server.js';

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `hub-${name}-`));
const JSON_HEADERS = { 'content-type': 'application/json' };
const FIRST_PASSWORD = 'first test password';
const SECOND_PASSWORD = 'second test password';

async function withHub({ yaml = 'title: x\n', containers = [], envPassword = '', update = null } = {}, fn) {
  const dir = tmp('setup');
  const file = path.join(dir, 'services.yaml');
  fs.writeFileSync(file, yaml);
  const monitor = new Monitor({ configPath: file, dockerHost: 'http://docker.invalid', containers: async () => containers, check: async () => ({ status: 'up' }), statsReader: { read: async () => null } });
  await monitor.tick();
  const auth = createAuth({ password: envPassword, file: path.join(dir, 'hub-auth.json') });
  const server = createApp({ monitor, auth, update });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (url, body, cookie) => fetch(base + url, { method: 'POST', headers: { ...JSON_HEADERS, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  try {
    await fn({ base, post, dir, file });
  } finally {
    await new Promise((r) => server.close(r));
  }
}
const cookieFrom = (res) => (res.headers.get('set-cookie') ?? '').split(';')[0];

test('a password can be set on the page: open before, protected after, and it survives a restart', async () => {
  await withHub({}, async ({ base, post, dir }) => {
    let status = await (await fetch(`${base}/api/status`)).json();
    assert.deepEqual(status.auth, { mode: null, loggedIn: false, enabled: false, canSet: true });
    assert.equal(status.version, VERSION);
    assert.equal((await fetch(`${base}/login`, { redirect: 'manual' })).status, 200, 'no password: /login is just the page');

    assert.equal((await post('/api/password', { password: 'short' })).status, 400);
    assert.equal((await fetch(`${base}/api/password`, { method: 'POST', headers: { ...JSON_HEADERS, 'sec-fetch-site': 'cross-site' }, body: '{}' })).status, 403);
    const set = await post('/api/password', { password: FIRST_PASSWORD, protects: 'all' });
    assert.equal(set.status, 200);
    const cookie = cookieFrom(set);

    assert.equal((await fetch(`${base}/api/status`)).status, 401, 'now the hub asks for the login');
    status = await (await fetch(`${base}/api/status`, { headers: { cookie } })).json();
    assert.deepEqual(status.auth, { mode: 'all', loggedIn: true, enabled: true, canSet: true });

    // the file holds a salted hash, never the password
    const stored = fs.readFileSync(path.join(dir, 'hub-auth.json'), 'utf8');
    assert.ok(!stored.includes(FIRST_PASSWORD));
    assert.match(stored, /"salt"/);

    // changing or removing it needs the login
    assert.equal((await post('/api/password', { password: SECOND_PASSWORD })).status, 401);
    assert.equal((await post('/api/password', { remove: true })).status, 401);
    const changed = await post('/api/password', { password: SECOND_PASSWORD, protects: 'editor' }, cookie);
    assert.equal(changed.status, 200);
    assert.equal((await fetch(`${base}/api/config`, { headers: { cookie } })).status, 401, 'the old login ended with the old password');
    assert.equal((await fetch(`${base}/api/status`)).status, 200, 'it now protects only the editor');
    assert.equal((await post('/api/login', { password: FIRST_PASSWORD })).status, 401);
    const login = await post('/api/login', { password: SECOND_PASSWORD });
    assert.equal(login.status, 200);

    // a new process reads the same file
    const again = createAuth({ file: path.join(dir, 'hub-auth.json') });
    assert.equal(again.enabled, true);
    assert.equal(again.mode, 'editor');
    assert.equal(again.loggedIn({ headers: { cookie: cookieFrom(login) } }), true);

    const removed = await post('/api/password', { remove: true }, cookieFrom(login));
    assert.equal(removed.status, 200);
    assert.equal(fs.existsSync(path.join(dir, 'hub-auth.json')), false);
    assert.equal((await fetch(`${base}/api/config`)).status, 200, 'open again');
  });
});

test('a password from HUB_PASSWORD cannot be changed on the page', async () => {
  await withHub({ envPassword: FIRST_PASSWORD }, async ({ base, post }) => {
    const login = await post('/api/login', { password: FIRST_PASSWORD });
    const cookie = cookieFrom(login);
    const status = await (await fetch(`${base}/api/status`, { headers: { cookie } })).json();
    assert.deepEqual(status.auth, { mode: 'all', loggedIn: true, enabled: true, canSet: false });
    const res = await post('/api/password', { password: SECOND_PASSWORD }, cookie);
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /HUB_PASSWORD/);
    assert.equal((await post('/api/password', { remove: true }, cookie)).status, 400);
  });
});

const container = (name, image, ports, extra = {}) =>
  normalizeContainer({
    Id: name, Names: [`/${name}`], Image: image, State: 'running', Status: 'Up 1 hour',
    Ports: ports.map((p) => ({ PrivatePort: p, PublicPort: p, Type: 'tcp', IP: '0.0.0.0' })),
    Labels: { 'com.docker.compose.project': extra.project ?? name.replace(/-1$/, ''), 'com.docker.compose.service': extra.service ?? name.replace(/-1$/, ''), ...(extra.labels ?? {}) },
    ...(extra.raw ?? {})
  });

test('published ports are read from Docker (TCP only, each once)', () => {
  const c = normalizeContainer({ Names: ['/x'], State: 'running', Ports: [{ PrivatePort: 80, PublicPort: 8080, Type: 'tcp', IP: '0.0.0.0' }, { PrivatePort: 80, PublicPort: 8080, Type: 'tcp', IP: '::' }, { PrivatePort: 53, PublicPort: 53, Type: 'udp' }, { PrivatePort: 9000, Type: 'tcp' }] });
  assert.deepEqual(c.ports, [8080]);
});

test('found on this server: apps with a published port and no card yet; helpers and known ones are left out', () => {
  const config = parseConfigText(`hosts:
  nas: 192.168.1.10
groups:
  - name: NAS
    autoContainers: true
    services:
      - { name: Jellyfin, url: "https://media.example.com", local: "http://{nas}:8096" }
      - { name: Photos, url: "https://photos.example.com", check: "http://{nas}:2283" }
      - { name: Uptime Kuma, local: "http://{nas}:3001" }
`).config;
  const list = [
    container('ix-jellyfin-jellyfin-1', 'jellyfin/jellyfin', [8096], { project: 'ix-jellyfin' }), // has a card (port and name)
    container('immich-server-1', 'ghcr.io/immich-app/immich-server', [2283], { project: 'immich' }), // has a card: its check uses the port
    container('immich-postgres-1', 'postgres:16', [5432], { project: 'immich' }),
    container('uptime-kuma-1', 'louislam/uptime-kuma', [3001]),
    container('ix-n8n-n8n-1', 'n8nio/n8n', [5678], { project: 'ix-n8n' }),
    container('ix-n8n-redis-1', 'redis:7', [6379], { project: 'ix-n8n' }),
    container('portainer-1', 'portainer/portainer-ce', [8000, 9443]),
    container('paperless-web-1', 'paperless-ngx', [8010, 8443], { project: 'paperless' }),
    container('vaultwarden-1', 'vaultwarden/server', []), // nothing published
    container('grafana-1', 'grafana/grafana', [3000], { labels: { 'homelab-hub.url': 'https://grafana.example.com' } }), // has its card through labels
    container('hub-1', 'ghcr.io/someone/homelab-hub:latest', [8080]),
    container('proxy-1', 'tecnativa/docker-socket-proxy', [2375]),
    container('tunnel-1', 'cloudflare/cloudflared', [2000]),
    container('stopped-1', 'nginx', [8088], { raw: { State: 'exited', Status: 'Exited (1) 1 hour ago' } })
  ];
  const found = suggestServices(list, config);
  assert.deepEqual(found.map((s) => [s.name, s.icon, s.scheme, s.port, s.ports]), [
    ['N8n', 'n8n', 'http', 5678, [5678]],
    ['Paperless', 'paperless', 'https', 8443, [8010, 8443]],
    ['Portainer', 'portainer', 'http', 8000, [8000, 9443]]
  ]);
  assert.deepEqual(suggestServices([], config), []);
});

test('the suggestions are served to the editor only', async () => {
  await withHub({ containers: [container('whoami-1', 'traefik/whoami', [8000])] }, async ({ base }) => {
    const res = await (await fetch(`${base}/api/config/suggestions`)).json();
    assert.deepEqual(res.suggestions.map((s) => [s.name, s.port]), [['Whoami', 8000]]);
    assert.equal(res.dockerError, null);
  });
  await withHub({ envPassword: FIRST_PASSWORD }, async ({ base }) => {
    assert.equal((await fetch(`${base}/api/config/suggestions`)).status, 401);
  });
});

test('import: Homepage, Dashy and Homarr files become groups of cards', async () => {
  const homepage = importServices(`- Media:
    - Jellyfin:
        icon: jellyfin.png
        href: http://192.168.1.10:8096
        description: Films
        widget: { type: jellyfin, key: secret }
    - Broken:
        description: no address
- Tools:
    - Router:
        icon: mdi-router
        href: http://192.168.1.1
`);
  assert.equal(homepage.format, 'Homepage');
  assert.deepEqual(homepage.groups, [
    { name: 'Media', services: [{ name: 'Jellyfin', url: 'http://192.168.1.10:8096', icon: 'jellyfin', description: 'Films' }] },
    { name: 'Tools', services: [{ name: 'Router', url: 'http://192.168.1.1' }] }
  ]);
  assert.ok(!JSON.stringify(homepage).includes('secret'), 'widget settings (keys) are not taken over');

  const dashy = importServices('pageInfo: { title: x }\nsections:\n  - name: Apps\n    items:\n      - { title: Grafana, url: "https://grafana.example.com", icon: hl-grafana, description: Graphs }\n      - { title: No link }\n');
  assert.deepEqual([dashy.format, dashy.groups], ['Dashy', [{ name: 'Apps', services: [{ name: 'Grafana', url: 'https://grafana.example.com', icon: 'grafana', description: 'Graphs' }] }]]);

  const homarr = importServices(JSON.stringify({ categories: [{ id: 'c1', name: 'Media' }], apps: [{ name: 'Sonarr', url: 'http://192.168.1.10:8989', appearance: { iconUrl: 'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/sonarr.png' }, area: { type: 'category', properties: { id: 'c1' } } }, { name: 'Loose', url: 'http://192.168.1.10:1', appearance: { iconUrl: 'https://example.com/logo.png' } }] }));
  assert.deepEqual([homarr.format, homarr.groups], ['Homarr', [{ name: 'Media', services: [{ name: 'Sonarr', url: 'http://192.168.1.10:8989', icon: 'sonarr' }] }, { name: 'Homarr', services: [{ name: 'Loose', url: 'http://192.168.1.10:1' }] }]]);

  assert.throws(() => importServices('title: just a hub config\ngroups: []'), /not recognised/);
  assert.throws(() => importServices('{ not: [valid'), /neither YAML nor JSON/);
  assert.throws(() => importServices('- Empty:\n    - Nothing: { description: x }\n'), /no entries/);
  for (const [raw, want] of [['jellyfin.svg', 'jellyfin'], ['hl-pi-hole', 'pi-hole'], ['mdi-home', ''], ['si-github', ''], ['https://example.com/x.png', ''], ['favicon', ''], [5, ''], ['Home Assistant', '']]) assert.equal(iconName(raw), want, String(raw));

  // what comes out is valid for the hub's own config
  const { errors } = parseConfigText(JSON.stringify({ groups: homepage.groups }));
  assert.deepEqual(errors, []);

  await withHub({}, async ({ post }) => {
    const ok = await post('/api/config/import', { text: '- A:\n    - One: { href: "http://one.example.com" }\n' });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).groups[0].services[0].name, 'One');
    assert.equal((await post('/api/config/import', { text: 'nope: true' })).status, 400);
  });
});

test('update notice: only when the latest release is newer than what is running', async () => {
  assert.deepEqual(parseVersion('v1.2.3'), [1, 2, 3]);
  assert.equal(parseVersion('1.2'), null);
  assert.equal(isNewer('1.10.0', '1.9.9'), true);
  assert.equal(isNewer('v2.0.0', '1.9.9'), true);
  assert.equal(isNewer('1.2.0', '1.2.0'), false);
  assert.equal(isNewer('1.1.9', '1.2.0'), false);
  assert.equal(isNewer('nightly', '1.2.0'), false);

  let answer = { tag: 'v1.3.0', url: 'https://github.com/x/y/releases/tag/v1.3.0' };
  const asked = [];
  const checker = createUpdateChecker({ current: '1.2.0', repo: 'x/y', fetchLatest: async (repo) => (asked.push(repo), answer) });
  assert.equal(checker.available(), null, 'nothing known before the first check');
  await checker.check();
  assert.deepEqual(checker.available(), { version: '1.3.0', url: 'https://github.com/x/y/releases/tag/v1.3.0' });
  assert.deepEqual(asked, ['x/y']);
  answer = { tag: 'v1.2.0', url: 'javascript:alert(1)' };
  await checker.check();
  assert.equal(checker.available(), null);
  const offline = createUpdateChecker({ current: '1.2.0', fetchLatest: async () => { throw new Error('offline'); } });
  await offline.check();
  assert.equal(offline.available(), null);

  const update = createUpdateChecker({ current: VERSION, fetchLatest: async () => ({ tag: 'v99.0.0', url: 'https://github.com/x/y/releases/tag/v99.0.0' }) });
  await update.check();
  await withHub({ update }, async ({ base }) => {
    const status = await (await fetch(`${base}/api/status`)).json();
    assert.deepEqual(status.update, { version: '99.0.0', url: 'https://github.com/x/y/releases/tag/v99.0.0' });
  });
});

test('backups: every save keeps a dated copy, and only the newest are kept', () => {
  const dir = tmp('backups');
  const file = path.join(dir, 'services.yaml');
  for (let i = 0; i < BACKUPS_KEPT + 3; i++) {
    fs.writeFileSync(file, `title: version ${i}\n`);
    keepBackup(file, new Date(Date.UTC(2026, 0, 1, 12, 0, i)));
  }
  const kept = fs.readdirSync(path.join(dir, 'backups')).sort();
  assert.equal(kept.length, BACKUPS_KEPT);
  assert.equal(kept[0], 'services-20260101-120003.yaml');
  assert.equal(fs.readFileSync(path.join(dir, 'backups', kept.at(-1)), 'utf8'), `title: version ${BACKUPS_KEPT + 2}\n`);
});
