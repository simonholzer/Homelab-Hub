import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfigText } from '../src/config.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const MINIMAL = `
hosts:
  nas: 10.0.0.5
groups:
  - name: Apps
    services:
      - name: One
        url: https://one.example.net
        check: http://{nas}:30080
`;

test('the example config/services.yaml is valid', () => {
  const text = fs.readFileSync(path.join(here, '..', 'config', 'services.yaml'), 'utf8');
  const { config, errors } = parseConfigText(text);
  assert.deepEqual(errors, []);
  const names = config.groups.flatMap((g) => g.services.map((s) => s.name));
  assert.ok(names.includes('Immich') && names.includes('AMP'));
  // an app behind Cloudflare Access must have a direct check, not the public URL
  const immich = config.groups[0].services.find((s) => s.name === 'Immich');
  assert.equal(immich.url, 'https://photos.example.com');
  assert.equal(immich.check.url, 'http://192.168.1.10:2283');
  assert.equal(immich.localUrl, 'http://192.168.1.10:2283');
  // the first group matches containers by card name by itself
  assert.equal(immich.autoContainers, true);
  assert.deepEqual(immich.containers, []);
  // game server: local only (no public route), checked on the LAN
  const mc = config.groups.find((g) => g.name === 'Game Server').services;
  for (const name of ['AMP', 'BlueMap']) {
    const s = mc.find((x) => x.name === name);
    assert.equal(s.url, '', `${name} on the game server has no public address`);
    assert.match(s.localUrl, /^http:\/\/192\.168\.1\.30:\d+$/);
    assert.match(s.check.url, /^http:\/\/192\.168\.1\.30:\d+$/);
  }
  // every service of the first group has a local address for the home network
  for (const s of config.groups[0].services) {
    assert.match(s.localUrl, /^https?:\/\/192\.168\.1\.10:\d+$/, s.name);
  }
  // the Pi cards open the public address; SSH is checked on its port only
  const pi = config.groups.find((g) => g.name === 'Raspberry Pi').services;
  assert.equal(pi.find((x) => x.name === 'Cockpit').url, 'https://cockpit.example.com');
  assert.equal(pi.find((x) => x.name === 'Cockpit').localUrl, '');
});

test('host aliases are substituted in url and check', () => {
  const { config, errors } = parseConfigText(MINIMAL.replace('https://one.example.net', 'http://{nas}:1'));
  assert.deepEqual(errors, []);
  const svc = config.groups[0].services[0];
  assert.equal(svc.url, 'http://10.0.0.5:1');
  assert.deepEqual(svc.check, { type: 'http', url: 'http://10.0.0.5:30080', insecure: false });
});

test('tcp checks, insecure flag, none and default check', () => {
  const { config, errors } = parseConfigText(`
hosts: { pi: 1.2.3.4 }
groups:
  - name: G
    services:
      - { name: A, url: "https://a.example.net", check: "tcp://{pi}:22" }
      - { name: B, url: "https://b.example.net", check: "https://{pi}:9090", insecure: true }
      - { name: C, url: "https://c.example.net", check: none }
      - { name: D, url: "https://d.example.net", check: false }
      - { name: E, url: "https://e.example.net" }
`);
  assert.deepEqual(errors, []);
  const [a, b, c, d, e] = config.groups[0].services;
  assert.deepEqual(a.check, { type: 'tcp', host: '1.2.3.4', port: 22 });
  assert.equal(b.check.insecure, true);
  assert.equal(c.check, null);
  assert.equal(d.check, null);
  assert.deepEqual(e.check, { type: 'http', url: 'https://e.example.net', insecure: false });
});

test('hidden services are skipped, containers accept a string or a list', () => {
  const { config } = parseConfigText(`
groups:
  - name: G
    services:
      - { name: A, url: "https://a.example.net", hidden: true }
      - { name: B, url: "https://b.example.net", containers: "*b*" }
      - { name: C, url: "https://c.example.net", containers: ["x", "y"] }
`);
  const svcs = config.groups[0].services;
  assert.deepEqual(svcs.map((s) => s.name), ['B', 'C']);
  assert.deepEqual(svcs[0].containers, ['*b*']);
  assert.deepEqual(svcs[1].containers, ['x', 'y']);
});

test('errors are collected with readable messages', () => {
  const { config, errors } = parseConfigText(`
groups:
  - name: G
    services:
      - { name: A, url: "javascript:alert(1)" }
      - { name: B, url: "https://b.example.net", check: "http://{nope}:1" }
      - { name: C }
      - { url: "https://d.example.net" }
`);
  assert.equal(config, null);
  assert.equal(errors.length, 4);
  assert.match(errors.join('\n'), /A\.url: must be a full http/);
  assert.match(errors.join('\n'), /unknown host alias \{nope\}/);
  assert.match(errors.join('\n'), /C: needs a url/);
  assert.match(errors.join('\n'), /needs a name/);
});

test('YAML syntax errors do not throw', () => {
  const { config, errors } = parseConfigText('groups:\n  - name: [unclosed\n');
  assert.equal(config, null);
  assert.match(errors[0], /YAML syntax error/);
});

test('empty / wrong top level', () => {
  assert.equal(parseConfigText('').config, null);
  assert.equal(parseConfigText('- a\n- b').config, null);
  assert.match(parseConfigText('title: x').errors[0], /groups/);
});

test('setting limits are enforced', () => {
  const { errors } = parseConfigText(MINIMAL + '\nsettings:\n  checkIntervalSeconds: 1\n  timeoutSeconds: 100\n');
  assert.equal(errors.length, 2);
});

import { parseSize } from '../src/config.js';

test('parseSize reads sizes like 106.6G, 1.5 TB, 900 GiB (1024-based)', () => {
  assert.equal(parseSize('1G'), 1024 ** 3);
  assert.equal(parseSize('1.5 TB'), Math.round(1.5 * 1024 ** 4));
  assert.equal(parseSize('900 GiB'), 900 * 1024 ** 3);
  assert.equal(parseSize(2048), 2048);
  for (const bad of ['', 'abc', '-5G', '0', 'G', '12 XB']) assert.equal(parseSize(bad), null, bad);
});

test('disk size in the config: valid sizes are kept, a bad one is an error', () => {
  const base = (size) => `stats:\n  disks:\n    - { name: A, path: /x, size: ${size} }\ngroups:\n  - name: G\n    services:\n      - { name: S, url: "https://s.example.net" }\n`;
  assert.equal(parseConfigText(base('10G')).config.stats.disks[0].sizeBytes, 10 * 1024 ** 3);
  assert.match(parseConfigText(base('lots')).errors.join(), /stats\.disks\[0\]\.size/);
});

test('statsIntervalSeconds: default 5, range 1 to 3600', () => {
  const base = (s) => `settings: { ${s} }\ngroups:\n  - name: G\n    services:\n      - { name: A, url: "https://a.example.net" }\n`;
  assert.equal(parseConfigText(base('')).config.settings.statsIntervalSeconds, 5);
  assert.equal(parseConfigText(base('statsIntervalSeconds: 2')).config.settings.statsIntervalSeconds, 2);
  assert.match(parseConfigText(base('statsIntervalSeconds: 0')).errors.join(), /statsIntervalSeconds/);
  assert.match(parseConfigText(base('statsIntervalSeconds: 99999')).errors.join(), /statsIntervalSeconds/);
});
