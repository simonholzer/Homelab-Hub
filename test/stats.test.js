import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseLoadavg, parseUptime, parseMeminfo, parseArcSize, parseCpuStat, computeMemory, StatsReader } from '../src/stats.js';

// Fixtures in the format Linux (and OpenZFS) really write.
const MEMINFO = `MemTotal:       32843076 kB
MemFree:         1048576 kB
MemAvailable:   12582912 kB
Buffers:           10240 kB
Cached:           524288 kB
`;
const ARCSTATS = `12 1 0x01 98 26656 7345310 2189347629
name                            type data
hits                            4    123456
size                            4    17179869184
c                               4    17179869184
`;
const STAT_A = `cpu  1000 0 500 8000 500 0 0 0 0 0
cpu0 500 0 250 4000 250 0 0 0 0 0
cpu1 500 0 250 4000 250 0 0 0 0 0
intr 12345
`;
const STAT_B = `cpu  1300 0 700 8800 600 0 0 0 0 0
cpu0 650 0 350 4400 300 0 0 0 0 0
cpu1 650 0 350 4400 300 0 0 0 0 0
`;

test('parsers', () => {
  assert.deepEqual(parseLoadavg('0.52 0.40 0.31 2/615 12345\n'), [0.52, 0.4, 0.31]);
  assert.equal(parseUptime('86400.55 170000.10\n'), 86401);
  assert.equal(parseMeminfo(MEMINFO).MemAvailable, 12582912);
  assert.equal(parseArcSize(ARCSTATS), 17179869184);
  assert.equal(parseArcSize('nothing here'), null);
  assert.deepEqual(parseCpuStat(STAT_A), { idle: 8500, total: 10000, cores: 2 });
});

test('memory excludes the reclaimable ZFS cache from "used"', () => {
  const kb = parseMeminfo(MEMINFO);
  const withArc = computeMemory(kb, 17179869184);
  const gib = 1024 ** 3;
  // total 31.3 GiB, available 12 GiB, ARC 16 GiB => used ~3.3 GiB (not 19 GiB)
  assert.ok(Math.abs(withArc.used / gib - (32843076 / 1024 ** 2 - 12 - 16)) < 0.01);
  assert.equal(withArc.cache, 17179869184);
  const noZfs = computeMemory(kb, null);
  assert.equal(noZfs.cache, null);
  assert.ok(noZfs.used > withArc.used);
  // never negative
  assert.equal(computeMemory({ MemTotal: 100, MemAvailable: 10 }, 10 * 1024 * 1024).used, 0);
});

