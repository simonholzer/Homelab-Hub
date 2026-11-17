// HTTP server: static page + JSON API. A password login is optional (HUB_PASSWORD, see auth.js);
// without it the hub is meant to sit behind something that authenticates (Cloudflare Access,
// Authelia, a VPN) or to stay on the home network.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { Monitor } from './monitor.js';
import { HomeNetwork } from './network.js';
import { createConfigApi, fromOwnPage, readBody } from './editor.js';
import { createAuth, PUBLIC_PATHS, safeNext } from './auth.js';
import { createIconFetcher } from './icons.js';
import { createAgentApp, AGENT_PATH } from './agent.js';
import { StatsReader } from './stats.js';
import { suggestServices } from './discover.js';
import { listContainers } from './docker.js';
import { AgentFinder } from './scan.js';
import { importServices } from './import.js';
import { createUpdateChecker, DEFAULT_REPO } from './update.js';

export const VERSION = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version;

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json; charset=utf-8'
};

const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY'
};

const sha = (data) => crypto.createHash('sha1').update(data).digest('hex').slice(0, 10);
const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.svg', '.json', '.webmanifest']);
/** A file asked for with its current version in the address never changes under that address. */
const KEEP_FOREVER = 'public, max-age=31536000, immutable';

/**
 * Files are kept in memory together with their hash and gzip form. A changed file (other time or
 * size) is read again, so editing a file needs no restart. Throws when there is no such file.
 */
const fileCache = new Map(); // path -> {mtimeMs, size, data, hash, gzip}
export function loadFile(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error('not a file');
  const hit = fileCache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit;
  const data = fs.readFileSync(file);
  const entry = { mtimeMs: stat.mtimeMs, size: stat.size, data, hash: sha(data), gzip: null };
  fileCache.set(file, entry);
  return entry;
}

/**
 * Sends a body: "not changed" (304) when the browser already has this version, gzip when the browser
 * takes it and the content is text of some size.
 */
function send(req, res, status, { data, type, cache, etag, gzip }) {
  const headers = { 'content-type': type, 'cache-control': cache, ...SECURITY_HEADERS };
  if (gzip) headers.vary = 'accept-encoding';
  if (etag) {
    headers.etag = `"${etag}"`;
    // a proxy may hand the tag back marked as "weak" (W/"...") after compressing: still the same version
    if ((req.headers['if-none-match'] ?? '').replace(/^W\//, '') === headers.etag) {
      res.writeHead(304, headers);
      return res.end();
    }
  }
  let body = data;
  if (gzip && data.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] ?? '')) {
    body = gzip();
    headers['content-encoding'] = 'gzip';
  }
  headers['content-length'] = body.length;
  res.writeHead(status, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}

/** Adds ?v=<hash of the file> to the page's own script and stylesheet links (also in data-… attributes). */
export function withAssetVersions(html, publicDir) {
  return html.replace(/(href|src|data-[a-z-]+)="(\/[\w.-]+\.(?:css|js))"/g, (match, attr, url) => {
    try {
      const { hash } = loadFile(path.join(publicDir, url));
      return `${attr}="${url}?v=${hash}"`;
    } catch {
      return match; // file missing: leave the link as it is
    }
  });
}

/**
 * Icon name -> short hash of its file in public/icons. The page asks for /icons/<name>.svg?v=<hash>,
 * so a new or changed icon gets a new address at once (Cloudflare tells browsers to keep icons for
 * 4 hours), and a name without a file goes straight to the default icon (no 404 a browser could keep).
 * Icons come from two folders: public/icons (part of the image) and, when given, userDir: the icons
 * added on the page (config editor), kept next to the config file. Those win over a bundled one of
 * the same name. Read once and again after an icon was added (forgetIcons).
 */
