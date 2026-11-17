// Finding agents on the home network, and other machines' containers on the hub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseCidr, formatCidr, hostsOf, subnetsFromRouteTable, subnetsFromInterfaces, networksToSearch, findAgents, AgentFinder } from '../src/scan.js';
import { createAgentApp, fetchAgent, cleanContainers } from '../src/agent.js';
import { parseConfigText } from '../src/config.js';
import { Monitor } from '../src/monitor.js';
import { suggestServices } from '../src/discover.js';

const ROUTE = [
  'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT',
  'eno1\t00000000\t0101A8C0\t0003\t0\t0\t0\t00000000\t0\t0\t0',
  'eno1\t0001A8C0\t00000000\t0001\t0\t0\t0\t00FFFFFF\t0\t0\t0',
  'docker0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0',
  'br-1234\t000012AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0',
  'eno2\t0000000A\t00000000\t0001\t0\t0\t0\t000000FF\t0\t0\t0',
  'wg0\t0000080A\t00000000\t0001\t0\t0\t0\t00FFFFFF\t0\t0\t0',
  ''
].join('\n');

test('scan: networks from the routing table, without Docker\'s own, too-large ones shrunk', () => {
  const nets = subnetsFromRouteTable(ROUTE);
  assert.deepEqual(nets.map((n) => [n.iface, formatCidr(n)]), [['eno1', '192.168.1.0/24'], ['eno2', '10.0.0.0/8']]);
  const readFile = (f) => {
    if (f.replaceAll('\\', '/') === '/p/1/net/route') return ROUTE;
    throw new Error('no');
  };
  assert.deepEqual(networksToSearch({ procPath: '/p', readFile }).map(formatCidr), ['192.168.1.0/24', '10.0.0.0/24']);
});

test('scan: networks from the config win; network cards are the last resort', () => {
  assert.deepEqual(networksToSearch({ subnets: ['192.168.5.7/24', '10.1.0.0/22'] }).map(formatCidr), ['192.168.5.0/24', '10.1.0.0/22']);
  const ifaces = {
    lo: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', internal: true }],
    Ethernet: [{ address: '192.168.178.40', netmask: '255.255.255.0', family: 'IPv4', internal: false, cidr: '192.168.178.40/24' }],
    Public: [{ address: '8.8.8.8', netmask: '255.255.255.0', family: 'IPv4', internal: false }]
  };
  assert.deepEqual(subnetsFromInterfaces(ifaces).map(formatCidr), ['192.168.178.0/24']);
  const readFile = () => {
    throw new Error('no');
  };
  assert.deepEqual(networksToSearch({ readFile, interfaces: ifaces }).map(formatCidr), ['192.168.178.0/24']);
});

test('scan: cidr helpers', () => {
  assert.equal(parseCidr('300.1.1.1/24'), null);
  assert.equal(parseCidr('nope'), null);
  assert.equal(hostsOf(parseCidr('192.168.1.0/24')).length, 254);
  assert.deepEqual(hostsOf(parseCidr('10.0.0.4/30')), ['10.0.0.5', '10.0.0.6']);
  assert.deepEqual(hostsOf(parseCidr('10.0.0.4/32')), ['10.0.0.4']);
});

test('scan: finds agents (one per machine) and nothing else', async () => {
  const asked = [];
  const probe = async (url) => {
    asked.push(url);
    if (url.startsWith('http://10.0.0.5:')) return { ok: true, mode: 'agent', name: 'Pi', docker: true, token: false, version: '1.4.0' };
    return null;
  };
  const found = await findAgents({ networks: [parseCidr('10.0.0.4/30')], probe, concurrency: 1 });
  assert.deepEqual(found, [{ url: 'http://10.0.0.5:8081', ip: '10.0.0.5', port: 8081, name: 'Pi', version: '1.4.0', docker: true, token: false }]);
  assert.equal(asked.length, 3); // 10.0.0.5:8080 is skipped once the machine has an agent
});

test('scan: a real agent answers the search', async () => {
  const agent = createAgentApp({ reader: { read: async () => ({}) }, name: 'Box', version: '1.4.0' });
  await new Promise((r) => agent.listen(0, '127.0.0.1', r));
  const port = agent.address().port;
  try {
    const found = await findAgents({ networks: [parseCidr('127.0.0.1/32')], ports: [port] });
    assert.equal(found[0].name, 'Box');
    assert.equal(found[0].url, `http://127.0.0.1:${port}`);
  } finally {
    await new Promise((r) => agent.close(r));
  }
});

test('scan: AgentFinder follows the settings', async () => {
  let settings = { enabled: true, subnets: [], ports: [] };
  const finder = new AgentFinder({
    getSettings: () => settings,
    networks: () => [parseCidr('10.0.0.0/30')],
    find: async ({ ports }) => [{ url: `http://10.0.0.1:${ports[0]}`, ip: '10.0.0.1', port: ports[0], name: 'A' }]
  });
  await finder.scan();
  assert.equal(finder.state().agents[0].port, 8081);
  assert.deepEqual(finder.state().networks, ['10.0.0.0/30']);
  settings = { enabled: false };
  await finder.scan();
  assert.deepEqual(finder.state().agents, []);
  const none = new AgentFinder({ getSettings: () => ({ enabled: true }), networks: () => [] });
  await none.scan();
  assert.match(none.state().error, /settings\.discovery\.subnets/);
});

