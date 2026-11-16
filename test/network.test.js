import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeIp, isPrivateAddress, samePublicAddress, parseTrace, HomeNetwork } from '../src/network.js';
import { Monitor } from '../src/monitor.js';
import { createApp } from '../src/server.js';
import { parseConfigText } from '../src/config.js';

// 203.0.113.0/24 and 198.51.100.0/24 are reserved for documentation: safe stand-ins for public IPs.
const NAS_PUBLIC = '203.0.113.10';
const OTHER_PUBLIC = '198.51.100.77';

const req = (headers = {}, remoteAddress = '192.168.1.20') => ({ headers, socket: { remoteAddress } });

test('normalizeIp', () => {
  assert.equal(normalizeIp('::ffff:192.168.1.5'), '192.168.1.5');
  assert.equal(normalizeIp('[2001:DB8::1]'), '2001:db8::1');
  assert.equal(normalizeIp('fe80::1%eth0'), 'fe80::1');
  assert.equal(normalizeIp(' 1.2.3.4 '), '1.2.3.4');
  assert.equal(normalizeIp(undefined), '');
});

test('isPrivateAddress', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.86', '169.254.1.1', '::1', 'fd12:3456::1', 'fe80::1', '::ffff:192.168.0.9']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '172.32.0.1', '172.15.0.1', '192.169.0.1', '2001:db8::1', '', 'nonsense']) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test('samePublicAddress: IPv4 exact, IPv6 same /64', () => {
  assert.equal(samePublicAddress('203.0.113.10', '203.0.113.10'), true);
  assert.equal(samePublicAddress('203.0.113.10', '203.0.113.11'), false);
  assert.equal(samePublicAddress('::ffff:203.0.113.10', '203.0.113.10'), true);
  assert.equal(samePublicAddress('2001:db8:1:2:aaaa::1', '2001:db8:1:2:bbbb::9'), true);
  assert.equal(samePublicAddress('2001:db8:1:2::1', '2001:db8:1:3::1'), false);
  assert.equal(samePublicAddress('2001:db8::1', '203.0.113.10'), false);
});

test('parseTrace reads the ip= line of Cloudflare\'s trace page', () => {
  assert.equal(parseTrace('fl=1\nh=www.cloudflare.com\nip=203.0.113.10\nts=1\nloc=IT\n'), '203.0.113.10');
  assert.equal(parseTrace('nothing'), null);
});

test('direct LAN / localhost request = home; direct public request = away', async () => {
  const n = new HomeNetwork({ lookup: async () => NAS_PUBLIC });
  assert.deepEqual([n.detect(req({}, '192.168.1.20')).home, n.detect(req({}, '192.168.1.20')).via], [true, 'direct']);
  assert.equal(n.detect(req({}, '127.0.0.1')).home, true);
  assert.equal(n.detect(req({}, '::1')).home, true);
  assert.equal(n.detect(req({}, '::ffff:172.18.0.1')).home, true); // docker bridge peer
  const pub = n.detect(req({}, OTHER_PUBLIC));
  assert.deepEqual([pub.home, pub.via], [false, 'direct-public']);
});

test('through Cloudflare: home only when the visitor has the same public IP as the NAS', async () => {
  const n = new HomeNetwork({ lookup: async () => NAS_PUBLIC });
  await n.refresh();
  // the peer is cloudflared (private) in both cases: the header must decide, not the peer
  const home = n.detect(req({ 'cf-connecting-ip': NAS_PUBLIC }, '172.18.0.1'));
  assert.deepEqual([home.home, home.via], [true, 'public-ip']);
  assert.match(home.reason, /home network/);
  const away = n.detect(req({ 'cf-connecting-ip': OTHER_PUBLIC }, '172.18.0.1'));
  assert.deepEqual([away.home, away.via], [false, 'public-ip']);
  assert.match(away.reason, /differs/);
  assert.match(away.reason, /settings\.home\.publicIps/);
});

test('extra public IPs from the config count as home', async () => {
  const n = new HomeNetwork({ lookup: async () => NAS_PUBLIC, getExtraIps: () => [OTHER_PUBLIC] });
  await n.refresh();
  assert.equal(n.detect(req({ 'cf-connecting-ip': OTHER_PUBLIC }, '10.0.0.2')).home, true);
});

test('unknown until the NAS public IP is known; the config list works even before', () => {
  const n = new HomeNetwork({ lookup: async () => { throw new Error('offline'); } });
  const r = n.detect(req({ 'cf-connecting-ip': NAS_PUBLIC }, '10.0.0.2'));
  assert.deepEqual([r.home, r.via], [null, 'unknown']);
  const withList = new HomeNetwork({ lookup: async () => NAS_PUBLIC, getExtraIps: () => [NAS_PUBLIC] });
  assert.equal(withList.detect(req({ 'cf-connecting-ip': NAS_PUBLIC }, '10.0.0.2')).home, true);
});

test('a hub that runs away from home (laptop preview): a direct visit is home only if this machine\'s public IP is a home IP', async () => {
  // the laptop's public IP is OTHER_PUBLIC, the NAS's is NAS_PUBLIC
  const away = new HomeNetwork({ lookup: async () => OTHER_PUBLIC, getRunsAtHome: () => false, getExtraIps: () => [NAS_PUBLIC] });
  await away.refresh();
  const r = away.detect(req({}, '127.0.0.1'));
  assert.deepEqual([r.home, r.via], [false, 'server-network']);
  assert.match(r.reason, /not a home IP/);
  // the hub's own IP must not count as home through Cloudflare either
  assert.equal(away.detect(req({ 'cf-connecting-ip': OTHER_PUBLIC }, '10.0.0.2')).home, false);
  assert.equal(away.detect(req({ 'cf-connecting-ip': NAS_PUBLIC }, '10.0.0.2')).home, true);

  // the same laptop taken home: its public IP is now the NAS's
  const home = new HomeNetwork({ lookup: async () => NAS_PUBLIC, getRunsAtHome: () => false, getExtraIps: () => [NAS_PUBLIC] });
  await home.refresh();
  assert.equal(home.detect(req({}, '127.0.0.1')).home, true);

  // nothing listed and nothing known: away, never a guess of "home"
  const bare = new HomeNetwork({ lookup: async () => { throw new Error('offline'); }, getRunsAtHome: () => false });
  assert.equal(bare.detect(req({}, '127.0.0.1')).home, false);
});

