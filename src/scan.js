// Finding agents on the home network.
//
// The hub knows the networks of the machine it runs on (from the host's routing table, mounted at
// PROC_PATH, or from its own network cards when it runs without Docker), asks every address there on
// the agent port(s) for /healthz, and keeps the ones that answer "I am an agent". That works from inside
// a Docker bridge network too, where broadcasts would not get through.
//
// Nothing is added by itself: the config editor lists what was found with an "Add" button (an agent
// with AGENT_TOKEN still needs its token typed in).
//
//   settings:
//     discovery:
//       enabled: true                 # false = never search
//       subnets: [192.168.1.0/24]     # instead of the networks found on this machine
//       ports: [8081]                 # where agents answer (default 8081 and 8080)
import dgram from 'node:dgram';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_AGENT_PORTS = [8081, 8080];
// Docker's, VPNs' and virtual machines' own networks: no agent to find there (and the same machine twice)
const SKIP_IFACE = /^(lo|docker|br-|veth|virbr|vboxnet|vmnet|cni|flannel|cali|vxlan|tun|tap|wg|tailscale|zt|kube|podman|lxc|lxd|incus)|virtualbox|vmware|vethernet|hyper-v|bluetooth/i;
const MIN_PREFIX = 20; // at most 4096 addresses per network
const AUTO_MIN_PREFIX = 22; // networks found by themselves: at most 1024 addresses, larger ones shrink to the /24 around this machine

const ipToInt = (ip) => ip.split('.').reduce((n, part) => n * 256 + Number(part), 0);
const intToIp = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
const maskToPrefix = (mask) => (mask >>> 0).toString(2).replace(/0+$/, '').length;

/** "192.168.1.0/24" -> {base, prefix} or null. */
export function parseCidr(text) {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(String(text).trim());
  if (!m) return null;
  const parts = m[1].split('.').map(Number);
  const prefix = Number(m[2]);
  if (parts.some((p) => p > 255) || prefix < 0 || prefix > 32) return null;
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  return { base: (ipToInt(m[1]) & mask) >>> 0, prefix };
}

export const formatCidr = ({ base, prefix }) => `${intToIp(base)}/${prefix}`;

/** Every host address of a network (without network and broadcast address for /30 and larger). */
export function hostsOf({ base, prefix }) {
  const size = 2 ** (32 - prefix);
  if (size <= 2) return Array.from({ length: size }, (_, i) => intToIp(base + i));
  return Array.from({ length: size - 2 }, (_, i) => intToIp(base + 1 + i));
}

function isPrivate(n) {
  const a = n >>> 24;
  const b = (n >>> 16) & 255;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * The networks in a Linux routing table (/proc/net/route): directly attached, private, not Docker's own.
 * @returns {{base: number, prefix: number, iface: string}[]}
 */
export function subnetsFromRouteTable(text) {
  const out = [];
  let defaultIface = null; // the card the way to the internet goes through: its network is the "real" one
  for (const line of String(text).split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 8) continue;
    const [iface, destHex, gatewayHex, , , , , maskHex] = f;
    // the kernel writes the numbers in little-endian hex
    const le = (hex) => Buffer.from(hex.padStart(8, '0'), 'hex').readUInt32LE(0);
    const dest = le(destHex);
    const mask = le(maskHex);
    if (dest === 0 && mask === 0 && gatewayHex !== '00000000') defaultIface ??= iface;
    if (SKIP_IFACE.test(iface) || gatewayHex !== '00000000') continue; // only networks the machine sits in
    if (dest === 0 || mask === 0 || !isPrivate(dest)) continue;
    out.push({ base: dest, prefix: maskToPrefix(mask), iface });
  }
  for (const n of out) if (n.iface === defaultIface) n.primary = true;
  return out;
}

/** The same from this process's own network cards (the hub running without Docker, or with network_mode: host). */
export function subnetsFromInterfaces(interfaces = os.networkInterfaces(), primaryIp = null) {
  const out = [];
  for (const [iface, addrs] of Object.entries(interfaces)) {
    if (SKIP_IFACE.test(iface)) continue;
    for (const a of addrs ?? []) {
      if (a.internal || a.family !== 'IPv4' && a.family !== 4) continue;
      const own = ipToInt(a.address);
      if (!isPrivate(own)) continue;
      const net = parseCidr(a.cidr ?? `${a.address}/${maskToPrefix(ipToInt(a.netmask))}`);
      if (net) out.push({ ...net, iface, own, ...(a.address === primaryIp ? { primary: true } : {}) });
    }
  }
  return out;
}

/** Networks too big to ask every address shrink to the /24 around this machine (or their first /24). */
function limit(nets, minPrefix) {
  const seen = new Set();
  const out = [];
  // the network with the way to the internet first: an agent that answers on two networks (a virtual
  // machine's adapter, say) is then kept with its address there
  const ordered = [...nets.filter((n) => n.primary), ...nets.filter((n) => !n.primary)];
  for (const n of ordered) {
    let net = { base: n.base, prefix: n.prefix };
    if (net.prefix < minPrefix) net = { base: ((n.own ?? n.base) & 0xffffff00) >>> 0, prefix: 24 };
    const key = formatCidr(net);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(net);
    }
  }
  return out;
}

/**
 * The networks to search: the ones from the config, else the host's (routing table of PID 1 under
 * procPath, i.e. the host when /proc is mounted from it), else this process's own cards.
 */
