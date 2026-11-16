// A demo with made-up data, to look at the hub without a homelab (and to take screenshots):
//   npm run demo        -> http://localhost:8099
// Everything is fake and stays on this computer: the services are answered by a small local
// server, Docker and /proc are imitated. Nothing here touches your real config.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-demo-'));

// fake /proc whose CPU counters move on every read, so the CPU meter shows something
const proc = path.join(tmp, 'proc');
fs.mkdirSync(path.join(proc, 'spl/kstat/zfs'), { recursive: true });
fs.writeFileSync(path.join(proc, 'meminfo'), 'MemTotal: 33554432 kB\nMemAvailable: 14680064 kB\n');
fs.writeFileSync(path.join(proc, 'loadavg'), '0.74 0.52 0.41 2/615 1\n');
fs.writeFileSync(path.join(proc, 'uptime'), '1234567.00 2000000.00\n');
fs.writeFileSync(path.join(proc, 'spl/kstat/zfs/arcstats'), 'x\nname type data\nsize 4 12884901888\n');
const disk = path.join(tmp, 'storage').replace(/\\/g, '/');
fs.mkdirSync(disk);
// the tiles show this computer's real free space: pick totals that give pleasant bars
const freeGb = (() => {
  try {
    const s = fs.statfsSync(disk);
    return Math.max(1, Math.round((s.bavail * s.bsize) / 1024 ** 3));
  } catch {
    return 500;
  }
})();
let busy = 0;
let idle = 0;
const writeCpu = () => {
  busy += 2300;
  idle += 7700;
  fs.writeFileSync(path.join(proc, 'stat'), `cpu ${busy} 0 0 ${idle} 0 0 0 0\ncpu0 1 0 0 1 0 0 0 0\ncpu1 1 0 0 1 0 0 0 0\ncpu2 1 0 0 1 0 0 0 0\ncpu3 1 0 0 1 0 0 0 0\n`);
};
writeCpu();
setInterval(writeCpu, 500).unref();

// fake network card whose byte counters grow (about 2.5 MB/s down, 0.4 MB/s up)
const nic = path.join(tmp, 'sys/class/net/eno1');
fs.mkdirSync(path.join(nic, 'statistics'), { recursive: true });
fs.mkdirSync(path.join(nic, 'device'));
let rx = 5e9;
let tx = 1e9;
const writeNet = () => {
  rx += 1.25e6;
  tx += 0.2e6;
  fs.writeFileSync(path.join(nic, 'statistics/rx_bytes'), String(rx));
  fs.writeFileSync(path.join(nic, 'statistics/tx_bytes'), String(tx));
};
writeNet();
setInterval(writeNet, 500).unref();

// fake Docker: a few containers, one of them with labels that make a card by themselves
const container = (name, project, status, labels = {}, ports = []) => ({
  Id: name, Names: [`/${name}`], Image: project, State: 'running', Status: status,
  Ports: ports.map((p) => ({ PrivatePort: p, PublicPort: p, Type: 'tcp', IP: '0.0.0.0' })),
  Labels: { 'com.docker.compose.project': project, ...labels }
});
const docker = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify([
    container('immich-server-1', 'immich', 'Up 2 days (healthy)'),
    container('immich-postgres-1', 'immich', 'Up 2 days (healthy)'),
    container('immich-ml-1', 'immich', 'Up 2 days (healthy)'),
    container('jellyfin-1', 'jellyfin', 'Up 5 days'),
    container('n8n-1', 'n8n', 'Up 5 days (healthy)'),
    container('uptime-kuma-1', 'uptime-kuma', 'Up 3 hours (unhealthy)'),
    // two apps without a card: the editor lists them under "Found on this server"
    container('paperless-ngx-1', 'paperless-ngx', 'Up 4 days (healthy)', {}, [8010]),
    container('vaultwarden-1', 'vaultwarden', 'Up 4 days (healthy)', {}, [8222]),
    container('paperless-redis-1', 'redis', 'Up 4 days', {}, [6379]),
    container('grafana-1', 'monitoring', 'Up 9 days (healthy)', {
      'homelab-hub.name': 'Grafana',
      'homelab-hub.group': 'Monitoring',
      'homelab-hub.icon': 'grafana',
      'homelab-hub.url': 'https://grafana.example.com',
      'homelab-hub.check': 'http://127.0.0.1:{port}/up'
    })
  ].map((c) => JSON.parse(JSON.stringify(c).replaceAll('{port}', String(services.address().port))))));
});

// fake services: /up answers 200, /down answers 503
const services = http.createServer((req, res) => {
  res.writeHead(req.url === '/down' ? 503 : 200, { 'content-type': 'text/plain' });
  res.end('demo');
});
await new Promise((r) => services.listen(0, '127.0.0.1', r));
await new Promise((r) => docker.listen(0, '127.0.0.1', r));
const up = `http://127.0.0.1:${services.address().port}/up`;
const down = `http://127.0.0.1:${services.address().port}/down`;

