// "Am I on the home network?" decided on the server, per request.
//
//   1. A request that did NOT come through a proxy (no visitor-address header) and whose
//      peer is a private/loopback address was made directly on the LAN  ->  home.
//      (Requests through a tunnel or proxy also have a private peer, so the header, not the peer,
//      tells the two apart.) The header is Cloudflare's CF-Connecting-IP, plus the one named in
//      settings.home.clientIpHeader for other reverse proxies (x-forwarded-for, x-real-ip).
//      X-Forwarded-For is ignored unless it is named there.
//   2. A request through a proxy is "home" when the visitor's address is a private one (a proxy
//      on the LAN), or when the visitor's public IP equals the server's own public IP (looked up
//      via Cloudflare's trace page) or one listed in settings.home.publicIps.
//   3. Anything else is "away". The page also has a manual Auto / Home / Away switch, because
//      public-IP matching can be wrong (VPN, a second internet line, IPv6).
//
// The browser can't probe the LAN address itself: an https page may not call http://192.168.x.x.
import net from 'node:net';

/** Strips brackets, zone ids and the ::ffff: prefix of IPv4-mapped addresses; lower-cases. */
export function normalizeIp(ip) {
  let s = String(ip ?? '').trim().toLowerCase();
  if (s.startsWith('[') && s.includes(']')) s = s.slice(1, s.indexOf(']'));
  s = s.replace(/%.*$/, '');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  return mapped ? mapped[1] : s;
}

export function isPrivateAddress(ip) {
  const s = normalizeIp(ip);
  if (net.isIPv4(s)) {
    const [a, b] = s.split('.').map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (net.isIPv6(s)) return s === '::1' || /^f[cd]/.test(s) || /^fe[89ab]/.test(s);
  return false;
}

/** First 64 bits of an IPv6 address as 4 hex groups. */
function ipv6Prefix64(s) {
  const [head, tail = ''] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return groups.slice(0, 4).map((g) => g.padStart(4, '0')).join(':');
}

/** IPv4: exact match. IPv6: same /64 (a household shares one prefix). */
export function samePublicAddress(a, b) {
  const x = normalizeIp(a);
  const y = normalizeIp(b);
  if (net.isIPv4(x) && net.isIPv4(y)) return x === y;
  if (net.isIPv6(x) && net.isIPv6(y)) return ipv6Prefix64(x) === ipv6Prefix64(y);
  return false;
}

export function parseTrace(text) {
  const m = /^ip=(\S+)$/m.exec(text);
  return m ? normalizeIp(m[1]) : null;
}

/** The server's own public IPv4, as seen by Cloudflare. */
export async function lookupPublicIp() {
  const res = await fetch('https://1.1.1.1/cdn-cgi/trace', { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ip = parseTrace(await res.text());
  if (!ip) throw new Error('no ip= line in the answer');
  return ip;
}

export class HomeNetwork {
  /**
   * @param {object} [o]
   * @param {() => Promise<string>} [o.lookup]  returns the server's public IP
   * @param {() => string[]} [o.getExtraIps]    extra "home" IPs from the YAML (read on every request)
   * @param {number} [o.intervalMs]
   */
  constructor({ lookup = lookupPublicIp, getExtraIps = () => [], getRunsAtHome = () => true, getClientIpHeader = () => '', intervalMs = 10 * 60 * 1000 } = {}) {
    this.getClientIpHeader = getClientIpHeader;
    this.lookup = lookup;
    this.getExtraIps = getExtraIps;
    this.getRunsAtHome = getRunsAtHome;
    this.intervalMs = intervalMs;
    this.publicIp = null;
    this.lookupError = null;
    this.timer = null;
  }

  async refresh() {
    try {
      this.publicIp = await this.lookup();
      this.lookupError = null;
    } catch (err) {
      this.lookupError = err.message; // keep the last known address
    }
  }

  start() {
    this.refresh();
    this.timer = setInterval(() => this.refresh(), this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
  }

  /** @returns {{home: boolean|null, via: string, reason: string, clientIp: string|null, serverIp: string|null}} */
  detect(req) {
    const serverIp = this.publicIp;
    const runsAtHome = this.getRunsAtHome();
    const extraHeader = this.getClientIpHeader();
    const cf = req.headers['cf-connecting-ip'] ?? (extraHeader ? req.headers[extraHeader] : undefined);
    if (cf) {
      const clientIp = normalizeIp(String(cf).split(',')[0]);
      if (isPrivateAddress(clientIp) && runsAtHome) {
        return { home: true, via: 'proxy-lan', clientIp, serverIp, reason: 'You reached the hub through a proxy from an address on the home network' };
      }
      // When the hub itself is not at home (laptop preview), its own public IP says nothing about home.
      const known = [runsAtHome ? serverIp : null, ...this.getExtraIps()].filter(Boolean);
      if (known.length === 0) {
        return { home: null, via: 'unknown', clientIp, serverIp, reason: "Reached through a proxy, and the hub doesn't know the server's public address yet" + (this.lookupError ? ` (${this.lookupError})` : '') };
      }
      const home = known.some((ip) => samePublicAddress(clientIp, ip));
      return {
        home,
        via: 'public-ip',
        clientIp,
        serverIp,
        reason: home
          ? `Your public IP (${clientIp}) is the server's: you are on the home network`
          : `Your public IP (${clientIp}) differs from the server's (${known.join(', ')}). If you are at home, use the switch, or add your IP under settings.home.publicIps`
      };
    }
    const peer = normalizeIp(req.socket?.remoteAddress);
    if (isPrivateAddress(peer) && !runsAtHome) {
      // The visitor sits on the same network as this machine, which is not the home network:
      // it is home only when this machine's public IP is one of the listed home IPs.
      const extra = this.getExtraIps();
      const home = Boolean(serverIp) && extra.some((ip) => samePublicAddress(serverIp, ip));
      return {
        home,
        via: 'server-network',
        clientIp: peer,
        serverIp,
        reason: home
          ? `This computer's public IP (${serverIp}) is a home IP: you are on the home network`
          : `The hub runs on a network${serverIp ? ` with the public IP ${serverIp}` : ''} that is not a home IP (settings.home.publicIps), so this counts as away`
      };
    }
    if (isPrivateAddress(peer)) {
      return { home: true, via: 'direct', clientIp: peer, serverIp, reason: 'You opened the hub directly on the home network' };
    }
    return { home: false, via: 'direct-public', clientIp: peer, serverIp, reason: `Direct connection from the public address ${peer}` };
  }
}
