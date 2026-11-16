// Host stats read from /proc (mounted read-only into the container as /host/proc).
// No API key needed. Everything is optional: whatever can't be read is left out.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const read = (file) => fs.readFileSync(file, 'utf8');

export function parseLoadavg(text) {
  const [a, b, c] = text.trim().split(/\s+/).map(Number);
  return [a, b, c];
}

export function parseUptime(text) {
  return Math.round(Number(text.trim().split(/\s+/)[0]));
}

/** Returns {kb:{MemTotal, MemAvailable, ...}} in kB. */
export function parseMeminfo(text) {
  const kb = {};
  for (const line of text.split('\n')) {
    const m = /^(\w+):\s+(\d+)/.exec(line);
    if (m) kb[m[1]] = Number(m[2]);
  }
  return kb;
}

/** ZFS ARC size in bytes, or null when ZFS isn't there. */
export function parseArcSize(text) {
  for (const line of text.split('\n')) {
    const m = /^size\s+\d+\s+(\d+)/.exec(line);
    if (m) return Number(m[1]);
  }
  return null;
}

/** Aggregate CPU counters from the first line of /proc/stat plus the core count. */
export function parseCpuStat(text) {
  const lines = text.split('\n');
  const first = lines.find((l) => l.startsWith('cpu '));
  if (!first) return null;
  const v = first.trim().split(/\s+/).slice(1).map(Number);
  const idle = (v[3] ?? 0) + (v[4] ?? 0); // idle + iowait
  const total = v.slice(0, 8).reduce((a, b) => a + b, 0);
  const cores = lines.filter((l) => /^cpu\d+\s/.test(l)).length;
  return { idle, total, cores };
}

/**
 * Memory in bytes. On ZFS the ARC cache counts as "used" in MemAvailable terms, but it
 * is released under pressure, so it is shown separately and not as used RAM.
 */
export function computeMemory(kb, arcBytes) {
  const total = (kb.MemTotal ?? 0) * 1024;
  const available = (kb.MemAvailable ?? kb.MemFree ?? 0) * 1024;
  const cache = arcBytes ?? 0;
  const used = Math.max(0, total - available - cache);
  return { total, used, cache: arcBytes == null ? null : cache };
}

function readHwmonTemp(sysPath) {
  const dir = path.join(sysPath, 'class', 'hwmon');
  let best = null;
  try {
    for (const entry of fs.readdirSync(dir)) {
      const base = path.join(dir, entry);
      let name = '';
      try {
        name = read(path.join(base, 'name')).trim();
      } catch {
        // no name file
      }
      if (!/coretemp|k10temp|cpu|zenpower/i.test(name)) continue;
      for (const f of fs.readdirSync(base)) {
        if (!/^temp\d+_input$/.test(f)) continue;
        const milli = Number(read(path.join(base, f)));
        if (Number.isFinite(milli) && (best == null || milli > best)) best = milli;
      }
    }
  } catch {
    return null;
  }
  return best == null ? null : Math.round(best / 100) / 10;
}

/**
 * Byte counters of the network cards, from <sys>/class/net/<name>/statistics.
 * Without a list, only physical cards count (they have a `device` entry; this skips lo, docker, veth,
 * bridges and tunnels, which would count the same traffic twice). Why /sys and not /proc/net/dev: inside a
 * container /proc/net/dev shows the container's own network, the bind-mounted host /sys shows the host's cards.
 */
export function readNetworkCounters(sysPath, only = []) {
  const dir = path.join(sysPath, 'class', 'net');
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  let rx = 0;
  let tx = 0;
  const used = [];
  for (const name of names) {
    if (only.length > 0 ? !only.includes(name) : !fs.existsSync(path.join(dir, name, 'device'))) continue;
    try {
      const r = Number(read(path.join(dir, name, 'statistics', 'rx_bytes')));
      const t = Number(read(path.join(dir, name, 'statistics', 'tx_bytes')));
      if (!Number.isFinite(r) || !Number.isFinite(t)) continue;
      rx += r;
      tx += t;
      used.push(name);
    } catch {
      // card without counters: skipped
    }
  }
  return used.length > 0 ? { rx, tx, names: used, at: Date.now() } : null;
}

export class StatsReader {
  /**
   * @param {{procPath?: string, sysPath?: string}} paths
   */
  constructor({ procPath = '/proc', sysPath = '/sys', platform = process.platform } = {}) {
    this.procPath = procPath;
    this.sysPath = sysPath;
    this.platform = platform;
    this.prevCpu = null;
    this.prevNet = null;
  }

  /** Current network speed in bytes per second since the last reading (null until there are two samples). */
  networkRates(only, first, cur = readNetworkCounters(this.sysPath, only)) {
    const prev = this.prevNet ?? first;
    this.prevNet = cur;
    if (!cur) return null;
    const out = { interfaces: cur.names };
    const seconds = prev ? (cur.at - prev.at) / 1000 : 0;
    // a counter that went backwards (card reset, reboot) gives no rate for this round
    if (seconds >= 0.2 && cur.rx >= prev.rx && cur.tx >= prev.tx) {
      out.rxBytesPerSec = Math.round((cur.rx - prev.rx) / seconds);
      out.txBytesPerSec = Math.round((cur.tx - prev.tx) / seconds);
    }
    return out;
  }

