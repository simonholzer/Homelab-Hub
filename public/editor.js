// The config editor: a dialog that edits config/services.yaml as a form (or as plain YAML text).
// Opened from the gear menu (app.js loads this file on the first click). The server does the YAML work
// (src/editor.js): this page only edits a copy of the parsed file and sends it back.
// All text goes in through textContent / input values (config values are never HTML).
import { t, hasText, LANGUAGES } from '/i18n.js';

const ID = '__i'; // position marker the server puts on list entries; kept as it is
const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  up: 'M6 15l6-6 6 6',
  down: 'M6 9l6 6 6-6',
  chev: 'M9 6l6 6-6 6',
  plus: 'M12 5v14M5 12h14',
  x: 'M6 6l12 12M18 6L6 18',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  grip: 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01'
};
const NO_CHECK = ['none', 'off', 'no', 'false'];

const isObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const asList = (v) => (v == null || v === false ? [] : Array.isArray(v) ? v.map(String) : [String(v)]);

/** The fixed texts of the form are translated in h(), in one place; texts from the config go in as rawText. */
const TRANSLATED = new Set(['title', 'aria-label', 'placeholder']);
const tr = (v) => (typeof v === 'string' && hasText(v) ? t(v) : v);

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = tr(v);
    else if (k === 'rawText') el.textContent = v;
    else if (TRANSLATED.has(k)) el.setAttribute(k, tr(v));
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c);
  return el;
}

function svg(name, size = 16) {
  const el = document.createElementNS(SVG_NS, 'svg');
  el.setAttribute('viewBox', '0 0 24 24');
  el.setAttribute('width', size);
  el.setAttribute('height', size);
  el.setAttribute('aria-hidden', 'true');
  el.classList.add('cfg-ic');
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', ICONS[name]);
  el.append(p);
  return el;
}

function iconBtn(icon, label, onClick, o = {}) {
  const b = h('button', { type: 'button', class: `cfg-ib${o.danger ? ' danger' : ''}`, title: label, 'aria-label': label, disabled: o.disabled }, svg(icon));
  b.addEventListener('click', onClick);
  return b;
}

function textBtn(icon, label, onClick, cls = '') {
  const b = h('button', { type: 'button', class: `cfg-btn ${cls}` }, icon ? svg(icon, 14) : null, h('span', { text: label }));
  b.addEventListener('click', onClick);
  return b;
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    cache: 'no-store',
    redirect: 'manual',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: typeof body === 'string' ? body : body ? JSON.stringify(body) : undefined
  });
  if (res.type === 'opaqueredirect' || res.status === 401) throw new Error(t('Your login has expired. Reload the page and log in again.'));
  let data = null;
  try {
    data = await res.json();
  } catch {
    // not JSON: handled below
  }
  if (!data) throw new Error(t('The hub answered with an error ({status}).', { status: res.status }));
  return { status: res.status, data };
}

// ---- state ----
let st = null; // {version, base, model, text, file, writable, icons, errors, saved, open, tab, note, busy}
let dlg = null;
const ui = {};
let validateTimer = null;
let validateRun = 0;
let validated = ''; // the state the hub checked last: the same state is not sent twice

/** The model as it is sent: without the empty sections the form created on the way. */
function clean(model) {
  if (!model) return model;
  const m = JSON.parse(JSON.stringify(model));
  if (isObject(m.settings?.home) && Object.keys(m.settings.home).length === 0) delete m.settings.home;
  for (const k of ['settings', 'stats', 'hosts']) if (isObject(m[k]) && Object.keys(m[k]).length === 0) delete m[k];
  return m;
}

function adopt(d) {
  st = {
    file: st?.file,
    writable: st?.writable ?? true,
    icons: st?.icons ?? {},
    tab: st?.tab ?? 'visual',
    ...Object.fromEntries(Object.entries(d).filter(([k]) => ['file', 'writable', 'icons'].includes(k))),
    version: d.version,
    base: d.text,
    text: d.text,
    model: d.model,
    errors: d.errors ?? [],
    saved: { text: d.text, model: JSON.stringify(clean(d.model)) },
    open: new WeakSet(),
    note: '',
    busy: false
  };
  if (!st.model) st.tab = 'yaml';
}

function isDirty() {
  if (!st) return false;
  if (st.tab === 'yaml') return st.text !== st.saved.text;
  return st.base !== st.saved.text || JSON.stringify(clean(st.model)) !== st.saved.model;
}

const source = () => (st.tab === 'yaml' ? { text: st.text } : { base: st.base, model: clean(st.model) });

function touched() {
  st.note = '';
  updateStatus();
  clearTimeout(validateTimer);
  validateTimer = setTimeout(validate, 600);
}

/** Asks the hub what it thinks of the current state (nothing is saved). */
async function validate() {
  const body = JSON.stringify(source());
  if (body === validated) return;
  const run = ++validateRun;
  try {
    const { status, data } = await api('POST', '/api/config/render', body);
    if (run !== validateRun || !st) return;
    validated = body;
    st.errors = status === 200 ? data.errors : [tr(data.error ?? 'The config could not be checked.')];
  } catch {
    return; // connection trouble: saving will say so
  }
  updateStatus();
}

function updateStatus() {
  const dirty = isDirty();
  const n = st.errors.length;
  const parts = [];
  if (st.busy) parts.push(t('Saving…'));
  else if (!st.writable) parts.push(t('The file is read-only here, so it cannot be saved'));
  else if (n > 0) parts.push(n === 1 ? t('1 problem to fix') : t('{n} problems to fix', { n }));
  else if (st.note) parts.push(tr(st.note));
  else parts.push(dirty ? t('Unsaved changes') : t('No changes'));
  if (n > 0 && dirty && !st.busy) parts.push(t('unsaved changes'));
  ui.status.textContent = parts.join(' · ');
  ui.status.dataset.state = n > 0 || !st.writable ? 'bad' : st.note && !dirty ? 'ok' : dirty ? 'dirty' : 'idle';
  ui.problems.hidden = n === 0;
  ui.problems.replaceChildren(...st.errors.map((e) => h('li', { text: e })));
  ui.save.disabled = !dirty || st.busy || !st.writable;
}

// ---- small form parts ----
const put = (obj, key, v) => {
  if (v === undefined || v === '') delete obj[key];
  else obj[key] = v;
};
const child = (obj, key) => {
  if (!isObject(obj[key])) obj[key] = {};
  return obj[key];
};

function input(get, set, o = {}) {
  const el = h('input', {
    type: o.type ?? 'text',
    class: `cfg-in${o.mono ? ' mono' : ''}${o.big ? ' big' : ''}`,
    placeholder: o.placeholder,
    min: o.min,
    max: o.max,
    'aria-label': o.label,
    spellcheck: 'false',
    autocomplete: 'off'
  });
  const v = get();
  el.value = v == null ? '' : String(v);
  el.addEventListener('input', () => {
    const raw = el.value;
    if (o.type === 'number') set(raw.trim() === '' || !Number.isFinite(Number(raw)) ? undefined : Number(raw));
    else set(raw);
    o.after?.();
    touched();
  });
  return el;
}

