import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyModel, describe, versionOf, fromOwnPage, directLink, iconNameFrom, checkSvg, downloadSvg } from '../src/editor.js';
import { createApp } from '../src/server.js';

const YAML = `# top comment
title: Hub
settings:
  timeoutSeconds: 4          # aligned comment
  home:
    publicIps: []
hosts:
  nas: 192.168.1.2
groups:
  - name: NAS
    services:
      # the photo app
      - name: Immich
        icon: immich
        url: https://immich.example.net     # public
        check: http://{nas}:30041

      # the media server
      - name: Jellyfin
        local: http://{nas}:8096

      # a note at the end of the list
  - name: Pi
    services:
      - name: Light
        url: https://light.example.net
`;

test('an unchanged model leaves the text exactly as it is', () => {
  const { model, errors } = describe(YAML);
  assert.deepEqual(errors, []);
  assert.equal(applyModel(YAML, model), YAML);
});

test('editing keeps comments, alignment and blank lines of everything untouched', () => {
  const { model } = describe(YAML);
  model.groups[0].services[0].name = 'Immich Photos'; // renamed: still the same entry
  model.groups[0].services.push({ name: 'New', local: 'http://{nas}:1' });
  model.settings.home.publicIps.push('1.2.3.4');
  const out = applyModel(YAML, model);
  assert.deepEqual(describe(out).errors, []);
  const expected = YAML.replace('name: Immich\n', 'name: Immich Photos\n')
    .replace('publicIps: []', 'publicIps: [ 1.2.3.4 ]')
    .replace('local: http://{nas}:8096\n', 'local: http://{nas}:8096\n\n      - name: New\n        local: http://{nas}:1\n');
  assert.equal(out, expected);
});