const ICON_FILE = /^([a-z0-9][a-z0-9_-]*)\.svg$/i;
const iconCache = new Map(); // folders -> versions
export function iconVersions(publicDir, userDir = null) {
  const key = `${publicDir}|${userDir ?? ''}`;
  if (iconCache.has(key)) return iconCache.get(key);
  const versions = {};
  for (const dir of [path.join(publicDir, 'icons'), userDir]) {
    if (!dir) continue;
    try {
      for (const f of fs.readdirSync(dir)) {
        const m = ICON_FILE.exec(f);
        if (!m) continue;
        versions[m[1]] = loadFile(path.join(dir, f)).hash;
      }
    } catch {
      // no such folder: every card gets the default icon
    }
  }
  iconCache.set(key, versions);
  return versions;
}
export const forgetIcons = () => iconCache.clear();

/**
 * @param {object} o
 * @param {object} o.monitor
 * @param {object} [o.network]
 * @param {string} [o.publicDir]
 * @param {boolean} [o.editor]  false = the config can't be read or changed from the page (CONFIG_EDITOR=off)
 * @param {string} [o.iconsDir]  folder for icons added on the page (default: "icons" next to the config file)
 * @param {Function} [o.downloadIcon]  override for tests
 * @param {object|null} [o.auth]  from createAuth(): the password login (null = none)
 * @param {boolean} [o.autoIcons]  true = icons that are named but missing are fetched from dashboard-icons
 * @param {object|null} [o.update]  from createUpdateChecker(): tells the page about a newer version
 * @param {object|null} [o.finder]  from new AgentFinder(): agents found on the home network
 */