/** A text box for a list: entries separated by commas. */
function listInput(get, set, o = {}) {
  return input(
    () => asList(get()).join(', '),
    (raw) => set(raw.split(',').map((x) => x.trim()).filter(Boolean)),
    { mono: true, ...o }
  );
}

function field(label, control, hint, cls = '') {
  return h('label', { class: `cfg-f ${cls}` }, h('span', { class: 'cfg-l', text: label }), control, hint ? h('span', { class: 'cfg-h', text: hint }) : null);
}

function check(label, checked, onChange, hint) {
  const box = h('input', { type: 'checkbox' });
  box.checked = checked;
  box.addEventListener('change', () => {
    onChange(box.checked);
    touched();
  });
  return h('label', { class: 'cfg-ck' }, box, h('span', {}, h('span', { text: label }), hint ? h('span', { class: 'cfg-h', text: hint }) : null));
}

const withUnit = (control, unit) => h('span', { class: 'cfg-unit' }, control, h('span', { text: unit }));
const grid = (cols, ...children) => h('div', { class: `cfg-grid c${cols}` }, ...children);

function section(id, title, desc, ...children) {
  return h('section', { class: 'cfg-sec', id }, h('h3', { text: title }), desc ? h('p', { class: 'cfg-desc', text: desc }) : null, ...children);
}

/** Swaps two neighbours; `redraw` draws the part of the form that shows them (default: all of it). */
function move(arr, i, d, redraw = renderForm) {
  const j = i + d;
  if (j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]];
  touched();
  redraw();
}

// ---- sections ----
function secGeneral() {
  const m = st.model;
  const s = () => child(m, 'settings');
  const num = (key, placeholder, min, max) =>
    withUnit(input(() => m.settings?.[key], (v) => put(s(), key, v), { type: 'number', min, max, placeholder }), 'seconds');
  const language = h('select', { class: 'cfg-in' }, h('option', { value: 'auto', text: "Automatic: the browser's language" }), ...Object.entries(LANGUAGES).map(([code, name]) => h('option', { value: code, rawText: name })));
  language.value = Object.hasOwn(LANGUAGES, m.settings?.language) ? m.settings.language : 'auto';
  language.addEventListener('change', () => {
    put(s(), 'language', language.value === 'auto' ? undefined : language.value);
    touched();
  });
  return section(
    'cfg-general',
    'General',
    null,
    grid(2, field('Title', input(() => m.title, (v) => put(m, 'title', v), { placeholder: 'Homelab Hub' })), field('Subtitle', input(() => m.subtitle, (v) => put(m, 'subtitle', v)))),
    h('h4', { text: 'Timing' }),
    grid(
      3,
      field('Check services every', num('checkIntervalSeconds', '30', 5, 3600), '5 to 3600'),
      field('Measure server stats every', num('statsIntervalSeconds', '5', 1, 3600), '1 to 3600'),
      field('A check may take', num('timeoutSeconds', '4', 1, 30), '1 to 30, then it counts as offline')
    ),
    h('h4', { text: 'Home network' }),
    field(
      'Extra public IP addresses that count as home',
      listInput(() => m.settings?.home?.publicIps, (arr) => (child(s(), 'home').publicIps = arr), { placeholder: 'none' }),
      'Usually empty. Separate several with commas.'
    ),
    check(
      'This hub runs on the home network',
      m.settings?.home?.runsAtHome !== false,
      (on) => {
        const home = child(s(), 'home');
        if (on) delete home.runsAtHome;
        else home.runsAtHome = false;
      },
      'Switch off for a preview on a computer somewhere else.'
    ),
    h('h4', { text: 'Behind a reverse proxy or login page' }),
    grid(
      2,
      field(
        'Header with the visitor address',
        input(() => m.settings?.home?.clientIpHeader, (v) => put(child(s(), 'home'), 'clientIpHeader', v.trim()), { mono: true, placeholder: 'x-forwarded-for' }),
        'Only for a reverse proxy other than Cloudflare, e.g. x-forwarded-for. Used to tell home from away.'
      ),
      field(
        'Host names of your login pages',
        listInput(() => m.settings?.loginHosts, (arr) => put(s(), 'loginHosts', arr.length ? arr : undefined), { placeholder: 'auth.example.com' }),
        'E.g. auth.example.com. A check that is redirected there shows "unknown" instead of green.'
      )
    ),
    h('h4', { text: 'Page' }),
    grid(
      2,
      h(
        'div',
        { class: 'cfg-f' },
        h('span', { class: 'cfg-l', text: 'Language' }),
        language,
        h('span', { class: 'cfg-h', text: 'For browsers that have not chosen one in the gear menu.' })
      ),
      h(
        'div',
        { class: 'cfg-f' },
        h('span', { class: 'cfg-l', text: 'Docker' }),
        check('Cards from Docker labels', m.settings?.dockerLabels !== false, (on) => put(s(), 'dockerLabels', on ? undefined : false), 'Containers with homelab-hub.* labels get a card by themselves.')
      )
    )
  );
}

function renameHost(old, el) {
  const m = st.model;
  const next = el.value.trim();
  if (next === old) return;
  const problem = !/^[A-Za-z0-9_-]+$/.test(next) ? t('Use only letters, digits, - and _ for a shortcut name.') : Object.hasOwn(m.hosts, next) ? t('"{name}" already exists.', { name: next }) : '';
  if (problem) {
    el.value = old;
    st.note = problem;
    return updateStatus();
  }
  m.hosts = Object.fromEntries(Object.entries(m.hosts).map(([k, v]) => [k === old ? next : k, v]));
  // every address that used {old} follows the new name
  for (const g of Array.isArray(m.groups) ? m.groups : []) {
    for (const svc of Array.isArray(g?.services) ? g.services : []) {
      for (const key of ['url', 'local', 'check']) {
        if (typeof svc?.[key] === 'string') svc[key] = svc[key].replaceAll(`{${old}}`, `{${next}}`);
      }
    }
  }
  touched();
  renderForm();
}

