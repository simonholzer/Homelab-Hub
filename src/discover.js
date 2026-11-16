// "Found on this server": containers that publish a port and have no card yet, as suggestions for
// the config editor. Nothing here adds a card by itself; the editor shows the list with an Add button.
//
// What Docker knows: names, images, published ports. What it does not know: your public addresses,
// and which containers are websites. So helpers (databases, caches, tunnels) are left out by their
// image name, and the web port is a guess the user can correct after adding.
import { autoContainerPatterns, wildcardToRegExp } from './docker.js';

const HELPER = /(^|[/_.-])(postgres|postgresql|pgvecto-rs|pgvector|redis|valkey|keydb|mariadb|mysql|mongo|mongodb|memcached|influxdb|docker-socket-proxy|socket-proxy|cloudflared|tailscale|watchtower|autoheal|permissions?)([:/_.@-]|$)/i;
// the port a web UI most likely answers on, when a container publishes several
const LIKELY_WEB = [80, 443, 8080, 3000, 8000, 5000, 8096, 9000, 8443, 9443, 8081, 8888, 3001, 5678, 7575, 2283, 8384, 9090];
const HTTPS_PORTS = new Set([443, 8443, 9443]);

const pretty = (slug) => slug.split(/[-_]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');

function portOf(address) {
  try {
    const u = new URL(address);
    return Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
  } catch {
    return null;
  }
}

/**
 * @param {object[]} containers  from docker.js (with .ports: published TCP ports)
 * @param {object} config        the loaded config
 * @returns {{name: string, icon: string, port: number, scheme: string, ports: number[], container: string}[]}
 */
export function suggestServices(containers, config) {
  const services = (config.groups ?? []).flatMap((g) => g.services);
  const usedPorts = new Set();
  const patterns = [];
  for (const s of services) {
    // a port only counts as "has a card" when the card points at a machine, not at a public name:
    // https://app.example.com says nothing about port 443 on this server
    for (const address of [s.localUrl, s.check?.type === 'http' ? s.check.url : null]) {
      const port = address ? portOf(address) : null;
      if (port) usedPorts.add(port);
    }
    if (s.check?.type === 'tcp') usedPorts.add(s.check.port);
    for (const p of s.containers.length > 0 ? s.containers : autoContainerPatterns(s.name)) patterns.push(wildcardToRegExp(p));
  }
  const hasCard = (c) => patterns.some((re) => re.test(c.name) || (c.project && re.test(c.project)) || (c.service && re.test(c.service)));

  // one suggestion per app: the containers of one compose project belong together
  const apps = new Map();
  for (const c of containers) {
    if (c.labels?.url || c.labels?.local) continue; // makes its own card through labels
    if (/homelab-hub/i.test(c.image) || HELPER.test(c.image) || HELPER.test(c.service) || HELPER.test(c.name)) continue;
    if (!c.ports?.length || c.state !== 'running') continue;
    const key = c.project || c.name;
    if (!apps.has(key)) apps.set(key, { key, containers: [], ports: new Set() });
    const app = apps.get(key);
    app.containers.push(c);
    for (const p of c.ports) app.ports.add(p);
  }

  const out = [];
  for (const app of apps.values()) {
    if (app.containers.some(hasCard)) continue;
    const ports = [...app.ports].sort((a, b) => a - b);
    if (ports.some((p) => usedPorts.has(p))) continue;
    const port = LIKELY_WEB.find((p) => app.ports.has(p)) ?? ports[0];
    const slug = app.key.replace(/^ix-/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (!slug) continue;
    out.push({ name: pretty(slug), icon: slug, port, scheme: HTTPS_PORTS.has(port) ? 'https' : 'http', ports, container: app.containers[0].name });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
