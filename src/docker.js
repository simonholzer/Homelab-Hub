// Container health from the Docker API. Read-only: the hub talks to a socket proxy
// (tecnativa/docker-socket-proxy with only CONTAINERS=1), never to the raw socket.
//
// DOCKER_HOST forms:  http://docker-proxy:2375   tcp://host:2375   unix:///var/run/docker.sock
import http from 'node:http';
import { LABEL_PREFIX } from './config.js';

function requestOptions(dockerHost, pathAndQuery) {
  if (dockerHost.startsWith('unix://')) {
    return { socketPath: dockerHost.slice('unix://'.length), path: pathAndQuery };
  }
  const u = new URL(dockerHost.replace(/^tcp:/, 'http:'));
  return { host: u.hostname, port: Number(u.port) || 80, path: pathAndQuery };
}

/** Turns Docker's list entry into {name, project, service, image, state, health}. Exported for tests. */
export function normalizeContainer(c) {
  const status = String(c.Status ?? '');
  const state = String(c.State ?? '').toLowerCase();
  let health;
  if (/\(unhealthy\)/i.test(status)) health = 'unhealthy';
  else if (/\(health: starting\)/i.test(status)) health = 'starting';
  else if (/\(healthy\)/i.test(status)) health = 'healthy';
  else if (state === 'running') health = 'running'; // running, but the image has no healthcheck
  else if (state === 'restarting') health = 'starting';
  else if (state === 'exited' && /^Exited \(0\)/.test(status)) health = 'completed'; // one-shot job (e.g. a "permissions" init container)
  else health = 'stopped'; // crashed, dead, created, paused ...
  const labels = c.Labels ?? {};
  // the labels that describe a card (see servicesFromLabels in config.js), without their prefix
  const hub = {};
  for (const [k, v] of Object.entries(labels)) if (k.startsWith(LABEL_PREFIX)) hub[k.slice(LABEL_PREFIX.length).toLowerCase()] = String(v);
  return {
    name: String((c.Names?.[0] ?? c.Id ?? '').replace(/^\//, '')),
    project: labels['com.docker.compose.project'] ?? '',
    service: labels['com.docker.compose.service'] ?? '',
    image: String(c.Image ?? ''),
    state,
    status,
    health,
    // TCP ports published on the host (for the "found on this server" suggestions)
    ports: [...new Set((c.Ports ?? []).filter((p) => p.PublicPort && (p.Type ?? 'tcp') === 'tcp').map((p) => p.PublicPort))].sort((a, b) => a - b),
    ...(Object.keys(hub).length > 0 ? { labels: hub } : {})
  };
}

export function listContainers(dockerHost, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    if (!dockerHost) return reject(new Error('DOCKER_HOST is not set'));
    const req = http.request(
      { ...requestOptions(dockerHost, '/containers/json?all=1'), method: 'GET', timeout: timeoutMs },
      (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode !== 200) {
            return reject(new Error(`Docker API answered HTTP ${res.statusCode}: ${body.slice(0, 120)}`));
          }
          try {
            resolve(JSON.parse(body).map(normalizeContainer));
          } catch {
            reject(new Error('Docker API sent invalid JSON'));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('Docker API timed out')));
    req.on('error', (err) => reject(new Error(err.code === 'ECONNREFUSED' ? 'Docker API refused the connection' : err.message)));
    req.end();
  });
}

/** `*immich*` style wildcard, case-insensitive, matches the whole string. */
export function wildcardToRegExp(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

const SEVERITY = { stopped: 4, unhealthy: 3, starting: 2, running: 1, healthy: 0 };

/**
 * Collects the containers a service lists under `containers:` and rolls them up.
 * Patterns match the container name, the compose project or the compose service name.
 * Result state: healthy | running (no healthcheck) | starting | unhealthy | stopped | missing
 */
/**
 * Patterns for a service that has no `containers:` of its own, from its name: "Uptime Kuma" -> *uptime-kuma*, *uptimekuma*.
 * Used for groups with `autoContainers: true`, where a card gets a health badge when a container matches.
 */
export function autoContainerPatterns(name) {
  const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (slug.length < 3) return []; // too short to match safely
  const compact = slug.replace(/-/g, '');
  return compact === slug ? [`*${slug}*`] : [`*${slug}*`, `*${compact}*`];
}

export function summarizeContainers(patterns, containers) {
  const regexes = patterns.map(wildcardToRegExp);
  const items = containers.filter((c) =>
    regexes.some((re) => re.test(c.name) || (c.project && re.test(c.project)) || (c.service && re.test(c.service)))
  );
  if (items.length === 0) return { state: 'missing', total: 0, items: [] };
  // Containers that finished cleanly (Exited (0), e.g. TrueNAS "permissions" init jobs) are
  // left out of the roll-up, unless nothing else matched: then the app really is stopped.
  const active = items.filter((c) => c.health !== 'completed');
  const counted = active.length > 0 ? active : items.map((c) => ({ ...c, health: 'stopped' }));
  let worst = 'healthy';
  for (const c of counted) if (SEVERITY[c.health] > SEVERITY[worst]) worst = c.health;
  return {
    state: worst,
    total: counted.length,
    healthy: counted.filter((c) => c.health === 'healthy').length,
    items: items.map((c) => ({ name: c.name, health: c.health }))
  };
}
