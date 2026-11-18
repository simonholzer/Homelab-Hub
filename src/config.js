// Loads and validates the YAML config (config/services.yaml).
// A broken file never takes the page down: the caller keeps the last good config
// and shows the error list (see monitor.js).
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { parse } from 'yaml';
import { widgetRef, resolveWidget } from './widgets.js';

export const DEFAULT_SETTINGS = { checkIntervalSeconds: 30, timeoutSeconds: 4, statsIntervalSeconds: 5 };
export const LANGUAGES = ['auto', 'en', 'de'];
/** Docker labels that make a card: homelab-hub.name, homelab-hub.url, ... */
export const LABEL_PREFIX = 'homelab-hub.';
/** The themes that come with the hub (a block each in public/style.css, listed in public/theme.js too). */
export const BUILTIN_THEMES = ['dark', 'light', 'catppuccin', 'nord', 'gruvbox', 'high-contrast'];
/** The colors a theme of your own may set: YAML key -> CSS variable (see the top of public/style.css). */
export const THEME_COLORS = {
  bg: '--bg', panel: '--panel', panelHover: '--panel-hover', border: '--border', borderStrong: '--border-strong',
  text: '--text', muted: '--muted', accent: '--accent', onAccent: '--on-accent',
  up: '--up', down: '--down', warn: '--warn', unknown: '--unknown', track: '--track', shadow: '--shadow'
};
const MAX_THEMES = 20;

/** #rgb, #rrggbb (with alpha too), rgb(...) or hsl(...) with numbers only: nothing else can get into the page's CSS. */
export function isColor(value) {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  return /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v) || /^(?:rgba?|hsla?)\(\s*[\d.%\s,/+-]+\)$/i.test(v);
}

/**
 * `themes:` -> [{id, name, base, colors: {'--accent': '#...'}}]. Each theme starts from a built-in one
 * (base, default dark) and changes only the colors it names.
 */
function normalizeThemes(raw, errors) {
  const themes = [];
  if (raw == null) return themes;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push('themes: must be a mapping like  my-theme: { base: dark, accent: "#b48eff" }');
    return themes;
  }
  for (const [id, t] of Object.entries(raw)) {
    const where = `themes.${id}`;
    if (!/^[a-z0-9][a-z0-9_-]{0,39}$/i.test(id)) {
      errors.push(`${where}: a theme name may only use letters, digits, - and _ (up to 40)`);
      continue;
    }
    if (BUILTIN_THEMES.includes(id.toLowerCase()) || id.toLowerCase() === 'auto') {
      errors.push(`${where}: "${id}" is a built-in theme; give yours another name (and base: ${id} to start from it)`);
      continue;
    }
    if (t == null || typeof t !== 'object' || Array.isArray(t)) {
      errors.push(`${where}: must be a mapping of colors, e.g. accent: "#b48eff"`);
      continue;
    }
    const base = t.base == null ? 'dark' : String(t.base).toLowerCase();
    if (!BUILTIN_THEMES.includes(base)) errors.push(`${where}.base: must be one of ${BUILTIN_THEMES.join(', ')}`);
    const colors = {};
    for (const [key, value] of Object.entries(t)) {
      if (key === 'base' || key === 'name') continue;
      if (!Object.hasOwn(THEME_COLORS, key)) {
        errors.push(`${where}.${key}: unknown color; use ${Object.keys(THEME_COLORS).join(', ')}`);
      } else if (!isColor(value)) {
        errors.push(`${where}.${key}: "${value}" is not a color like "#7aa2ff" or "rgb(122, 162, 255)" (put # colors in quotes)`);
      } else colors[THEME_COLORS[key]] = value.trim();
    }
    if (themes.length >= MAX_THEMES) {
      errors.push(`themes: at most ${MAX_THEMES} themes`);
      break;
    }
    themes.push({ id, name: t.name == null ? id : String(t.name).slice(0, 60), base: BUILTIN_THEMES.includes(base) ? base : 'dark', colors });
  }
  return themes;
}

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

