// Stats from other machines.
//
// The same program runs on the other machine in "agent" mode (HUB_MODE=agent): no page, no config,
// only one address that answers with that machine's CPU, memory, load, network and storage numbers.
// The hub asks every machine listed under stats.machines and shows a row of tiles for each.
//
//   agent:  HUB_MODE=agent  PORT=8080  AGENT_TOKEN=<optional shared secret>
//   hub:    stats:
//             machines:
//               - { name: Raspberry Pi, url: "http://192.168.1.20:8080", token: "<the same secret>" }
//
// Which storage paths and network cards to report is set on the hub (in the YAML, next to the
// machine) and sent with every request, so the agent itself has nothing to configure.
//
// Containers: when the agent has DOCKER_HOST (a read-only socket proxy, see compose.agent.yaml), every
// answer also carries that machine's containers. The hub adds them to its own: health badges, cards
// from labels and "found" suggestions then work for containers on every machine, not only its own.
//
// /healthz says "I am an agent" (with a name), so the hub can find agents on its network (see scan.js).
import crypto from 'node:crypto';
import http from 'node:http';

export const AGENT_PATH = '/api/agent';
const MAX_BODY_BYTES = 16 * 1024;
const MAX_DISKS = 32;
const MAX_CONTAINERS = 500;
const CONTAINER_CACHE_MS = 10_000; // the hub asks every few seconds; Docker is asked at most this often

const digest = (text) => crypto.createHash('sha256').update(String(text)).digest();

/** Only well-formed entries reach the stats reader: {name, path, sizeBytes?}. */
function cleanDisks(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const d of list.slice(0, MAX_DISKS)) {
    if (!d || typeof d.path !== 'string' || d.path.length === 0 || d.path.length > 400) continue;
    const disk = { name: String(d.name ?? d.path).slice(0, 80), path: d.path };
    if (typeof d.sizeBytes === 'number' && Number.isFinite(d.sizeBytes) && d.sizeBytes > 0) disk.sizeBytes = d.sizeBytes;
    out.push(disk);
  }
  return out;
}

const cleanInterfaces = (list) => (Array.isArray(list) ? list.map(String).filter((n) => /^[\w.:@-]{1,40}$/.test(n)).slice(0, 16) : []);