export function networksToSearch({ subnets = [], procPath = '/proc', readFile = (f) => fs.readFileSync(f, 'utf8'), interfaces, primaryIp = null } = {}) {
  if (subnets.length > 0) return limit(subnets.map(parseCidr).filter(Boolean), MIN_PREFIX);
  for (const file of [path.join(procPath, '1', 'net', 'route'), path.join(procPath, 'net', 'route')]) {
    try {
      const found = subnetsFromRouteTable(readFile(file));
      // inside a container without the host's /proc only the container's own network shows up (172.x): skip it
      if (found.length > 0) return limit(found, AUTO_MIN_PREFIX);
    } catch {
      // not Linux, or not mounted: next one
    }
  }
  return limit(subnetsFromInterfaces(interfaces, primaryIp), AUTO_MIN_PREFIX);
}

/**
 * This machine's own address on the way to the internet (no packet is sent: a UDP "connect" only picks
 * the route). null when there is none.
 */
export function primaryAddress() {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const done = (ip) => {
      try {
        socket.close();
      } catch {
        // already closed
      }
      resolve(ip);
    };
    socket.on('error', () => done(null));
    try {
      socket.connect(53, '1.1.1.1', () => {
        try {
          done(socket.address().address);
        } catch {
          done(null);
        }
      });
    } catch {
      done(null);
    }
  });
}

/** Asks one address whether an agent answers there. Resolves to the agent's /healthz answer or null. */
export async function probeAgent(url, timeoutMs = 800) {
  try {
    const res = await fetch(new URL('/healthz', url), { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.ok === true && data.mode === 'agent' ? data : null;
  } catch {
    return null;
  }
}

/** Runs fn over items with at most `limit` running at once. */
async function pool(items, limitCount, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limitCount, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/**
 * Searches the networks for agents.
 * @returns {Promise<{url: string, ip: string, port: number, name: string, version: string, docker: boolean, token: boolean}[]>}
 */
export async function findAgents({ networks, ports = DEFAULT_AGENT_PORTS, probe = probeAgent, concurrency = 64, timeoutMs = 800 }) {
  const targets = [];
  networks.forEach((net, rank) => {
    for (const ip of hostsOf(net)) for (const port of ports) targets.push({ ip, port, rank });
  });
  const found = [];
  const ipsWithAgent = new Set();
  await pool(targets, concurrency, async ({ ip, port, rank }) => {
    if (ipsWithAgent.has(ip)) return; // one agent per machine is enough
    const url = `http://${ip}:${port}`;
    const hello = await probe(url, timeoutMs);
    if (!hello || ipsWithAgent.has(ip)) return;
    ipsWithAgent.add(ip);
    found.push({
      id: typeof hello.id === 'string' ? hello.id : '',
      rank,
      url,
      ip,
      port,
      name: typeof hello.name === 'string' ? hello.name.slice(0, 80) : '',
      version: typeof hello.version === 'string' ? hello.version.slice(0, 20) : '',
      docker: hello.docker === true,
      token: hello.token === true
    });
  });
  // the same agent on several addresses (one machine in two networks): once, from the first network
  const byId = new Map();
  for (const a of found.sort((x, y) => x.rank - y.rank || ipToInt(x.ip) - ipToInt(y.ip))) {
    const key = a.id || a.ip;
    if (!byId.has(key)) byId.set(key, a);
  }
  return [...byId.values()].map(({ id, rank, ...rest }) => rest).sort((a, b) => ipToInt(a.ip) - ipToInt(b.ip));
}

/**
 * Searches now and then in the background (at start, then every `intervalMs`), and on request.
 * @param {object} o
 * @param {() => {enabled: boolean, subnets: string[], ports: number[]}} o.getSettings  read each time
 * @param {string} [o.procPath]
 * @param {Function} [o.find]      override for tests
 * @param {Function} [o.networks]  override for tests: () => networks
 */
export class AgentFinder {
  constructor({ getSettings, procPath = '/proc', find = findAgents, networks, intervalMs = 10 * 60 * 1000 }) {
    this.getSettings = getSettings;
    this.procPath = procPath;
    this.find = find;
    this.networks = networks ?? (async (subnets) => networksToSearch({ subnets, procPath, primaryIp: subnets.length ? null : await primaryAddress() }));
    this.intervalMs = intervalMs;
    this.agents = [];
    this.searched = []; // the networks of the last search, as text
    this.scannedAt = null;
    this.error = null;
    this.running = null; // the search under way
    this.timer = null;
  }

  /** Starts a search unless one is running; resolves when it is done. */
  scan() {
    if (this.running) return this.running;
    const settings = this.getSettings();
    if (!settings.enabled) {
      this.agents = [];
      this.error = null;
      return Promise.resolve();
    }
    this.running = (async () => {
      try {
        const networks = await this.networks(settings.subnets ?? []);
        this.searched = networks.map(formatCidr);
        if (networks.length === 0) {
          this.agents = [];
          this.error = 'No home network found to search. Set it under settings.discovery.subnets, e.g. 192.168.1.0/24.';
        } else {
          this.agents = await this.find({ networks, ports: settings.ports?.length ? settings.ports : DEFAULT_AGENT_PORTS });
          this.error = null;
        }
        this.scannedAt = Date.now();
      } catch (err) {
        this.error = err.message;
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  state() {
    return { enabled: this.getSettings().enabled, scanning: this.running != null, scannedAt: this.scannedAt, networks: this.searched, error: this.error, agents: this.agents };
  }

  start(firstDelayMs = 3000) {
    const loop = async () => {
      await this.scan();
      this.timer = setTimeout(loop, this.intervalMs);
      this.timer.unref?.();
    };
    this.timer = setTimeout(loop, firstDelayMs);
    this.timer.unref?.();
  }

  stop() {
    clearTimeout(this.timer);
  }
}
