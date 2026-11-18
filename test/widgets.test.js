import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { parseValue, readValue, normalizeWidgets, parseWidgetsText, resolveWidget, widgetRef, requestJson, runWidget, WIDGETS_STARTER } from '../src/widgets.js';
import { normalizeConfig, servicesFromLabels } from '../src/config.js';
import { Monitor } from '../src/monitor.js';
import { createApp } from '../src/server.js';
import { applyModel, describe, versionOf, answerPaths } from '../src/editor.js';

const ANSWER = {
  photos: 48213,
  usage: 442368000000,
  name: 'immich',
  ok: true,
  nothing: null,
  data: { stats: { total: '12' } },
  users: [{ name: 'a', photos: 10, playing: { title: 'x' } }, { name: 'b', photos: 5 }, { name: 'c', photos: '7' }]
};

test('values are read from the answer by path, with count/sum/min/max/avg', () => {
  assert.deepEqual(readValue(ANSWER, 'photos'), { value: 48213 });
  assert.deepEqual(readValue(ANSWER, 'data.stats.total'), { value: '12' });
  assert.deepEqual(readValue(ANSWER, 'users.1.name'), { value: 'b' });
  assert.deepEqual(readValue(ANSWER, 'users[0].name'), { value: 'a' });
  assert.deepEqual(readValue(ANSWER, 'users.length'), { value: 3 });
  assert.deepEqual(readValue(ANSWER, 'count(users)'), { value: 3 });
  assert.deepEqual(readValue(ANSWER, 'count(users.*.playing)'), { value: 1 });
  assert.deepEqual(readValue(ANSWER, 'sum(users.*.photos)'), { value: 22 });
  assert.deepEqual(readValue(ANSWER, 'max(users.*.photos)'), { value: 10 });
  assert.deepEqual(readValue(ANSWER, 'min(users.*.photos)'), { value: 5 });
  assert.deepEqual(readValue(ANSWER, 'count(data.stats)'), { value: 1 }, 'an object counts its entries');
  assert.deepEqual(readValue([1, 2, 3], 'count(.)'), { value: 3 }, 'the answer itself can be a list');
  assert.deepEqual(readValue(ANSWER, 'ok'), { value: 'yes' });
  assert.deepEqual(readValue(ANSWER, 'nothing'), { value: '–' });
});

test('values that cannot be shown say why', () => {
  assert.match(readValue(ANSWER, 'missing').error, /not in the answer/);
  assert.match(readValue(ANSWER, 'users').error, /is a list; use count\(users\)/);
  assert.match(readValue(ANSWER, 'data').error, /pick one inside it/);
  assert.match(readValue(ANSWER, 'users.*.name').error, /is a list/);
  assert.match(readValue(ANSWER, 'sum(photos)').error, /not a list/);
  assert.match(parseValue('median(x)').error, /unknown/);
  assert.match(parseValue('').error, /needs a value/);
  assert.match(parseValue('a..b').error, /empty part/);
});

test('widgets.yaml is validated with readable errors', () => {
  const ok = normalizeWidgets({ immich: { path: '/api/server/statistics', headers: { 'x-api-key': '{env:KEY}' }, fields: [{ label: 'Photos', value: 'photos', format: 'number' }] } });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.widgets.immich.fields[0].format, 'number');

  const bad = normalizeWidgets({
    'bad name!': { fields: [] },
    a: { path: '/x', url: 'http://y', fields: [{ value: 'x' }] },
    b: { url: 'ftp://x', fields: [{ value: 'x', format: 'fancy', colour: 1 }] },
    c: { path: '/x', body: 'x', fields: [{ value: 'x' }] },
    d: { path: '/x' },
    e: { path: '/x', typo: 1, fields: [{ value: 'count(' }] }
  });
  const text = bad.errors.join('\n');
  assert.match(text, /bad name!: a widget name/);
  assert.match(text, /a: give either path .* or url/);
  assert.match(text, /b\.url: must be a full http/);
  assert.match(text, /b\.fields\[0\]\.format: must be one of/);
  assert.match(text, /b\.fields\[0\]\.colour: unknown key/);
  assert.match(text, /c\.body: only a POST request/);
  assert.match(text, /d\.fields: needs a list/);
  assert.match(text, /e\.typo: unknown key/);
  assert.match(text, /e\.fields\[0\]\.value/);

  assert.deepEqual(parseWidgetsText(null), { widgets: {}, errors: [] });
  assert.deepEqual(parseWidgetsText(WIDGETS_STARTER), { widgets: {}, errors: [] }, 'only comments: no widgets');
  assert.match(parseWidgetsText('a: [oops').errors[0], /YAML syntax error/);
});

