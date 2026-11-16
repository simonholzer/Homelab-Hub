// Stats from other machines: the agent, the hub asking it, and what the page gets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createAgentApp, fetchMachineStats, AGENT_PATH } from '../src/agent.js';
import { parseConfigText } from '../src/config.js';
import { Monitor } from '../src/monitor.js';

const TEST_TOKEN = 'test-token-123';

async function withAgent(options, fn) {
  const asked = [];
  const reader = {
    read: async (disks, opts) => {
      asked.push({ disks, opts });
      return { source: 'proc', cpuPercent: 12, cores: 4, memory: { total: 8, used: 3, cache: null }, disks: disks.map((d) => ({ name: d.name, freeBytes: 5, totalBytes: d.sizeBytes ?? null })) };
    }
  };
  const server = createAgentApp({ reader, ...options });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(url, asked);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('agent: answers with this machine\'s numbers for the disks and cards the hub names', async () => {
  await withAgent({}, async (url, asked) => {
    const stats = await fetchMachineStats({ url, disks: [{ name: 'SD card', path: '/', sizeBytes: 1000 }], network: ['eth0'] });
    assert.equal(stats.cpuPercent, 12);
    assert.deepEqual(stats.disks, [{ name: 'SD card', freeBytes: 5, totalBytes: 1000 }]);
    assert.deepEqual(asked[0], { disks: [{ name: 'SD card', path: '/', sizeBytes: 1000 }], opts: { interfaces: ['eth0'] } });

    // a plain GET works too (to look at it in a browser); there is no page and nothing else to find
    const get = await fetch(url + AGENT_PATH);
    assert.equal(get.status, 200);
    assert.equal((await get.json()).ok, true);
    assert.equal((await fetch(url + '/')).status, 404);
    assert.equal((await fetch(url + '/api/status')).status, 404);
    assert.equal((await fetch(url + '/api/config')).status, 404);
    assert.deepEqual(await (await fetch(url + '/healthz')).json(), { ok: true, mode: 'agent' });
  });
});

test('agent: malformed requests never reach the stats reader as they are', async () => {
  await withAgent({}, async (url, asked) => {
    const post = (body) => fetch(url + AGENT_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    assert.equal((await post('{not json')).status, 400);
    assert.equal((await post(JSON.stringify({ disks: 'everything', interfaces: 'all' }))).status, 200);
    assert.deepEqual(asked.at(-1), { disks: [], opts: { interfaces: [] } });
    const res = await post(JSON.stringify({ disks: [{ path: 5 }, null, { path: '/data', sizeBytes: 'big' }, { name: 'x', path: '' }], interfaces: ['eth0', 'bad name;rm', 7] }));
    assert.equal(res.status, 200);
    assert.deepEqual(asked.at(-1), { disks: [{ name: '/data', path: '/data' }], opts: { interfaces: ['eth0', '7'] } });
    assert.equal((await post('x'.repeat(40_000))).status, 400);
    assert.equal((await fetch(url + AGENT_PATH, { method: 'DELETE' })).status, 405);
  });
});

test('agent with a token: only the right token gets an answer', async () => {
  await withAgent({ token: TEST_TOKEN }, async (url, asked) => {
    assert.equal((await fetch(url + AGENT_PATH)).status, 401);
    assert.equal((await fetch(url + AGENT_PATH, { headers: { authorization: 'Bearer nope' } })).status, 401);
    await assert.rejects(fetchMachineStats({ url }), /refused the token/);
    await assert.rejects(fetchMachineStats({ url, token: 'nope' }), /refused the token/);
    assert.equal(asked.length, 0);
    assert.equal((await fetchMachineStats({ url, token: TEST_TOKEN })).cores, 4);
    assert.equal((await fetch(url + '/healthz')).status, 200, 'the health check needs no token');
  });
});

test('asking a machine that is not there, or is something else, gives a short reason', async () => {
  // a port nothing listens on: taken for a moment, then given back
  const gone = await new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
  await assert.rejects(fetchMachineStats({ url: `http://127.0.0.1:${gone}` }, 1500), /Connection refused|Timed out/);
  // something that is not an agent: a plain web server
  const web = http.createServer((req, res) => res.writeHead(404).end('nothing here'));
  await new Promise((r) => web.listen(0, '127.0.0.1', r));
  await assert.rejects(fetchMachineStats({ url: `http://127.0.0.1:${web.address().port}` }), /No agent at this address/);
  await new Promise((r) => web.close(r));
});

test('config: stats.machines', () => {
  const ok = parseConfigText(`hosts:
  pi: 192.168.1.20
stats:
  machines:
    - name: Raspberry Pi
      url: http://{pi}:8080
      token: abc
      network: [eth0]
      disks:
        - { name: SD card, path: /, size: 29G }
    - url: https://vps.example.com:8443
    - { name: Off, url: "http://192.168.1.99:8080", hidden: true }
`);
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.config.stats.machines, [
    { name: 'Raspberry Pi', url: 'http://192.168.1.20:8080', token: 'abc', disks: [{ name: 'SD card', path: '/', sizeBytes: 29 * 1024 ** 3 }], network: ['eth0'] },
    { name: 'vps.example.com', url: 'https://vps.example.com:8443', token: '', disks: [], network: [] }
  ]);
  assert.deepEqual(parseConfigText('title: x').config.stats.machines, []);

  const bad = parseConfigText('stats:\n  machines:\n    - name: No address\n    - { url: "ftp://x" }\n    - { url: "http://{nope}:1" }\n    - { url: "http://ok:1", disks: [{ name: x }] }\n');
  assert.equal(bad.config, null);
  assert.equal(bad.errors.length, 4);
  assert.match(parseConfigText('stats:\n  machines: yes please\n').errors[0], /stats\.machines/);
});

test('hub: asks every machine, shows what answered, and never passes addresses or tokens to the page', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-machines-'));
  const file = path.join(dir, 'services.yaml');
  fs.writeFileSync(file, `stats:
  machines:
    - { name: Pi, url: "http://192.168.1.20:8080", token: secret-token-value }
    - { name: Broken, url: "http://192.168.1.21:8080" }
`);
  const asked = [];
  const monitor = new Monitor({
    configPath: file,
    check: async () => ({ status: 'up' }),
    statsReader: { read: async () => ({ source: 'proc', cpuPercent: 1 }) },
    fetchMachine: async (machine, timeoutMs) => {
      asked.push([machine.url, machine.token, timeoutMs]);
      if (machine.name === 'Broken') throw new Error('Connection refused');
      return { source: 'proc', cpuPercent: 42 };
    }
  });
  await monitor.tick();
  const snap = monitor.snapshot();
  assert.deepEqual(asked, [['http://192.168.1.20:8080', 'secret-token-value', 4000], ['http://192.168.1.21:8080', '', 4000]]);
  assert.equal(snap.stats.cpuPercent, 1);
  assert.deepEqual(snap.machines, [
    { name: 'Pi', stats: { source: 'proc', cpuPercent: 42 }, error: null },
    { name: 'Broken', stats: null, error: 'Connection refused' }
  ]);
  const sent = JSON.stringify(snap);
  assert.ok(!sent.includes('secret-token-value') && !sent.includes('192.168.1.20'), 'tokens and agent addresses stay on the server');

  // the hub's own stats failing does not hide the other machines, and the other way round
  const lonely = new Monitor({
    configPath: file,
    check: async () => ({ status: 'up' }),
    statsReader: { read: async () => { throw new Error('cannot read /proc/meminfo'); } },
    fetchMachine: async () => ({ source: 'proc', cpuPercent: 7 })
  });
  await lonely.tick();
  const s = lonely.snapshot();
  assert.equal(s.stats, null);
  assert.match(s.statsError, /meminfo/);
  assert.equal(s.machines[0].stats.cpuPercent, 7);

  // machines removed from the YAML disappear
  fs.writeFileSync(file, 'title: none\n');
  await monitor.tick();
  assert.deepEqual(monitor.snapshot().machines, []);
});