  readDisks(disks) {
    const out = [];
    for (const d of disks) {
      try {
        const s = fs.statfsSync(d.path);
        // On ZFS this is the *dataset's* own data plus the pool's free space, so only
        // "free" is trustworthy; the used/total split would look nearly empty.
        const entry = { name: d.name, freeBytes: Number(s.bavail) * Number(s.bsize) };
        // The total can't be read from inside the container (a pool's top folder only knows its own data),
        // so it comes from `size:` in the config. A size smaller than the free space is a typo: ignored.
        if (d.sizeBytes && d.sizeBytes >= entry.freeBytes) entry.totalBytes = d.sizeBytes;
        out.push(entry);
      } catch (err) {
        out.push({ name: d.name, path: d.path, error: err.code ?? 'unreadable' });
      }
    }
    return out;
  }

  /**
   * Fallback for development machines (Windows, macOS) that have no /proc: the stats of the
   * computer the hub runs on. Never used on Linux, where a missing /proc mount is a real error.
   */
  /** Windows (development only): byte counters of the physical network cards, via PowerShell. */
  async readWindowsNetwork() {
    try {
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', 'Get-NetAdapter -Physical | Where-Object Status -eq Up | Get-NetAdapterStatistics | Select-Object Name,ReceivedBytes,SentBytes | ConvertTo-Json -Compress'],
        { timeout: 6000, windowsHide: true }
      );
      const parsed = JSON.parse(stdout);
      const cards = (Array.isArray(parsed) ? parsed : [parsed]).filter((c) => Number.isFinite(c?.ReceivedBytes) && Number.isFinite(c?.SentBytes));
      if (cards.length === 0) return null;
      return {
        rx: cards.reduce((a, c) => a + c.ReceivedBytes, 0),
        tx: cards.reduce((a, c) => a + c.SentBytes, 0),
        names: cards.map((c) => String(c.Name)),
        at: Date.now()
      };
    } catch {
      return null; // no PowerShell or no permission: no network tile
    }
  }

  async readOs(disks) {
    const sample = () => {
      const cpus = os.cpus();
      let idle = 0;
      let total = 0;
      for (const c of cpus) {
        idle += c.times.idle;
        total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
      }
      return { idle, total, cores: cpus.length };
    };
    const firstNet = this.platform === 'win32' && !this.prevNet ? await this.readWindowsNetwork() : null;
    if (!this.prevCpu) {
      this.prevCpu = sample();
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const cpu = sample();
    const out = { source: 'os', cores: cpu.cores || null, memory: { total: os.totalmem(), used: os.totalmem() - os.freemem(), cache: null } };
    if (cpu.total > this.prevCpu.total) {
      out.cpuPercent = Math.max(0, Math.min(100, Math.round((1 - (cpu.idle - this.prevCpu.idle) / (cpu.total - this.prevCpu.total)) * 100)));
    }
    this.prevCpu = cpu;
    out.uptimeSeconds = Math.round(os.uptime());
    if (this.platform !== 'win32') out.load = os.loadavg();
    out.disks = this.readDisks(disks);
    if (this.platform === 'win32') {
      const network = this.networkRates([], firstNet, await this.readWindowsNetwork());
      if (network) out.network = network;
    }
    return out;
  }

  /** @param {{name: string, path: string}[]} disks */
  async read(disks = [], { interfaces = [] } = {}) {
    const p = (f) => path.join(this.procPath, f);
    const firstNet = this.prevNet ? null : readNetworkCounters(this.sysPath, interfaces); // baseline for the very first reading
    let meminfo;
    try {
      meminfo = parseMeminfo(read(p('meminfo')));
    } catch (err) {
      if (this.platform !== 'linux') return this.readOs(disks);
      throw new Error(`cannot read ${p('meminfo')} (${err.code ?? err.message})`);
    }
    const out = { source: 'proc', disks: [] };

    let arc = null;
    try {
      arc = parseArcSize(read(p('spl/kstat/zfs/arcstats')));
    } catch {
      // not a ZFS host or not exposed: fine
    }
    out.memory = computeMemory(meminfo, arc);

    try {
      out.load = parseLoadavg(read(p('loadavg')));
      out.uptimeSeconds = parseUptime(read(p('uptime')));
    } catch {
      // optional
    }

    try {
      if (!this.prevCpu) {
        // First reading: take a short baseline so CPU shows up right away, not after one cycle.
        this.prevCpu = parseCpuStat(read(p('stat')));
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      const cpu = parseCpuStat(read(p('stat')));
      if (cpu) {
        out.cores = cpu.cores || null;
        if (this.prevCpu && cpu.total > this.prevCpu.total) {
          const dTotal = cpu.total - this.prevCpu.total;
          const dIdle = cpu.idle - this.prevCpu.idle;
          out.cpuPercent = Math.max(0, Math.min(100, Math.round((1 - dIdle / dTotal) * 100)));
        }
        this.prevCpu = cpu;
      }
    } catch {
      // optional
    }

    const temp = readHwmonTemp(this.sysPath);
    if (temp != null) out.cpuTempC = temp;

    const network = this.networkRates(interfaces, firstNet);
    if (network) out.network = network;

    out.disks = this.readDisks(disks);
    return out;
  }
}