test('a card resolves its widget: path on its address, placeholders from the card, env and hosts', () => {
  const { widgets } = normalizeWidgets({
    immich: { path: '/api/stats', headers: { 'x-api-key': '{env:KEY}', 'x-user': '{user}' }, fields: [{ value: 'photos' }] },
    full: { url: 'http://{nas}:9000/api', fields: [{ value: 'x' }] }
  });
  const errors = [];
  const ref = widgetRef({ use: 'immich', user: 'simon' }, 'card', errors);
  const r = resolveWidget(ref, widgets.immich, { base: 'http://10.0.0.2:2283/', hosts: {}, env: { KEY: 'secret' } }, 'card', errors);
  assert.deepEqual(errors, []);
  assert.equal(r.request.url, 'http://10.0.0.2:2283/api/stats');
  assert.deepEqual(r.request.headers, { 'x-api-key': 'secret', 'x-user': 'simon' });

  const full = resolveWidget(widgetRef('full', 'card', errors), widgets.full, { base: '', hosts: { nas: '10.0.0.2' }, env: {} }, 'card', errors);
  assert.equal(full.request.url, 'http://10.0.0.2:9000/api');

  // a missing environment variable is the card's problem, not a config error
  const noEnv = resolveWidget(widgetRef({ use: 'immich', user: 'u' }, 'card', errors), widgets.immich, { base: 'http://x', hosts: {}, env: {} }, 'card', errors);
  assert.deepEqual(errors, []);
  assert.match(noEnv.problem, /Not set on the hub: KEY/);

  const errs2 = [];
  resolveWidget(widgetRef('immich', 'card', errs2), widgets.immich, { base: 'http://x', hosts: {}, env: { KEY: 'k' } }, 'card', errs2);
  assert.match(errs2[0], /unknown placeholder \{user\}/);
});

test('cards in the config use widgets by name; unknown ones are errors', () => {
  const { widgets } = normalizeWidgets({ immich: { path: '/api', fields: [{ value: 'photos' }] } });
  const raw = { hosts: { nas: '10.0.0.2' }, groups: [{ name: 'NAS', services: [{ name: 'Immich', local: 'http://{nas}:2283', url: 'https://photos.example.com', widget: 'immich' }] }] };
  const { config, errors } = normalizeConfig(raw, { widgets });
  assert.deepEqual(errors, []);
  assert.equal(config.groups[0].services[0].widget.request.url, 'http://10.0.0.2:2283/api', 'the home address is asked first');

  const bad = normalizeConfig({ groups: [{ name: 'G', services: [{ name: 'X', url: 'http://x', widget: 'nope' }] }] }, { widgets });
  assert.match(bad.errors[0], /there is no widget "nope" in widgets\.yaml \(there are: immich\)/);
  assert.match(normalizeConfig({ groups: [{ name: 'G', services: [{ name: 'X', url: 'http://x', widget: 5 }] }] }).errors[0], /X\.widget: must be the name/);
  assert.equal(normalizeConfig({ groups: [{ name: 'G', services: [{ name: 'X', url: 'http://x', widget: 'none' }] }] }).config.groups[0].services[0].widget, undefined);

  // Docker labels: homelab-hub.widget
  const made = servicesFromLabels([{ name: 'immich-1', labels: { url: 'http://10.0.0.2:2283', widget: 'immich' } }], config);
  assert.deepEqual(made.errors, []);
  assert.equal(made.groups[0].services[0].widget.request.url, 'http://10.0.0.2:2283/api');
});