/** A `disks:` list (of the hub itself or of another machine) -> [{name, path, sizeBytes?}]. */
function normalizeDisks(list, where, errors) {
  const disks = [];
  if (list != null && !Array.isArray(list)) {
    errors.push(`${where}: must be a list`);
    return disks;
  }
  for (const [i, d] of (list ?? []).entries()) {
    if (!d || typeof d.path !== 'string') {
      errors.push(`${where}[${i}]: needs a path`);
      continue;
    }
    const disk = { name: String(d.name ?? d.path), path: d.path };
    if (d.size != null) {
      const bytes = parseSize(d.size);
      if (bytes == null) errors.push(`${where}[${i}].size: "${d.size}" is not a size like 106.6G or 1.5T`);
      else disk.sizeBytes = bytes;
    }
    disks.push(disk);
  }
  return disks;
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

/**
 * Validates the parsed YAML. Returns {config, errors}; config is null when unusable.
 * @param {object} [o]
 * @param {object} [o.widgets]  the widgets of widgets.yaml (see widgets.js), for cards with `widget:`
 * @param {object} [o.env]      where {env:NAME} in a widget is read from (default: the hub's environment)
 */
export function normalizeConfig(raw, { widgets = {}, env = process.env } = {}) {
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
  // Search the home network for agents (see scan.js): on unless switched off.
  const d = s.discovery ?? {};
  const discovery = { enabled: true, subnets: [], ports: [] };
  if (typeof d === 'boolean') discovery.enabled = d;
  else if (typeof d !== 'object' || Array.isArray(d)) errors.push('settings.discovery: must be a mapping (enabled, subnets, ports) or true/false');
  else {
    if (d.enabled != null && typeof d.enabled !== 'boolean') errors.push('settings.discovery.enabled: must be true or false');
    discovery.enabled = d.enabled !== false;
    for (const [i, net] of asList(d.subnets).entries()) {
      const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(net.trim());
      if (!m || Number(m[2]) < 20 || Number(m[2]) > 32 || m[1].split('.').some((x) => Number(x) > 255)) {
        errors.push(`settings.discovery.subnets[${i}]: "${net}" must be a network like 192.168.1.0/24 (from /20 to /32)`);
      } else discovery.subnets.push(net.trim());
    }
    for (const [i, port] of asList(d.ports).entries()) {
      const n = Number(port);
      if (!Number.isInteger(n) || n < 1 || n > 65535) errors.push(`settings.discovery.ports[${i}]: "${port}" is not a port number`);
      else if (discovery.ports.length < 4) discovery.ports.push(n);
    }
  }
  settings.discovery = discovery;
  // Language of the page for browsers that have not chosen one: auto (the browser's), en, de.
  const language = s.language == null ? 'auto' : String(s.language).toLowerCase();
  if (!LANGUAGES.includes(language)) errors.push(`settings.language: must be one of ${LANGUAGES.join(', ')}`);
  settings.language = LANGUAGES.includes(language) ? language : 'auto';

  const themes = normalizeThemes(raw.themes, errors);

  const disks = normalizeDisks(raw.stats?.disks, 'stats.disks', errors);

  // Other machines whose numbers are shown too: each runs this program in agent mode (see agent.js).
  const machines = [];
  const machinesRaw = raw.stats?.machines;
  if (machinesRaw != null && !Array.isArray(machinesRaw)) errors.push('stats.machines: must be a list');
  for (const [i, m] of (Array.isArray(machinesRaw) ? machinesRaw : []).entries()) {
    const where = `stats.machines[${i}]`;
    if (!m || typeof m.url !== 'string' || !m.url.trim()) {
      errors.push(`${where}: needs a url (the address of the agent, e.g. http://{pi}:8080)`);
      continue;
    }
    const url = interpolate(m.url.trim(), hosts, `${where}.url`, errors);
    if (!isHttpUrl(url)) {
      errors.push(`${where}.url: must be a full http:// or https:// address`);
      continue;
    }
    if (m.hidden === true) continue;
    machines.push({
      name: String(m.name ?? new URL(url).hostname),
      url,
      token: m.token == null ? '' : String(m.token),
      disks: normalizeDisks(m.disks, `${where}.disks`, errors),
      network: asList(m.network).filter((n) => /^[\w.:@-]+$/.test(n))
    });
  }

  /** The widget a card or tile asks for, resolved for its address; null when there is none (or it is wrong). */
  const widgetOf = (svc, label, base) => {
    const ref = widgetRef(svc.widget, label, errors);
    if (!ref) return null;
    const def = Object.hasOwn(widgets, ref.use) ? widgets[ref.use] : null;
    if (!def) {
      errors.push(`${label}.widget: there is no widget "${ref.use}" in widgets.yaml${Object.keys(widgets).length ? ` (there are: ${Object.keys(widgets).join(', ')})` : ''}`);
      return null;
    }
    return resolveWidget(ref, def, { base, hosts, env, insecure: svc.insecure === true }, label, errors);
  };

  /**
   * A widget tile: only a widget's values, on a tile of its own (type: widget in a group, or an entry of
   * tiles:). Its url/local is where the widget asks (and where a click on the tile goes); both are optional.
   */
  const normalizeTile = (svc, id, where) => {
    if (!svc || typeof svc !== 'object' || Array.isArray(svc)) {
      errors.push(`${where}: must be a mapping with a widget`);
      return null;
    }
    if (svc.hidden === true) return null;
    const label = `${where}${typeof svc.name === 'string' && svc.name.trim() ? ` (${svc.name.trim()})` : ''}`;
    if (svc.widget == null || svc.widget === '') {
      errors.push(`${label}: a widget tile needs a widget (widget: <name from widgets.yaml>)`);
      return null;
    }
    const url = svc.url == null ? '' : interpolate(String(svc.url), hosts, `${label}.url`, errors);
    const localUrl = svc.local == null ? '' : interpolate(String(svc.local), hosts, `${label}.local`, errors);
    if (url && !isHttpUrl(url)) errors.push(`${label}.url: must be a full http:// or https:// address`);
    if (localUrl && !isHttpUrl(localUrl)) errors.push(`${label}.local: must be a full http:// or https:// address`);
    const widget = widgetOf(svc, label, localUrl || url);
    const ref = widgetRef(svc.widget, label, []);
    return {
      id,
      tile: true,
      name: typeof svc.name === 'string' && svc.name.trim() ? svc.name.trim() : widgets[ref?.use]?.name ?? ref?.use ?? 'Widget',
      url: isHttpUrl(url) ? url : '',
      localUrl: isHttpUrl(localUrl) ? localUrl : '',
      description: '',
      icon: svc.icon == null ? '' : String(svc.icon),
      check: null,
      ...(widget ? { widget } : {}),
      containers: [],
      autoContainers: false
    };
  };

  // the widget row at the top of the page
  const tiles = [];
  if (raw.tiles != null && !Array.isArray(raw.tiles)) errors.push('tiles: must be a list of widget tiles');
  for (const [i, t] of (Array.isArray(raw.tiles) ? raw.tiles : []).entries()) {
    if (t && typeof t === 'object' && t.type != null && t.type !== 'widget') {
      errors.push(`tiles[${i}]: only widget tiles go into the widget row (type: widget)`);
      continue;
    }
    const tile = normalizeTile(t, `t${i}`, `tiles[${i}]`);
    if (tile) tiles.push(tile);
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
        if (svc && typeof svc === 'object' && svc.type != null && !['card', 'widget'].includes(svc.type)) {
          errors.push(`${where}.type: must be card (the default) or widget`);
          return;
        }
        if (svc?.type === 'widget') {
          const tile = normalizeTile(svc, `g${gi}s${si}`, where);
          if (tile) services.push(tile);
          return;
        }
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
        // a few values from the service's own API (widgets.yaml)
        const widget = widgetOf(svc, label, localUrl || url);
        services.push({
          id: `g${gi}s${si}`,
          name: svc.name.trim(),
          url,
          localUrl,
          description: svc.description == null ? '' : String(svc.description),
          icon: svc.icon == null ? '' : String(svc.icon),
          check,
          ...(widget ? { widget } : {}),
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
      themes,
      stats: {
        name: raw.stats?.name == null ? '' : String(raw.stats.name),
        disks,
        machines,
        // network cards to count (default: all physical ones)
        network: asList(raw.stats?.network).map(String).filter((n) => /^[\w.:@-]+$/.test(n))
      },
      groups,
      tiles,
      widgets // the widgets of widgets.yaml, for cards made from Docker labels
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
    for (const k of ['url', 'local', 'icon', 'check', 'description', 'widget']) if (l[k] != null && l[k] !== '') svc[k] = l[k];
    if (String(l.insecure ?? '').toLowerCase() === 'true') svc.insecure = true;
    const one = normalizeConfig({ hosts: config.hosts ?? {}, settings: { loginHosts: config.settings?.loginHosts ?? [] }, groups: [{ name: groupName, services: [svc] }] }, { widgets: config.widgets ?? {} });
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

/**
 * Parses YAML text. YAML syntax errors come back as errors, never as exceptions.
 * @param {string} text
 * @param {object} [o]  passed on to normalizeConfig (widgets, env)
 */
export function parseConfigText(text, o) {
  let raw;
  try {
    raw = parse(text);
  } catch (err) {
    const pos = err.linePos?.[0];
    const where = pos ? ` (line ${pos.line}, column ${pos.col})` : '';
    const first = String(err.message).split('\n')[0];
    return { config: null, errors: [`YAML syntax error${where}: ${first}`] };
  }
  return normalizeConfig(raw, o);
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
