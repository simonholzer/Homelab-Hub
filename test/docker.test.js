import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { normalizeContainer, summarizeContainers, wildcardToRegExp, listContainers } from '../src/docker.js';

// Shaped like Docker's GET /containers/json?all=1 on a TrueNAS (compose) host.
const RAW = [
  { Id: 'a1', Names: ['/ix-immich-server-1'], Image: 'ghcr.io/immich-app/immich-server', State: 'running', Status: 'Up 2 days (healthy)', Labels: { 'com.docker.compose.project': 'ix-immich', 'com.docker.compose.service': 'server' } },
  { Id: 'a2', Names: ['/ix-immich-postgres-1'], Image: 'postgres', State: 'running', Status: 'Up 2 days (healthy)', Labels: { 'com.docker.compose.project': 'ix-immich', 'com.docker.compose.service': 'postgres' } },
  { Id: 'a3', Names: ['/ix-immich-ml-1'], Image: 'immich-ml', State: 'running', Status: 'Up 2 days (unhealthy)', Labels: { 'com.docker.compose.project': 'ix-immich', 'com.docker.compose.service': 'ml' } },
  { Id: 'b1', Names: ['/ix-todo-sync-todo-sync-1'], Image: 'todo-sync:latest', State: 'running', Status: 'Up 3 hours (health: starting)', Labels: { 'com.docker.compose.project': 'ix-todo-sync', 'com.docker.compose.service': 'todo-sync' } },
  { Id: 'c1', Names: ['/ix-jellyfin-jellyfin-1'], Image: 'jellyfin/jellyfin', State: 'running', Status: 'Up 5 days', Labels: { 'com.docker.compose.project': 'ix-jellyfin' } },
  { Id: 'd1', Names: ['/ix-n8n-n8n-1'], Image: 'n8n', State: 'exited', Status: 'Exited (1) 2 hours ago', Labels: { 'com.docker.compose.project': 'ix-n8n' } },
  { Id: 'f1', Names: ['/ix-immich-permissions-1'], Image: 'bash', State: 'exited', Status: 'Exited (0) 3 days ago', Labels: { 'com.docker.compose.project': 'ix-immich', 'com.docker.compose.service': 'permissions' } },
  { Id: 'g1', Names: ['/ix-excalidash-backend-1'], Image: 'x', State: 'exited', Status: 'Exited (0) 1 hour ago', Labels: { 'com.docker.compose.project': 'ix-excalidash' } },
  { Id: 'e1', Names: ['/loop'], Image: 'x', State: 'restarting', Status: 'Restarting (1) 5 seconds ago', Labels: {} }
];
const CONTAINERS = RAW.map(normalizeContainer);

test('normalizeContainer derives health from the status text', () => {
  const by = Object.fromEntries(CONTAINERS.map((c) => [c.name, c.health]));
  assert.equal(by['ix-immich-server-1'], 'healthy');
  assert.equal(by['ix-immich-ml-1'], 'unhealthy');
  assert.equal(by['ix-todo-sync-todo-sync-1'], 'starting');
  assert.equal(by['ix-jellyfin-jellyfin-1'], 'running'); // no healthcheck in the image
  assert.equal(by['ix-n8n-n8n-1'], 'stopped');
  assert.equal(by['loop'], 'starting');
  assert.equal(CONTAINERS[0].project, 'ix-immich');
});

test('wildcards are whole-string and case-insensitive', () => {
  assert.ok(wildcardToRegExp('*immich*').test('ix-Immich-server-1'));
  assert.ok(!wildcardToRegExp('immich').test('ix-immich-server-1'));
  assert.ok(wildcardToRegExp('ix-immich').test('IX-immich'));
  assert.ok(!wildcardToRegExp('a.c').test('abc')); // dot is literal
});

test('summary takes the worst state and matches name, project or service', () => {
  const immich = summarizeContainers(['*immich*'], CONTAINERS);
  assert.equal(immich.state, 'unhealthy');
  assert.equal(immich.total, 3);
  assert.equal(immich.healthy, 2);

  assert.equal(summarizeContainers(['ix-todo-sync'], CONTAINERS).state, 'starting'); // by project
  assert.equal(summarizeContainers(['postgres'], CONTAINERS).state, 'healthy'); // by service name
  assert.equal(summarizeContainers(['*jellyfin*'], CONTAINERS).state, 'running');
  assert.equal(summarizeContainers(['*n8n*'], CONTAINERS).state, 'stopped');
});

test('a finished one-shot container (Exited (0)) does not turn the app red', () => {
  const by = Object.fromEntries(CONTAINERS.map((c) => [c.name, c.health]));
  assert.equal(by['ix-immich-permissions-1'], 'completed');
  // Immich is still "unhealthy" because of ml, not because of the permissions job: drop ml and it is healthy
  const withoutMl = CONTAINERS.filter((c) => c.name !== 'ix-immich-ml-1');
  const s = summarizeContainers(['*immich*'], withoutMl);
  assert.equal(s.state, 'healthy');
  assert.equal(s.total, 2, 'the permissions job is listed in items but not counted');
  assert.equal(s.items.length, 3);
  // ...but if the only matching container exited, the app is stopped
  assert.equal(summarizeContainers(['*excalidash*'], CONTAINERS).state, 'stopped');
});

test('no match reports "missing", not healthy', () => {
  assert.deepEqual(summarizeContainers(['*nothing*'], CONTAINERS), { state: 'missing', total: 0, items: [] });
});

test('listContainers talks to a (fake) Docker API over TCP', async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(RAW));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const list = await listContainers(`http://127.0.0.1:${server.address().port}`);
    assert.equal(list.length, RAW.length);
    assert.deepEqual(requests, ['GET /containers/json?all=1']); // read-only call only
    // tcp:// is accepted too
    assert.equal((await listContainers(`tcp://127.0.0.1:${server.address().port}`)).length, RAW.length);
  } finally {
    server.close();
  }
});

test('listContainers errors are readable', async () => {
  await assert.rejects(listContainers(''), /DOCKER_HOST/);
  await assert.rejects(listContainers('http://127.0.0.1:1'), /refused|ECONN/i);
  const server = http.createServer((req, res) => {
    res.statusCode = 403;
    res.end('forbidden by proxy');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    await assert.rejects(listContainers(`http://127.0.0.1:${server.address().port}`), /HTTP 403/);
  } finally {
    server.close();
  }
});
