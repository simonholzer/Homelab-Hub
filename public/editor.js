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
  grip: 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01',
  cards: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  server: 'M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01',
  link: 'M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1',
  gear: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1',
  box: 'M4 7l8-4 8 4v10l-8 4-8-4zM4 7l8 4 8-4M12 11v10',
  fold: 'M7 10l5-5 5 5M7 14l5 5 5-5',
  palette: 'M12 3a9 9 0 1 0 0 18c.9 0 1.5-.7 1.5-1.5 0-.4-.2-.8-.4-1.1-.3-.3-.4-.6-.4-1 0-.8.7-1.4 1.5-1.4H16a5 5 0 0 0 5-5c0-4.4-4-8-9-8zM7.5 11.5h.01M9.5 7.5h.01M14.5 7.5h.01M17 11h.01',
  eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  share: 'M4 13v6a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-6M12 3v12M7 8l5-5 5 5',
  download: 'M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4M12 3v12M7 10l5 5 5-5'
};

/**
 * The pages of the form, in the order of the tab bar. Every part of the config lives on exactly one page;
 * `sections` are the ids of the boxes on it (to open the editor at one of them).
 */
const PAGES = [
  { id: 'services', icon: 'cards', label: 'Services', desc: 'The cards on the page, in their groups. Click a service to edit it; drag the handle to move it, also into another group.', sections: [] },
  { id: 'found', icon: 'search', label: 'Found', desc: 'Containers that run in Docker and have no card yet: one click makes a card.', sections: ['cfg-found'] },
  { id: 'machines', icon: 'server', label: 'Machines', desc: 'The stats tiles at the top of the page: this server, and other machines that run the agent.', sections: ['cfg-own', 'cfg-stats', 'cfg-agents-sec'] },
  { id: 'hosts', icon: 'link', label: 'Host shortcuts', desc: 'Short names for addresses, used as {name} in service addresses.', sections: ['cfg-hosts'] },
  { id: 'settings', icon: 'gear', label: 'Settings', desc: 'How the page looks and how often the hub checks things.', sections: ['cfg-general', 'cfg-timing', 'cfg-home', 'cfg-proxy', 'cfg-docker'] },
  { id: 'themes', icon: 'palette', label: 'Themes', desc: 'Color themes of your own. Each starts from a built-in theme and changes only the colors you set. After saving, everyone can pick them in the gear menu under Appearance.', sections: ['cfg-themes'] },
  { id: 'backup', icon: 'box', label: 'Import and backup', desc: '', sections: ['cfg-tools'] }
];
const pageOf = (sectionId) => (/^cfg-group-/.test(sectionId ?? '') ? 'services' : PAGES.find((p) => p.sections.includes(sectionId))?.id ?? null);
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
  for (const k of ['settings', 'stats', 'hosts', 'themes']) if (isObject(m[k]) && Object.keys(m[k]).length === 0) delete m[k];
  return m;
}