test('entries can be removed and reordered; their comments travel with them', () => {
  const { model } = describe(YAML);
  model.groups[0].services.reverse();
  model.groups.reverse();
  delete model.groups[1].services[1].check;
  const out = applyModel(YAML, model);
  const again = describe(out);
  assert.deepEqual(again.errors, []);
  assert.deepEqual(again.model.groups.map((g) => g.name), ['Pi', 'NAS']);
  assert.deepEqual(again.model.groups[1].services.map((s) => s.name), ['Jellyfin', 'Immich']);
  assert.ok(!out.includes('check:'));
  assert.match(out, /# the media server\n\s+- name: Jellyfin\n/); // moved up together with its entry
  assert.match(out, /services:\n\s+# the photo app\n/); // a comment above the first entry belongs to the list: it stays on top
  assert.match(out, /# top comment/);
  assert.match(out, /timeoutSeconds: 4 {10}# aligned comment/);
});

test('themes made in the form are written as valid YAML: # colors quoted, renames and removals kept', () => {
  const { model } = describe(YAML);
  model.themes = { mine: { name: 'Mine', base: 'nord', accent: '#ff6ac1' }, gone: { up: '#0f0' } };
  let out = applyModel(YAML, model);
  assert.match(out, /accent: "#ff6ac1"/);
  let again = describe(out);
  assert.deepEqual(again.errors, []);
  again.model.themes = { renamed: again.model.themes.mine };
  again.model.themes.renamed.panel = 'rgb(10, 20, 30)';
  out = applyModel(out, again.model);
  again = describe(out);
  assert.deepEqual(again.errors, []);
  assert.deepEqual(Object.keys(again.model.themes), ['renamed']);
  assert.equal(again.model.themes.renamed.accent, '#ff6ac1');
  assert.equal(again.model.themes.renamed.panel, 'rgb(10, 20, 30)');
  assert.match(out, /# top comment/);
});

test('a text with syntax errors has no model, only problems', () => {
  const d = describe('title: [oops\n');
  assert.equal(d.model, null);
  assert.match(d.errors[0], /YAML syntax error/);
  assert.throws(() => applyModel('title: [oops\n', {}));
});

test('only the hub page itself may change the config', () => {
  const req = (headers) => ({ headers: { 'content-type': 'application/json', host: 'hub.example.net', ...headers } });
  assert.equal(fromOwnPage(req({ 'sec-fetch-site': 'same-origin' })), true);
  assert.equal(fromOwnPage(req({ 'sec-fetch-site': 'cross-site' })), false);
  assert.equal(fromOwnPage(req({ origin: 'https://hub.example.net' })), true);
  assert.equal(fromOwnPage(req({ origin: 'https://evil.example' })), false);
  assert.equal(fromOwnPage({ headers: { 'content-type': 'text/plain', 'sec-fetch-site': 'same-origin' } }), false);
});

async function withServer(options, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-editor-'));
  const file = path.join(dir, 'services.yaml');
  fs.writeFileSync(file, YAML);
  const calls = { reload: 0, tick: 0 };
  const monitor = {
    readConfigFile: () => file,
    reloadConfig: () => calls.reload++,
    tick: async () => calls.tick++,
    snapshot: () => ({}),
    containers: () => ({})
  };
  const server = createApp({ monitor, publicDir: dir, ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, headers = { 'content-type': 'application/json' }) => {
    const res = await fetch(base + url, { method, headers: body ? headers : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  try {
    await run({ call, file, calls });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('API: read, preview, save with backup, and the refusals', async () => {
  await withServer({}, async ({ call, file, calls }) => {
    const got = await call('GET', '/api/config');
    assert.equal(got.status, 200);
    assert.equal(got.data.text, YAML);
    assert.equal(got.data.writable, true);
    assert.equal(got.data.version, versionOf(YAML));
    assert.equal((await call('GET', '/api/status')).data.editor, true);

    const model = got.data.model;
    model.title = 'New title';

    // preview: nothing is written
    const preview = await call('POST', '/api/config/render', { base: YAML, model });
    assert.equal(preview.status, 200);
    assert.match(preview.data.text, /^title: New title$/m);
    assert.equal(fs.readFileSync(file, 'utf8'), YAML);

    // a config with problems is not saved
    const bad = await call('PUT', '/api/config', { version: got.data.version, text: 'groups: nope\n' });
    assert.equal(bad.status, 422);
    assert.ok(bad.data.errors.length > 0);

    // not from the page (wrong content type) / stale version
    assert.equal((await call('PUT', '/api/config', { version: got.data.version, text: YAML }, { 'content-type': 'text/plain' })).status, 403);
    assert.equal((await call('PUT', '/api/config', { version: 'old', base: YAML, model })).status, 409);
    assert.equal(fs.readFileSync(file, 'utf8'), YAML);
    assert.equal(calls.reload, 0);

    const saved = await call('PUT', '/api/config', { version: got.data.version, base: YAML, model });
    assert.equal(saved.status, 200);
    assert.equal(fs.readFileSync(file, 'utf8'), YAML.replace('title: Hub', 'title: New title'));
    assert.equal(fs.readFileSync(`${file}.bak`, 'utf8'), YAML);
    assert.equal(saved.data.version, versionOf(fs.readFileSync(file, 'utf8')));
    assert.equal(calls.reload, 1);
    assert.equal(calls.tick, 1);
  });
});

test('icon links: GitHub page links become file links, names come from the file name', () => {
  assert.equal(
    directLink('https://github.com/homarr-labs/dashboard-icons/blob/main/svg/open-webui.svg'),
    'https://raw.githubusercontent.com/homarr-labs/dashboard-icons/main/svg/open-webui.svg'
  );
  assert.equal(directLink('https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/n8n.svg'), 'https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/n8n.svg');
  assert.equal(iconNameFrom('https://x.example/svg/Open%20WebUI.svg'), 'open-webui');
  assert.equal(iconNameFrom('https://x.example/'), null);
  assert.throws(() => checkSvg('<html>not found</html>'), /not an SVG/);
  assert.throws(() => checkSvg('<svg><script>alert(1)</script></svg>'), /scripts/);
  assert.throws(() => checkSvg('<svg onload="x()"></svg>'), /scripts/);
  checkSvg('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>');
});

test('icon download refuses anything but https links to public sites', async () => {
  await assert.rejects(downloadSvg('http://example.net/a.svg'), /https/);
  await assert.rejects(downloadSvg('https://192.168.1.1/a.svg'), /website/);
  await assert.rejects(downloadSvg('https://localhost/a.svg'), /website/);
});

test('API: an icon from a link is downloaded once, kept, listed and served', async () => {
  const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>';
  const asked = [];
  const iconsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-icons-'));
  const downloadIcon = async (url) => (asked.push(url), url.includes('bad') ? '<html></html>' : SVG);
  try {
    await withServer({ iconsDir, downloadIcon }, async ({ call }) => {
      const added = await call('POST', '/api/config/icon', { url: 'https://github.com/o/r/blob/main/svg/My-App.svg' });
      assert.equal(added.status, 200);
      assert.equal(added.data.name, 'my-app');
      assert.ok(added.data.icons['my-app']);
      assert.deepEqual(asked, ['https://raw.githubusercontent.com/o/r/main/svg/My-App.svg']);
      assert.equal(fs.readFileSync(path.join(iconsDir, 'my-app.svg'), 'utf8'), SVG);
      assert.ok((await call('GET', '/api/status')).data.icons['my-app']);

      const bad = await call('POST', '/api/config/icon', { url: 'https://x.example/bad.svg' });
      assert.equal(bad.status, 400);
      assert.match(bad.data.error, /not an SVG/);
      assert.ok(!fs.existsSync(path.join(iconsDir, 'bad.svg')));
      assert.equal((await call('POST', '/api/config/icon', { url: 'nonsense' })).status, 400);
      assert.equal((await call('POST', '/api/config/icon', { url: 'https://x.example/a.svg' }, { 'content-type': 'text/plain' })).status, 403);
    });
  } finally {
    fs.rmSync(iconsDir, { recursive: true, force: true });
  }
});

test('API: CONFIG_EDITOR=off closes it completely', async () => {
  await withServer({ editor: false }, async ({ call, file }) => {
    assert.equal((await call('GET', '/api/config')).status, 404);
    assert.equal((await call('PUT', '/api/config', { text: 'title: x\n' })).status, 405);
    assert.equal((await call('GET', '/api/status')).data.editor, false);
    assert.equal(fs.readFileSync(file, 'utf8'), YAML);
  });
});
