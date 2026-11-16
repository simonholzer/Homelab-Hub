// Local preview helper (Windows has no /proc and no Docker socket):
// starts a fake Docker API and a fake /proc folder, then runs the hub against them.
//   node scripts/dev-fakes.mjs        -> http://localhost:8099
// Service checks are REAL (they hit the addresses in config/services.yaml); only stats and
// container health are fake.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-dev-'));

// fake /proc whose CPU counters move on every read, so the CPU meter shows something
const proc = path.join(tmp, 'proc');
fs.mkdirSync(path.join(proc, 'spl/kstat/zfs'), { recursive: true });
fs.writeFileSync(path.join(proc, 'meminfo'), 'MemTotal: 33554432 kB\nMemAvailable: 14680064 kB\n');
fs.writeFileSync(path.join(proc, 'loadavg'), '0.74 0.52 0.41 2/615 1\n');
fs.writeFileSync(path.join(proc, 'uptime'), '1234567.00 2000000.00\n');
fs.writeFileSync(path.join(proc, 'spl/kstat/zfs/arcstats'), 'x\nname type data\nsize 4 12884901888\n');
const disk = path.join(tmp, 'storage');
fs.mkdirSync(disk);
let busy = 0;
let idle = 0;
setInterval(() => {
  busy += 2300;
  idle += 7700;
  fs.writeFileSync(path.join(proc, 'stat'), `cpu ${busy} 0 0 ${idle} 0 0 0 0\ncpu0 1 0 0 1 0 0 0 0\ncpu1 1 0 0 1 0 0 0 0\ncpu2 1 0 0 1 0 0 0 0\ncpu3 1 0 0 1 0 0 0 0\n`);
}, 500).unref();

// fake network card whose byte counters grow (about 2.5 MB/s down, 0.4 MB/s up)
const nic = path.join(tmp, 'sys/class/net/eno1');
fs.mkdirSync(path.join(nic, 'statistics'), { recursive: true });
fs.mkdirSync(path.join(nic, 'device'));
let rx = 5e9;
let tx = 1e9;
setInterval(() => {
  rx += 1.25e6;
  tx += 0.2e6;
  fs.writeFileSync(path.join(nic, 'statistics/rx_bytes'), String(rx));
  fs.writeFileSync(path.join(nic, 'statistics/tx_bytes'), String(tx));
}, 500).unref();

const container = (name, project, state, status) => ({
  Id: name, Names: [`/${name}`], Image: 'img', State: state, Status: status,
  Labels: { 'com.docker.compose.project': project }
});
const docker = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify([
    container('ix-immich-server-1', 'ix-immich', 'running', 'Up 2 days (healthy)'),
    container('ix-immich-postgres-1', 'ix-immich', 'running', 'Up 2 days (healthy)'),
    container('ix-immich-ml-1', 'ix-immich', 'running', 'Up 2 days (healthy)'),
    container('ix-jellyfin-jellyfin-1', 'ix-jellyfin', 'running', 'Up 5 days'),
    container('ix-uptime-kuma-uptime-kuma-1', 'ix-uptime-kuma', 'running', 'Up 3 hours (unhealthy)')
  ]));
});
await new Promise((r) => docker.listen(0, '127.0.0.1', r));

fs.writeFileSync(
  path.join(tmp, 'services.yaml'),
  fs.readFileSync(path.join(root, 'config', 'services.yaml'), 'utf8').replace(/^(  disks:\n)(?:    .*\n|\s*#.*\n)+/m, `$1    - name: Storage\n      path: ${disk.replace(/\\/g, '/')}\n      size: 600G\n    - name: Backup\n      path: ${disk.replace(/\\/g, '/')}\n      size: 2T\n    - name: No size set\n      path: ${disk.replace(/\\/g, '/')}\n`)
);

const child = spawn(process.execPath, ['src/server.js'], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    PORT: process.env.PORT ?? '8099',
    PROC_PATH: proc,
    SYS_PATH: path.join(tmp, 'sys'),
    DOCKER_HOST: `http://127.0.0.1:${docker.address().port}`,
    // read the example config, but use the temp disk for the "Storage" stat
    CONFIG_PATH: path.join(tmp, 'services.yaml'),
    DEFAULT_CONFIG_PATH: path.join(root, 'config', 'services.yaml')
  }
});
console.log(`[dev] config you can edit live: ${path.join(tmp, 'services.yaml')}`);
process.on('SIGINT', () => child.kill());
child.on('exit', (code) => process.exit(code ?? 0));
