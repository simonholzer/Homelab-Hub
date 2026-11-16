// Docker label cards, login hosts, reverse-proxy header, icons by name, the empty and the starter config.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfigText, servicesFromLabels } from '../src/config.js';
import { classifyResponse } from '../src/checks.js';
import { normalizeContainer } from '../src/docker.js';
import { HomeNetwork } from '../src/network.js';
import { Monitor } from '../src/monitor.js';
import { createApp } from '../src/server.js';
import { createIconFetcher, ICON_SOURCE } from '../src/icons.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `hub-${name}-`));
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>';

const container = (name, labels = {}, status = 'Up 2 days (healthy)') =>
  normalizeContainer({ Id: name, Names: [`/${name}`], Image: 'img', State: 'running', Status: status, Labels: { 'com.docker.compose.service': name.replace(/-1$/, ''), ...labels } });

test('a config without services is valid (the page then says how to add the first one)', () => {
  for (const text of ['title: x', 'title: x\ngroups: []']) {
    const { config, errors } = parseConfigText(text);
    assert.deepEqual(errors, []);
    assert.deepEqual(config.groups, []);
  }
  assert.match(parseConfigText('groups: nope').errors[0], /groups/);
});

test('the starter config (copied on the first start in Docker) is valid', () => {
  const { config, errors } = parseConfigText(fs.readFileSync(path.join(here, '..', 'config', 'starter.yaml'), 'utf8'));
  assert.deepEqual(errors, []);
  assert.ok(config.groups.length >= 1);
});

test('new settings: login hosts, proxy header, docker labels, language', () => {
  const ok = parseConfigText('settings:\n  loginHosts: [Auth.Example.com]\n  dockerLabels: false\n  language: de\n  home:\n    clientIpHeader: X-Forwarded-For\ngroups:\n  - name: A\n    services:\n      - { name: One, url: "https://one.example.com" }\n');
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.config.settings.loginHosts, ['auth.example.com']);
  assert.equal(ok.config.settings.home.clientIpHeader, 'x-forwarded-for');
  assert.equal(ok.config.settings.dockerLabels, false);
  assert.equal(ok.config.settings.language, 'de');
  assert.deepEqual(ok.config.groups[0].services[0].check.loginHosts, ['auth.example.com']);

  const bad = parseConfigText('settings:\n  loginHosts: ["https://auth.example.com/login"]\n  dockerLabels: maybe\n  language: xx\n  home:\n    clientIpHeader: "bad header"\n');
  assert.equal(bad.errors.length, 4);
});

test('a redirect to one of your login hosts is "unknown", like one to Cloudflare Access', () => {
  assert.equal(classifyResponse(302, 'https://auth.example.com/?rd=x', ['auth.example.com']).status, 'unknown');
  assert.equal(classifyResponse(302, 'https://auth.example.com/?rd=x').status, 'up');
  assert.equal(classifyResponse(302, 'https://other.example.com/', ['auth.example.com']).status, 'up');
  assert.equal(classifyResponse(302, '/login', ['auth.example.com']).status, 'up');
});

test('reverse proxy: the visitor address is taken from the configured header only', async () => {
  const SERVER_IP = '203.0.113.10';
  const req = (headers, remoteAddress = '172.18.0.2') => ({ headers, socket: { remoteAddress } });
  const plain = new HomeNetwork({ lookup: async () => SERVER_IP });
  await plain.refresh();
  // not configured: the header is ignored, the proxy's private address decides
  assert.equal(plain.detect(req({ 'x-forwarded-for': '198.51.100.7' })).via, 'direct');

  const proxied = new HomeNetwork({ lookup: async () => SERVER_IP, getClientIpHeader: () => 'x-forwarded-for' });
  await proxied.refresh();
  const away = proxied.detect(req({ 'x-forwarded-for': '198.51.100.7' }));
  assert.deepEqual([away.home, away.via, away.clientIp], [false, 'public-ip', '198.51.100.7']);
  const lan = proxied.detect(req({ 'x-forwarded-for': '192.168.1.50, 172.18.0.1' }));
  assert.deepEqual([lan.home, lan.via, lan.clientIp], [true, 'proxy-lan', '192.168.1.50']);
  assert.equal(proxied.detect(req({ 'x-forwarded-for': SERVER_IP })).home, true, 'same public IP as the server');
  assert.equal(proxied.detect(req({})).via, 'direct', 'no header: a direct visit on the LAN');
});

test('cards from Docker labels', () => {
  const config = parseConfigText('hosts:\n  nas: 192.168.1.10\n').config;
  const list = [
    container('whoami-1', { 'homelab-hub.url': 'https://whoami.example.com', 'homelab-hub.local': 'http://{nas}:8000', 'homelab-hub.group': 'Tools', 'homelab-hub.icon': 'traefik' }),
    container('grafana-1', { 'homelab-hub.name': 'Grafana', 'homelab-hub.local': 'http://{nas}:3000', 'homelab-hub.check': 'tcp://{nas}:3000' }),
    container('grafana-2', { 'homelab-hub.name': 'Grafana', 'homelab-hub.local': 'http://{nas}:3000' }),
    container('secret-1', { 'homelab-hub.local': 'http://{nas}:1', 'homelab-hub.hide': 'true' }),
    container('broken-1', { 'homelab-hub.url': 'not a url' }),
    container('plain-1', { 'homelab-hub.name': 'No address' }),
    container('other-1')
  ];
  const { groups, errors } = servicesFromLabels(list, config);
  assert.deepEqual(groups.map((g) => [g.name, g.services.map((s) => s.name)]), [['Tools', ['whoami']], ['Docker', ['Grafana']]]);
  const whoami = groups[0].services[0];
  assert.equal(whoami.id, 'd:whoami-1');
  assert.equal(whoami.url, 'https://whoami.example.com');
  assert.equal(whoami.localUrl, 'http://192.168.1.10:8000');
  assert.equal(whoami.icon, 'traefik');
  assert.deepEqual(whoami.containers, ['whoami-1']);
  assert.deepEqual(groups[1].services[0].check, { type: 'tcp', host: '192.168.1.10', port: 3000 });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^container broken-1: /);
});