function secHosts() {
  const m = st.model;
  const hosts = isObject(m.hosts) ? m.hosts : {};
  const usage = JSON.stringify(m.groups ?? []);
  const rows = Object.keys(hosts).map((alias) => {
    const name = h('input', { type: 'text', class: 'cfg-in mono', 'aria-label': 'Shortcut name', spellcheck: 'false', autocomplete: 'off' });
    name.value = alias;
    name.addEventListener('change', () => renameHost(alias, name));
    const used = usage.split(`{${alias}}`).length - 1;
    return h(
      'div',
      { class: 'cfg-row hosts' },
      h('span', { class: 'cfg-brace' }, h('span', { text: '{' }), name, h('span', { text: '}' })),
      input(() => hosts[alias], (v) => (hosts[alias] = v), { mono: true, placeholder: '192.168.1.10', label: t('Address of {alias}', { alias }) }),
      h('span', { class: 'cfg-used', text: used === 0 ? 'not used' : t('used {n}×', { n: used }) }),
      iconBtn('trash', t('Remove {alias}', { alias }), () => {
        if (used > 0 && !confirm(t('{alias} is still used {n} time(s). Remove it anyway?', { alias: `{${alias}}`, n: used }))) return;
        delete hosts[alias];
        touched();
        renderForm();
      }, { danger: true })
    );
  });
  const add = textBtn('plus', 'Add host', () => {
    const hs = child(m, 'hosts');
    let name = 'host';
    for (let i = 2; Object.hasOwn(hs, name); i++) name = `host${i}`;
    hs[name] = '';
    touched();
    renderForm();
    const inputs = ui.main.querySelectorAll('#cfg-hosts .cfg-brace input');
    inputs[inputs.length - 1]?.select();
  });
  return section(
    'cfg-hosts',
    'Hosts',
    'Address shortcuts. Write {name} in a service address and it is replaced with the address here, so a machine that moves to a new IP is one change.',
    ...rows,
    h('div', { class: 'cfg-add' }, add)
  );
}

function secStats() {
  const m = st.model;
  const stats = () => child(m, 'stats');
  /** The storage tiles of one machine (the hub itself or another one): rows plus the "add" button. `owner.disks` is the list. */
  const diskEditor = (owner, pathHint) => {
    const disks = Array.isArray(owner.disks) ? owner.disks : [];
    const box = h('div', { class: 'cfg-disks' });
    const rows = disks.map((d, i) =>
      isObject(d)
        ? h(
            'div',
            { class: 'cfg-row disks' },
            input(() => d.name, (v) => put(d, 'name', v), { placeholder: 'Name', label: 'Name' }),
            input(() => d.path, (v) => put(d, 'path', v), { mono: true, placeholder: pathHint, label: 'Path' }),
            input(() => d.size, (v) => put(d, 'size', v), { mono: true, placeholder: 'size, e.g. 3.6T', label: 'Total size' }),
            h(
              'span',
              { class: 'cfg-acts' },
              iconBtn('up', 'Move up', () => move(disks, i, -1), { disabled: i === 0 }),
              iconBtn('down', 'Move down', () => move(disks, i, 1), { disabled: i === disks.length - 1 }),
              iconBtn('trash', 'Remove', () => {
                disks.splice(i, 1);
                if (disks.length === 0) delete owner.disks;
                touched();
                renderForm();
              }, { danger: true })
            )
          )
        : null
    );
    const add = textBtn('plus', 'Add storage tile', () => {
      if (!Array.isArray(owner.disks)) owner.disks = [];
      const fresh = { name: '', path: '' };
      owner.disks.push(fresh);
      focusNew = fresh;
      touched();
      renderForm();
    });
    box.append(...rows.filter(Boolean), h('div', { class: 'cfg-add' }, add));
    // the row that was just added gets the cursor
    const at = disks.indexOf(focusNew);
    if (at >= 0) {
      focusNew = null;
      queueMicrotask(() => box.querySelectorAll('.cfg-row.disks')[at]?.querySelector('input')?.focus());
    }
    return box;
  };

  const machines = Array.isArray(m.stats?.machines) ? m.stats.machines : [];
  const machineBoxes = machines.map((mc, i) => {
    if (!isObject(mc)) return null;
    const title = h('span', { class: 'cfg-machine-name' });
    const showTitle = () => (title.textContent = mc.name || t('Unnamed machine'));
    showTitle();
    return h(
      'div',
      { class: 'cfg-machine' },
      h(
        'div',
        { class: 'cfg-machine-head' },
        title,
        h(
          'span',
          { class: 'cfg-acts' },
          iconBtn('up', 'Move up', () => move(machines, i, -1), { disabled: i === 0 }),
          iconBtn('down', 'Move down', () => move(machines, i, 1), { disabled: i === machines.length - 1 }),
          iconBtn('trash', 'Remove', () => {
            if ((mc.url || mc.disks?.length) && !confirm(t('Remove the machine "{name}"?', { name: mc.name ?? '' }))) return;
            machines.splice(i, 1);
            if (machines.length === 0) delete stats().machines;
            touched();
            renderForm();
          }, { danger: true })
        )
      ),
      grid(
        2,
        field('Name', input(() => mc.name, (v) => put(mc, 'name', v), { placeholder: 'Raspberry Pi', after: showTitle })),
        field('Address of the agent', input(() => mc.url, (v) => put(mc, 'url', v.trim()), { mono: true, placeholder: 'http://{pi}:8081' }), 'Where the hub in agent mode answers on that machine. {host} shortcuts work.')
      ),
      grid(
        2,
        field('Token', input(() => mc.token, (v) => put(mc, 'token', v.trim()), { mono: true, placeholder: 'none' }), 'Only if the agent has AGENT_TOKEN set: the same text.'),
        field('Network cards', listInput(() => mc.network, (arr) => put(mc, 'network', arr.length ? arr : undefined), { placeholder: 'all physical cards' }), 'For the network speed tile, e.g. eth0')
      ),
      check('Hide this machine', mc.hidden === true, (on) => put(mc, 'hidden', on || undefined)),
      h('h5', { text: 'Storage tiles' }),
      h('p', { class: 'cfg-desc', text: 'Paths as the agent sees them (the right-hand side of its volume mounts).' }),
      diskEditor(mc, '/pools/root')
    );
  });
  const addMachine = textBtn('plus', 'Add machine', () => {
    if (!Array.isArray(stats().machines)) stats().machines = [];
    stats().machines.push({ name: '', url: '' });
    touched();
    renderForm();
    const boxes = ui.main.querySelectorAll('#cfg-stats .cfg-machine');
    boxes[boxes.length - 1]?.querySelector('input')?.focus();
  });
  return section(
    'cfg-stats',
    'Server stats',
    'The tiles at the top of the page. One storage tile per path; the free space is read live, the total size is a number you set.',
    grid(
      2,
      field('Caption', input(() => m.stats?.name, (v) => put(stats(), 'name', v), { placeholder: 'NAS' })),
      field('Network cards', listInput(() => m.stats?.network, (arr) => put(stats(), 'network', arr.length ? arr : undefined), { placeholder: 'all physical cards' }), 'For the network speed tile, e.g. eno1')
    ),
    h('h4', { text: 'Storage tiles' }),
    diskEditor(stats(), '/pools/tank'),
    h('h4', { text: 'Other machines' }),
    h('p', { class: 'cfg-desc', text: 'Machines that run the hub in agent mode (HUB_MODE=agent). Each gets its own row of tiles below this one\'s.' }),
    ...machineBoxes,
    h('div', { class: 'cfg-add' }, addMachine),
    agentList()
  );
}
let focusNew = null; // the storage tile that was just added (see diskEditor)

const iconUrl = (name) => (st.icons[name] ? `/icons/${name}.svg?v=${st.icons[name]}` : '/icons/default.svg');