test('requestJson asks the API and explains what went wrong', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/ok') return res.end(JSON.stringify({ n: 1, got: req.headers['x-api-key'] ?? null, method: req.method }));
    if (req.url === '/post') {
      let body = '';
      req.on('data', (c) => (body += c));
      return req.on('end', () => res.end(JSON.stringify({ body, type: req.headers['content-type'] })));
    }
    if (req.url === '/html') return res.end('<html>');
    if (req.url === '/login') {
      res.writeHead(302, { location: 'https://auth.example.com/' });
      return res.end();
    }
    if (req.url === '/slow') return setTimeout(() => res.end('{}'), 500);
    res.writeHead(req.url === '/key' ? 401 : 404);
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.deepEqual(await requestJson({ url: `${base}/ok`, headers: { 'x-api-key': 'k' } }), { data: { n: 1, got: 'k', method: 'GET' } });
    assert.deepEqual(await requestJson({ url: `${base}/post`, method: 'POST', body: '{"a":1}' }), { data: { body: '{"a":1}', type: 'application/json' } });
    assert.match((await requestJson({ url: `${base}/html` })).error, /not JSON/);
    assert.match((await requestJson({ url: `${base}/key` })).error, /HTTP 401: the API key/);
    assert.match((await requestJson({ url: `${base}/nope` })).error, /HTTP 404/);
    assert.match((await requestJson({ url: `${base}/login` })).error, /redirected to auth\.example\.com/);
    assert.match((await requestJson({ url: `${base}/slow` }, 100)).error, /Timed out/);
    assert.match((await requestJson({ url: 'http://127.0.0.1:1/' })).error, /Connection refused/);

    const widget = { request: { url: `${base}/ok` }, fields: [{ label: 'N', value: 'n', format: 'number' }, { label: 'Bad', value: 'x', format: 'auto' }] };
    const r = await runWidget(widget, 2000);
    assert.deepEqual(r.fields[0], { label: 'N', format: 'number', value: 1 });
    assert.match(r.fields[1].error, /not in the answer/);
    assert.deepEqual(await runWidget({ ...widget, problem: 'Not set on the hub: X' }, 2000), { error: 'Not set on the hub: X' });
  } finally {
    server.close();
  }
});

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hub-widgets-'));
}