export function createApp({ monitor, network, publicDir = path.join(root, 'public'), editor = true, iconsDir, downloadIcon, auth = null, autoIcons = false, update = null, finder = null }) {
  const userIcons = iconsDir ?? (monitor.configPath ? path.join(path.dirname(monitor.configPath), 'icons') : null);
  const icons = () => iconVersions(publicDir, userIcons);
  const fetchIcons = autoIcons && userIcons ? createIconFetcher({ iconsDir: userIcons, download: downloadIcon, onIcon: forgetIcons }) : null;
  const configApi =
    editor && typeof monitor.readConfigFile === 'function'
      ? createConfigApi({
          getFile: () => monitor.readConfigFile(),
          getIcons: icons,
          iconsDir: userIcons,
          download: downloadIcon,
          onIcon: forgetIcons,
          // apply at once instead of at the next check cycle, and check new services right away
          onSaved: () => {
            monitor.reloadConfig();
            monitor.tick().catch((err) => console.error('[monitor] tick after save failed:', err));
          }
        })
      : null;

  const json = (res, status, body) => {
    const data = Buffer.from(JSON.stringify(body));
    send(res.req, res, status, { data, type: MIME['.json'], cache: 'no-store', gzip: () => zlib.gzipSync(data) });
  };
  const pages = new Map(); // the pages with versioned links, kept until one of those versions changes

  return http.createServer((req, res) => {
    const isConfigApi = /^\/api\/config(\/|$)/.test(req.url ?? '');
    const isAuthApi = auth != null && req.method === 'POST' && /^\/api\/(login|logout|password)$/.test(req.url ?? '');
    if (req.method !== 'GET' && req.method !== 'HEAD' && !(configApi && isConfigApi) && !isAuthApi) {
      res.writeHead(405, { allow: 'GET, HEAD', ...SECURITY_HEADERS });
      return res.end();
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400, SECURITY_HEADERS);
      return res.end();
    }

    if (pathname === '/healthz') return json(res, 200, { ok: true });

    // ---- password login (only once a password is set: HUB_PASSWORD, or on the page) ----
    const authOn = auth?.enabled === true;
    const loggedIn = authOn ? auth.loggedIn(req) : false;
    if (auth && pathname === '/api/password' && req.method === 'POST') {
      // set, change or remove the password from the page. Setting the first one needs no login (there
      // is none yet: whoever can open the hub can already change everything); after that it does.
      if (!fromOwnPage(req)) return json(res, 403, { error: 'Only accepted from the hub page itself.' });
      if (authOn && !loggedIn) return json(res, 401, { error: 'Log in first.', login: true });
      return void readBody(req).then(
        (body) => {
          const result = body?.remove === true ? auth.removePassword(req) : auth.setPassword(req, body?.password, body?.protects);
          if (!result.ok) return json(res, 400, { error: result.error });
          res.setHeader('set-cookie', result.cookie);
          console.log(`[hub] password ${body?.remove === true ? 'removed' : 'set'} from the page`);
          return json(res, 200, { ok: true });
        },
        (err) => json(res, err.status ?? 400, { error: err.message })
      );
    }
    if (authOn) {
      if (pathname === '/api/login' && req.method === 'POST') {
        if (!fromOwnPage(req)) return json(res, 403, { error: 'Logins are only accepted from the hub page itself.' });
        return void readBody(req).then(
          (body) => {
            const result = auth.login(req, body?.password);
            if (result.ok) {
              res.setHeader('set-cookie', result.cookie);
              return json(res, 200, { ok: true, next: safeNext(body?.next) });
            }
            return json(res, result.wait > 0 ? 429 : 401, { error: result.wait > 0 ? 'Too many wrong passwords. Wait a minute and try again.' : 'Wrong password.', wait: result.wait });
          },
          (err) => json(res, err.status ?? 400, { error: err.message })
        );
      }
      if (pathname === '/api/logout' && req.method === 'POST') {
        if (!fromOwnPage(req)) return json(res, 403, { error: 'Only accepted from the hub page itself.' });
        res.setHeader('set-cookie', auth.logoutCookie(req));
        return json(res, 200, { ok: true });
      }
      const needsLogin = auth.mode === 'all' ? !PUBLIC_PATHS.has(pathname) : isConfigApi;
      if (needsLogin && !loggedIn) {
        // only a page that is being opened goes to the login; scripts, pictures and the API get a plain "no"
        const opensPage = pathname === '/' || String(req.headers.accept ?? '').includes('text/html');
        if (pathname.startsWith('/api/') || !opensPage) return json(res, 401, { error: 'Log in first.', login: true });
        // a page: off to the login, and back here afterwards
        res.writeHead(302, { location: `/login?next=${encodeURIComponent(safeNext(req.url))}`, 'cache-control': 'no-store', ...SECURITY_HEADERS });
        return res.end();
      }
    }
    if (pathname === '/login') pathname = authOn ? '/login.html' : '/';

    if (pathname === '/api/status') {
      const client = network ? network.detect(req) : { home: null, via: 'unknown', reason: 'Home detection is off', clientIp: null, serverIp: null };
      const snapshot = monitor.snapshot();
      const known = icons();
      if (fetchIcons) {
        // icons that are named on a card but have no file yet: fetched in the background, there on a later refresh
        const missing = snapshot.groups.flatMap((g) => g.services.map((s) => s.icon)).filter((name) => name && !known[name] && !known[name.toLowerCase()]);
        if (missing.length > 0) fetchIcons(missing).catch(() => {});
      }
      return json(res, 200, {
        ...snapshot,
        client,
        icons: known,
        editor: configApi != null,
        // enabled: a password is set; canSet: one can be set or changed on the page (not with HUB_PASSWORD)
        auth: auth ? { mode: auth.mode, loggedIn, enabled: authOn, canSet: auth.canSet } : null,
        version: VERSION,
        update: update?.available() ?? null
      });
    }
    if (pathname === '/api/containers') return json(res, 200, monitor.containers());
    if (isAuthApi) return json(res, 404, { error: 'Not found' });
    if (pathname === '/api/config' || pathname.startsWith('/api/config/')) {
      if (!configApi) return json(res, 404, { error: 'The config editor is switched off (CONFIG_EDITOR=off).' });
      // containers that publish a port and have no card yet, for the editor's "found on this server" list
      if (pathname === '/api/config/suggestions' && (req.method === 'GET' || req.method === 'HEAD')) {
        return json(res, 200, { suggestions: suggestServices(monitor.discovered ?? [], monitor.config), dockerError: monitor.dockerError ?? null });
      }
      // agents found on the home network, for the editor's "Found on the network" list
      if (pathname === '/api/config/agents' && (req.method === 'GET' || req.method === 'HEAD')) {
        if (!finder) return json(res, 200, { enabled: false, agents: [] });
        const known = new Set((monitor.config.stats?.machines ?? []).map((m) => agentKey(m.url)));
        const state = finder.state();
        return json(res, 200, { ...state, agents: state.agents.map((a) => ({ ...a, added: known.has(agentKey(a.url)) })) });
      }
      if (pathname === '/api/config/agents/scan' && req.method === 'POST') {
        if (!fromOwnPage(req)) return json(res, 403, { error: 'Changes are only accepted from the hub page itself.' });
        if (!finder) return json(res, 404, { error: 'Searching for agents is switched off (AGENT_DISCOVERY=off).' });
        finder.scan().catch(() => {});
        return json(res, 202, { ok: true });
      }
      // another dashboard's config file -> groups of cards (nothing is saved here)
      if (pathname === '/api/config/import' && req.method === 'POST') {
        if (!fromOwnPage(req)) return json(res, 403, { error: 'Changes are only accepted from the hub page itself.' });
        return void readBody(req).then(
          (body) => {
            try {
              return json(res, 200, importServices(body?.text ?? ''));
            } catch (err) {
              return json(res, 400, { error: err.message });
            }
          },
          (err) => json(res, err.status ?? 400, { error: err.message })
        );
      }
      return void configApi(req, res, pathname, json);
    }

    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const isPage = rel === 'index.html' || rel === 'login.html';
    let file = path.resolve(publicDir, rel);
    if (file !== publicDir && !file.startsWith(publicDir + path.sep)) {
      res.writeHead(403, SECURITY_HEADERS);
      return res.end();
    }
    // an icon added on the page lives next to the config file and wins over a bundled one
    const icon = userIcons && /^\/icons\/([a-z0-9][a-z0-9_-]*\.svg)$/i.exec(pathname);
    if (icon && fs.existsSync(path.join(userIcons, icon[1]))) file = path.join(userIcons, icon[1]);
    let entry;
    try {
      entry = loadFile(file);
    } catch {
      // no-store: a browser must never keep a "not found" (e.g. an icon asked for before it was deployed)
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS });
      return res.end('Not found');
    }
    const ext = path.extname(file);
    // Cloudflare rewrites the cache header of .js/.css files to "max-age=14400" (4 hours), so after an
    // update browsers would keep the old script and style. The page therefore asks for them with a
    // version in the address (?v=...), which changes whenever their content does.
    if (isPage) {
      const html = withAssetVersions(entry.data.toString('utf8'), publicDir);
      if (pages.get(rel)?.html !== html) {
        const data = Buffer.from(html);
        pages.set(rel, { html, data, hash: sha(data), gzip: null });
      }
      entry = pages.get(rel);
    }
    const page = entry;
    send(req, res, 200, {
      data: page.data,
      type: MIME[ext] ?? 'application/octet-stream',
      // Asked for with the current version in the address: the browser may keep it for good, a new
      // version has a new address. Everything else is checked each time, answered with "not changed".
      cache: !isPage && url.searchParams.get('v') === page.hash ? KEEP_FOREVER : 'no-cache',
      etag: page.hash,
      gzip: COMPRESSIBLE.has(ext) ? () => (page.gzip ??= zlib.gzipSync(page.data)) : null
    });
  });
}

