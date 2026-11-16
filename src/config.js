// Loads and validates the YAML config (config/services.yaml).
// A broken file never takes the page down: the caller keeps the last good config
// and shows the error list (see monitor.js).
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { parse } from 'yaml';

export const DEFAULT_SETTINGS = { checkIntervalSeconds: 30, timeoutSeconds: 4, statsIntervalSeconds: 5 };
export const LANGUAGES = ['auto', 'en', 'de'];
/** Docker labels that make a card: homelab-hub.name, homelab-hub.url, ... */
export const LABEL_PREFIX = 'homelab-hub.';

/** Replaces {alias} with the value from `hosts:`; unknown aliases are reported. */
export function interpolate(value, hosts, where, errors) {
  return String(value).replace(/\{([A-Za-z0-9_-]+)\}/g, (match, key) => {
    if (Object.hasOwn(hosts, key)) return String(hosts[key]);
    errors.push(`${where}: unknown host alias {${key}} (add it under "hosts:")`);
    return match;
  });
}

function isHttpUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function asList(value) {
  if (value == null || value === false) return [];
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

/** "106.6G", "1.5 TB", "900 GiB", 5000000 (bytes) -> bytes (1024-based, like the page); null if it isn't a size. */
export function parseSize(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
  const m = /^(\d+(?:\.\d+)?)\s*([kmgt]?)(?:i?b)?$/i.exec(String(value).trim());
  if (!m) return null;
  const power = { '': 0, k: 1, m: 2, g: 3, t: 4 }[m[2].toLowerCase()];
  const bytes = Math.round(Number(m[1]) * 1024 ** power);
  return bytes > 0 ? bytes : null;
}

function number(value, fallback, min, max, where, errors) {
  if (value == null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    errors.push(`${where}: must be a number between ${min} and ${max}`);
    return fallback;
  }
  return value;
}

/** Turns one `check:` value into {type:'http'|'tcp', ...} or null (= no check). */
function normalizeCheck(raw, service, hosts, where, errors, loginHosts = []) {
  const insecure = service.insecure === true;
  if (raw === false || raw === null && 'check' in service) return null;
  if (typeof raw === 'string' && ['none', 'off', 'no', 'false'].includes(raw.toLowerCase())) return null;
  const target = raw == null ? service.url : raw;
  if (typeof target !== 'string') {
    errors.push(`${where}.check: must be a URL like http://{nas}:30080 or tcp://{pi}:22, or "none"`);
    return null;
  }
  const resolved = interpolate(target, hosts, `${where}.check`, errors);
  let u;
  try {
    u = new URL(resolved);
  } catch {
    errors.push(`${where}.check: "${resolved}" is not a valid URL`);
    return null;
  }
  if (u.protocol === 'tcp:') {
    if (!u.hostname || !u.port) {
      errors.push(`${where}.check: tcp checks need a host and a port, e.g. tcp://{pi}:22`);
      return null;
    }
    return { type: 'tcp', host: u.hostname, port: Number(u.port) };
  }
  if (u.protocol === 'http:' || u.protocol === 'https:') {
    return { type: 'http', url: resolved, insecure, ...(loginHosts.length > 0 ? { loginHosts } : {}) };
  }
  errors.push(`${where}.check: only http://, https:// and tcp:// are supported`);
  return null;
}

/** Validates the parsed YAML. Returns {config, errors}; config is null when unusable. */
export function normalizeConfig(raw) {
  const errors = [];
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { config: null, errors: ['The file must contain a YAML mapping (title:, groups:, ...)'] };
  }

  const hosts = {};
  if (raw.hosts != null) {
    if (typeof raw.hosts !== 'object' || Array.isArray(raw.hosts)) {
      errors.push('hosts: must be a mapping like  nas: 192.168.1.10');
    } else {
      for (const [k, v] of Object.entries(raw.hosts)) hosts[k] = String(v);
    }
  }

  const s = raw.settings ?? {};
  const settings = {
    checkIntervalSeconds: number(s.checkIntervalSeconds, DEFAULT_SETTINGS.checkIntervalSeconds, 5, 3600, 'settings.checkIntervalSeconds', errors),
    timeoutSeconds: number(s.timeoutSeconds, DEFAULT_SETTINGS.timeoutSeconds, 1, 30, 'settings.timeoutSeconds', errors),
    statsIntervalSeconds: number(s.statsIntervalSeconds, DEFAULT_SETTINGS.statsIntervalSeconds, 1, 3600, 'settings.statsIntervalSeconds', errors)
  };

  // Extra public IP addresses that count as "home" (see network.js). Optional.
  const publicIps = [];
  for (const [i, ip] of asList(raw.settings?.home?.publicIps).entries()) {
    if (net.isIP(ip) === 0) errors.push(`settings.home.publicIps[${i}]: "${ip}" is not an IP address`);
    else publicIps.push(ip);
  }
  // false = this hub runs somewhere else than the home network (a laptop preview): a direct visit is
  // then not "home" by itself, it only is when this machine's public IP is one of publicIps.
  const runsAtHomeRaw = raw.settings?.home?.runsAtHome;
  if (runsAtHomeRaw != null && typeof runsAtHomeRaw !== 'boolean') errors.push('settings.home.runsAtHome: must be true or false');
  // Behind a reverse proxy other than Cloudflare: the header in which the proxy passes the visitor's
  // address (x-forwarded-for, x-real-ip, ...). Cloudflare's own header is always understood.
  let clientIpHeader = '';
  const headerRaw = raw.settings?.home?.clientIpHeader;
  if (headerRaw != null && headerRaw !== '') {
    if (typeof headerRaw !== 'string' || !/^[A-Za-z0-9-]+$/.test(headerRaw)) errors.push('settings.home.clientIpHeader: must be a header name like x-forwarded-for');
    else clientIpHeader = headerRaw.toLowerCase();
  }
  settings.home = { publicIps, runsAtHome: runsAtHomeRaw !== false, clientIpHeader };

  // Host names of your own login pages (Authelia, Authentik, ...): a check that is redirected there
  // says nothing about the service behind it, so it shows "unknown" instead of green.
  settings.loginHosts = [];
  for (const [i, host] of asList(s.loginHosts).entries()) {
    if (!/^[a-z0-9.-]+$/i.test(host)) errors.push(`settings.loginHosts[${i}]: "${host}" is not a host name (write it without https:// and path)`);
    else settings.loginHosts.push(host.toLowerCase());
  }
  // Cards from Docker labels (homelab-hub.name, homelab-hub.url, ...): on unless switched off.
  if (s.dockerLabels != null && typeof s.dockerLabels !== 'boolean') errors.push('settings.dockerLabels: must be true or false');
  settings.dockerLabels = s.dockerLabels !== false;
  // Language of the page for browsers that have not chosen one: auto (the browser's), en, de.
  const language = s.language == null ? 'auto' : String(s.language).toLowerCase();
  if (!LANGUAGES.includes(language)) errors.push(`settings.language: must be one of ${LANGUAGES.join(', ')}`);
  settings.language = LANGUAGES.includes(language) ? language : 'auto';

  const disks = [];
  for (const [i, d] of (raw.stats?.disks ?? []).entries()) {
    if (!d || typeof d.path !== 'string') {
      errors.push(`stats.disks[${i}]: needs a path`);
      continue;
    }
    const disk = { name: String(d.name ?? d.path), path: d.path };
    if (d.size != null) {
      const bytes = parseSize(d.size);
      if (bytes == null) errors.push(`stats.disks[${i}].size: "${d.size}" is not a size like 106.6G or 1.5T`);
      else disk.sizeBytes = bytes;
    }
    disks.push(disk);
  }

  const groups = [];
  if (raw.groups != null && !Array.isArray(raw.groups)) {
    errors.push('groups: must be a list of groups');
  } else if (raw.groups != null) {
    raw.groups.forEach((g, gi) => {
      const gWhere = `groups[${gi}]`;
      if (!g || typeof g.name !== 'string' || !g.name.trim()) {
        errors.push(`${gWhere}: needs a name`);
        return;
      }
      if (!Array.isArray(g.services)) {
        errors.push(`${gWhere} (${g.name}): needs a services: list`);
        return;
      }
      const services = [];
      g.services.forEach((svc, si) => {
        const where = `${g.name} → services[${si}]`;
        if (!svc || typeof svc.name !== 'string' || !svc.name.trim()) {
          errors.push(`${where}: needs a name`);
          return;
        }
        const label = `${g.name} → ${svc.name}`;
        if (svc.hidden === true) return;
        // url = public address (Cloudflare); local = address used on the home network.
        // A service may have only `local` (no tunnel): it is shown as "home only" when away.
        const url = svc.url == null ? '' : interpolate(String(svc.url), hosts, `${label}.url`, errors);
        const localUrl = svc.local == null ? '' : interpolate(String(svc.local), hosts, `${label}.local`, errors);
        if (!url && !localUrl) {
          errors.push(`${label}: needs a url (public address) and/or a local address`);
          return;
        }
        if (url && !isHttpUrl(url)) {
          errors.push(`${label}.url: must be a full http:// or https:// address`);
          return;
        }
        if (localUrl && !isHttpUrl(localUrl)) {
          errors.push(`${label}.local: must be a full http:// or https:// address`);
          return;
        }
        const check = normalizeCheck(svc.check, { ...svc, url: url || localUrl }, hosts, label, errors, settings.loginHosts);
        services.push({
          id: `g${gi}s${si}`,
          name: svc.name.trim(),
          url,
          localUrl,
          description: svc.description == null ? '' : String(svc.description),
          icon: svc.icon == null ? '' : String(svc.icon),
          check,
          containers: asList(svc.containers),
          // no containers: of its own, but the group asks for automatic matching by name
          autoContainers: g.autoContainers === true && asList(svc.containers).length === 0
        });
      });
      groups.push({
        id: `g${gi}`,
        name: g.name.trim(),
        icon: g.icon == null ? '' : String(g.icon),
        services
      });
    });
  }

  if (errors.length > 0) return { config: null, errors };
  return {
    config: {
      title: String(raw.title ?? 'Homelab Hub'),
      hosts,
      subtitle: raw.subtitle == null ? '' : String(raw.subtitle),
      settings,
      stats: {
        name: raw.stats?.name == null ? '' : String(raw.stats.name),
        disks,
        // network cards to count (default: all physical ones)
        network: asList(raw.stats?.network).map(String).filter((n) => /^[\w.:@-]+$/.test(n))
      },
      groups
    },
    errors: []
  };
}