function iconPicker(svc, after) {
  const img = h('img', { alt: '', width: 26, height: 26 });
  const show = () => (img.src = iconUrl(svc.icon));
  show();
  const name = input(() => svc.icon, (v) => put(svc, 'icon', v.trim()), { mono: true, placeholder: 'default', label: 'Icon name', after: () => (show(), after()) });
  const choices = h('div', { class: 'cfg-icons', hidden: true });
  // the list is only built when it is opened: most services are edited without touching the icon
  const fill = () => {
    for (const n of Object.keys(st.icons)) {
    const b = h('button', { type: 'button', class: 'cfg-iconopt', title: n, 'aria-label': n }, h('img', { src: iconUrl(n), alt: '', width: 26, height: 26, loading: 'lazy' }));
    b.addEventListener('click', () => {
      svc.icon = n;
      name.value = n;
      choices.hidden = true;
      fromLink.hidden = true;
      show();
      after();
      touched();
    });
    choices.append(b);
    }
  };
  const toggle = h('button', { type: 'button', class: 'cfg-iconbtn', title: 'Choose an icon', 'aria-label': 'Choose an icon' }, img);

  // An icon that is not in the list: paste the link to its .svg file. The hub downloads it once and keeps it.
  const link = h('input', { type: 'url', class: 'cfg-in mono', placeholder: 'https://…/icon.svg', 'aria-label': 'Link to an SVG icon', spellcheck: 'false', autocomplete: 'off' });
  const note = h('span', { class: 'cfg-h', text: 'Not in the list? Type the name of an icon from dashboard-icons (it is fetched by itself), or paste the link to an .svg file. The hub downloads it once and keeps it.' });
  const fetchBtn = textBtn(null, 'Add', async () => {
    if (!link.value.trim() || fetchBtn.disabled) return;
    fetchBtn.disabled = true;
    note.classList.remove('bad');
    note.textContent = t('Downloading…');
    try {
      const { status, data } = await api('POST', '/api/config/icon', { url: link.value.trim() });
      if (status !== 200) throw new Error(data.error ?? t('The hub answered with an error ({status}).', { status }));
      st.icons = data.icons;
      svc.icon = data.name;
      touched();
      renderForm(); // every icon list now has the new icon
    } catch (err) {
      note.classList.add('bad');
      note.textContent = err.message;
      fetchBtn.disabled = false;
    }
  });
  link.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      fetchBtn.click();
    }
  });
  const fromLink = h('div', { class: 'cfg-iconlink', hidden: true }, h('div', { class: 'cfg-iconrow' }, link, fetchBtn), note);
  toggle.addEventListener('click', () => {
    if (choices.childElementCount === 0) fill();
    choices.hidden = !choices.hidden;
    fromLink.hidden = choices.hidden;
  });
  return h('div', { class: 'cfg-f' }, h('span', { class: 'cfg-l', text: 'Icon' }), h('div', { class: 'cfg-iconrow' }, toggle, name), choices, fromLink);
}

function checkField(svc) {
  const mode = !Object.hasOwn(svc, 'check') || svc.check === undefined ? 'auto' : svc.check === false || svc.check === null || NO_CHECK.includes(String(svc.check).toLowerCase()) ? 'none' : 'custom';
  const select = h(
    'select',
    { class: 'cfg-in' },
    h('option', { value: 'auto', text: 'Automatic: check the service address' }),
    h('option', { value: 'custom', text: 'Check another address' }),
    h('option', { value: 'none', text: 'No check: a plain link without a dot' })
  );
  select.value = mode;
  const custom = input(() => (mode === 'custom' ? svc.check : ''), (v) => (svc.check = v), { mono: true, placeholder: 'http://{nas}:8080  or  tcp://{pi}:22', label: 'Address to check' });
  custom.hidden = mode !== 'custom';
  custom.dataset.addr = '';
  select.addEventListener('change', () => {
    if (select.value === 'auto') delete svc.check;
    else if (select.value === 'none') svc.check = 'none';
    else {
      svc.check = custom.value || (typeof svc.local === 'string' ? svc.local : '');
      custom.value = svc.check;
    }
    custom.hidden = select.value !== 'custom';
    if (!custom.hidden) custom.focus();
    touched();
  });
  return h(
    'div',
    { class: 'cfg-f' },
    h('span', { class: 'cfg-l', text: 'Online check' }),
    select,
    custom,
    h('span', { class: 'cfg-h', text: 'Addresses behind a login page always answer, so check the real address (machine and port) instead.' })
  );
}

function svcForm(svc, refreshHead) {
  const addr = (key, placeholder) => {
    const el = input(() => svc[key], (v) => put(svc, key, v.trim()), { mono: true, placeholder, after: refreshHead });
    el.dataset.addr = '';
    return el;
  };
  const form = h(
    'div',
    { class: 'cfg-svcform' },
    grid(2, field('Name', input(() => svc.name, (v) => put(svc, 'name', v), { after: refreshHead })), iconPicker(svc, refreshHead)),
    field('Description', input(() => svc.description, (v) => put(svc, 'description', v)), 'A short line under the name. Optional.'),
    grid(
      2,
      field('Public address', addr('url', 'https://app.example.net'), 'Opened when you are away. Empty = home network only.'),
      field('Home address', addr('local', 'http://{nas}:8080'), 'Opened instead when you are on the home network. Optional.')
    ),
    grid(
      2,
      checkField(svc),
      field(
        'Docker containers',
        listInput(() => svc.containers, (arr) => put(svc, 'containers', arr.length ? arr : undefined), { placeholder: '*immich*' }),
        'Show the health of these containers on the card. * matches anything; separate several with commas.'
      )
    ),
    h(
      'div',
      { class: 'cfg-checks' },
      check('Accept a self-signed certificate on the check', svc.insecure === true, (on) => put(svc, 'insecure', on || undefined)),
      check('Hide this card', svc.hidden === true, (on) => (put(svc, 'hidden', on || undefined), refreshHead()))
    )
  );
  // host shortcuts: a click writes {name} into the address field used last
  const hosts = Object.keys(isObject(st.model.hosts) ? st.model.hosts : {});
  if (hosts.length > 0) {
    let last = null;
    form.addEventListener('focusin', (e) => {
      if (e.target instanceof HTMLInputElement && 'addr' in e.target.dataset) last = e.target;
    });
    const chips = hosts.map((name) => {
      const b = h('button', { type: 'button', class: 'cfg-chip', text: `{${name}}`, title: t('Insert {name} ({address})', { name: `{${name}}`, address: st.model.hosts[name] }) });
      b.addEventListener('click', () => {
        const el = last && !last.hidden ? last : form.querySelector('input[data-addr]:not([hidden])');
        if (!el) return;
        const at = el.selectionStart ?? el.value.length;
        el.setRangeText(`{${name}}`, at, el.selectionEnd ?? at, 'end');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.focus();
      });
      return b;
    });
    form.append(h('div', { class: 'cfg-chips' }, h('span', { class: 'cfg-h', text: 'Insert a host:' }), ...chips));
  }
  return form;
}

