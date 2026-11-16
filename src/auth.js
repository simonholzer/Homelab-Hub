// Optional password login. Off until a password is set, in one of two ways:
//
//   HUB_PASSWORD           set in the environment (compose file). Then it can't be changed on the page.
//   on the page            gear menu -> Password. Stored as a salted hash in hub-auth.json next to the
//                          config file (delete that file to remove a forgotten password).
//   HUB_PASSWORD_PROTECTS  all (default): the whole page needs the login
//                          editor: everyone can see the page, only the config editor needs the login
//                          (for a password set on the page, this is chosen there)
//
// A login is remembered in a cookie that holds an expiry time signed with a key derived from the
// password: nothing else is stored on the server, a restart keeps people logged in, and changing the
// password logs everyone out.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const COOKIE = 'hub_session';
const SESSION_DAYS = 30;
const MAX_FAILS = 5; // wrong passwords from one address ...
const LOCK_MS = 60_000; // ... before that address has to wait this long
export const MIN_PASSWORD_LENGTH = 8;

const digest = (text) => crypto.createHash('sha256').update(text).digest();
const modeOf = (protects) => (String(protects).toLowerCase() === 'editor' ? 'editor' : 'all');
const scrypt = (password, salt) => crypto.scryptSync(String(password), salt, 32);

/**
 * @param {object} [o]
 * @param {string} [o.password]  from HUB_PASSWORD
 * @param {string} [o.protects]  from HUB_PASSWORD_PROTECTS
 * @param {string|null} [o.file] where a password set on the page is kept; null = it can't be set there
 * @returns {null | object} null when there is neither a password nor a place to keep one
 */
export function createAuth({ password = '', protects = 'all', file = null, now = () => Date.now() } = {}) {
  if (!password && !file) return null;
  const fails = new Map(); // address -> {count, until}

  // ---- where the password comes from: the environment wins over the file ----
  let stored = null; // {salt, hash, protects} from the file
  const readStored = () => {
    if (!file) return null;
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      return typeof j?.salt === 'string' && typeof j?.hash === 'string' ? { salt: j.salt, hash: j.hash, protects: modeOf(j.protects) } : null;
    } catch {
      return null; // no file (no password set on the page) or unreadable
    }
  };
  if (!password) stored = readStored();

  const source = () => (password ? 'env' : stored ? 'file' : null);
  const enabled = () => source() != null;
  const mode = () => (password ? modeOf(protects) : stored ? stored.protects : null);
  const key = () => digest(`homelab-hub session key\n${password || stored?.hash || ''}`);
  const matches = (given) => {
    if (password) return crypto.timingSafeEqual(digest(String(given ?? '')), digest(password));
    if (!stored) return false;
    const want = Buffer.from(stored.hash, 'hex');
    const got = scrypt(given ?? '', Buffer.from(stored.salt, 'hex'));
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  };

  const sign = (expires) => crypto.createHmac('sha256', key()).update(String(expires)).digest('base64url');

  function cookieOf(req) {
    for (const part of String(req.headers.cookie ?? '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
    }
    return '';
  }

  /** True when the request carries a valid, unexpired login. */
  function loggedIn(req) {
    if (!enabled()) return false;
    const [expires, mac] = cookieOf(req).split('.');
    if (!expires || !mac || !/^\d+$/.test(expires) || Number(expires) < now()) return false;
    const good = Buffer.from(sign(expires));
    const got = Buffer.from(mac);
    return got.length === good.length && crypto.timingSafeEqual(got, good);
  }

  const isHttps = (req) => Boolean(req.socket?.encrypted) || String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https';
  const cookie = (req, value, maxAge) => `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;
  const sessionCookie = (req) => {
    const expires = now() + SESSION_DAYS * 86_400_000;
    return cookie(req, `${expires}.${sign(expires)}`, SESSION_DAYS * 86_400);
  };

  /** The address wrong passwords are counted for (the peer: a header could be made up to dodge the wait). */
  const peerOf = (req) => String(req.socket?.remoteAddress ?? '?');

  /**
   * Checks a password. Returns {ok: true, cookie} or {ok: false, wait} (wait = seconds this address is
   * locked, 0 when it may try again at once).
   */
  function login(req, given) {
    const peer = peerOf(req);
    const entry = fails.get(peer);
    if (entry && entry.until > now()) return { ok: false, wait: Math.ceil((entry.until - now()) / 1000) };
    if (enabled() && matches(given)) {
      fails.delete(peer);
      return { ok: true, cookie: sessionCookie(req) };
    }
    const count = (entry && entry.until > now() - LOCK_MS * 10 ? entry.count : 0) + 1;
    const locked = count >= MAX_FAILS;
    fails.set(peer, { count: locked ? 0 : count, until: locked ? now() + LOCK_MS : now() });
    if (fails.size > 10_000) for (const [k, v] of fails) if (v.until < now() - LOCK_MS * 10) fails.delete(k);
    return { ok: false, wait: locked ? LOCK_MS / 1000 : 0 };
  }

  /**
   * Sets (or changes) the password from the page. Returns {ok: true, cookie} (the caller is logged in
   * with the new password) or {ok: false, error}.
   */
  function setPassword(req, next, nextProtects = 'all') {
    if (password) return { ok: false, error: 'The password is set with HUB_PASSWORD in the compose file and can only be changed there.' };
    if (!file) return { ok: false, error: 'This hub has no place to keep a password.' };
    if (typeof next !== 'string' || next.length < MIN_PASSWORD_LENGTH) return { ok: false, error: `The password needs at least ${MIN_PASSWORD_LENGTH} characters.` };
    const salt = crypto.randomBytes(16);
    const record = { salt: salt.toString('hex'), hash: scrypt(next, salt).toString('hex'), protects: modeOf(nextProtects) };
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    } catch (err) {
      return { ok: false, error: `Cannot write ${file}: ${err.code ?? err.message}` };
    }
    stored = record;
    return { ok: true, cookie: sessionCookie(req) };
  }

  /** Removes a password that was set on the page: the hub is open again. */
  function removePassword(req) {
    if (password) return { ok: false, error: 'The password is set with HUB_PASSWORD in the compose file and can only be removed there.' };
    try {
      fs.rmSync(file, { force: true });
    } catch (err) {
      return { ok: false, error: `Cannot remove ${file}: ${err.code ?? err.message}` };
    }
    stored = null;
    return { ok: true, cookie: cookie(req, '', 0) };
  }

  return {
    get enabled() {
      return enabled();
    },
    get mode() {
      return mode();
    },
    get source() {
      return source();
    },
    canSet: Boolean(file) && !password,
    loggedIn,
    login,
    setPassword,
    removePassword,
    logoutCookie: (req) => cookie(req, '', 0)
  };
}

/** What the page may load without a login: the login page and what it is made of. */
export const PUBLIC_PATHS = new Set([
  '/login', '/login.html', '/login.js', '/i18n.js', '/theme.js', '/style.css', '/favicon.svg', '/healthz',
  // "install as app": browsers fetch these without the login cookie
  '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png', '/apple-touch-icon.png'
]);

/** Where to go after the login: only a path on this hub, never another site. */
export function safeNext(next) {
  return typeof next === 'string' && /^\/(?!\/)[\w\-./?=&%#]*$/.test(next) && !next.includes('\\') ? next : '/';
}