function adopt(d) {
  st = {
    file: st?.file,
    writable: st?.writable ?? true,
    icons: st?.icons ?? {},
    tab: st?.tab ?? 'visual',
    page: st?.page ?? 'services',
    filter: st?.filter ?? '',
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

/** A labelled part inside a form (e.g. "Addresses" in a service), so it is clear which fields belong together. */
const fieldset = (title, ...children) => h('div', { class: 'cfg-fs' }, h('div', { class: 'cfg-fs-t', text: title }), ...children);

/** Swaps two neighbours; `redraw` draws the part of the form that shows them (default: all of it). */
function move(arr, i, d, redraw = renderForm) {
  const j = i + d;
  if (j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]];
  touched();
  redraw();
}

// ---- sections ----
/** The Settings page: one box per topic. */
function secSettings() {
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
  // settings.discovery may be written as true/false or as a mapping; the form always writes the mapping
  const disc = () => {
    const set = s();
    if (!isObject(set.discovery)) set.discovery = set.discovery === false ? { enabled: false } : {};
    return set.discovery;
  };
  const discRaw = m.settings?.discovery;
  const discOn = discRaw !== false && !(isObject(discRaw) && discRaw.enabled === false);
  const tidyDisc = () => {
    const d = m.settings?.discovery;
    if (isObject(d) && Object.keys(d).filter((k) => k !== ID).length === 0) delete m.settings.discovery;
  };
  return [
    section(
      'cfg-general',
      'Page',
      'What the page is called and which language it speaks.',
      grid(2, field('Title', input(() => m.title, (v) => put(m, 'title', v), { placeholder: 'Homelab Hub' })), field('Subtitle', input(() => m.subtitle, (v) => put(m, 'subtitle', v)), 'A short line under the title. Optional.')),
      grid(2, h('div', { class: 'cfg-f' }, h('span', { class: 'cfg-l', text: 'Language' }), language, h('span', { class: 'cfg-h', text: 'For browsers that have not chosen one in the gear menu.' })))
    ),
    section(
      'cfg-timing',
      'Timing',
      'How often the hub looks at your services and machines.',
      grid(
        3,
        field('Check services every', num('checkIntervalSeconds', '30', 5, 3600), '5 to 3600'),
        field('Measure server stats every', num('statsIntervalSeconds', '5', 1, 3600), '1 to 3600'),
        field('A check may take', num('timeoutSeconds', '4', 1, 30), '1 to 30, then it counts as offline')
      )
    ),
    section(
      'cfg-home',
      'Home network',
      'On the home network the cards open their home address; away, their public one.',
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
      field(
        'Extra public IP addresses that count as home',
        listInput(() => m.settings?.home?.publicIps, (arr) => (child(s(), 'home').publicIps = arr), { placeholder: 'none' }),
        'Usually empty. Separate several with commas.'
      )
    ),
    section(
      'cfg-proxy',
      'Behind a reverse proxy or login page',
      null,
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
      )
    ),
    section(
      'cfg-docker',
      'Docker and other machines',
      null,
      check('Cards from Docker labels', m.settings?.dockerLabels !== false, (on) => put(s(), 'dockerLabels', on ? undefined : false), 'Containers with homelab-hub.* labels get a card by themselves.'),
      check(
        'Search the home network for agents',
        discOn,
        (on) => {
          put(disc(), 'enabled', on ? undefined : false);
          tidyDisc();
        },
        'Agents on other machines then show up under Machines, ready to add.'
      ),
      grid(
        2,
        field(
          'Networks to search',
          listInput(() => (isObject(discRaw) ? discRaw.subnets : null), (arr) => (put(disc(), 'subnets', arr.length ? arr : undefined), tidyDisc()), { placeholder: 'the networks of this server' }),
          'Only if the right one is not found by itself, e.g. 192.168.1.0/24'
        ),
        field(
          'Agent ports',
          listInput(() => (isObject(discRaw) ? discRaw.ports : null), (arr) => (put(disc(), 'ports', arr.length ? arr.map((x) => (/^\d+$/.test(x) ? Number(x) : x)) : undefined), tidyDisc()), { placeholder: '8081, 8080' }),
          'Where your agents answer.'
        )
      )
    )
  ];
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
      fieldset(
        'Connection',
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
        check('Hide this machine', mc.hidden === true, (on) => put(mc, 'hidden', on || undefined))
      ),
      fieldset('Storage tiles', h('p', { class: 'cfg-h', text: 'Paths as the agent sees them (the right-hand side of its volume mounts).' }), diskEditor(mc, '/pools/root'))
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
  return [
    section(
      'cfg-own',
      'This server',
      'The machine the hub runs on. One storage tile per path; the free space is read live, the total size is a number you set.',
      grid(
        2,
        field('Caption', input(() => m.stats?.name, (v) => put(stats(), 'name', v), { placeholder: 'NAS' })),
        field('Network cards', listInput(() => m.stats?.network, (arr) => put(stats(), 'network', arr.length ? arr : undefined), { placeholder: 'all physical cards' }), 'For the network speed tile, e.g. eno1')
      ),
      h('h4', { text: 'Storage tiles' }),
      diskEditor(stats(), '/pools/tank')
    ),
    section(
      'cfg-stats',
      'Other machines',
      "Machines that run the hub in agent mode (HUB_MODE=agent). Each gets its own row of tiles, and its Docker containers count like this server's.",
      ...(machineBoxes.filter(Boolean).length ? machineBoxes : [h('p', { class: 'cfg-empty', text: 'No other machines yet.' })]),
      h('div', { class: 'cfg-add' }, addMachine)
    ),
    section('cfg-agents-sec', 'Found on the network', 'Agents the hub found on its home network that are not a machine here yet.', agentList())
  ];
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
  const addresses = fieldset(
    'Addresses',
    grid(
      2,
      field('Public address', addr('url', 'https://app.example.net'), 'Opened when you are away. Empty = home network only.'),
      field('Home address', addr('local', 'http://{nas}:8080'), 'Opened instead when you are on the home network. Optional.')
    )
  );
  const form = h(
    'div',
    { class: 'cfg-svcform' },
    fieldset(
      'Card',
      grid(2, field('Name', input(() => svc.name, (v) => put(svc, 'name', v), { after: refreshHead })), iconPicker(svc, refreshHead)),
      field('Description', input(() => svc.description, (v) => put(svc, 'description', v)), 'A short line under the name. Optional.'),
      check('Hide this card', svc.hidden === true, (on) => (put(svc, 'hidden', on || undefined), refreshHead()))
    ),
    addresses,
    fieldset(
      'Status',
      grid(
        2,
        checkField(svc),
        field(
          'Docker containers',
          listInput(() => svc.containers, (arr) => put(svc, 'containers', arr.length ? arr : undefined), { placeholder: '*immich*' }),
          'Show the health of these containers on the card, on this server or another machine. * matches anything; separate several with commas.'
        )
      ),
      check('Accept a self-signed certificate on the check', svc.insecure === true, (on) => put(svc, 'insecure', on || undefined))
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
    addresses.append(h('div', { class: 'cfg-chips' }, h('span', { class: 'cfg-h', text: 'Insert a host:' }), ...chips));
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

/** Does a service match the search box of the Services page? */
function matchesFilter(svc) {
  const q = st.filter.trim().toLowerCase();
  if (!q) return true;
  return [svc.name, svc.url, svc.local, svc.description, svc.icon].some((v) => typeof v === 'string' && v.toLowerCase().includes(q));
}

function secGroup(g, gi, groups) {
  if (!isObject(g)) return null;
  const list = Array.isArray(g.services) ? g.services : [];
  const filtering = st.filter.trim() !== '';
  const groupHit = filtering && typeof g.name === 'string' && g.name.toLowerCase().includes(st.filter.trim().toLowerCase());
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
  const items = list.map((svc, i) => {
    const el = svcItem(svc, i, list, redraw);
    if (el && filtering && !groupHit && !matchesFilter(svc)) el.hidden = true;
    return el;
  });
  const svcs = h('div', { class: 'cfg-svcs' }, ...items);
  if (list.length === 0) svcs.append(h('p', { class: 'cfg-empty', text: 'No services in this group yet.' }));
  // a service dropped on the group (not on another service) goes to its end; an empty group gets its list then
  const ownList = () => (Array.isArray(g.services) ? g.services : (g.services = []));
  svcs.dropInfo = { kind: 'svc', list: ownList, i: list.length };
  const sec = h(
    'section',
    { class: 'cfg-sec cfg-group', id: `cfg-group-${gi}` },
    head,
    h('div', { class: 'cfg-groupopts' }, check('Container health badges for every card', g.autoContainers === true, (on) => put(g, 'autoContainers', on || undefined), 'Matches Docker containers by the card name; cards without a container get no badge.')),
    svcs,
    h('div', { class: 'cfg-add' }, add)
  );
  if (filtering && !groupHit && !list.some((x) => isObject(x) && matchesFilter(x))) sec.hidden = true;
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
  if (!st) return;
  try {
    const { status, data } = await api('GET', '/api/config/agents');
    agents = status === 200 ? data : { enabled: true, agents: [], error: data.error ?? '' };
  } catch (err) {
    agents = { enabled: true, agents: [], error: err.message };
  }
  if (!st) return;
  if (agents.scanning && dlg?.open) agentsTimer = setTimeout(loadAgents, 1500); // ask again until the search is done
  document.getElementById('cfg-agents')?.replaceWith(agentList());
  if (st.tab === 'visual') renderNav();
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
  const head = h('div', { class: 'cfg-found-head' }, again);
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
  if (st?.tab === 'visual') {
    document.getElementById('cfg-found')?.replaceWith(secFound());
    renderNav();
  }
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
    'Containers without a card',
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

/** How many new things wait on a page (shown as a badge on its tab). */
function newCount(page) {
  if (page === 'found') return found?.list?.length ?? 0;
  if (page === 'machines') {
    const inConfig = new Set((Array.isArray(st.model?.stats?.machines) ? st.model.stats.machines : []).filter(isObject).map((m) => String(m.url ?? '').replace(/\/+$/, '')));
    return (agents?.agents ?? []).filter((a) => !a.added && !inConfig.has(a.url)).length;
  }
  return 0;
}

/** A small grey number beside a tab: how much is on that page. */
function itemCount(page) {
  const m = st.model ?? {};
  if (page === 'services') return (Array.isArray(m.groups) ? m.groups : []).filter(isObject).reduce((n, g) => n + (Array.isArray(g.services) ? g.services.length : 0), 0);
  if (page === 'machines') return 1 + (Array.isArray(m.stats?.machines) ? m.stats.machines.length : 0);
  if (page === 'hosts') return isObject(m.hosts) ? Object.keys(m.hosts).length : 0;
  if (page === 'themes') return isObject(m.themes) ? Object.keys(m.themes).length : 0;
  return null;
}

function goPage(page, sectionId) {
  if (st.page !== page) {
    st.page = page;
    renderForm();
    ui.main.scrollTop = 0;
  }
  if (sectionId) document.getElementById(sectionId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderNav() {
  if (!st?.model) return ui.nav.replaceChildren();
  const tabs = PAGES.map((p) => {
    const fresh = newCount(p.id);
    const count = itemCount(p.id);
    const b = h(
      'button',
      { type: 'button', class: 'cfg-tab', role: 'tab', 'aria-selected': st.page === p.id ? 'true' : 'false' },
      svg(p.icon, 17),
      h('span', { class: 'cfg-tab-l', text: p.label }),
      fresh > 0 ? h('span', { class: 'cfg-badge new', rawText: String(fresh), title: 'New' }) : count != null ? h('span', { class: 'cfg-badge', rawText: String(count) }) : null
    );
    b.addEventListener('click', () => goPage(p.id));
    return b;
  });
  const out = [h('div', { class: 'cfg-tablist', role: 'tablist', 'aria-label': 'Sections' }, ...tabs)];
  // on the Services page: a jump list of its groups
  if (st.page === 'services') {
    const groups = Array.isArray(st.model.groups) ? st.model.groups : [];
    const jumps = groups.map((g, gi) => {
      if (!isObject(g)) return null;
      const b = h('button', { type: 'button', class: 'sub', rawText: g.name || t('Unnamed group') });
      b.addEventListener('click', () => goPage('services', `cfg-group-${gi}`));
      return b;
    });
    if (jumps.some(Boolean)) out.push(h('div', { class: 'cfg-jumps' }, h('div', { class: 'cfg-navtitle', text: 'Groups' }), ...jumps));
  }
  ui.nav.replaceChildren(...out);
}

/** The top of the Services page: search, fold all, add a group. */
function servicesBar() {
  const m = st.model;
  const search = h('input', { type: 'search', class: 'cfg-in cfg-search', placeholder: 'Find a service…', 'aria-label': 'Find a service', spellcheck: 'false', autocomplete: 'off' });
  search.value = st.filter;
  search.addEventListener('input', () => {
    st.filter = search.value;
    const groups = Array.isArray(m.groups) ? m.groups : [];
    groups.forEach((g, gi) => document.getElementById(`cfg-group-${gi}`)?.replaceWith(secGroup(g, gi, groups) ?? h('span')));
  });
  const all = () => (Array.isArray(m.groups) ? m.groups : []).flatMap((g) => (isObject(g) && Array.isArray(g.services) ? g.services.filter(isObject) : []));
  const anyOpen = all().some((x) => st.open.has(x));
  const fold = textBtn('fold', anyOpen ? 'Close all' : 'Open all', () => {
    if (anyOpen) st.open = new WeakSet();
    else all().forEach((x) => st.open.add(x));
    renderForm();
  });
  const addGroup = textBtn('plus', 'Add group', () => {
    if (!Array.isArray(m.groups)) m.groups = [];
    m.groups.push({ name: '', services: [] });
    st.filter = '';
    touched();
    renderForm();
    const el = document.getElementById(`cfg-group-${m.groups.length - 1}`);
    el?.scrollIntoView({ block: 'center' });
    el?.querySelector('input')?.focus();
  });
  return h('div', { class: 'cfg-toolbar' }, search, fold, addGroup);
}

function renderForm() {
  const m = st.model;
  const scroll = ui.main.scrollTop;
  const page = PAGES.find((p) => p.id === st.page) ?? PAGES[0];
  st.page = page.id;
  const head = h('header', { class: 'cfg-pagehead' }, h('h3', { text: page.label }), page.desc ? h('p', { class: 'cfg-desc', text: page.desc }) : null);
  let body;
  if (page.id === 'services') {
    const groups = Array.isArray(m.groups) ? m.groups : [];
    const addGroup = textBtn('plus', 'Add group', () => {
      if (!Array.isArray(m.groups)) m.groups = [];
      m.groups.push({ name: '', services: [] });
      st.filter = '';
      touched();
      renderForm();
      const el = document.getElementById(`cfg-group-${m.groups.length - 1}`);
      el?.scrollIntoView({ block: 'center' });
      el?.querySelector('input')?.focus();
    }, 'wide');
    const sections = groups.map((g, gi) => secGroup(g, gi, groups));
    const nothing = st.filter.trim() && sections.every((x) => !x || x.hidden) ? h('p', { class: 'cfg-empty', text: 'No service matches.' }) : null;
    body = [servicesBar(), nothing, ...sections, groups.length === 0 ? h('p', { class: 'cfg-empty', text: 'No groups yet. A group is a heading on the page with its cards below it.' }) : null, addGroup];
  } else if (page.id === 'found') {
    const waiting = newCount('machines');
    const hint = waiting > 0 ? h('div', { class: 'cfg-callout' }, h('span', { text: waiting === 1 ? 'An agent was found on the network.' : 'Agents were found on the network.' }), textBtn('server', 'Show', () => goPage('machines', 'cfg-agents-sec'))) : null;
    body = [hint, secFound()];
  } else if (page.id === 'machines') body = secStats();
  else if (page.id === 'hosts') body = [secHosts()];
  else if (page.id === 'settings') body = secSettings();
  else if (page.id === 'themes') body = secThemes();
  else body = [secTools()];
  ui.main.replaceChildren(head, ...[body].flat().filter(Boolean));
  ui.main.scrollTop = scroll;
  renderNav();
}

// ---- color coding of the YAML text ----
// The text box draws its text transparent; a <pre> behind it shows the same text in colors. Only colors,
// never another font weight or size, so every character stays exactly where the text box has it.
const YAML_CONST = /^(?:true|false|yes|no|on|off|null|~)$/i;
const YAML_NUMBER = /^[-+]?(?:\d[\d_]*(?:\.\d+)?(?:e[-+]?\d+)?|\.\d+|0x[\da-f]+)$/i;

function yamlSpan(out, cls, text) {
  if (!text) return;
  if (!cls) return void out.push(document.createTextNode(text));
  const el = document.createElement('span');
  el.className = `y-${cls}`;
  el.textContent = text;
  out.push(el);
  return el;
}

/** A value: {host} shortcuts get their own color; a color value is underlined in that color. */
function yamlValue(out, cls, text) {
  const inner = cls === 'str' ? text.slice(1, -1) : text;
  if (/^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$|^(?:rgba?|hsla?)\([\d.%\s,/+-]+\)$/i.test(inner.trim())) {
    const el = yamlSpan(out, `${cls} y-color`, text);
    el.style.setProperty('--sw', inner.trim());
    return;
  }
  for (const part of text.split(/(\{[A-Za-z0-9_-]+\})/)) yamlSpan(out, /^\{[A-Za-z0-9_-]+\}$/.test(part) ? 'ph' : cls, part);
}

/** One line of YAML -> spans. Knows keys, values, strings, numbers, comments, lists and { } [ ] flow parts. */
function yamlLine(line, out) {
  if (/^\s*(?:---|\.\.\.)\s*$/.test(line)) return yamlSpan(out, 'punct', line);
  let i = 0;
  const flow = []; // open { or [
  let keyPos = true; // a key may start here
  const rest = () => line.slice(i);
  while (i < line.length) {
    const ws = /^\s+/.exec(rest());
    if (ws) {
      yamlSpan(out, '', ws[0]);
      i += ws[0].length;
      continue;
    }
    const c = line[i];
    if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      yamlSpan(out, 'comment', rest());
      break;
    }
    if (c === '-' && keyPos && flow.length === 0 && /^-(?:\s|$)/.test(rest())) {
      yamlSpan(out, 'punct', '-');
      i += 1;
      continue;
    }
    if (keyPos) {
      const key = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#,[\]{}"'][^#,[\]{}:]*?|[^\s#,[\]{}"'][^,[\]{}]*?)(\s*):(?=\s|$|[,\]}])/.exec(rest());
      if (key) {
        yamlSpan(out, 'key', key[1]);
        yamlSpan(out, '', key[2]);
        yamlSpan(out, 'punct', ':');
        i += key[0].length;
        keyPos = false;
        continue;
      }
    }
    if (c === '{' || c === '[') {
      flow.push(c);
      yamlSpan(out, 'punct', c);
      i += 1;
      keyPos = c === '{';
      continue;
    }
    if (c === '}' || c === ']' || c === ',') {
      if (c !== ',') flow.pop();
      yamlSpan(out, 'punct', c);
      i += 1;
      keyPos = c === ',' && flow.at(-1) === '{';
      continue;
    }
    keyPos = false;
    if (c === '"' || c === "'") {
      const str = c === '"' ? /^"(?:[^"\\]|\\.)*"?/.exec(rest()) : /^'(?:[^']|'')*'?/.exec(rest());
      yamlValue(out, 'str', str[0]);
      i += str[0].length;
      continue;
    }
    if ((c === '|' || c === '>' || c === '&' || c === '*' || c === '!') && /^[|>][-+\d]*(?:\s|$)|^[&*!][^\s,[\]{}]*/.test(rest())) {
      const m = /^[|>][-+\d]*|^[&*!][^\s,[\]{}]*/.exec(rest());
      yamlSpan(out, 'punct', m[0]);
      i += m[0].length;
      continue;
    }
    // a plain value: up to a comment, or in { } / [ ] up to the next , } or ]
    const plain = (flow.length ? /^[^,[\]{}]*?(?=\s+#|[,\]}]|$)/ : /^.*?(?=\s+#|$)/).exec(rest())[0] || c;
    const trimmed = plain.trimEnd();
    yamlValue(out, YAML_NUMBER.test(trimmed) ? 'num' : YAML_CONST.test(trimmed) ? 'const' : 'val', trimmed);
    yamlSpan(out, '', plain.slice(trimmed.length));
    i += plain.length;
  }
}

function highlightYaml(text) {
  const out = [];
  for (const line of text.split('\n')) {
    yamlLine(line, out);
    out.push(document.createTextNode('\n'));
  }
  out.push(document.createTextNode(' ')); // a last empty line still has its height
  return out;
}

function renderYaml() {
  const area = h('textarea', { class: 'cfg-yaml', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', wrap: 'off', 'aria-label': 'YAML text' });
  const colors = h('pre', { class: 'cfg-yamlhl', 'aria-hidden': 'true' });
  area.value = st.text;
  let frame = 0;
  const paint = () => {
    frame = 0;
    colors.replaceChildren(...highlightYaml(area.value));
    colors.scrollTop = area.scrollTop;
    colors.scrollLeft = area.scrollLeft;
  };
  paint();
  area.addEventListener('scroll', () => {
    colors.scrollTop = area.scrollTop;
    colors.scrollLeft = area.scrollLeft;
  });
  area.addEventListener('input', () => {
    st.text = area.value;
    frame ||= requestAnimationFrame(paint);
    touched();
  });
  area.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
    e.preventDefault(); // Tab indents, as YAML needs it
    area.setRangeText('  ', area.selectionStart, area.selectionEnd, 'end');
    area.dispatchEvent(new Event('input'));
  });
  ui.main.replaceChildren(h('div', { class: 'cfg-yamlbox' }, colors, area));
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
  const openThemes = st.tab === 'visual' && isObject(st.model?.themes) ? Object.keys(st.model.themes).filter((k) => st.open.has(st.model.themes[k])) : [];
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
      for (const k of openThemes) if (isObject(st.model?.themes?.[k])) st.open.add(st.model.themes[k]);
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

// ---- themes ----
/** The colors of a theme: YAML key, CSS variable, label (the same list as THEME_COLORS in src/config.js). */
const THEME_COLORS = [
  ['bg', '--bg', 'Background'],
  ['panel', '--panel', 'Cards'],
  ['panelHover', '--panel-hover', 'Card under the mouse'],
  ['border', '--border', 'Lines'],
  ['borderStrong', '--border-strong', 'Strong lines'],
  ['text', '--text', 'Text'],
  ['muted', '--muted', 'Quiet text'],
  ['accent', '--accent', 'Accent'],
  ['onAccent', '--on-accent', 'Text on accent'],
  ['up', '--up', 'Online'],
  ['down', '--down', 'Offline'],
  ['warn', '--warn', 'Warning'],
  ['unknown', '--unknown', 'Unknown'],
  ['track', '--track', 'Bar background'],
  ['shadow', '--shadow', 'Shadow']
];
const builtinThemes = () => window.hubTheme?.BUILTIN ?? [{ id: 'dark', name: 'Dark' }, { id: 'light', name: 'Light' }];
const isBuiltinTheme = (id) => id.toLowerCase() === 'auto' || builtinThemes().some((b) => b.id === id.toLowerCase());
let trying = null; // the theme shown on the whole page while the editor is open, or null

/** The colors of a built-in theme, read from its block in style.css. */
const baseCache = new Map();
function baseColors(base) {
  if (baseCache.has(base)) return baseCache.get(base);
  const selector = base === 'dark' ? ':root' : `:root[data-theme="${base}"]`;
  const out = {};
  for (const sheet of document.styleSheets) {
    let rules;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // not ours
    }
    for (const r of rules) {
      if (r.selectorText !== selector) continue;
      for (const [, v] of THEME_COLORS) if (r.style.getPropertyValue(v).trim()) out[v] = r.style.getPropertyValue(v).trim();
    }
  }
  baseCache.set(base, out);
  return out;
}

/** Any CSS color -> #rrggbb for the color picker (which knows no transparency), or null when it is no color. */
let colorCtx = null;
function toHex(color) {
  if (typeof color !== 'string' || !color.trim()) return null;
  colorCtx ??= document.createElement('canvas').getContext('2d');
  const probe = (start) => {
    colorCtx.fillStyle = start;
    colorCtx.fillStyle = color.trim();
    return colorCtx.fillStyle;
  };
  const v = probe('#010203');
  if (v !== probe('#040506')) return null; // the browser kept the old value: not a color
  if (v.startsWith('#')) return v;
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(v);
  return m ? '#' + m.slice(1, 4).map((n) => Number(n).toString(16).padStart(2, '0')).join('') : null;
}

const themeBase = (th) => {
  const b = String(th.base ?? 'dark').toLowerCase();
  return builtinThemes().some((x) => x.id === b) ? b : 'dark';
};

/** The theme as the page uses it: {id, base, colors: {'--accent': ...}}. */
function themeForPage(id, th) {
  const colors = {};
  for (const [key, v] of THEME_COLORS) if (typeof th[key] === 'string' && toHex(th[key])) colors[v] = th[key].trim();
  return { id, base: themeBase(th), colors };
}

/** Back to the theme this browser has chosen in the gear menu. */
function restoreTheme() {
  trying = null;
  try {
    const saved = JSON.parse(localStorage.getItem('hub-prefs') ?? '{}');
    window.hubTheme?.apply(typeof saved.theme === 'string' ? saved.theme : 'auto', saved.customTheme ?? null);
  } catch {
    window.hubTheme?.apply('auto', null);
  }
}

function renameTheme(old, el) {
  const m = st.model;
  const next = el.value.trim();
  if (next === old) return;
  const problem = !/^[a-z0-9][a-z0-9_-]{0,39}$/i.test(next)
    ? t('Use only letters, digits, - and _ for a theme name.')
    : isBuiltinTheme(next)
      ? t('"{name}" is a built-in theme. Choose another name.', { name: next })
      : Object.hasOwn(m.themes, next)
        ? t('"{name}" already exists.', { name: next })
        : '';
  if (problem) {
    el.value = old;
    st.note = problem;
    return updateStatus();
  }
  m.themes = Object.fromEntries(Object.entries(m.themes).map(([k, v]) => [k === old ? next : k, v]));
  if (trying === old) trying = next;
  touched();
  renderForm();
}

/** A small picture of the page in the theme's colors (set on the box itself, the page keeps its own). */
function themePreview(vars) {
  const box = h(
    'div',
    { class: 'cfg-tprev', 'aria-hidden': 'true' },
    h(
      'div',
      { class: 'cfg-tprev-card' },
      h('span', { class: 'cfg-tprev-title', text: 'Service' }),
      h('span', { class: 'cfg-tprev-muted', rawText: '192.168.1.10' }),
      h('span', { class: 'cfg-tprev-dots' }, ...['up', 'down', 'warn', 'unknown'].map((s) => h('i', { class: s })))
    ),
    h('div', { class: 'cfg-tprev-card hover' }, h('span', { class: 'cfg-tprev-bar' }, h('i')), h('span', { class: 'cfg-tprev-btn', text: 'Button' }))
  );
  for (const [name, value] of Object.entries(vars)) box.style.setProperty(name, value);
  return box;
}

/** A row of small color dots: what a closed theme looks like at a glance. */
function themeDots(vars) {
  const row = h('span', { class: 'cfg-tdots', 'aria-hidden': 'true' });
  for (const v of ['--bg', '--panel', '--text', '--accent', '--up', '--down']) {
    const dot = h('i');
    if (vars[v]) dot.style.setProperty('--c', vars[v]);
    row.append(dot);
  }
  return row;
}

/** One theme as a YAML block that can be pasted into another hub (Import, or the YAML itself). */
function themeYaml(id, th) {
  const lines = ['themes:', `  ${id}:`];
  for (const k of ['name', 'base', ...THEME_COLORS.map(([c]) => c)]) {
    if (th[k] != null && th[k] !== '') lines.push(`    ${k}: ${JSON.stringify(String(th[k]))}`);
  }
  return lines.join('\n') + '\n';
}

/** Copies text; also works on plain http:// addresses, where the clipboard API is not offered. */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = h('textarea', { class: 'cfg-offscreen', 'aria-hidden': 'true' });
    area.value = text;
    dlg.append(area); // inside the dialog: outside it nothing can be selected while the dialog is open
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}

/** A free key for a theme: `wanted`, else wanted-2, wanted-3 ... (never a built-in name). */
function freeThemeId(wanted) {
  const all = isObject(st.model.themes) ? st.model.themes : {};
  const base = (String(wanted ?? '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|-+$/g, '').slice(0, 34) || 'theme');
  let id = base;
  for (let i = 2; Object.hasOwn(all, id) || isBuiltinTheme(id); i++) id = `${base}-${i}`;
  return id;
}

/** The themes in a pasted YAML text: a whole `themes:` block, several themes, or the colors of one. */
function themesIn(model) {
  const known = new Set(['name', 'base', ...THEME_COLORS.map(([c]) => c)]);
  const isTheme = (v) => isObject(v) && Object.keys(v).some((k) => k === 'base' || (known.has(k) && k !== 'name'));
  const keep = (v) => Object.fromEntries(Object.entries(v).filter(([k, x]) => known.has(k) && (typeof x === 'string' || typeof x === 'number')).map(([k, x]) => [k, String(x)]));
  const map = isObject(model.themes) ? model.themes : model;
  if (isTheme(map)) return [[map.name ?? 'imported', keep(map)]];
  return Object.entries(map).filter(([, v]) => isTheme(v)).map(([k, v]) => [k, keep(v)]);
}

/** Adds the themes of a YAML text to the form; returns how many. The hub reads the YAML (one parser for everything). */
async function importThemes(text) {
  const { status, data } = await api('POST', '/api/config/render', { text });
  if (status !== 200) throw new Error(tr(data.error ?? 'The text could not be read.'));
  if (!isObject(data.model)) throw new Error(data.errors?.[0] ?? t('No theme found in the text.'));
  const found = themesIn(data.model);
  if (found.length === 0) throw new Error(t('No theme found in the text.'));
  const all = child(st.model, 'themes');
  for (const [wanted, th] of found) {
    all[freeThemeId(wanted)] = th;
    st.open.add(th);
  }
  return found.length;
}

function themeBox(id, th) {
  const m = st.model;
  const base = themeBase(th);
  const open = st.open.has(th);
  const vars = () => ({ ...baseColors(base), ...themeForPage(id, th).colors });
  let preview = themePreview(vars());
  let dots = themeDots(vars());
  const repaint = () => {
    const next = themePreview(vars());
    preview.replaceWith(next);
    preview = next;
    const nextDots = themeDots(vars());
    dots.replaceWith(nextDots);
    dots = nextDots;
    if (trying === id) window.hubTheme?.apply(id, themeForPage(id, th));
  };
  const baseName = builtinThemes().find((b) => b.id === base)?.name ?? base;
  const title = h('span', { class: 'cfg-svcname', rawText: th.name || id });
  const summary = h(
    'button',
    { type: 'button', class: 'cfg-svcsum', 'aria-expanded': open ? 'true' : 'false' },
    svg('chev', 14),
    dots,
    h('span', { class: 'cfg-svctext' }, title, h('span', { class: 'cfg-svcsub', rawText: `${id} · ${t('starts from {name}', { name: t(baseName) })}` }))
  );
  summary.addEventListener('click', () => {
    if (open) st.open.delete(th);
    else st.open.add(th);
    const next = themeBox(id, th); // only this theme is drawn again
    el.replaceWith(next);
    next.querySelector('.cfg-svcsum').focus();
  });

  const tryBtn = iconBtn('eye', trying === id ? t('Stop trying') : t('Try on the page'), () => {
    if (trying === id) restoreTheme();
    else {
      trying = id;
      window.hubTheme?.apply(id, themeForPage(id, th));
    }
    renderForm();
  });
  if (trying === id) tryBtn.classList.add('on');
  const share = iconBtn('share', t('Copy as YAML (to share it)'), async () => {
    st.note = (await copyText(themeYaml(id, th))) ? t('Copied. Paste it anywhere to share the theme; Import adds it to another hub.') : t('Could not copy. Switch to YAML and copy the block from there.');
    updateStatus();
  });
  const duplicate = iconBtn('copy', 'Duplicate', () => {
    const copy = JSON.parse(JSON.stringify(th));
    copy.name = t('{name} copy', { name: th.name || id });
    const all = child(m, 'themes');
    const nextId = freeThemeId(`${id}-copy`);
    // the copy goes right after the original
    m.themes = Object.fromEntries(Object.entries(all).flatMap(([k, v]) => (k === id ? [[k, v], [nextId, copy]] : [[k, v]])));
    st.open.add(copy);
    touched();
    renderForm();
  });
  const remove = iconBtn('trash', t('Remove theme {name}', { name: th.name || id }), () => {
    if (trying === id) restoreTheme();
    delete m.themes[id];
    touched();
    renderForm();
  }, { danger: true });

  const head = h('div', { class: 'cfg-svchead' }, summary, h('span', { class: 'cfg-acts' }, tryBtn, share, duplicate, remove));
  const el = h('section', { class: `cfg-svc cfg-theme${open ? ' open' : ''}` }, head);
  if (!open) return el;

  const key = h('input', { type: 'text', class: 'cfg-in mono', 'aria-label': 'Name in the file', spellcheck: 'false', autocomplete: 'off' });
  key.value = id;
  key.addEventListener('change', () => renameTheme(id, key));
  const baseSel = h('select', { class: 'cfg-in' }, ...builtinThemes().map((b) => h('option', { value: b.id, text: b.name })));
  baseSel.value = base;
  baseSel.addEventListener('change', () => {
    th.base = baseSel.value;
    touched();
    if (trying === id) window.hubTheme?.apply(id, themeForPage(id, th));
    renderForm();
  });

  const colors = THEME_COLORS.map(([k, v, label]) => {
    const fallback = baseColors(base)[v] ?? '';
    const picker = h('input', { type: 'color', class: 'cfg-swatch', 'aria-label': label, title: 'Pick a color' });
    picker.value = toHex(th[k]) ?? toHex(fallback) ?? '#000000';
    let reset = null;
    const text = input(() => th[k], (val) => put(th, k, val.trim()), {
      mono: true,
      placeholder: fallback,
      label,
      after: () => {
        const hex = toHex(text.value);
        if (hex) picker.value = hex;
        reset.disabled = th[k] == null;
        repaint();
      }
    });
    picker.addEventListener('input', () => {
      th[k] = picker.value;
      text.value = picker.value;
      reset.disabled = false;
      repaint();
      touched();
    });
    reset = iconBtn('x', t('Use the color of the base theme'), () => {
      delete th[k];
      text.value = '';
      picker.value = toHex(fallback) ?? '#000000';
      reset.disabled = true;
      repaint();
      touched();
    }, { disabled: th[k] == null });
    return h('div', { class: 'cfg-f' }, h('span', { class: 'cfg-l', text: label }), h('div', { class: 'cfg-color' }, picker, text, reset));
  });

  const nameIn = input(() => th.name, (v) => put(th, 'name', v), { placeholder: id, label: 'Name in the menu', after: () => (title.textContent = th.name || id) });
  el.append(
    h(
      'div',
      { class: 'cfg-svcform' },
      h(
        'div',
        { class: 'cfg-themetop' },
        h(
          'div',
          { class: 'cfg-grid' },
          field('Name in the menu', nameIn),
          grid(2, field('Name in the file', key, 'Letters, digits, - and _.'), field('Starts from', baseSel, 'Colors you leave empty come from here.'))
        ),
        preview
      ),
      grid(3, ...colors)
    )
  );
  return el;
}

/** The box where a theme someone shared is pasted (or loaded from a file). */
function themeImportBox() {
  const area = h('textarea', { class: 'cfg-in mono cfg-paste', rows: 7, spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Theme to import', placeholder: 'themes:\n  purple-night:\n    base: dark\n    accent: "#b48eff"' });
  area.value = st.themeImport?.text ?? '';
  area.addEventListener('input', () => (st.themeImport.text = area.value));
  const done = (n) => {
    st.themeImport = null;
    st.note = n === 1 ? t('1 theme imported. Check it, then save.') : t('{n} themes imported. Check them, then save.', { n });
    touched();
    renderForm();
  };
  const fail = (err) => {
    st.note = err.message;
    updateStatus();
  };
  const go = textBtn('plus', 'Import', () => importThemes(area.value).then(done, fail), 'primary');
  const file = textBtn(null, 'From a file…', async () => {
    const f = await pickFile('.yaml,.yml,.txt');
    if (f) importThemes(f.text).then(done, fail);
  });
  const cancel = textBtn(null, 'Cancel', () => {
    st.themeImport = null;
    renderForm();
  });
  return section(
    'cfg-themeimport',
    'Import themes',
    'Paste a theme someone shared: the YAML block that "Copy as YAML" gives, a whole themes: section, or just the colors. Themes with a name you already use get a number added.',
    area,
    h('div', { class: 'cfg-tools' }, go, file, cancel)
  );
}

function secThemes() {
  const m = st.model;
  const themes = isObject(m.themes) ? m.themes : {};
  const list = Object.entries(themes).filter(([, th]) => isObject(th));
  const boxes = list.map(([id, th]) => themeBox(id, th));
  const add = () => {
    const all = child(m, 'themes');
    const th = { name: t('My theme'), base: 'dark' };
    all[freeThemeId('my-theme')] = th;
    st.open.add(th);
    touched();
    renderForm();
    const last = [...ui.main.querySelectorAll('.cfg-theme')].pop();
    last?.scrollIntoView({ block: 'center' });
    last?.querySelector('.cfg-svcform input')?.select();
  };
  const anyOpen = list.some(([, th]) => st.open.has(th));
  const bar = h(
    'div',
    { class: 'cfg-toolbar' },
    textBtn('download', 'Import themes…', () => {
      st.themeImport = st.themeImport ? null : { text: '' };
      renderForm();
      ui.main.querySelector('.cfg-paste')?.focus();
    }),
    list.length > 1
      ? textBtn('fold', anyOpen ? 'Close all' : 'Open all', () => {
          for (const [, th] of list) {
            if (anyOpen) st.open.delete(th);
            else st.open.add(th);
          }
          renderForm();
        })
      : null,
    textBtn('plus', 'Add theme', add)
  );
  return [
    bar,
    st.themeImport ? themeImportBox() : null,
    h('div', { class: 'cfg-svcs' }, ...boxes),
    boxes.length === 0 ? h('p', { class: 'cfg-empty', text: 'No themes of your own yet. Add one, or import one someone shared.' }) : null,
    h('div', { id: 'cfg-themes', class: 'cfg-add' }, textBtn('plus', 'Add theme', add, 'wide'))
  ];
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
  dlg.addEventListener('close', () => trying && restoreTheme()); // a theme being tried ends with the editor
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
  const page = target.group != null ? 'services' : pageOf(target.section);
  if (page && page !== st.page) {
    st.page = page;
    st.filter = '';
    renderForm();
  }
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
    st.filter = '';
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