/** One service. `redraw` draws its group again (after moving, copying or removing). */
function svcItem(svc, i, list, redraw) {
  if (!isObject(svc)) return null;
  const open = st.open.has(svc);
  const img = h('img', { alt: '', width: 26, height: 26 });
  const name = h('span', { class: 'cfg-svcname' });
  const sub = h('span', { class: 'cfg-svcsub' });
  const tags = h('span', { class: 'cfg-tags' });
  const refreshHead = () => {
    img.src = iconUrl(svc.icon);
    name.textContent = svc.name || t('Unnamed service');
    sub.textContent = svc.url || svc.local || t('no address yet');
    tags.replaceChildren(
      ...[svc.hidden === true ? 'hidden' : '', !svc.url && svc.local ? 'home only' : ''].filter(Boolean).map((t) => h('span', { class: 'cfg-tag', text: t }))
    );
  };
  refreshHead();
  const summary = h('button', { type: 'button', class: 'cfg-svcsum', 'aria-expanded': open ? 'true' : 'false' }, svg('chev', 14), img, h('span', { class: 'cfg-svctext' }, name, sub), tags);
  summary.addEventListener('click', () => {
    if (open) st.open.delete(svc);
    else st.open.add(svc);
    // only this service is drawn again, not the whole form
    const next = svcItem(svc, i, list, redraw);
    el.replaceWith(next);
    next.querySelector('.cfg-svcsum').focus();
  });
  const head = h(
    'div',
    { class: 'cfg-svchead' },
    grip('svc', list, i),
    summary,
    h(
      'span',
      { class: 'cfg-acts' },
      iconBtn('up', 'Move up', () => move(list, i, -1, redraw), { disabled: i === 0 }),
      iconBtn('down', 'Move down', () => move(list, i, 1, redraw), { disabled: i === list.length - 1 }),
      iconBtn('copy', 'Duplicate', () => {
        const copy = JSON.parse(JSON.stringify(svc));
        delete copy[ID];
        copy.name = t('{name} copy', { name: svc.name ?? 'Service' });
        list.splice(i + 1, 0, copy);
        st.open.add(copy);
        touched();
        redraw();
      }),
      iconBtn('trash', 'Remove', () => {
        list.splice(i, 1);
        touched();
        redraw();
      }, { danger: true })
    )
  );
  const el = h('div', { class: `cfg-svc${open ? ' open' : ''}` }, head, open ? svcForm(svc, refreshHead) : null);
  el.dropInfo = { kind: 'svc', list: () => list, i };
  return el;
}

function secGroup(g, gi, groups) {
  if (!isObject(g)) return null;
  const list = Array.isArray(g.services) ? g.services : [];
  // changes inside a group draw only this group again
  const redraw = () => document.getElementById(`cfg-group-${gi}`)?.replaceWith(secGroup(g, gi, groups));
  const count = h('span', { class: 'cfg-used', text: list.length === 1 ? t('1 service') : t('{n} services', { n: list.length }) });
  const head = h(
    'div',
    { class: 'cfg-grouphead' },
    grip('group', groups, gi),
    input(() => g.name, (v) => put(g, 'name', v), { big: true, placeholder: 'Group name', label: 'Group name', after: renderNav }),
    count,
    h(
      'span',
      { class: 'cfg-acts' },
      iconBtn('up', 'Move group up', () => move(groups, gi, -1), { disabled: gi === 0 }),
      iconBtn('down', 'Move group down', () => move(groups, gi, 1), { disabled: gi === groups.length - 1 }),
      iconBtn('trash', 'Remove group', () => {
        if (list.length > 0 && !confirm(t('Remove the group "{name}" with its {n} service(s)?', { name: g.name ?? '', n: list.length }))) return;
        groups.splice(gi, 1);
        touched();
        renderForm();
      }, { danger: true })
    )
  );
  const add = textBtn('plus', 'Add service', () => {
    if (!Array.isArray(g.services)) g.services = [];
    const svc = { name: '' };
    g.services.push(svc);
    st.open.add(svc);
    touched();
    redraw();
    const forms = ui.main.querySelectorAll(`#cfg-group-${gi} .cfg-svcform`);
    forms[forms.length - 1]?.querySelector('input')?.focus();
  });
  const svcs = h('div', { class: 'cfg-svcs' }, ...list.map((svc, i) => svcItem(svc, i, list, redraw)));
  // a service dropped on the group (not on another service) goes to its end; an empty group gets its list then
  const ownList = () => (Array.isArray(g.services) ? g.services : (g.services = []));
  svcs.dropInfo = { kind: 'svc', list: ownList, i: list.length };
  const sec = h(
    'section',
    { class: 'cfg-sec cfg-group', id: `cfg-group-${gi}` },
    head,
    check('Container health badges for every card', g.autoContainers === true, (on) => put(g, 'autoContainers', on || undefined), 'Matches Docker containers by the card name; cards without a container get no badge.'),
    svcs,
    h('div', { class: 'cfg-add' }, add)
  );
  sec.dropInfo = { kind: 'group', list: () => groups, i: gi };
  return sec;
}

// ---- drag and drop: services (also into another group) and groups, with mouse, pen or finger ----
// Elements that can take a drop carry .dropInfo = {kind, list(), i}. The handle follows the pointer
// itself (pointer events, not the browser's drag and drop, which does not work on touch screens).
let drag = null; // {kind, list, i, target: {list, at} | null, marked}

function clearDropMark() {
  drag?.marked?.classList.remove('cfg-drop-before', 'cfg-drop-after', 'cfg-drop-end');
  if (drag) drag.marked = null;
}

function dragMove(e) {
  // near the top or bottom edge: scroll, so a far-away place can be reached
  const box = ui.main.getBoundingClientRect();
  if (e.clientY < box.top + 48) ui.main.scrollTop -= 16;
  else if (e.clientY > box.bottom - 48) ui.main.scrollTop += 16;

  clearDropMark();
  drag.target = null;
  const under = document.elementFromPoint(e.clientX, e.clientY);
  if (!under || !ui.main.contains(under)) return;
  let el = drag.kind === 'svc' ? under.closest('.cfg-svc') : null;
  if (!el) {
    const group = under.closest('.cfg-group');
    if (!group) return;
    el = drag.kind === 'svc' ? group.querySelector('.cfg-svcs') : group;
  }
  const info = el.dropInfo;
  if (!info || info.kind !== drag.kind) return;
  if (el.classList.contains('cfg-svcs')) {
    drag.target = { list: info.list, at: info.i };
    el.classList.add('cfg-drop-end');
  } else {
    const r = el.getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    drag.target = { list: info.list, at: info.i + (after ? 1 : 0) };
    el.classList.add(after ? 'cfg-drop-after' : 'cfg-drop-before');
  }
  drag.marked = el;
}