test('StatsReader reads a /proc-shaped folder and computes CPU from two samples', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-proc-'));
  const proc = path.join(dir, 'proc');
  fs.mkdirSync(path.join(proc, 'spl/kstat/zfs'), { recursive: true });
  const write = (f, t) => fs.writeFileSync(path.join(proc, f), t);
  write('meminfo', MEMINFO);
  write('loadavg', '0.10 0.20 0.30 1/100 1\n');
  write('uptime', '3600.0 7000.0\n');
  write('stat', STAT_A);
  write('spl/kstat/zfs/arcstats', ARCSTATS);
  const disk = path.join(dir, 'disk');
  fs.mkdirSync(disk);

  const reader = new StatsReader({ procPath: proc, sysPath: path.join(dir, 'sys-missing') });
  const first = await reader.read([{ name: 'Test disk', path: disk }, { name: 'Gone', path: path.join(dir, 'nope') }]);
  assert.equal(first.cpuPercent, undefined); // baseline sample is identical (counters didn't move)
  assert.equal(first.cores, 2);
  assert.deepEqual(first.load, [0.1, 0.2, 0.3]);
  assert.equal(first.uptimeSeconds, 3600);
  assert.equal(first.disks[0].name, 'Test disk');
  assert.ok(first.disks[0].freeBytes > 0);
  assert.equal(first.disks[1].error, 'ENOENT');
  assert.equal(first.cpuTempC, undefined); // no /sys: skipped silently

  write('stat', STAT_B); // +300 user, +200 system, +800 idle, +100 iowait
  const second = await reader.read();
  // busy delta = 500, total delta = 1400 => 1 - 900/1400 = 36 %
  assert.equal(second.cpuPercent, 36);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('on Linux a missing /proc mount is an error (never silently replaced)', async () => {
  const reader = new StatsReader({ procPath: path.join(os.tmpdir(), 'definitely-not-here'), platform: 'linux' });
  await assert.rejects(reader.read(), /cannot read/);
});

test('on a dev machine without /proc (Windows) it falls back to this computer\'s own numbers', async () => {
  const reader = new StatsReader({ procPath: path.join(os.tmpdir(), 'definitely-not-here'), platform: 'win32' });
  const s = await reader.read([{ name: 'Here', path: os.tmpdir() }, { name: 'Gone', path: path.join(os.tmpdir(), 'nope-nope') }]);
  assert.equal(s.source, 'os');
  assert.ok(s.memory.total > 0 && s.memory.used > 0 && s.memory.used <= s.memory.total);
  assert.ok(s.cores > 0);
  assert.ok(s.uptimeSeconds > 0);
  assert.equal(s.load, undefined, 'Windows has no load average');
  assert.ok(s.disks[0].freeBytes > 0);
  assert.equal(s.disks[1].error, 'ENOENT');
});

test('network speed: physical cards only, rate from two samples, resets ignored', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-net-'));
  const proc = path.join(dir, 'proc');
  fs.mkdirSync(proc);
  fs.writeFileSync(path.join(proc, 'meminfo'), MEMINFO);
  fs.writeFileSync(path.join(proc, 'stat'), STAT_A); // the first reading waits 250 ms for the CPU baseline: the network baseline rides on that
  const sys = path.join(dir, 'sys');
  const card = (name, physical, rx, tx) => {
    const base = path.join(sys, 'class/net', name);
    fs.mkdirSync(path.join(base, 'statistics'), { recursive: true });
    if (physical) fs.mkdirSync(path.join(base, 'device'), { recursive: true });
    fs.writeFileSync(path.join(base, 'statistics/rx_bytes'), String(rx));
    fs.writeFileSync(path.join(base, 'statistics/tx_bytes'), String(tx));
  };
  card('eno1', true, 1000, 500);
  card('docker0', false, 999999, 999999); // virtual: would double-count
  card('lo', false, 5, 5);

  const reader = new StatsReader({ procPath: proc, sysPath: sys, platform: 'linux' });
  const first = await reader.read();
  assert.deepEqual(first.network.interfaces, ['eno1']);
  assert.equal(first.network.rxBytesPerSec, 0, 'nothing moved between the baseline and the first reading');

  await new Promise((r) => setTimeout(r, 300));
  card('eno1', true, 1000 + 3000, 500 + 900);
  const second = await reader.read();
  assert.ok(second.network.rxBytesPerSec > 3000 / 1 / 5 && second.network.rxBytesPerSec <= 3000 / 0.25, `rx ${second.network.rxBytesPerSec}`);
  assert.ok(second.network.txBytesPerSec * 3000 > second.network.rxBytesPerSec * 900 * 0.7, 'tx is about 30 % of rx');

  card('eno1', true, 10, 10); // counter went backwards (reboot): no rate this round
  await new Promise((r) => setTimeout(r, 250));
  assert.equal((await reader.read()).network.rxBytesPerSec, undefined);

  const chosen = await new StatsReader({ procPath: proc, sysPath: sys, platform: 'linux' }).read([], { interfaces: ['docker0'] });
  assert.deepEqual(chosen.network.interfaces, ['docker0']);
  const none = await new StatsReader({ procPath: proc, sysPath: path.join(dir, 'nope'), platform: 'linux' }).read();
  assert.equal(none.network, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CPU temperature from hwmon', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-sys-'));
  const proc = path.join(dir, 'proc');
  fs.mkdirSync(proc);
  fs.writeFileSync(path.join(proc, 'meminfo'), MEMINFO);
  const hw = path.join(dir, 'sys/class/hwmon/hwmon2');
  fs.mkdirSync(hw, { recursive: true });
  fs.writeFileSync(path.join(hw, 'name'), 'coretemp\n');
  fs.writeFileSync(path.join(hw, 'temp1_input'), '45000\n');
  fs.writeFileSync(path.join(hw, 'temp2_input'), '51500\n');
  const other = path.join(dir, 'sys/class/hwmon/hwmon0');
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, 'name'), 'nvme\n');
  fs.writeFileSync(path.join(other, 'temp1_input'), '99000\n'); // not a CPU sensor
  const stats = await new StatsReader({ procPath: proc, sysPath: path.join(dir, 'sys') }).read();
  assert.equal(stats.cpuTempC, 51.5);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('disk tiles: total only when a plausible size is configured', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-size-'));
  const reader = new StatsReader({ procPath: path.join(dir, 'nope'), platform: 'win32' });
  const free = reader.readDisks([{ name: 'A', path: dir }])[0].freeBytes;
  const ok = reader.readDisks([{ name: 'A', path: dir, sizeBytes: free + 1000 }])[0];
  assert.equal(ok.totalBytes, free + 1000);
  const typo = reader.readDisks([{ name: 'A', path: dir, sizeBytes: Math.max(1, free - 1000) }])[0];
  assert.equal(typo.totalBytes, undefined, 'a size smaller than the free space is ignored');
  fs.rmSync(dir, { recursive: true, force: true });
});