function readJson(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk); // too large: the rest is read and thrown away, then refused
    });
    req.on('end', () => {
      if (size > MAX_BODY_BYTES) return resolve(null);
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

/** Asks Docker at most once per CONTAINER_CACHE_MS; callers in between share the answer. */
function cachedContainers(list) {
  let last = null; // {at, promise}
  return () => {
    if (!last || Date.now() - last.at > CONTAINER_CACHE_MS) {
      last = { at: Date.now(), promise: list().then((containers) => ({ containers }), (err) => ({ error: err.message })) };
    }
    return last.promise;
  };
}

/**
 * The agent's HTTP server.
 * @param {object} o
 * @param {{read: Function}} o.reader  a StatsReader for this machine
 * @param {string} [o.token]           when set, requests need "Authorization: Bearer <token>"
 * @param {Function|null} [o.containers]  () => Promise<container[]> of this machine (null = no Docker)
 * @param {string} [o.name]            how this machine calls itself (AGENT_NAME, else its host name)
 * @param {string} [o.version]
 */
export function createAgentApp({ reader, token = '', containers = null, name = '', version = '' }) {
  const wanted = token ? digest(token) : null;
  const docker = containers ? cachedContainers(containers) : null;
  // new at every start: tells the hub's search that two addresses lead to the same agent
  const id = crypto.randomUUID();
  const send = (res, status, body) => {
    const data = Buffer.from(JSON.stringify(body));
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': data.length, 'x-content-type-options': 'nosniff' });
    res.end(data);
  };
  return http.createServer(async (req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    // open to anyone (no token): just enough for the hub's network search to recognise an agent
    if (pathname === '/healthz') return send(res, 200, { ok: true, mode: 'agent', id, name, version, docker: docker != null, token: wanted != null });
    if (pathname !== AGENT_PATH) return send(res, 404, { error: 'This is a Homelab Hub agent: it only answers the hub (see the README, "Stats from other machines").' });
    if (req.method !== 'GET' && req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
    if (wanted) {
      const given = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1] ?? '';
      if (!crypto.timingSafeEqual(digest(given), wanted)) return send(res, 401, { error: 'Wrong or missing token' });
    }
    const body = req.method === 'POST' ? await readJson(req) : {};
    if (body == null || typeof body !== 'object') return send(res, 400, { error: 'The request is not valid JSON' });
    try {
      const [stats, found] = await Promise.all([
        reader.read(cleanDisks(body.disks), { interfaces: cleanInterfaces(body.interfaces) }),
        docker ? docker() : Promise.resolve(null)
      ]);
      const out = { ok: true, name, stats };
      if (found?.containers) out.containers = found.containers.slice(0, MAX_CONTAINERS);
      else if (found?.error) out.dockerError = found.error;
      return send(res, 200, out);
    } catch (err) {
      return send(res, 500, { error: err.message });
    }
  });
}

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : v == null ? '' : String(v).slice(0, max));
const HEALTH = new Set(['healthy', 'running', 'starting', 'unhealthy', 'completed', 'stopped']);

/**
 * Containers as an agent reported them, made safe to use as the hub's own: only known fields, short
 * strings, numbers that are ports. An agent is another machine, so nothing it sends is trusted as is.
 * @returns {object[]}
 */
export function cleanContainers(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const c of list.slice(0, MAX_CONTAINERS)) {
    if (!c || typeof c !== 'object' || typeof c.name !== 'string' || !c.name) continue;
    const container = {
      name: str(c.name, 200),
      project: str(c.project, 200),
      service: str(c.service, 200),
      image: str(c.image, 300),
      state: str(c.state, 40).toLowerCase(),
      status: str(c.status, 200),
      health: HEALTH.has(c.health) ? c.health : 'stopped',
      ports: Array.isArray(c.ports) ? [...new Set(c.ports.filter((p) => Number.isInteger(p) && p > 0 && p < 65536))].slice(0, 64).sort((a, b) => a - b) : []
    };
    if (c.labels && typeof c.labels === 'object' && !Array.isArray(c.labels)) {
      const labels = {};
      for (const [k, v] of Object.entries(c.labels).slice(0, 32)) if (/^[a-z0-9_.-]{1,40}$/.test(k)) labels[k] = str(v, 500);
      if (Object.keys(labels).length > 0) container.labels = labels;
    }
    out.push(container);
  }
  return out;
}

/**
 * Asks one agent for its numbers (and its containers, when it has Docker). Throws a short readable
 * message when that fails.
 * @param {{url: string, token?: string, disks?: object[], network?: string[]}} machine
 * @returns {Promise<{stats: object, containers: object[]|null, dockerError: string|null, name: string}>}
 */
export async function fetchAgent(machine, timeoutMs = 4000) {
  let res;
  try {
    res = await fetch(new URL(AGENT_PATH, machine.url), {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'content-type': 'application/json', ...(machine.token ? { authorization: `Bearer ${machine.token}` } : {}) },
      body: JSON.stringify({ disks: machine.disks ?? [], interfaces: machine.network ?? [] })
    });
  } catch (err) {
    const code = err.cause?.code ?? err.cause?.errors?.[0]?.code ?? '';
    if (err.name === 'TimeoutError') throw new Error('Timed out');
    if (code === 'ECONNREFUSED') throw new Error('Connection refused');
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') throw new Error('DNS lookup failed');
    if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') throw new Error('Host unreachable');
    throw new Error(code || (err.message === 'fetch failed' ? err.cause?.message : err.message) || 'Not reachable');
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    // not JSON: handled below
  }
  if (res.status === 401) throw new Error('The agent refused the token (stats.machines token / AGENT_TOKEN)');
  if (!res.ok || !data?.stats) throw new Error(data?.error ? `Agent: ${data.error}` : `No agent at this address (HTTP ${res.status})`);
  return {
    stats: data.stats,
    containers: Array.isArray(data.containers) ? cleanContainers(data.containers) : null,
    dockerError: typeof data.dockerError === 'string' ? data.dockerError.slice(0, 300) : null,
    name: typeof data.name === 'string' ? data.name.slice(0, 80) : ''
  };
}

/** Only the numbers (older callers and tests). */
export async function fetchMachineStats(machine, timeoutMs = 4000) {
  return (await fetchAgent(machine, timeoutMs)).stats;
}