test('label cards are checked, shown in their group, and go away with their container', async () => {
  const dir = tmp('labels');
  const file = path.join(dir, 'services.yaml');
  fs.writeFileSync(file, 'groups:\n  - name: Tools\n    services:\n      - { name: Manual, url: "https://manual.example.com" }\n      - { name: whoami, url: "https://yaml-wins.example.com" }\n');
  let list = [
    container('whoami-1', { 'homelab-hub.url': 'https://whoami.example.com', 'homelab-hub.group': 'Tools' }),
    container('grafana-1', { 'homelab-hub.name': 'Grafana', 'homelab-hub.local': 'http://192.168.1.10:3000' }, 'Up 1 hour (unhealthy)')
  ];
  const checked = [];
  const monitor = new Monitor({
    configPath: file,
    dockerHost: 'http://docker.invalid',
    containers: async () => list,
    check: async (check) => (checked.push(check.url), { status: 'up', detail: 'HTTP 200', ms: 1 }),
    statsReader: { read: async () => null }
  });
  await monitor.tick();
  let snap = monitor.snapshot();
  assert.deepEqual(snap.groups.map((g) => [g.name, g.services.map((s) => s.name)]), [['Tools', ['Manual', 'whoami']], ['Docker', ['Grafana']]]);
  assert.equal(snap.groups[0].services[1].url, 'https://yaml-wins.example.com', 'a card written in the YAML wins over a label of the same name');
  const grafana = snap.groups[1].services[0];
  assert.equal(grafana.status, 'up');
  assert.equal(grafana.fromDocker, true);
  assert.equal(grafana.containers.state, 'unhealthy');
  assert.ok(checked.includes('http://192.168.1.10:3000'));
  assert.equal(snap.summary.total, 3);

  list = [];
  await monitor.tick();
  snap = monitor.snapshot();
  assert.deepEqual(snap.groups.map((g) => g.name), ['Tools']);

  // switched off in the YAML: labels are ignored
  list = [container('grafana-1', { 'homelab-hub.local': 'http://192.168.1.10:3000' })];
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8') + 'settings:\n  dockerLabels: false\n');
  await monitor.tick();
  assert.deepEqual(monitor.snapshot().groups.map((g) => g.name), ['Tools']);
});

test('icons by name: fetched once from dashboard-icons, kept next to the config, not asked for again after a miss', async () => {
  const dir = tmp('icons');
  const asked = [];
  let clock = 0;
  const fetchMissing = createIconFetcher({
    iconsDir: dir,
    now: () => clock,
    download: async (url) => {
      asked.push(url);
      if (url.endsWith('/nothing-like-this.svg')) throw new Error('the site answered 404');
      return SVG;
    }
  });
  await fetchMissing(['Grafana', 'grafana', 'nothing-like-this', '../etc/passwd', '']);
  assert.deepEqual(asked.sort(), [`${ICON_SOURCE}/grafana.svg`, `${ICON_SOURCE}/nothing-like-this.svg`]);
  assert.equal(fs.readFileSync(path.join(dir, 'grafana.svg'), 'utf8'), SVG);
  assert.deepEqual(fs.readdirSync(dir), ['grafana.svg']);

  await fetchMissing(['nothing-like-this']);
  assert.equal(asked.length, 2, 'a miss is not retried right away');
  clock += 7 * 60 * 60 * 1000;
  await fetchMissing(['nothing-like-this']);
  assert.equal(asked.length, 3, 'but it is after some hours');
});

test('the page asks for missing icons only when that is switched on, and shows them once they are there', async () => {
  const dir = tmp('autoicons');
  const file = path.join(dir, 'services.yaml');
  fs.writeFileSync(file, 'groups:\n  - name: A\n    services:\n      - { name: One, icon: grafana, url: "https://one.example.com" }\n');
  const run = async (autoIcons) => {
    const asked = [];
    const monitor = new Monitor({ configPath: file, check: async () => ({ status: 'up' }), statsReader: { read: async () => null } });
    await monitor.tick();
    const server = createApp({ monitor, publicDir: tmp('pub'), autoIcons, downloadIcon: async (url) => (asked.push(url), SVG) });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const status = async () => (await fetch(`http://127.0.0.1:${server.address().port}/api/status`)).json();
    const first = await status();
    await new Promise((r) => setTimeout(r, 50));
    const second = await status();
    await new Promise((r) => server.close(r));
    return { asked, first, second };
  };
  const off = await run(false);
  assert.deepEqual(off.asked, []);
  assert.equal(off.second.icons.grafana, undefined);

  const on = await run(true);
  assert.deepEqual(on.asked, [`${ICON_SOURCE}/grafana.svg`]);
  assert.equal(on.first.icons.grafana, undefined);
  assert.equal(typeof on.second.icons.grafana, 'string');
});
