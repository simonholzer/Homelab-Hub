import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { classifyResponse, probeHttp, probeTcp, runCheck } from '../src/checks.js';

let server;
let base;
const sockets = new Set();

before(async () => {
  server = http.createServer((req, res) => {
    switch (req.url) {
      case '/ok': return res.end('hello');
      case '/missing': res.statusCode = 404; return res.end('nope');
      case '/forbidden': res.statusCode = 403; return res.end();
      case '/err': res.statusCode = 500; return res.end();
      case '/cf-530': res.statusCode = 530; return res.end('error code: 1033');
      case '/redirect': res.writeHead(302, { location: '/ok' }); return res.end();
      case '/cf-login':
        res.writeHead(302, { location: 'https://example.cloudflareaccess.com/cdn-cgi/access/login/x?kid=1' });
        return res.end();
      case '/slow': return; // never answers
      default: res.statusCode = 200; return res.end();
    }
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  for (const s of sockets) s.destroy();
  server.close();
});

test('classifyResponse', () => {
  assert.equal(classifyResponse(200).status, 'up');
  assert.equal(classifyResponse(404).status, 'up');
  assert.equal(classifyResponse(401).status, 'up');
  assert.equal(classifyResponse(500).status, 'down');
  assert.equal(classifyResponse(530).status, 'down');
  assert.equal(classifyResponse(302, 'https://x.cloudflareaccess.com/login').status, 'unknown');
  assert.equal(classifyResponse(302, '/somewhere').status, 'up');
  assert.equal(classifyResponse(302, 'https://evil-cloudflareaccess.com.example.org/').status, 'up');
});

test('200, 404 and 403 count as online', async () => {
  for (const p of ['/ok', '/missing', '/forbidden']) {
    const r = await probeHttp({ url: base + p, timeoutMs: 2000 });
    assert.equal(r.status, 'up', p);
    assert.ok(r.ms >= 0);
  }
});

test('500 and Cloudflare 530 count as offline', async () => {
  const a = await probeHttp({ url: base + '/err', timeoutMs: 2000 });
  assert.deepEqual([a.status, a.code, a.detail], ['down', 500, 'HTTP 500']);
  const b = await probeHttp({ url: base + '/cf-530', timeoutMs: 2000 });
  assert.deepEqual([b.status, b.code], ['down', 530]);
});

test('redirects are not followed; a redirect to the Cloudflare login is "unknown", never green', async () => {
  const plain = await probeHttp({ url: base + '/redirect', timeoutMs: 2000 });
  assert.deepEqual([plain.status, plain.code], ['up', 302]);
  const login = await probeHttp({ url: base + '/cf-login', timeoutMs: 2000 });
  assert.equal(login.status, 'unknown');
  assert.match(login.detail, /Cloudflare login/);
});

test('a server that never answers times out', async () => {
  const started = Date.now();
  const r = await probeHttp({ url: base + '/slow', timeoutMs: 300 });
  assert.deepEqual([r.status, r.detail], ['down', 'Timed out']);
  assert.ok(Date.now() - started < 1500);
});

test('connection refused and DNS failure', async () => {
  const free = await new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
  const refused = await probeHttp({ url: `http://127.0.0.1:${free}/`, timeoutMs: 2000 });
  assert.deepEqual([refused.status, refused.detail], ['down', 'Connection refused']);
  const dns = await probeHttp({ url: 'http://does-not-exist.invalid/', timeoutMs: 3000 });
  assert.equal(dns.status, 'down');
});

test('tcp: open port is up, closed port is down', async () => {
  const port = server.address().port;
  assert.equal((await probeTcp({ host: '127.0.0.1', port, timeoutMs: 1000 })).status, 'up');
  const free = await new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port: p } = s.address();
      s.close(() => resolve(p));
    });
  });
  const closed = await probeTcp({ host: '127.0.0.1', port: free, timeoutMs: 1000 });
  assert.deepEqual([closed.status, closed.detail], ['down', 'Connection refused']);
});

test('runCheck dispatches and handles "no check"', async () => {
  assert.equal((await runCheck(null, 1000)).status, 'unknown');
  assert.equal((await runCheck({ type: 'http', url: base + '/ok' }, 1000)).status, 'up');
  assert.equal((await runCheck({ type: 'tcp', host: '127.0.0.1', port: server.address().port }, 1000)).status, 'up');
});
