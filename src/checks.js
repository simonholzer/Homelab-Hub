// Availability checks: HTTP(S) and TCP.
//
// Important: a service behind a login proxy (Cloudflare Access, Authelia, Authentik, ...) answers
// with a redirect to the login page even when the service itself is dead. So a redirect to
// *.cloudflareaccess.com, or to one of the hosts listed under settings.loginHosts, is reported as
// "unknown" (not green). Real checks should point at the service itself (http://server-ip:port).
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

const USER_AGENT = 'homelab-hub/1.0 (status check)';

/** Decides what an HTTP answer means. Exported for tests. */
export function classifyResponse(code, location, loginHosts = []) {
  if (code >= 500) return { status: 'down', detail: `HTTP ${code}` };
  if (code >= 300 && code < 400 && location) {
    let host = '';
    try {
      host = new URL(location, 'http://placeholder.invalid').hostname.toLowerCase();
    } catch {
      // not a valid URL: treat as an ordinary redirect
    }
    if (host === 'cloudflareaccess.com' || host.endsWith('.cloudflareaccess.com') || (host && loginHosts.includes(host))) {
      return { status: 'unknown', detail: 'Behind a login page: set a direct check (http://server-ip:port)' };
    }
  }
  return { status: 'up', detail: `HTTP ${code}` };
}

function describeError(err) {
  const code = err.code ?? '';
  if (code === 'ECONNREFUSED') return 'Connection refused';
  if (code === 'ETIMEDOUT' || err.message === 'timeout') return 'Timed out';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'DNS lookup failed';
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'Host unreachable';
  if (code === 'ECONNRESET') return 'Connection reset';
  if (/CERT|TLS|SSL|self[- ]signed/i.test(code + err.message)) return `TLS error (${code || err.message})`;
  return code || err.message || 'Failed';
}

export function probeHttp({ url, insecure = false, timeoutMs = 4000, loginHosts = [] }) {
  return new Promise((resolve) => {
    const started = performance.now();
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(hard);
      resolve({ ...result, ms: Math.round(performance.now() - started) });
    };
    const lib = url.startsWith('https:') ? https : http;
    let req;
    const hard = setTimeout(() => {
      finish({ status: 'down', detail: 'Timed out' });
      req?.destroy();
    }, timeoutMs);
    try {
      // No redirect following, no keep-alive: every check is a fresh, independent request.
      req = lib.request(
        url,
        {
          method: 'GET',
          agent: false,
          rejectUnauthorized: !insecure,
          headers: { 'user-agent': USER_AGENT, accept: '*/*' }
        },
        (res) => {
          const result = classifyResponse(res.statusCode ?? 0, res.headers.location, loginHosts);
          res.destroy(); // headers are enough, don't download the body
          finish({ ...result, code: res.statusCode });
        }
      );
      req.on('error', (err) => finish({ status: 'down', detail: describeError(err) }));
      req.end();
    } catch (err) {
      finish({ status: 'down', detail: describeError(err) });
    }
  });
}

export function probeTcp({ host, port, timeoutMs = 4000 }) {
  return new Promise((resolve) => {
    const started = performance.now();
    let settled = false;
    const socket = net.connect({ host, port });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ ...result, ms: Math.round(performance.now() - started) });
    };
    const timer = setTimeout(() => finish({ status: 'down', detail: 'Timed out' }), timeoutMs);
    socket.on('connect', () => finish({ status: 'up', detail: `Port ${port} open` }));
    socket.on('error', (err) => finish({ status: 'down', detail: describeError(err) }));
  });
}

/** Runs one normalized check (see config.js). `null` = no check configured. */
export function runCheck(check, timeoutMs) {
  if (!check) return Promise.resolve({ status: 'unknown', detail: 'No check configured', ms: null });
  if (check.type === 'tcp') return probeTcp({ host: check.host, port: check.port, timeoutMs });
  return probeHttp({ url: check.url, insecure: check.insecure, timeoutMs, loginHosts: check.loginHosts });
}