function dragEnd(e) {
  if (!drag) return;
  const d = drag;
  clearDropMark();
  drag = null;
  document.body.classList.remove('cfg-dragging');
  ui.main.querySelector('.cfg-dragged')?.classList.remove('cfg-dragged');
  if (e.type !== 'pointerup' || !d.target) return;
  const to = d.target.list();
  let at = d.target.at;
  if (to === d.list && (at === d.i || at === d.i + 1)) return; // dropped where it was
  const [item] = d.list.splice(d.i, 1);
  if (to === d.list && d.i < at) at--;
  to.splice(at, 0, item);
  touched();
  renderForm();
}

/** The handle to drag a service or a group by. */
function grip(kind, list, i) {
  const b = h('span', { class: 'cfg-grip', title: 'Drag to move' }, svg('grip', 16));
  b.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    try {
      b.setPointerCapture(e.pointerId); // moves keep coming to the handle, wherever the pointer goes
    } catch {
      // no capture (unusual pointer): dragging still works while the pointer stays on the handle
    }
    drag = { kind, list, i, target: null, marked: null };
    document.body.classList.add('cfg-dragging');
    b.closest(kind === 'svc' ? '.cfg-svc' : '.cfg-group')?.classList.add('cfg-dragged');
  });
  b.addEventListener('pointermove', (e) => {
    if (drag) dragMove(e);
  });
  b.addEventListener('pointerup', dragEnd);
  b.addEventListener('pointercancel', dragEnd);
  return b;
}

// ---- agents found on the home network (see scan.js) ----
let agents = null; // null = not asked yet; the answer of /api/config/agents
let agentsTimer = null;

async function loadAgents() {
  clearTimeout(agentsTimer);
  try {
    const { status, data } = await api('GET', '/api/config/agents');
    agents = status === 200 ? data : { enabled: true, agents: [], error: data.error ?? '' };
  } catch (err) {
    agents = { enabled: true, agents: [], error: err.message };
  }
  if (agents.scanning && dlg?.open) agentsTimer = setTimeout(loadAgents, 1500); // ask again until the search is done
  document.getElementById('cfg-agents')?.replaceWith(agentList());
}

async function searchAgents() {
  agents = { ...(agents ?? { agents: [] }), scanning: true };
  document.getElementById('cfg-agents')?.replaceWith(agentList());
  try {
    await api('POST', '/api/config/agents/scan', {});
  } catch {
    // shown by loadAgents
  }
  setTimeout(loadAgents, 800);
}

/** The agents found on the network that are not a machine here yet, each with an Add button. */
function agentList() {
  const box = h('div', { class: 'cfg-agents', id: 'cfg-agents' });
  const inConfig = new Set((Array.isArray(st.model.stats?.machines) ? st.model.stats.machines : []).filter(isObject).map((m) => String(m.url ?? '').replace(/\/+$/, '')));
  const fresh = (agents?.agents ?? []).filter((a) => !a.added && !inConfig.has(a.url));
  const again = textBtn(null, agents?.scanning ? 'Searching…' : 'Search again', searchAgents);
  if (agents?.scanning) again.disabled = true;
  const head = h('div', { class: 'cfg-found-head' }, h('span', { class: 'cfg-l', text: 'Found on the network' }), again);
  let note;
  if (!agents) note = 'Looking…';
  else if (agents.enabled === false) note = 'Searching for agents is switched off.';
  else if (agents.error) note = agents.error;
  else if (agents.scanning && fresh.length === 0) note = 'Searching the home network for agents…';
  else if (fresh.length === 0) note = agents.scannedAt ? 'No new agents found. An agent answers on port 8081 (compose.agent.yaml).' : 'Not searched yet.';
  const rows = fresh.map((a) =>
    h(
      'div',
      { class: 'cfg-found-row' },
      h('span', { class: 'cfg-svctext' }, h('span', { class: 'cfg-svcname', rawText: a.name || a.ip }), h('span', { class: 'cfg-svcsub', rawText: `${a.url}${a.docker ? ` · ${t('with containers')}` : ''}${a.token ? ` · ${t('needs its token')}` : ''}` })),
      textBtn('plus', 'Add', () => {
        const stats = isObject(st.model.stats) ? st.model.stats : (st.model.stats = {});
        if (!Array.isArray(stats.machines)) stats.machines = [];
        const mc = { name: a.name || a.ip, url: hostShortcut(a.ip) === a.ip ? a.url : `http://${hostShortcut(a.ip)}:${a.port}` };
        if (a.token) mc.token = '';
        stats.machines.push(mc);
        a.added = true;
        touched();
        renderForm();
        if (a.token) {
          // the token has to be typed in: put the cursor there
          const boxes = ui.main.querySelectorAll('#cfg-stats .cfg-machine');
          boxes[boxes.length - 1]?.querySelectorAll('input')[2]?.focus();
        }
      })
    )
  );
  box.append(head, ...(note ? [h('p', { class: 'cfg-desc', text: note })] : []), ...rows);
  if (agents?.networks?.length) box.append(h('p', { class: 'cfg-h', rawText: `${t('Searched')}: ${agents.networks.join(', ')}` }));
  return box;
}

// ---- found on this server: containers with a published port and no card yet ----
let found = null; // null = not asked yet; {list, error}
let foundGroup = ''; // name of the group new cards go into ('' = the first group)

async function loadFound() {
  try {
    const { status, data } = await api('GET', '/api/config/suggestions');
    found = status === 200 ? { list: data.suggestions ?? [], error: data.dockerError ?? '' } : { list: [], error: data.error ?? '' };
  } catch (err) {
    found = { list: [], error: err.message };
  }
  if (st?.tab === 'visual') document.getElementById('cfg-found')?.replaceWith(secFound());
}

/** An address as the cards should write it: {name} when a host shortcut has exactly this address. */
function hostShortcut(address) {
  const hosts = isObject(st.model.hosts) ? st.model.hosts : {};
  const match = Object.keys(hosts).find((k) => String(hosts[k]) === address);
  return match ? `{${match}}` : address;
}

/** The address of this server as the cards should write it: a host shortcut when one fits. */
function serverHost() {
  const hosts = isObject(st.model.hosts) ? st.model.hosts : {};
  const here = location.hostname;
  const match = Object.keys(hosts).find((k) => String(hosts[k]) === here);
  if (match) return `{${match}}`;
  const first = Object.keys(hosts)[0];
  if (first) return `{${first}}`;
  return /^[\d.]+$/.test(here) ? here : 'SERVER-IP';
}