/** "http://192.168.1.20:8081/" and "http://192.168.1.20:8081" are the same agent. */
function agentKey(url) {
  try {
    const u = new URL(url);
    return `${u.hostname.toLowerCase()}:${u.port || (u.protocol === 'https:' ? 443 : 80)}`;
  } catch {
    return String(url);
  }
}

/** HUB_MODE=agent: no page, only this machine's numbers for a hub somewhere else (see agent.js). */
function agentMain() {
  const token = process.env.AGENT_TOKEN ?? '';
  const reader = new StatsReader({ procPath: process.env.PROC_PATH ?? '/proc', sysPath: process.env.SYS_PATH ?? '/sys' });
  const dockerHost = process.env.DOCKER_HOST ?? '';
  const name = (process.env.AGENT_NAME ?? '').trim() || os.hostname();
  const server = createAgentApp({ reader, token, name, version: VERSION, containers: dockerHost ? () => listContainers(dockerHost) : null });
  const port = Number(process.env.PORT ?? 8080);
  const host = process.env.HOST ?? '0.0.0.0';
  server.listen(port, host, () => {
    console.log(`[agent] answering the hub on http://${host.includes(':') ? `[${host}]` : host}:${port}${AGENT_PATH}`);
    if (!token) console.log('[agent] no token set (AGENT_TOKEN): anyone who can reach this port can read the numbers');
    console.log(dockerHost ? `[agent] reporting the containers of ${dockerHost} as "${name}"` : '[agent] no DOCKER_HOST: only numbers, no containers');
  });
  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

function main() {
  if ((process.env.HUB_MODE ?? '').toLowerCase() === 'agent') return agentMain();
  const monitor = new Monitor({
    configPath: process.env.CONFIG_PATH ?? path.join(root, 'config', 'services.yaml'),
    defaultConfigPath: process.env.DEFAULT_CONFIG_PATH ?? path.join(root, 'config', 'services.yaml'),
    dockerHost: process.env.DOCKER_HOST ?? '',
    procPath: process.env.PROC_PATH ?? '/proc',
    sysPath: process.env.SYS_PATH ?? '/sys'
  });
  monitor.start();
  const network = new HomeNetwork({
    getExtraIps: () => monitor.config.settings.home?.publicIps ?? [],
    getClientIpHeader: () => monitor.config.settings.home?.clientIpHeader ?? '',
    getRunsAtHome: () => monitor.config.settings.home?.runsAtHome !== false
  });
  network.start();
  const port = Number(process.env.PORT ?? 8080);
  const editor = !['off', 'false', '0', 'no'].includes((process.env.CONFIG_EDITOR ?? '').toLowerCase());
  const off = (value) => ['off', 'false', '0', 'no'].includes(String(value ?? '').toLowerCase());
  const auth = createAuth({
    password: process.env.HUB_PASSWORD ?? '',
    protects: process.env.HUB_PASSWORD_PROTECTS ?? 'all',
    file: path.join(path.dirname(monitor.configPath), 'hub-auth.json') // a password set on the page
  });
  if (auth.enabled) console.log(`[hub] password login is on (protects: ${auth.mode === 'all' ? 'the whole page' : 'the config editor'})`);
  else console.log('[hub] no password set: anyone who can reach this port can see the page and edit the config (set one in the gear menu, or HUB_PASSWORD)');
  const update = off(process.env.UPDATE_CHECK) ? null : createUpdateChecker({ current: VERSION, repo: process.env.UPDATE_REPO || DEFAULT_REPO });
  update?.start();
  console.log(`[hub] version ${VERSION}`);
  const finder = off(process.env.AGENT_DISCOVERY)
    ? null
    : new AgentFinder({ getSettings: () => monitor.config.settings.discovery ?? { enabled: true, subnets: [], ports: [] }, procPath: process.env.PROC_PATH ?? '/proc' });
  finder?.start();
  const server = createApp({ monitor, network, editor, auth, autoIcons: !off(process.env.ICON_DOWNLOAD), update, finder });
  // HOST=:: also answers on IPv6 (the laptop preview sets it: "localhost" is tried on IPv6 first on Windows)
  const host = process.env.HOST ?? '0.0.0.0';
  server.listen(port, host, () => console.log(`[hub] listening on http://${host.includes(':') ? `[${host}]` : host}:${port}`));
  const shutdown = () => {
    monitor.stop();
    network.stop();
    finder?.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