/**
 * Cards described on the containers themselves, with labels:
 *   homelab-hub.name   (default: the compose service or container name)
 *   homelab-hub.url    public address        homelab-hub.local   home network address (one of the two is needed)
 *   homelab-hub.group  (default "Docker")    homelab-hub.icon    homelab-hub.check    homelab-hub.description
 * The same rules as for the YAML apply ({host} shortcuts included). The card shows the health of its container.
 * @param {object[]} containers  from docker.js (each with .labels: the homelab-hub.* ones, prefix removed)
 * @param {object} config        the loaded config (hosts and settings are used)
 * @returns {{groups: {name: string, services: object[]}[], errors: string[]}}
 */
export function servicesFromLabels(containers, config) {
  const groups = new Map();
  const errors = [];
  const seen = new Set();
  for (const c of containers) {
    const l = c.labels;
    if (!l || (!l.url && !l.local)) continue;
    if (String(l.hide ?? l.hidden ?? '').toLowerCase() === 'true') continue;
    const groupName = String(l.group ?? 'Docker').trim() || 'Docker';
    const name = String(l.name ?? (c.service || c.name)).trim() || c.name;
    const key = `${groupName}/${name}`;
    if (seen.has(key)) continue; // several replicas of one service: one card
    seen.add(key);
    const svc = { name, containers: [c.name] };
    for (const k of ['url', 'local', 'icon', 'check', 'description']) if (l[k] != null && l[k] !== '') svc[k] = l[k];
    if (String(l.insecure ?? '').toLowerCase() === 'true') svc.insecure = true;
    const one = normalizeConfig({ hosts: config.hosts ?? {}, settings: { loginHosts: config.settings?.loginHosts ?? [] }, groups: [{ name: groupName, services: [svc] }] });
    if (!one.config) {
      errors.push(...one.errors.map((e) => `container ${c.name}: ${e}`));
      continue;
    }
    const made = one.config.groups[0].services[0];
    made.id = `d:${c.name}`;
    made.fromDocker = true;
    if (!groups.has(groupName)) groups.set(groupName, { name: groupName, services: [] });
    groups.get(groupName).services.push(made);
  }
  return { groups: [...groups.values()], errors };
}

/** Parses YAML text. YAML syntax errors come back as errors, never as exceptions. */
export function parseConfigText(text) {
  let raw;
  try {
    raw = parse(text);
  } catch (err) {
    const pos = err.linePos?.[0];
    const where = pos ? ` (line ${pos.line}, column ${pos.col})` : '';
    const first = String(err.message).split('\n')[0];
    return { config: null, errors: [`YAML syntax error${where}: ${first}`] };
  }
  return normalizeConfig(raw);
}

/**
 * Makes sure the config file exists: on first start the bundled example is copied
 * to the (mounted) config folder so there is something to edit.
 * Returns the path that should be read.
 */
export function ensureConfigFile(configPath, defaultPath) {
  if (fs.existsSync(configPath)) return configPath;
  if (!defaultPath || !fs.existsSync(defaultPath)) return configPath;
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.copyFileSync(defaultPath, configPath);
    console.log(`[config] created ${configPath} from the bundled example`);
    return configPath;
  } catch (err) {
    console.warn(`[config] cannot write ${configPath} (${err.code ?? err.message}); using the bundled example read-only`);
    return defaultPath;
  }
}