test('config: runsAtHome defaults to true and must be a boolean', () => {
  const base = (home) => `settings: { home: ${home} }\ngroups:\n  - name: G\n    services:\n      - { name: A, url: "https://a.example.net" }\n`;
  assert.equal(parseConfigText(base('{}')).config.settings.home.runsAtHome, true);
  assert.equal(parseConfigText(base('{ runsAtHome: false }')).config.settings.home.runsAtHome, false);
  assert.match(parseConfigText(base('{ runsAtHome: "no" }')).errors.join(), /runsAtHome/);
});

test('a failed lookup keeps the last known address', async () => {
  let fail = false;
  const n = new HomeNetwork({ lookup: async () => { if (fail) throw new Error('timeout'); return NAS_PUBLIC; } });
  await n.refresh();
  fail = true;
  await n.refresh();
  assert.equal(n.publicIp, NAS_PUBLIC);
  assert.equal(n.lookupError, 'timeout');
});

test('X-Forwarded-For is ignored (cannot be used to claim home)', () => {
  const n = new HomeNetwork({ lookup: async () => NAS_PUBLIC });
  const r = n.detect(req({ 'x-forwarded-for': '192.168.1.5' }, OTHER_PUBLIC));
  assert.equal(r.home, false);
});

test('IPv6 visitor through Cloudflare is not matched against an IPv4-only NAS: reported as away, not as an error', async () => {
  const n = new HomeNetwork({ lookup: async () => NAS_PUBLIC });
  await n.refresh();
  assert.equal(n.detect(req({ 'cf-connecting-ip': '2001:db8:1:2::5' }, '10.0.0.2')).home, false);
});

test('/api/status carries the per-request home verdict', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-net-'));
  const file = path.join(dir, 'services.yaml');
  fs.writeFileSync(file, `
settings:
  home:
    publicIps: ["${OTHER_PUBLIC}"]
groups:
  - name: G
    services:
      - { name: Both, url: "https://both.example.net", local: "http://10.0.0.5:81", check: "http://10.0.0.5:81" }
      - { name: LanOnly, local: "http://10.0.0.5:9000" }
`);
  const monitor = new Monitor({
    configPath: file,
    check: async () => ({ status: 'up', detail: 'HTTP 200', ms: 1 }),
    statsReader: { read: async () => ({ memory: { total: 1, used: 1, cache: null }, disks: [] }) }
  });
  await monitor.tick();
  const network = new HomeNetwork({ lookup: async () => NAS_PUBLIC, getExtraIps: () => monitor.config.settings.home.publicIps });
  await network.refresh();
  const server = createApp({ monitor, network });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api/status`;
  try {
    const direct = await (await fetch(base)).json();
    assert.equal(direct.client.home, true); // localhost = direct on this machine
    assert.equal(direct.client.via, 'direct');

    const viaCf = await (await fetch(base, { headers: { 'cf-connecting-ip': '192.0.2.99' } })).json();
    assert.equal(viaCf.client.home, false);

    const viaCfHome = await (await fetch(base, { headers: { 'cf-connecting-ip': NAS_PUBLIC } })).json();
    assert.equal(viaCfHome.client.home, true);
    const viaList = await (await fetch(base, { headers: { 'cf-connecting-ip': OTHER_PUBLIC } })).json();
    assert.equal(viaList.client.home, true);

    const [both, lanOnly] = direct.groups[0].services;
    assert.deepEqual([both.url, both.localUrl], ['https://both.example.net', 'http://10.0.0.5:81']);
    assert.deepEqual([lanOnly.url, lanOnly.localUrl], ['', 'http://10.0.0.5:9000']);
    assert.equal(lanOnly.status, 'up', 'a home-only service is checked at its local address by default');
  } finally {
    server.close();
  }
});

test('config: local addresses, home-only services and publicIps validation', () => {
  const ok = parseConfigText(`
hosts: { nas: 10.0.0.5 }
groups:
  - name: G
    services:
      - { name: A, url: "https://a.example.net", local: "http://{nas}:1" }
      - { name: B, local: "http://{nas}:2" }
`);
  assert.deepEqual(ok.errors, []);
  const [a, b] = ok.config.groups[0].services;
  assert.equal(a.localUrl, 'http://10.0.0.5:1');
  assert.equal(b.url, '');
  assert.deepEqual(b.check, { type: 'http', url: 'http://10.0.0.5:2', insecure: false });

  const bad = parseConfigText(`
settings: { home: { publicIps: ["1.2.3.4", "not-an-ip"] } }
groups:
  - name: G
    services:
      - { name: A, url: "https://a.example.net", local: "ftp://x" }
      - { name: B }
`);
  assert.equal(bad.errors.length, 3);
  assert.match(bad.errors.join('\n'), /publicIps\[1\]/);
  assert.match(bad.errors.join('\n'), /A\.local/);
  assert.match(bad.errors.join('\n'), /needs a url/);
});