test('the monitor reads widgets.yaml next to the config, asks the widgets and keeps keys off the page', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'services.yaml');
  fs.writeFileSync(file, 'groups:\n  - name: G\n    services:\n      - { name: Immich, local: "http://10.0.0.2:2283", check: none, widget: immich }\n');
  const asked = [];
  const m = new Monitor({
    configPath: file,
    check: async () => ({ status: 'up' }),
    statsReader: { read: async () => null },
    env: { KEY: 'secret' },
    widget: async (w) => (asked.push(w.request), { fields: [{ label: 'Photos', value: 5, format: 'number' }] })
  });
  try {
    await m.tick();
    assert.match(m.snapshot().configError.lines[0], /no widget "immich"/, 'no widgets.yaml yet: the card asks for one that is not there');

    fs.writeFileSync(path.join(dir, 'widgets.yaml'), 'immich:\n  path: /api\n  headers: { x-api-key: "{env:KEY}" }\n  fields:\n    - { label: Photos, value: photos }\n');
    await m.tick();
    const snap = m.snapshot();
    assert.equal(snap.configError, null);
    assert.deepEqual(asked.at(-1), { url: 'http://10.0.0.2:2283/api', method: 'GET', headers: { 'x-api-key': 'secret' }, insecure: false });
    const svc = snap.groups[0].services[0];
    assert.deepEqual(svc.widget.fields, [{ label: 'Photos', value: 5, format: 'number' }]);
    assert.doesNotMatch(JSON.stringify(snap), /secret|x-api-key|\/api/, 'the address and key stay on the hub');

    fs.writeFileSync(path.join(dir, 'widgets.yaml'), 'immich: [oops');
    await m.tick();
    assert.match(m.snapshot().configError.lines[0], /^widgets\.yaml: YAML syntax error/);
    assert.equal(m.snapshot().groups[0].services[0].name, 'Immich', 'the last good config stays');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('editor: widgets.yaml is read, checked, created and saved through ?file=widgets', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'services.yaml');
  const widgetsFile = path.join(dir, 'widgets.yaml');
  const services = 'hosts:\n  nas: 10.0.0.2\ngroups:\n  - name: G\n    services:\n      - name: Immich\n        local: http://{nas}:2283\n';
  fs.writeFileSync(file, services);
  const monitor = { readConfigFile: () => file, widgetsPath: widgetsFile, reloadConfig: () => {}, tick: async () => {}, snapshot: () => ({}), containers: () => ({}) };
  const server = createApp({ monitor, publicDir: dir });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  try {
    // not there yet: the explaining comments, an empty form, the version of an empty file
    const got = await call('GET', '/api/config?file=widgets');
    assert.equal(got.status, 200);
    assert.equal(got.data.kind, 'widgets');
    assert.equal(got.data.text, WIDGETS_STARTER);
    assert.deepEqual(got.data.model, {});
    assert.equal(got.data.version, versionOf(''));
    assert.equal(got.data.writable, true);

    const model = { immich: { path: '/api', fields: [{ label: 'Photos', value: 'photos' }] } };
    const rendered = await call('POST', '/api/config/render?file=widgets', { base: got.data.text, model });
    assert.deepEqual(rendered.data.errors, []);
    assert.match(rendered.data.text, /^# Widgets:[\s\S]*\nimmich:\n  path: \/api\n/, 'the comments stay on top');
    assert.match((await call('POST', '/api/config/render?file=widgets', { text: 'x: { fields: 1 }' })).data.errors[0], /x\.fields/);

    // the config is checked against the widgets being edited next to it, else against the saved ones
    const withWidget = services.replace('2283\n', '2283\n        widget: immich\n');
    assert.match((await call('POST', '/api/config/render', { text: withWidget })).data.errors[0], /no widget "immich"/);
    assert.deepEqual((await call('POST', '/api/config/render', { text: withWidget, widgets: { base: got.data.text, model } })).data.errors, []);

    const saved = await call('PUT', '/api/config?file=widgets', { base: got.data.text, model, version: got.data.version });
    assert.equal(saved.status, 200);
    assert.equal(fs.readFileSync(widgetsFile, 'utf8'), rendered.data.text);
    assert.deepEqual((await call('POST', '/api/config/render', { text: withWidget })).data.errors, [], 'now the saved widget counts');
    assert.equal((await call('PUT', '/api/config?file=widgets', { text: 'immich: [oops', version: saved.data.version })).status, 422);
    assert.equal((await call('PUT', '/api/config?file=widgets', { text: 'a: 1\n', version: got.data.version })).status, 409);
  } finally {
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('editor: Test asks the API the way the card would and lists what the answer has', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'services.yaml');
  fs.writeFileSync(file, 'hosts:\n  nas: 10.0.0.2\n');
  const asked = [];
  const monitor = { readConfigFile: () => file, widgetsPath: path.join(dir, 'widgets.yaml'), reloadConfig: () => {}, tick: async () => {}, snapshot: () => ({}), containers: () => ({}) };
  const server = createApp({ monitor, publicDir: dir });
  // the API is replaced through the config API's request option: build one by hand
  const { createConfigApi } = await import('../src/editor.js');
  const api = createConfigApi({ getFile: () => file, getWidgetsFile: () => monitor.widgetsPath, env: { KEY: 'k' }, request: async (req) => (asked.push(req), { data: ANSWER }) });
  server.removeAllListeners('request');
  server.on('request', (req, res) => api(req, res, new URL(req.url, 'http://x').pathname, (r, status, body) => (r.writeHead(status, { 'content-type': 'application/json' }), r.end(JSON.stringify(body)))));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const post = async (body) => (await fetch(`http://127.0.0.1:${server.address().port}/api/config/widget-test`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  try {
    const r = await post({ widget: { path: '/api', headers: { 'x-api-key': '{env:KEY}' }, fields: [{ label: 'Photos', value: 'photos' }, { label: 'Users', value: 'count(users)' }] }, service: { local: 'http://{nas}:2283' } });
    assert.equal(r.ok, true);
    assert.equal(r.url, 'http://10.0.0.2:2283/api');
    assert.deepEqual(asked[0].headers, { 'x-api-key': 'k' });
    assert.deepEqual(r.fields.map((f) => f.value), [48213, 3]);
    assert.ok(r.paths.some((p) => p.path === 'count(users)' && p.value === 3));
    assert.ok(r.paths.some((p) => p.path === 'users.0.playing.title'));
    assert.match(r.answer, /"photos": 48213/);

    // the form's own (unsaved) host shortcuts win
    await post({ widget: { path: '/api', fields: [{ value: 'photos' }] }, service: { local: 'http://{nas}:1' }, hosts: { nas: '10.9.9.9' } });
    assert.equal(asked.at(-1).url, 'http://10.9.9.9:1/api');

    assert.match((await post({ widget: { path: '/api', fields: [] }, service: {} })).error, /fields/);
    assert.match((await post({ widget: { path: '/api', fields: [{ value: 'x' }] }, service: {} })).error, /needs an address/);
    assert.match((await post({ widget: { path: '/api', headers: { a: '{env:NOPE}' }, fields: [{ value: 'x' }] }, service: { url: 'http://x' } })).error, /Not set on the hub: NOPE/);
  } finally {
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('answerPaths lists values and lists of an answer', () => {
  const paths = answerPaths(ANSWER);
  assert.ok(paths.some((p) => p.path === 'photos' && p.value === 48213));
  assert.ok(paths.some((p) => p.path === 'data.stats.total'));
  assert.ok(paths.some((p) => p.path === 'count(users)' && p.value === 3));
  assert.ok(!paths.some((p) => p.path.startsWith('users.1')), 'only the first entry of a list');
  assert.deepEqual(answerPaths([1, 2])[0], { path: 'count(.)', value: 2 });
});

test('a widgets.yaml with only comments takes its first widget below them', () => {
  const out = applyModel(WIDGETS_STARTER, { a: { path: '/x', fields: [{ value: 'n' }] } });
  assert.ok(out.startsWith(WIDGETS_STARTER));
  assert.deepEqual(describe(out, { kind: 'widgets' }).errors, []);
});

test('the example widgets.yaml is valid', () => {
  const text = fs.readFileSync(new URL('../config/widgets.yaml', import.meta.url), 'utf8');
  const { widgets, errors } = parseWidgetsText(text);
  assert.deepEqual(errors, []);
  assert.ok(Object.keys(widgets).length >= 3);
});

test('ready-made widgets: each is valid, and cards find theirs by icon, name or containers', async () => {
  const { WIDGET_TEMPLATES, templateFor, templatesForEditor } = await import('../src/widget-templates.js');
  for (const tpl of WIDGET_TEMPLATES) {
    assert.deepEqual(normalizeWidgets({ [tpl.id]: tpl.widget }).errors, [], tpl.id);
    assert.ok(JSON.stringify(tpl.widget).includes(`{env:${tpl.env}}`), `${tpl.id} uses its key`);
  }
  assert.equal(templateFor({ icon: 'immich', name: 'Photos' }).id, 'immich');
  assert.equal(templateFor({ name: 'Home Assistant' }).id, 'home-assistant');
  assert.equal(templateFor({ name: 'Media', containers: ['*jellyfin*'] }).id, 'jellyfin');
  assert.equal(templateFor({ name: 'Router' }), null);
  const listed = templatesForEditor({ IMMICH_API_KEY: 'k' });
  assert.equal(listed.find((t) => t.id === 'immich').keySet, true);
  assert.equal(listed.find((t) => t.id === 'jellyfin').keySet, false);
  assert.doesNotMatch(JSON.stringify(listed), /"k"/, 'never the key itself');
});

test('widget tiles: in a group (type: widget) and in the widget row (tiles:)', () => {
  const { widgets } = normalizeWidgets({ immich: { name: 'Immich stats', path: '/api', fields: [{ value: 'photos' }] } });
  const raw = {
    hosts: { nas: '10.0.0.2' },
    tiles: [{ widget: 'immich', local: 'http://{nas}:2283' }, { name: 'Off', widget: 'immich', hidden: true }],
    groups: [{ name: 'NAS', services: [{ name: 'Immich', url: 'https://p.example.com' }, { type: 'widget', name: 'Photos', widget: 'immich', url: 'https://p.example.com' }] }]
  };
  const { config, errors } = normalizeConfig(raw, { widgets });
  assert.deepEqual(errors, []);
  assert.equal(config.tiles.length, 1);
  assert.equal(config.tiles[0].name, 'Immich stats', 'no name: the widget\'s');
  assert.equal(config.tiles[0].tile, true);
  assert.equal(config.tiles[0].widget.request.url, 'http://10.0.0.2:2283/api');
  assert.equal(config.tiles[0].check, null);
  const tile = config.groups[0].services[1];
  assert.equal(tile.tile, true);
  assert.equal(tile.widget.request.url, 'https://p.example.com/api');

  const bad = normalizeConfig({ tiles: [{ name: 'X' }, { type: 'card', name: 'Y', widget: 'immich' }], groups: [{ name: 'G', services: [{ type: 'box', name: 'Z', url: 'http://z' }, { type: 'widget' }] }] }, { widgets });
  const text = bad.errors.join('\n');
  assert.match(text, /tiles\[0\] \(X\): a widget tile needs a widget/);
  assert.match(text, /tiles\[1\]: only widget tiles go into the widget row/);
  assert.match(text, /services\[0\]\.type: must be card/);
  assert.match(text, /services\[1\]: a widget tile needs a widget/);
});

test('the monitor asks the widgets of tiles and the page gets them without a status dot', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'services.yaml');
  fs.writeFileSync(file, 'tiles:\n  - { name: Top, widget: w, local: "http://10.0.0.2" }\ngroups:\n  - name: G\n    services:\n      - { type: widget, name: In group, widget: w, local: "http://10.0.0.3" }\n');
  fs.writeFileSync(path.join(dir, 'widgets.yaml'), 'w:\n  path: /api\n  fields: [{ label: N, value: n }]\n');
  const asked = [];
  const m = new Monitor({ configPath: file, check: async () => ({ status: 'up' }), statsReader: { read: async () => null }, widget: async (w) => (asked.push(w.request.url), { fields: [{ label: 'N', value: 1 }] }) });
  try {
    await m.tick();
    const snap = m.snapshot();
    assert.equal(snap.configError, null);
    assert.deepEqual(asked.sort(), ['http://10.0.0.2/api', 'http://10.0.0.3/api']);
    assert.equal(snap.tiles[0].name, 'Top');
    assert.equal(snap.tiles[0].tile, true);
    assert.equal(snap.tiles[0].status, 'none');
    assert.equal(snap.tiles[0].widget.fields[0].value, 1);
    assert.equal(snap.groups[0].services[0].tile, true);
    assert.equal(snap.summary.total, 0, 'tiles are not counted as online or offline');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
