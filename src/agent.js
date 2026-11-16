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
import crypto from 'node:crypto';
import http from 'node:http';

export const AGENT_PATH = '/api/agent';
const MAX_BODY_BYTES = 16 * 1024;
const MAX_DISKS = 32;

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

/**
 * The agent's HTTP server.
 * @param {object} o
 * @param {{read: Function}} o.reader  a StatsReader for this machine
 * @param {string} [o.token]           when set, requests need "Authorization: Bearer <token>"
 */
export function createAgentApp({ reader, token = '' }) {
  const wanted = token ? digest(token) : null;
  const send = (res, status, body) => {
    const data = Buffer.from(JSON.stringify(body));
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': data.length, 'x-content-type-options': 'nosniff' });
    res.end(data);
  };
  return http.createServer(async (req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/healthz') return send(res, 200, { ok: true, mode: 'agent' });
    if (pathname !== AGENT_PATH) return send(res, 404, { error: 'This is a Homelab Hub agent: it only answers the hub (see the README, "Stats from other machines").' });
    if (req.method !== 'GET' && req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
    if (wanted) {
      const given = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1] ?? '';
      if (!crypto.timingSafeEqual(digest(given), wanted)) return send(res, 401, { error: 'Wrong or missing token' });
    }
    const body = req.method === 'POST' ? await readJson(req) : {};
    if (body == null || typeof body !== 'object') return send(res, 400, { error: 'The request is not valid JSON' });
    try {
      const stats = await reader.read(cleanDisks(body.disks), { interfaces: cleanInterfaces(body.interfaces) });
      return send(res, 200, { ok: true, stats });
    } catch (err) {
      return send(res, 500, { error: err.message });
    }
  });
}

/**
 * Asks one agent for its numbers. Throws a short readable message when that fails.
 * @param {{url: string, token?: string, disks?: object[], network?: string[]}} machine
 */
export async function fetchMachineStats(machine, timeoutMs = 4000) {
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
    throw new Error(code || err.message || 'Failed');
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    // not JSON: handled below
  }
  if (res.status === 401) throw new Error('The agent refused the token (stats.machines token / AGENT_TOKEN)');
  if (!res.ok || !data?.stats) throw new Error(data?.error ? `Agent: ${data.error}` : `No agent at this address (HTTP ${res.status})`);
  return data.stats;
}
