// Optional password login (HUB_PASSWORD). Off unless a password is set.
//
//   HUB_PASSWORD           the password. Empty or unset = no login (put the hub behind something else).
//   HUB_PASSWORD_PROTECTS  all (default): the whole page needs the login
//                          editor: everyone can see the page, only the config editor needs the login
//
// A login is remembered in a cookie that holds an expiry time signed with a key derived from the
// password: nothing is stored on the server, a restart keeps people logged in, and changing the
// password logs everyone out.
import crypto from 'node:crypto';

const COOKIE = 'hub_session';
const SESSION_DAYS = 30;
const MAX_FAILS = 5; // wrong passwords from one address ...
const LOCK_MS = 60_000; // ... before that address has to wait this long

const digest = (text) => crypto.createHash('sha256').update(text).digest();

/** @returns {null | {mode: 'all'|'editor', ...}} null when no password is set */
export function createAuth({ password = '', protects = 'all', now = () => Date.now() } = {}) {
  if (!password) return null;
  const mode = String(protects).toLowerCase() === 'editor' ? 'editor' : 'all';
  const key = digest(`homelab-hub session key\n${password}`);
  const wanted = digest(password);
  const fails = new Map(); // address -> {count, until}

  const sign = (expires) => crypto.createHmac('sha256', key).update(String(expires)).digest('base64url');

  function cookieOf(req) {
    for (const part of String(req.headers.cookie ?? '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
    }
    return '';
  }

  /** True when the request carries a valid, unexpired login. */
  function loggedIn(req) {
    const [expires, mac] = cookieOf(req).split('.');
    if (!expires || !mac || !/^\d+$/.test(expires) || Number(expires) < now()) return false;
    const good = Buffer.from(sign(expires));
    const got = Buffer.from(mac);
    return got.length === good.length && crypto.timingSafeEqual(got, good);
  }

  const isHttps = (req) => Boolean(req.socket?.encrypted) || String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https';
  const cookie = (req, value, maxAge) => `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;

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
    const right = crypto.timingSafeEqual(digest(String(given ?? '')), wanted);
    if (right) {
      fails.delete(peer);
      const expires = now() + SESSION_DAYS * 86_400_000;
      return { ok: true, cookie: cookie(req, `${expires}.${sign(expires)}`, SESSION_DAYS * 86_400) };
    }
    const count = (entry && entry.until > now() - LOCK_MS * 10 ? entry.count : 0) + 1;
    const locked = count >= MAX_FAILS;
    fails.set(peer, { count: locked ? 0 : count, until: locked ? now() + LOCK_MS : now() });
    if (fails.size > 10_000) for (const [k, v] of fails) if (v.until < now() - LOCK_MS * 10) fails.delete(k);
    return { ok: false, wait: locked ? LOCK_MS / 1000 : 0 };
  }

  return { mode, loggedIn, login, logoutCookie: (req) => cookie(req, '', 0) };
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