// a second machine: the same program in agent mode, with its own made-up numbers
const proc2 = path.join(tmp, 'proc-pi');
fs.mkdirSync(proc2);
fs.writeFileSync(path.join(proc2, 'meminfo'), 'MemTotal: 8388608 kB\nMemAvailable: 5242880 kB\n');
fs.writeFileSync(path.join(proc2, 'loadavg'), '0.31 0.22 0.18 1/210 1\n');
fs.writeFileSync(path.join(proc2, 'uptime'), '432100.00 800000.00\n');
let busy2 = 0;
let idle2 = 0;
const writeCpu2 = () => {
  busy2 += 900;
  idle2 += 9100;
  fs.writeFileSync(path.join(proc2, 'stat'), `cpu ${busy2} 0 0 ${idle2} 0 0 0 0\ncpu0 1 0 0 1 0 0 0 0\ncpu1 1 0 0 1 0 0 0 0\ncpu2 1 0 0 1 0 0 0 0\ncpu3 1 0 0 1 0 0 0 0\n`);
};
writeCpu2();
setInterval(writeCpu2, 500).unref();
const agentPort = Number(process.env.PORT ?? 8099) + 1;
const agent = spawn(process.execPath, ['src/server.js'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, HUB_MODE: 'agent', PORT: String(agentPort), HOST: '127.0.0.1', PROC_PATH: proc2, SYS_PATH: path.join(tmp, 'sys-pi'), AGENT_TOKEN: 'demo-token' }
});

const config = path.join(tmp, 'services.yaml');
fs.writeFileSync(config, `# Demo config, written by scripts/demo.mjs. Edit it while the demo runs.
title: Homelab Hub
subtitle: example.com

hosts:
  nas: 192.168.1.10
  pi: 192.168.1.20

stats:
  name: NAS
  disks:
    - { name: tank, path: "${disk}", size: ${Math.round(freeGb * 2.4)}G }
    - { name: backup, path: "${disk}", size: ${Math.round(freeGb * 1.25)}G }
  machines:
    - name: Raspberry Pi
      url: "http://127.0.0.1:${agentPort}"
      token: demo-token
      disks:
        - { name: SD card, path: "${disk}", size: ${Math.round(freeGb * 1.7)}G }

groups:
  - name: NAS
    autoContainers: true
    services:
      - { name: TrueNAS, icon: truenas, url: "https://nas.example.com", local: "http://{nas}", check: "${up}" }
      - { name: Immich, icon: immich, url: "https://photos.example.com", local: "http://{nas}:2283", check: "${up}" }
      - { name: Jellyfin, icon: jellyfin, url: "https://media.example.com", local: "http://{nas}:8096", check: "${up}" }
      - { name: n8n, icon: n8n, url: "https://n8n.example.com", local: "http://{nas}:5678", check: "${up}" }
      - { name: Homarr, icon: homarr, url: "https://homarr.example.com", local: "http://{nas}:7575", check: "${up}" }
      - { name: Portainer, icon: portainer, local: "https://{nas}:9443", check: "${up}" }
      - { name: Syncthing, icon: syncthing, local: "http://{nas}:8384", check: "${up}" }
      - { name: Uptime Kuma, icon: uptime-kuma, local: "http://{nas}:3001", check: "${up}" }
  - name: Raspberry Pi
    services:
      - { name: Cockpit, icon: cockpit, url: "https://cockpit.example.com", local: "https://{pi}:9090", check: "${up}" }
      - { name: Browser SSH, icon: terminal, url: "https://ssh.example.com", check: "${up}" }
      - { name: BlueMap, icon: bluemap, url: "https://map.example.com", check: "${down}" }
  - name: Links
    services:
      - { name: Router, description: "Port forwarding, DHCP, Wi-Fi", local: "http://192.168.1.1", check: none }
      - { name: Documentation, icon: obsidian, description: "Notes about this setup", url: "https://notes.example.com", check: none }
      - { name: Domain, description: "DNS records and tunnels", url: "https://dash.example.com", check: none }
`);

const child = spawn(process.execPath, ['src/server.js'], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    PORT: process.env.PORT ?? '8099',
    HOST: process.env.HOST ?? '::',
    PROC_PATH: proc,
    SYS_PATH: path.join(tmp, 'sys'),
    DOCKER_HOST: `http://127.0.0.1:${docker.address().port}`,
    CONFIG_PATH: config,
    DEFAULT_CONFIG_PATH: config
  }
});
console.log(`[demo] made-up data. Config you can edit live: ${config}`);
const stop = () => (child.kill(), agent.kill());
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', (code) => (agent.kill(), process.exit(code ?? 0)));