function secFound() {
  const groups = (Array.isArray(st.model.groups) ? st.model.groups : []).filter(isObject);
  const host = serverHost();
  // a container on another machine: that machine's address (as a {host} shortcut when one fits)
  const hostFor = (s) => (s.machine ? hostShortcut(s.host) : host);
  const body = [];
  if (!found) body.push(h('p', { class: 'cfg-desc', text: 'Looking…' }));
  else if (found.error) body.push(h('p', { class: 'cfg-desc', text: 'Docker is not reachable, so nothing can be found here. It needs the docker-proxy from the example compose file.' }));
  else if (found.list.length === 0) body.push(h('p', { class: 'cfg-desc', text: 'Nothing new: every container that publishes a port already has a card.' }));
  else {
    const select = h('select', { class: 'cfg-in', 'aria-label': 'Add to group' }, ...groups.map((g) => h('option', { value: g.name ?? '', rawText: g.name || t('Unnamed group') })), h('option', { value: '\u0000new', text: 'A new group' }));
    if ([...select.options].some((o) => o.value === foundGroup)) select.value = foundGroup;
    select.addEventListener('change', () => (foundGroup = select.value));
    foundGroup = select.value;
    const add = (s) => {
      if (!Array.isArray(st.model.groups)) st.model.groups = [];
      let g = st.model.groups.find((x) => isObject(x) && (x.name ?? '') === foundGroup);
      if (!g || foundGroup === '\u0000new') {
        g = { name: t('Services'), services: [] };
        st.model.groups.push(g);
        foundGroup = g.name;
      }
      if (!Array.isArray(g.services)) g.services = [];
      const svc = { name: s.name, icon: s.icon, local: `${s.scheme}://${hostFor(s)}:${s.port}` };
      if (s.scheme === 'https') svc.insecure = true; // a port like 9443 usually has a self-signed certificate
      g.services.push(svc);
      found.list = found.list.filter((x) => x !== s);
      touched();
      renderForm();
    };
    const rows = found.list.map((s) =>
      h(
        'div',
        { class: 'cfg-found-row' },
        h('img', { src: iconUrl(s.icon), alt: '', width: 26, height: 26 }),
        h('span', { class: 'cfg-svctext' }, h('span', { class: 'cfg-svcname', rawText: s.name }), h('span', { class: 'cfg-svcsub', rawText: `${s.machine ? `${s.machine} · ` : ''}${s.scheme}://${hostFor(s)}:${s.port}${s.ports.length > 1 ? `   (${t('also')} ${s.ports.filter((p) => p !== s.port).join(', ')})` : ''}` })),
        textBtn('plus', 'Add', () => add(s))
      )
    );
    body.push(
      h('div', { class: 'cfg-found-head' }, h('span', { class: 'cfg-l', text: 'Add to group' }), select),
      ...rows,
      found.list.length > 1 ? h('div', { class: 'cfg-add' }, textBtn('plus', 'Add all', () => [...found.list].forEach(add))) : null
    );
  }
  return section(
    'cfg-found',
    'Found on this server',
    'Containers that publish a port and have no card yet, on this server and on the other machines whose agent reports its containers. "Add" makes a normal card with the home address filled in; add the public address afterwards if there is one. Databases and other helpers are left out.',
    ...body
  );
}

// ---- tools: import from another dashboard, backup, restore ----
function pickFile(accept) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept });
    input.addEventListener('change', async () => resolve(input.files[0] ? { name: input.files[0].name, text: await input.files[0].text() } : null));
    input.click();
  });
}

function secTools() {
  const importBtn = textBtn(null, 'Import from Homepage, Dashy or Homarr…', async () => {
    const file = await pickFile('.yaml,.yml,.json');
    if (!file) return;
    try {
      const { status, data } = await api('POST', '/api/config/import', { text: file.text });
      if (status !== 200) throw new Error(tr(data.error));
      if (!Array.isArray(st.model.groups)) st.model.groups = [];
      let cards = 0;
      for (const g of data.groups) {
        const own = st.model.groups.find((x) => isObject(x) && x.name === g.name);
        const names = new Set((own?.services ?? []).map((s) => s?.name));
        const fresh = g.services.filter((s) => !names.has(s.name));
        cards += fresh.length;
        if (own) (Array.isArray(own.services) ? own.services : (own.services = [])).push(...fresh);
        else st.model.groups.push({ name: g.name, services: fresh });
      }
      touched();
      renderForm();
      st.note = t('{n} cards imported from {format}. Check them, then save.', { n: cards, format: data.format });
    } catch (err) {
      st.note = err.message;
    }
    updateStatus();
  });
  const download = textBtn(null, 'Download a backup', () => {
    const a = h('a', { href: URL.createObjectURL(new Blob([st.saved.text], { type: 'text/yaml' })), download: 'homelab-hub-services.yaml' });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });
  const restore = textBtn(null, 'Restore from a file…', async () => {
    const file = await pickFile('.yaml,.yml');
    if (!file) return;
    st.text = file.text;
    st.tab = 'yaml'; // shown as text, checked like anything typed there; nothing is saved until "Save"
    render();
    st.note = t('Loaded {name}. Check it, then save.', { name: file.name });
    touched();
    st.note = t('Loaded {name}. Check it, then save.', { name: file.name });
    updateStatus();
  });
  return section(
    'cfg-tools',
    'Import and backup',
    'Import takes names, addresses, icons and descriptions from another dashboard\'s config file. The backup is this config as a file; the hub also keeps the last 10 saved versions in the folder "backups" next to the config.',
    h('div', { class: 'cfg-tools' }, importBtn, download, restore)
  );
}

