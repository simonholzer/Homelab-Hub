import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAuth, safeNext } from '../src/auth.js';
import { createApp } from '../src/server.js';
import { Monitor } from '../src/monitor.js';

const TEST_PASSWORD = 'correct horse battery staple';
const YAML = 'groups:\n  - name: Apps\n    services:\n      - { name: One, url: "https://one.example.net" }\n';
const JSON_HEADERS = { 'content-type': 'application/json' };

async function withHub(authOptions, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-auth-'));
  const file = path.join(dir, 'services.yaml');
  fs.writeFileSync(file, YAML);
  const monitor = new Monitor({ configPath: file, check: async () => ({ status: 'up' }), statsReader: { read: async () => null } });
  await monitor.tick();
  const server = createApp({ monitor, auth: createAuth(authOptions) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const login = (base, password, next) => fetch(`${base}/api/login`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ password, next }) });
const cookieFrom = (res) => (res.headers.get('set-cookie') ?? '').split(';')[0];

test('no password set: there is no login at all', () => {
  assert.equal(createAuth({ password: '' }), null);
  assert.equal(createAuth(), null);
});

test('protects everything: pages go to the login, the API answers 401, the login page stays reachable', async () => {
  await withHub({ password: TEST_PASSWORD }, async (base) => {
    const page = await fetch(`${base}/`, { redirect: 'manual' });
    assert.equal(page.status, 302);
    assert.equal(page.headers.get('location'), '/login?next=%2F');
    assert.equal((await fetch(`${base}/api/status`)).status, 401);
    assert.equal((await fetch(`${base}/api/config`)).status, 401);
    assert.equal((await fetch(`${base}/api/containers`)).status, 401);
    assert.equal((await fetch(`${base}/icons/default.svg`)).status, 401);
    for (const open of ['/login', '/login.js', '/i18n.js', '/theme.js', '/style.css', '/favicon.svg', '/healthz']) {
      assert.equal((await fetch(base + open)).status, 200, open);
    }
    assert.match(await (await fetch(`${base}/login`)).text(), /type="password"/);
  });
});

test('a wrong password is refused, the right one gives a cookie that opens the hub; logging out ends it', async () => {
  await withHub({ password: TEST_PASSWORD }, async (base) => {
    const wrong = await login(base, 'nope');
    assert.equal(wrong.status, 401);
    assert.equal(wrong.headers.get('set-cookie'), null);

    const ok = await login(base, TEST_PASSWORD, '/#edit');
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).next, '/#edit');
    const setCookie = ok.headers.get('set-cookie');
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    const cookie = cookieFrom(ok);

    const status = await fetch(`${base}/api/status`, { headers: { cookie } });
    assert.equal(status.status, 200);
    assert.deepEqual((await status.json()).auth, { mode: 'all', loggedIn: true, enabled: true, canSet: false });
    assert.equal((await fetch(`${base}/`, { headers: { cookie }, redirect: 'manual' })).status, 200);

    // a made-up or tampered cookie is worth nothing
    const [expires] = cookie.split('=')[1].split('.');
    assert.equal((await fetch(`${base}/api/status`, { headers: { cookie: `hub_session=${expires}.AAAA` } })).status, 401);
    assert.equal((await fetch(`${base}/api/status`, { headers: { cookie: `hub_session=${Number(expires) + 1}.${cookie.split('.')[1]}` } })).status, 401);

    const out = await fetch(`${base}/api/logout`, { method: 'POST', headers: { ...JSON_HEADERS, cookie }, body: '{}' });
    assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
  });
});

test('a login from another website is refused', async () => {
  await withHub({ password: TEST_PASSWORD }, async (base) => {
    const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { ...JSON_HEADERS, 'sec-fetch-site': 'cross-site' }, body: JSON.stringify({ password: TEST_PASSWORD }) });
    assert.equal(res.status, 403);
  });
});

test('protects only the editor: the page is open, the config needs the login', async () => {
  await withHub({ password: TEST_PASSWORD, protects: 'editor' }, async (base) => {
    assert.equal((await fetch(`${base}/`)).status, 200);
    const status = await (await fetch(`${base}/api/status`)).json();
    assert.deepEqual(status.auth, { mode: 'editor', loggedIn: false, enabled: true, canSet: false });
    assert.equal((await fetch(`${base}/api/config`)).status, 401);
    const cookie = cookieFrom(await login(base, TEST_PASSWORD));
    assert.equal((await fetch(`${base}/api/config`, { headers: { cookie } })).status, 200);
  });
});

test('too many wrong passwords lock that address for a minute; a session expires', () => {
  let clock = 1_000_000;
  const auth = createAuth({ password: TEST_PASSWORD, now: () => clock });
  const req = { headers: {}, socket: { remoteAddress: '203.0.113.9' } };
  for (let i = 0; i < 4; i++) assert.deepEqual(auth.login(req, 'wrong'), { ok: false, wait: 0 });
  assert.equal(auth.login(req, 'wrong').wait, 60);
  assert.equal(auth.login(req, TEST_PASSWORD).ok, false, 'locked: even the right password has to wait');
  assert.equal(auth.login({ headers: {}, socket: { remoteAddress: '203.0.113.10' } }, TEST_PASSWORD).ok, true, 'other addresses are not locked');
  clock += 61_000;
  const ok = auth.login(req, TEST_PASSWORD);
  assert.equal(ok.ok, true);
  assert.doesNotMatch(ok.cookie, /Secure/);
  assert.match(auth.login({ headers: { 'x-forwarded-proto': 'https' }, socket: { remoteAddress: '203.0.113.11' } }, TEST_PASSWORD).cookie, /; Secure/);

  const cookie = ok.cookie.split(';')[0];
  assert.equal(auth.loggedIn({ headers: { cookie } }), true);
  clock += 31 * 86_400_000;
  assert.equal(auth.loggedIn({ headers: { cookie } }), false);
  // another password = another key: old sessions end
  clock = 1_000_000;
  assert.equal(createAuth({ password: 'another one', now: () => clock }).loggedIn({ headers: { cookie } }), false);
});

test('after the login you only ever land on the hub itself', () => {
  assert.equal(safeNext('/'), '/');
  assert.equal(safeNext('/#edit'), '/#edit');
  assert.equal(safeNext('/?x=1'), '/?x=1');
  for (const bad of ['//evil.example', 'https://evil.example', '/\\evil.example', 'javascript:alert(1)', '', undefined, 5]) {
    assert.equal(safeNext(bad), '/', String(bad));
  }
});