test('config: settings.discovery', () => {
  const ok = parseConfigText('settings:\n  discovery:\n    subnets: [192.168.1.0/24]\n    ports: [8081]\ngroups: []\n');
  assert.deepEqual(ok.config.settings.discovery, { enabled: true, subnets: ['192.168.1.0/24'], ports: [8081] });
  assert.equal(parseConfigText('settings:\n  discovery: false\n').config.settings.discovery.enabled, false);
  assert.equal(parseConfigText('groups: []\n').config.settings.discovery.enabled, true);
  const bad = parseConfigText('settings:\n  discovery:\n    subnets: [10.0.0.0/8, nope]\n    ports: [99999]\n');
  assert.equal(bad.config, null);
  assert.equal(bad.errors.length, 3);
});

// ---- containers of other machines ----

async function withAgent(options, fn) {
  const reader = { read: async () => ({ source: 'proc', cpuPercent: 12 }) };
  const server = createAgentApp({ reader, ...options });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('agent: reports its containers, asks Docker at most every few seconds, says so on /healthz', async () => {
  let asked = 0;
  const containers = async () => {
    asked++;
    return [{ name: 'pihole', project: 'pihole', service: 'pihole', image: 'pihole/pihole', state: 'running', status: 'Up', health: 'healthy', ports: [80, 53] }];
  };
  await withAgent({ containers, name: 'Raspberry Pi', version: '9.9.9', token: 'secret-1' }, async (url) => {
    const hello = await (await fetch(url + '/healthz')).json();
    assert.deepEqual(hello, { ok: true, mode: 'agent', name: 'Raspberry Pi', version: '9.9.9', docker: true, token: true });
    const a = await fetchAgent({ url, token: 'secret-1' });
    const b = await fetchAgent({ url, token: 'secret-1' });
    assert.equal(a.name, 'Raspberry Pi');
    assert.deepEqual(a.containers, [{ name: 'pihole', project: 'pihole', service: 'pihole', image: 'pihole/pihole', state: 'running', status: 'Up', health: 'healthy', ports: [53, 80] }]);
    assert.deepEqual(b.containers, a.containers);
    assert.equal(asked, 1);
  });
});

test('agent: a Docker error is passed on, the numbers still come', async () => {
  const containers = async () => {
    throw new Error('Docker API refused the connection');
  };
  await withAgent({ containers }, async (url) => {
    const a = await fetchAgent({ url });
    assert.equal(a.stats.cpuPercent, 12);
    assert.equal(a.containers, null);
    assert.equal(a.dockerError, 'Docker API refused the connection');
  });
});

test('agent: containers from an agent are cleaned before the hub uses them', () => {
  const out = cleanContainers([
    null,
    { name: '' },
    { name: 'x'.repeat(500), health: 'evil', ports: [80, 80, -1, 70000, 'a', 8080], labels: { url: 'http://a', 'Bad Key!': 'x', local: 5 }, extra: 'dropped' }
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].name.length, 200);
  assert.equal(out[0].health, 'stopped');
  assert.deepEqual(out[0].ports, [80, 8080]);
  assert.deepEqual(out[0].labels, { url: 'http://a', local: '5' });
  assert.equal('extra' in out[0], false);
  assert.deepEqual(cleanContainers('nope'), []);
});

test('hub: other machines\' containers get badges, label cards and suggestions with that machine\'s address', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-remote-'));
  const file = path.join(dir, 'services.yaml');
  fs.writeFileSync(
    file,
    [
      'stats:',
      '  machines:',
      '    - { name: Pi, url: "http://192.168.1.20:8081" }',
      'groups:',
      '  - name: Apps',
      '    services:',
      '      - { name: Pi-hole, local: "http://192.168.1.20:80", check: none, containers: ["*pihole*"] }',
      ''
    ].join('\n')
  );
  const remote = [
    { name: 'pihole', project: 'pihole', service: 'pihole', image: 'pihole/pihole', state: 'running', status: 'Up', health: 'healthy', ports: [80] },
    { name: 'grafana', project: 'grafana', service: 'grafana', image: 'grafana/grafana', state: 'running', status: 'Up', health: 'running', ports: [3000] },
    { name: 'whoami', project: '', service: '', image: 'traefik/whoami', state: 'running', status: 'Up', health: 'running', ports: [], labels: { name: 'Who', local: 'http://192.168.1.20:9999', check: 'none' } }
  ];
  const monitor = new Monitor({
    configPath: file,
    dockerHost: 'http://docker-proxy:2375',
    containers: async () => [{ name: 'x-grafana-1', project: 'x', service: 'grafana', image: 'grafana/grafana', state: 'running', status: 'Up', health: 'running', ports: [3000] }],
    statsReader: { read: async () => ({ source: 'proc' }) },
    fetchAgent: async () => ({ stats: { source: 'proc' }, containers: remote, dockerError: null, name: 'Pi' }),
    check: async () => ({ status: 'up' })
  });
  monitor.reloadConfig();
  await monitor.refreshStats();
  await monitor.tick();
  const snap = monitor.snapshot();
  const pihole = snap.groups[0].services[0];
  assert.equal(pihole.containers.state, 'healthy');
  assert.deepEqual(pihole.containers.items, [{ name: 'pihole', health: 'healthy', machine: 'Pi' }]);
  assert.ok(snap.groups.some((g) => g.services.some((s) => s.name === 'Who' && s.fromDocker)));
  assert.equal(snap.machines[0].containers, 3);
  assert.equal(snap.dockerError, null);

  // the local grafana and the Pi's grafana are two apps; the Pi's port 80 already has a card
  const found = suggestServices(monitor.discovered, monitor.config);
  assert.deepEqual(found.map((f) => [f.name, f.machine ?? null, f.host ?? null, f.port]), [['X', null, null, 3000], ['Grafana', 'Pi', '192.168.1.20', 3000]]);

  // the machine leaves the config: its containers go too
  fs.writeFileSync(file, 'groups: []\n');
  monitor.reloadConfig();
  await monitor.refreshStats();
  assert.equal(monitor.otherContainers().length, 0);
});