function renderNav() {
  const jump = (label, id, cls = '') => {
    const b = h('button', { type: 'button', class: cls, [cls === 'sub' ? 'rawText' : 'text']: label });
    b.addEventListener('click', () => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    return b;
  };
  const groups = Array.isArray(st.model?.groups) ? st.model.groups : [];
  ui.nav.replaceChildren(
    jump('General', 'cfg-general'),
    jump('Hosts', 'cfg-hosts'),
    jump('Server stats', 'cfg-stats'),
    jump('Found on this server', 'cfg-found'),
    h('div', { class: 'cfg-navtitle', text: 'Groups' }),
    ...groups.map((g, gi) => (isObject(g) ? jump(g.name || t('Unnamed group'), `cfg-group-${gi}`, 'sub') : null)),
    jump('Import and backup', 'cfg-tools')
  );
}

function renderForm() {
  const m = st.model;
  const scroll = ui.main.scrollTop;
  const groups = Array.isArray(m.groups) ? m.groups : [];
  const addGroup = textBtn('plus', 'Add group', () => {
    if (!Array.isArray(m.groups)) m.groups = [];
    m.groups.push({ name: '', services: [] });
    touched();
    renderForm();
    const el = document.getElementById(`cfg-group-${m.groups.length - 1}`);
    el?.scrollIntoView({ block: 'center' });
    el?.querySelector('input')?.focus();
  }, 'wide');
  ui.main.replaceChildren(
    secGeneral(),
    secHosts(),
    secStats(),
    secFound(),
    h('div', { class: 'cfg-divider' }, h('h3', { text: 'Groups and services' }), h('p', { class: 'cfg-desc', text: 'One card per web UI. Click a service to edit it.' })),
    ...groups.map((g, gi) => secGroup(g, gi, groups)),
    addGroup,
    secTools()
  );
  ui.main.scrollTop = scroll;
  renderNav();
}

function renderYaml() {
  const area = h('textarea', { class: 'cfg-yaml', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', wrap: 'off', 'aria-label': 'YAML text' });
  area.value = st.text;
  area.addEventListener('input', () => {
    st.text = area.value;
    touched();
  });
  area.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
    e.preventDefault(); // Tab indents, as YAML needs it
    area.setRangeText('  ', area.selectionStart, area.selectionEnd, 'end');
    area.dispatchEvent(new Event('input'));
  });
  ui.main.replaceChildren(area);
}

function render() {
  ui.file.textContent = st.file ?? '';
  for (const [tab, b] of Object.entries(ui.tabs)) b.setAttribute('aria-selected', st.tab === tab ? 'true' : 'false');
  ui.body.dataset.tab = st.tab;
  if (st.tab === 'yaml') renderYaml();
  else renderForm();
  updateStatus();
}

/** Visual -> YAML: the hub writes the text; YAML -> Visual: the hub reads it back into the form. */
async function switchTab(tab) {
  if (!st || st.busy || tab === st.tab) return;
  try {
    const { status, data } = await api('POST', '/api/config/render', source());
    if (status !== 200) throw new Error(data.error);
    if (tab === 'visual' && !data.model) {
      st.errors = data.errors;
      st.note = '';
      return updateStatus(); // syntax error: stay on the text until it is fixed
    }
    st.base = data.text;
    st.text = data.text;
    st.model = data.model ?? st.model;
    st.errors = data.errors;
    st.open = new WeakSet();
    st.tab = tab;
    render();
  } catch (err) {
    st.note = err.message;
    updateStatus();
  }
}

/** Which services are unfolded, as positions, to unfold the same ones in a freshly loaded model. */
function openPositions() {
  const out = [];
  (Array.isArray(st.model?.groups) ? st.model.groups : []).forEach((g, gi) => (Array.isArray(g?.services) ? g.services : []).forEach((s, si) => st.open.has(s) && out.push([gi, si])));
  return out;
}

async function save() {
  if (!st || st.busy || !isDirty()) return;
  const wasOpen = st.tab === 'visual' ? openPositions() : [];
  st.busy = true;
  updateStatus();
  try {
    const { status, data } = await api('PUT', '/api/config', { ...source(), version: st.version });
    if (status === 200) {
      const scroll = ui.main.scrollTop;
      adopt(data);
      for (const [gi, si] of wasOpen) {
        const svc = st.model?.groups?.[gi]?.services?.[si];
        if (isObject(svc)) st.open.add(svc);
      }
      st.note = t('Saved. The hub is using it now.');
      render();
      ui.main.scrollTop = scroll;
      document.dispatchEvent(new CustomEvent('hub:config-saved'));
      return;
    }
    st.busy = false;
    if (status === 409) {
      if (confirm(`${tr(data.error)}\n\n${t('Load the new version? Your changes here are lost.')}`)) return void load();
    } else if (status === 422) {
      st.errors = data.errors;
    } else {
      st.note = data.error ?? t('Not saved ({status}).', { status });
    }
  } catch (err) {
    st.busy = false;
    st.note = t('Not saved: {message}', { message: err.message });
  }
  updateStatus();
}

function requestClose() {
  if (st && isDirty() && !confirm(t('Close without saving? Your changes are lost.'))) return;
  clearTimeout(validateTimer);
  st = null;
  dlg.close();
}

function build() {
  if (dlg) return;
  ui.file = h('p', { class: 'cfg-file' });
  ui.tabs = {
    visual: h('button', { type: 'button', role: 'tab', text: 'Visual' }),
    yaml: h('button', { type: 'button', role: 'tab', text: 'YAML' })
  };
  for (const [tab, b] of Object.entries(ui.tabs)) b.addEventListener('click', () => switchTab(tab));
  ui.nav = h('nav', { class: 'cfg-nav', 'aria-label': 'Sections' });
  ui.main = h('div', { class: 'cfg-main' });
  ui.body = h('div', { class: 'cfg-body' }, ui.nav, ui.main);
  ui.status = h('span', { class: 'cfg-status', role: 'status' });
  ui.problems = h('ul', { class: 'cfg-problems', hidden: true });
  ui.save = textBtn(null, 'Save', save, 'primary');
  dlg = h(
    'dialog',
    { class: 'cfg', 'aria-label': 'Edit configuration' },
    h(
      'header',
      { class: 'cfg-head' },
      h('div', { class: 'cfg-heading' }, h('h2', { text: 'Edit configuration' }), ui.file),
      h('div', { class: 'cfg-tabs', role: 'tablist' }, ui.tabs.visual, ui.tabs.yaml),
      iconBtn('x', 'Close', requestClose)
    ),
    ui.body,
    ui.problems,
    h('footer', { class: 'cfg-foot' }, ui.status, textBtn(null, 'Close', requestClose), ui.save)
  );
  dlg.addEventListener('cancel', (e) => {
    e.preventDefault(); // Esc asks first when there are unsaved changes
    requestClose();
  });
  dlg.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      save();
    }
  });
  document.body.append(dlg);
}

/** Scrolls to a section, a group or one service (which is unfolded). */
function showTarget(target) {
  if (!target || !st?.model || st.tab !== 'visual') return;
  let el = target.section ? document.getElementById(target.section) : null;
  const groups = Array.isArray(st.model.groups) ? st.model.groups : [];
  const gi = target.group == null ? -1 : groups.findIndex((g) => isObject(g) && g.name === target.group);
  if (gi >= 0) {
    const list = Array.isArray(groups[gi].services) ? groups[gi].services : [];
    const si = target.service == null ? -1 : list.findIndex((s) => isObject(s) && s.name === target.service);
    if (si >= 0) {
      st.open.add(list[si]);
      renderForm();
      el = document.querySelectorAll(`#cfg-group-${gi} .cfg-svcs > .cfg-svc`)[si];
    } else el = document.getElementById(`cfg-group-${gi}`);
  }
  el?.scrollIntoView({ block: 'start' });
  el?.querySelector('.cfg-svcform input, input')?.focus({ preventScroll: true });
}

async function load(target) {
  build();
  st = null;
  ui.file.textContent = '';
  ui.nav.replaceChildren();
  ui.problems.hidden = true;
  ui.status.textContent = '';
  ui.save.disabled = true;
  ui.main.replaceChildren(h('p', { class: 'cfg-msg', text: 'Loading…' }));
  if (!dlg.open) dlg.showModal();
  try {
    const { status, data } = await api('GET', '/api/config');
    if (status !== 200) throw new Error(tr(data.error) ?? t('The hub answered with an error ({status}).', { status }));
    adopt(data);
    found = null;
    agents = null;
    render();
    showTarget(target);
    loadFound();
    loadAgents();
  } catch (err) {
    ui.main.replaceChildren(h('p', { class: 'cfg-msg bad', text: err.message }));
  }
}

/** Opens the editor with the config as it is on the hub now. */
/**
 * Opens the editor with the config as it is on the hub now.
 * @param {{group?: string, service?: string, section?: string}} [target]  what to show first
 */
export const openEditor = (target) => load(target);
window.addEventListener('beforeunload', (e) => {
  if (dlg?.open && st && isDirty()) e.preventDefault();
});
