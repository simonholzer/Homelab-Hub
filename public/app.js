// Renders /api/status. All text goes in through textContent (config values are never HTML).
import { t, setLanguage, LANGUAGES, language } from '/i18n.js';

const DEFAULT_REFRESH_SECONDS = 10;
const MIN_REFRESH_SECONDS = 2;
const MAX_REFRESH_SECONDS = 3600;

const $ = (id) => document.getElementById(id);
const els = {
  title: $('title'),
  subtitle: $('subtitle'),
  summary: $('summary'),
  netmode: $('netmode'),
  banner: $('banner'),
  stats: $('stats'),
  filter: $('filter'),
  groups: $('groups'),
  empty: $('empty'),
  updated: $('updated')
};

let data = null;
let drawnCards = null; // what the cards were last drawn from: a refresh with the same content draws nothing
let lastOk = null; // Date of the last successful fetch
let connection = 'ok'; // ok | lost | login

// Link mode: auto (the server decides), or forced home / away. Remembered in this browser.
const MODES = ['auto', 'home', 'away'];
let mode = 'auto';
try {
  const saved = localStorage.getItem('hub-link-mode');
  if (MODES.includes(saved)) mode = saved;
} catch {
  // storage blocked: auto it is
}

// What the page shows: chosen in the gear menu, remembered in this browser.
const prefs = { health: true, widgets: true, stats: true, pinned: true, newTab: true, compact: false, hiddenGroups: [], refreshSeconds: DEFAULT_REFRESH_SECONDS, theme: 'auto', customTheme: null, lang: 'auto' };
// the built-in themes come from theme.js; themes of your own (themes: in the YAML) from the server
const BUILTIN_THEMES = window.hubTheme?.BUILTIN ?? [{ id: 'dark', name: 'Dark' }, { id: 'light', name: 'Light' }];
const isBuiltinTheme = (id) => id === 'auto' || BUILTIN_THEMES.some((b) => b.id === id);
/** A whole number of seconds within the allowed range, or null. */
function validRefresh(value) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n >= MIN_REFRESH_SECONDS && n <= MAX_REFRESH_SECONDS ? n : null;
}
try {
  const saved = JSON.parse(localStorage.getItem('hub-prefs') ?? '{}');
  for (const key of ['health', 'widgets', 'stats', 'pinned', 'newTab', 'compact']) if (typeof saved[key] === 'boolean') prefs[key] = saved[key];
  prefs.refreshSeconds = validRefresh(saved.refreshSeconds) ?? DEFAULT_REFRESH_SECONDS;
  if (Array.isArray(saved.hiddenGroups)) prefs.hiddenGroups = saved.hiddenGroups.filter((n) => typeof n === 'string');
  if (typeof saved.theme === 'string' && /^[a-z0-9][a-z0-9_-]*$/i.test(saved.theme)) prefs.theme = saved.theme;
  if (saved.customTheme && typeof saved.customTheme === 'object' && saved.customTheme.id === prefs.theme) prefs.customTheme = saved.customTheme;
  if (saved.lang === 'auto' || Object.hasOwn(LANGUAGES, saved.lang)) prefs.lang = saved.lang;
} catch {
  // storage blocked or damaged: everything is shown
}
function savePrefs() {
  try {
    localStorage.setItem('hub-prefs', JSON.stringify(prefs));
  } catch {
    // storage blocked: lasts until reload
  }
}

/** The chosen theme, or what the system says (the same code as before the page was drawn: theme.js). */
function applyTheme() {
  if (window.hubTheme) window.hubTheme.apply(prefs.theme, prefs.customTheme);
  else if (prefs.theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = prefs.theme;
  document.body.classList.toggle('compact', prefs.compact);
}

/** Chooses a theme: 'auto', a built-in one or one of the YAML's (whose colors are then kept in this browser too). */
function chooseTheme(id) {
  prefs.theme = id;
  prefs.customTheme = isBuiltinTheme(id) ? null : (data?.themes ?? []).find((t) => t.id === id) ?? null;
  if (!isBuiltinTheme(id) && !prefs.customTheme) prefs.theme = 'auto';
  savePrefs();
  applyTheme();
  darkLogo.clear(); // logos are measured against the new background
  drawnCards = null;
}

/** A theme of your own that was changed or removed in the YAML: the page follows. */
function syncCustomTheme() {
  if (!data || isBuiltinTheme(prefs.theme)) return;
  const current = (data.themes ?? []).find((t) => t.id === prefs.theme) ?? null;
  if (JSON.stringify(current) !== JSON.stringify(prefs.customTheme)) chooseTheme(prefs.theme);
}

/** Things this browser was told once and should not see again (the first-start guide, a notice). */
let dismissed = [];
try {
  const saved = JSON.parse(localStorage.getItem('hub-dismissed') ?? '[]');
  if (Array.isArray(saved)) dismissed = saved.filter((k) => typeof k === 'string');
} catch {
  // storage blocked: shown again after a reload
}
function dismiss(key) {
  dismissed = [...new Set([...dismissed, key])];
  try {
    localStorage.setItem('hub-dismissed', JSON.stringify(dismissed));
  } catch {
    // storage blocked: lasts until reload
  }
  render();
}

/** The language chosen in this browser, else the one set in the YAML, else the browser's. Returns true when it changed. */
function applyLanguage() {
  const changed = setLanguage(prefs.lang !== 'auto' ? prefs.lang : data?.language ?? 'auto');
  // the fixed texts of index.html
  els.filter.placeholder = t('Filter services  ( press / )');
  els.filter.setAttribute('aria-label', t('Filter services'));
  gear.title = t('Settings');
  gear.setAttribute('aria-label', t('Settings'));
  panel.setAttribute('aria-label', t('Settings'));
  $('link-containers').textContent = t('containers');
  $('link-status').textContent = t('status JSON');
  return changed;
}

/** True when cards should open their local (home network) address. */
function atHome() {
  if (mode === 'home') return true;
  if (mode === 'away') return false;
  return data?.client?.home === true;
}

/** The address a card opens right now ('' = nothing to open, i.e. home-only service while away). */
function linkFor(svc) {
  return atHome() && svc.localUrl ? svc.localUrl : svc.url;
}

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) if (c != null) el.append(c);
  return el;
}

const STATUS_LABEL = { up: 'Online', down: 'Offline', unknown: 'Unknown', pending: 'Checking…' };
const HEALTH_LABEL = {
  healthy: 'healthy',
  completed: 'finished',
  running: 'running',
  starting: 'starting',
  unhealthy: 'unhealthy',
  stopped: 'stopped',
  missing: 'no container found'
};

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function formatBytes(n) {
  if (n == null) return '?';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** "33.9 / 106.6 GB": both numbers in the unit of the total. */
function formatUsedOfTotal(used, total) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  while (total / 1024 ** i >= 1024 && i < units.length - 1) i++;
  const f = (n) => (n >= 100 ? Math.round(n) : n.toFixed(1));
  return `${f(used / 1024 ** i)} / ${f(total / 1024 ** i)} ${units[i]}`;
}

/** Bytes per second, in the units network speeds are usually read in. */
function formatRate(bytesPerSec) {
  return `${formatBytes(bytesPerSec)}/s`;
}

function formatUptime(sec) {
  const d = Math.floor(sec / 86400);
  const hr = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return t('{d} d {h} h', { d, h: hr });
  if (hr > 0) return t('{h} h {m} min', { h: hr, m });
  return t('{m} min', { m });
}

/** A widget value (see src/widgets.js) in the way its format asks for. */
function formatWidgetValue(value, format) {
  if (typeof value !== 'number' || format === 'text') return String(value);
  const num = (n, digits) => n.toLocaleString(language(), { maximumFractionDigits: digits });
  if (format === 'bytes') return formatBytes(value);
  if (format === 'percent') return `${num(value, 1)} %`;
  if (format === 'duration') return formatUptime(value);
  return num(value, Number.isInteger(value) ? 0 : 2);
}

/** The values a card's widget shows, under its name. */
function widgetBox(w) {
  if (!w) return null;
  if (w.error) return h('div', { class: 'widget bad', title: t(w.error), text: t(w.error) });
  const items = (w.fields ?? []).map((f) => {
    const value = f.error ? '!' : w.pending || f.value == null ? '…' : `${formatWidgetValue(f.value, f.format)}${f.suffix ? ` ${f.suffix}` : ''}`;
    return h('div', { class: `wf${f.error ? ' bad' : ''}`, title: f.error ? t(f.error) : null }, h('span', { class: 'wv', text: value }), h('span', { class: 'wl', text: f.label }));
  });
  return items.length ? h('div', { class: 'widget' }, ...items) : null;
}

function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 5) return t('just now');
  if (s < 60) return t('{n} s ago', { n: s });
  if (s < 3600) return t('{n} min ago', { n: Math.round(s / 60) });
  return t('{n} h ago', { n: Math.round(s / 3600) });
}

function renderSummary() {
  els.summary.replaceChildren();
  if (!data) return;
  const { up, down, unknown } = data.summary;
  const chip = (cls, n, word) => h('span', { class: `chip ${cls} ${n === 0 ? 'zero' : ''}`, text: `${n} ${word}` });
  els.summary.append(chip('up', up, t('online')), chip('down', down, t('offline')));
  if (unknown > 0) els.summary.append(chip('', unknown, t('unknown')));
}

function renderNetmode() {
  const b = els.netmode;
  b.hidden = !data;
  if (!data) return;
  const home = atHome();
  const how = mode === 'auto' ? (data.client?.home == null ? t('auto, not sure') : t('auto')) : t('set by you');
  b.textContent = `${home ? t('Home network') : t('Away')} · ${how}`;
  b.dataset.state = home ? 'home' : 'away';
  b.title = [
    home ? t('Cards open their local address.') : t('Cards open their public address.'),
    mode === 'auto' ? data.client?.reason ?? '' : t('Switched by hand.'),
    t('Click to switch: Auto → Home → Away.')
  ].filter(Boolean).join('\n');
}

function renderBanner() {
  const parts = [];
  // The hub runs in a container on a server, yet is told it is "not on the home network" (a setting
  // meant for a preview on a laptop, easily copied along with a config): local addresses are then never used.
  if (data?.client?.via === 'server-network' && data.stats?.source === 'proc' && !dismissed.includes('runs-at-home')) {
    const box = h('div', {}, t('This hub is set to "not on the home network", so cards never open their local addresses. If this server is at home, switch on "This hub runs on the home network".') + ' ');
    if (data.editor) {
      const fix = h('button', { type: 'button', text: t('Open the setting') });
      fix.addEventListener('click', () => openEditor({ section: 'cfg-general' }));
      box.append(fix);
    }
    const hide = h('button', { type: 'button', text: t('Hide') });
    hide.addEventListener('click', () => dismiss('runs-at-home'));
    box.append(hide);
    parts.push({ cls: '', node: box });
  }
  if (data?.configError) {
    const box = h('div', {});
    box.append(h('strong', { text: t('Config problem') }), document.createTextNode(t(data.configError.message)));
    if (data.configError.lines.length) {
      const ul = h('ul');
      for (const line of data.configError.lines) ul.append(h('li', { text: line }));
      box.append(ul);
    }
    parts.push({ cls: 'error', node: box });
  }
  if (connection === 'login') {
    const box = h('div', {}, t('Your login has expired. '));
    const btn = h('button', { type: 'button', text: t('Log in again') });
    btn.addEventListener('click', () => location.reload());
    box.append(btn);
    parts.push({ cls: '', node: box });
  } else if (connection === 'lost') {
    parts.push({ cls: '', node: h('div', { text: lastOk ? t("Can't reach the hub right now. Showing the last data ({ago}).", { ago: ago(lastOk) }) : t("Can't reach the hub right now. Showing the last data.") }) });
  }
  if (data && data.checkedAt && Date.now() - data.checkedAt > data.checkIntervalSeconds * 3000 + 10_000) {
    parts.push({ cls: '', node: h('div', { text: t('The status checks seem stuck: the data is old.') }) });
  }
  els.banner.replaceChildren();
  els.banner.hidden = parts.length === 0;
  els.banner.className = `banner ${parts.some((p) => p.cls === 'error') ? 'error' : ''}`;
  for (const p of parts) els.banner.append(p.node);
}

/** A stat tile. opts.pct draws a bar (0-100); opts.cachePct a lighter second part after it; opts.wide = double width. */
function statBox(label, value, note, opts = {}) {
  const box = h('div', { class: `stat${opts.wide ? ' wide' : ''}${opts.compact ? ' compact' : ''}` }, h('div', { class: 'label', text: label }), h('div', { class: 'value', text: value }));
  if (opts.pct != null) {
    const pct = Math.max(0, Math.min(100, opts.pct));
    const level = pct >= 90 ? 'high' : pct >= 70 ? 'mid' : 'low';
    const bar = h('div', { class: 'bar', role: 'meter', 'aria-label': label, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(pct) });
    const fill = h('div', { class: `fill ${level}` });
    fill.style.width = `${pct}%`; // a CSS property set from script, allowed by the strict CSP
    bar.append(fill);
    if (opts.cachePct) {
      const cache = h('div', { class: 'fill cache' });
      cache.style.width = `${Math.min(opts.cachePct, 100 - pct)}%`;
      bar.append(cache);
    }
    box.append(bar);
  }
  if (note) box.append(h('div', { class: 'note', text: note }));
  return box;
}

function renderStats() {
  const s = data?.stats;
  const machines = (data?.machines ?? []).filter((m) => m.stats || m.error);
  els.stats.replaceChildren();
  // no numbers although this is a server: say why instead of showing nothing (only to who can fix it)
  const why = !s && data?.statsError && data.editor ? data.statsError : '';
  els.stats.hidden = (!s && machines.length === 0 && !why) || !prefs.stats;
  if (els.stats.hidden) return;
  if (why) {
    els.stats.append(h('div', { class: 'stats-line', text: t('No server stats: {error}. In Docker, mount /proc and /sys of the host as in the example compose file.', { error: why }) }));
  }
  if (s) {
    const preview = s.source === 'os';
    appendStats(
      s,
      preview ? t('This computer · local preview') : data.statsLabel,
      preview ? t('No /proc here (Windows/macOS), so these are the numbers of the computer running the hub, not of your server.') : ''
    );
  }
  // the other machines (stats.machines in the YAML), each with its own caption
  for (const m of machines) {
    if (m.stats) appendStats(m.stats, m.name);
    else {
      els.stats.append(h('div', { class: 'stats-title', text: m.name }));
      els.stats.append(statBox(t('Stats'), t('unreachable'), t(m.error)));
    }
  }
}

let statsClosed = {}; // caption -> true (closed) / false (open); missing = closed on a phone, open otherwise
try {
  const saved = JSON.parse(localStorage.getItem('hub-stats-closed') ?? '{}');
  if (saved && typeof saved === 'object' && !Array.isArray(saved)) statsClosed = saved;
} catch {
  // storage blocked or damaged: automatic
}

/** One machine's tiles, under its caption. */
function appendStats(s, caption, title = '') {
  if (caption) {
    // The caption opens and closes this machine's tiles. Closed, one line sums them up. On a phone they
    // start closed, so the links come first; your own choice is remembered in this browser.
    const closed = statsClosed[caption] ?? window.matchMedia('(max-width: 520px)').matches;
    const head = h(
      'button',
      { type: 'button', class: 'stats-title', title, 'aria-expanded': closed ? 'false' : 'true' },
      h('span', { class: 'chev', 'aria-hidden': 'true', text: '▾' }),
      h('span', { text: caption })
    );
    head.addEventListener('click', () => {
      statsClosed[caption] = !closed;
      try {
        localStorage.setItem('hub-stats-closed', JSON.stringify(statsClosed));
      } catch {
        // storage blocked: lasts until reload
      }
      renderStats();
    });
    els.stats.append(head);
    if (closed) {
      const parts = [];
      if (s.cpuPercent != null) parts.push(`${t('CPU')} ${s.cpuPercent} %`);
      if (s.memory?.total > 0) parts.push(`${t('Memory')} ${Math.round((s.memory.used / s.memory.total) * 100)} %`);
      if (s.load) parts.push(`${t('Load')} ${s.load[0].toFixed(2)}`);
      for (const d of s.disks ?? []) if (d.totalBytes) parts.push(`${d.name} ${Math.round(((d.totalBytes - d.freeBytes) / d.totalBytes) * 100)} %`);
      els.stats.append(h('div', { class: 'stats-line', text: parts.join(' · ') }));
      return;
    }
  }
  if (s.cpuPercent != null) {
    const note = [s.cores ? t('{n} threads', { n: s.cores }) : '', s.cpuTempC != null ? `${s.cpuTempC} °C` : ''].filter(Boolean).join(' · ');
    els.stats.append(statBox(t('CPU'), `${s.cpuPercent} %`, note, { pct: s.cpuPercent, wide: true }));
  } else if (s.cpuTempC != null) {
    els.stats.append(statBox(t('CPU temperature'), `${s.cpuTempC} °C`));
  }
  if (s.memory && s.memory.total > 0) {
    const pct = (s.memory.used / s.memory.total) * 100;
    const note = s.memory.cache != null ? t('{pct} % used · lighter part: {cache} ZFS cache (freed when needed)', { pct: Math.round(pct), cache: formatBytes(s.memory.cache) }) : t('{pct} % used', { pct: Math.round(pct) });
    const cachePct = s.memory.cache ? (s.memory.cache / s.memory.total) * 100 : 0;
    els.stats.append(statBox(t('Memory'), t('{used} of {total}', { used: formatBytes(s.memory.used), total: formatBytes(s.memory.total) }), note, { pct, cachePct, wide: true }));
  }
  if (s.network?.rxBytesPerSec != null) {
    const n = s.network;
    const box = statBox(t('Network'), `↓ ${formatRate(n.rxBytesPerSec)}`, `↑ ${formatRate(n.txBytesPerSec)}`);
    box.title = t(n.interfaces.length > 1 ? 'Average over the last check cycle, cards: {cards}' : 'Average over the last check cycle, card: {cards}', { cards: n.interfaces.join(', ') });
    els.stats.append(box);
  }
  if (s.load) {
    // Load = how many tasks on average are running or waiting for a CPU thread. As many as there are
    // threads means fully busy; more means a queue. The bar shows the 1-minute value against the thread count.
    const [l1, l5, l15] = s.load;
    const threads = s.cores || null;
    const note = t('5 min {a} · 15 min {b}', { a: l5.toFixed(2), b: l15.toFixed(2) }) + (threads ? ` · ${t('{n} threads', { n: threads })}` : '');
    const box = statBox(t('Load'), `${l1.toFixed(2)}`, note, threads ? { pct: (l1 / threads) * 100 } : {});
    box.title = t('Load average: tasks running or waiting for the CPU, averaged over 1, 5 and 15 minutes.') + (threads ? ` ${t('{n} means every thread is busy all the time; higher means tasks have to wait.', { n: threads })}` : '');
    els.stats.append(box);
  }
  if (s.uptimeSeconds != null) els.stats.append(statBox(t('Uptime'), formatUptime(s.uptimeSeconds)));
  for (const d of s.disks ?? []) {
    if (d.error) {
      const hint =
        d.error === 'ENOENT' && d.path
          ? t('{path} does not exist inside the container. Add a line like this to the volumes in your compose file, then restart:  - /path/on/the/server:{path}:ro', { path: d.path })
          : d.error === 'EACCES'
            ? t('No permission to read {path}.', { path: d.path ?? '' })
            : d.error;
      els.stats.append(statBox(d.name, t('unreadable'), hint, { wide: true }));
    } else if (d.totalBytes) {
      const used = d.totalBytes - d.freeBytes;
      const pct = (used / d.totalBytes) * 100;
      els.stats.append(statBox(d.name, formatUsedOfTotal(used, d.totalBytes), t('{free} free · {pct} % used', { free: formatBytes(d.freeBytes), pct: Math.round(pct) }), { pct, compact: true }));
    } else {
      els.stats.append(statBox(d.name, t('{free} free', { free: formatBytes(d.freeBytes) })));
    }
  }
}

function healthBadge(svc) {
  if (!prefs.health || !svc.watchContainers) return null;
  const c = svc.containers;
  if (!c) return h('span', { class: 'health', title: data.dockerError || t('No container data yet'), text: t('containers: ?') });
  const label = t(HEALTH_LABEL[c.state] ?? c.state);
  const text = c.state === 'missing' ? label : c.total > 1 ? `${label} (${c.total})` : label;
  const title = c.items.map((i) => `${i.name}${i.machine ? ` (${i.machine})` : ''}: ${t(HEALTH_LABEL[i.health] ?? i.health)}`).join('\n') || t('No matching container. See /api/containers.');
  return h('span', { class: `health ${c.state}`, title, text: `● ${text}` });
}

const DEFAULT_ICON = '/icons/default.svg';
const PENCIL = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4"/></svg>';

/** The app's icon: a file from /icons named in the config, or the default one. */
// Logos have no background. Dark ones (Portainer, Cockpit, ...) would vanish on the dark page, so each
// logo is measured once and, when it is mostly dark, flipped to light (class "flip", see style.css).
const darkLogo = new Map(); // icon name -> true/false

function isMostlyDark(img) {
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, 32, 32);
    const px = ctx.getImageData(0, 0, 32, 32).data;
    let sum = 0;
    let weight = 0;
    for (let i = 0; i < px.length; i += 4) {
      const a = px[i + 3] / 255;
      if (a < 0.1) continue;
      sum += ((0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255) * a;
      weight += a;
    }
    const dark = getComputedStyle(document.documentElement).colorScheme !== 'light';
    // a mostly dark logo vanishes on the dark page, a mostly light one on the light page
    return weight > 0 && (dark ? sum / weight < 0.3 : sum / weight > 0.72);
  } catch {
    return false; // can't measure: leave the logo as it is
  }
}

function iconFor(name) {
  const img = h('img', { class: 'icon', alt: '', width: 36, height: 36, decoding: 'async', 'aria-hidden': 'true' });
  const safe = /^[a-z0-9][a-z0-9_-]*$/i.test(name ?? '');
  const key = safe ? name : '';
  if (darkLogo.get(key)) img.classList.add('flip');
  img.addEventListener('load', () => {
    if (!darkLogo.has(key)) darkLogo.set(key, isMostlyDark(img));
    img.classList.toggle('flip', darkLogo.get(key) === true);
  }, { once: true });
  img.addEventListener('error', () => {
    if (!img.src.endsWith(DEFAULT_ICON)) img.src = DEFAULT_ICON; // missing file: default icon
  }, { once: true });
  // data.icons (from /api/status): icon name -> version of its file. Without an entry there is no file.
  const versions = data?.icons;
  const version = safe && versions ? versions[name] : undefined;
  if (versions && !version) img.src = DEFAULT_ICON;
  else if (safe) img.src = version ? `/icons/${name}.svg?v=${version}` : `/icons/${name}.svg`;
  else img.src = DEFAULT_ICON;
  return img;
}

// ---- pins: remembered in this browser ----
let pins = [];
try {
  const saved = JSON.parse(localStorage.getItem('hub-pins') ?? '[]');
  if (Array.isArray(saved)) pins = saved.filter((k) => typeof k === 'string');
} catch {
  // storage blocked or damaged: no pins
}
const pinKey = (group, svc) => `${group}/${svc.name}`;
function togglePin(key) {
  pins = pins.includes(key) ? pins.filter((k) => k !== key) : [...pins, key];
  try {
    localStorage.setItem('hub-pins', JSON.stringify(pins));
  } catch {
    // storage blocked: the pin lasts until reload
  }
  renderGroups();
}

/**
 * A widget tile: only a widget's values, under a small heading. A click opens the service when the tile has an
 * address. `groupName` null = a tile of the widget row at the top.
 */
function tileCard(svc, groupName) {
  const href = svc.url || svc.localUrl ? linkFor(svc) : null;
  const top = h('div', { class: 'row' }, svc.icon ? iconFor(svc.icon) : null, h('span', { class: 'name', text: svc.name }));
  const values = widgetBox(svc.widget) ?? h('div', { class: 'widget bad', text: t('No values yet') });
  const a = href
    ? h('a', { class: 'card wtile', href, target: prefs.newTab ? '_blank' : null, rel: 'noopener noreferrer' }, top, values)
    : h('div', { class: 'card wtile' }, top, values);
  let edit = null;
  if (data?.editor) {
    edit = h('button', { type: 'button', class: 'pin edit', 'aria-label': t('Edit {name}', { name: svc.name }), title: t('Edit') });
    edit.innerHTML = PENCIL; // fixed markup, no config text
    edit.addEventListener('click', () => openEditor(groupName == null ? { section: 'cfg-tiles', tile: svc.name } : { group: groupName, service: svc.name }));
  }
  return h('div', { class: `cardwrap tilewrap${edit ? ' editable' : ''}` }, a, edit);
}

function card(svc, groupName) {
  if (svc.tile) return tileCard(svc, groupName);
  const plain = svc.status === 'none'; // a plain link (check: none): no dot
  const status = plain ? 'none' : svc.status in STATUS_LABEL ? svc.status : 'unknown';
  const pillTitle = [t(svc.detail), svc.ms != null ? `${svc.ms} ms` : ''].filter(Boolean).join(' · ');
  const pill = plain ? null : h('span', { class: `pill ${status}`, title: pillTitle, text: t(STATUS_LABEL[status]) });
  const top = h('div', { class: 'row' }, iconFor(svc.icon), h('span', { class: 'name', text: svc.name }), pill);
  const href = linkFor(svc);
  const homeOnly = !svc.url; // no public address: only reachable on the home network
  const hostText = href ? hostOf(href) : t('{host} (home network only)', { host: hostOf(svc.localUrl) });
  const meta = h('div', { class: 'meta' }, h('span', { class: 'host', text: hostText }), healthBadge(svc));
  const body = [top];
  if (svc.description) body.push(h('div', { class: 'desc', text: svc.description }));
  if (prefs.widgets) body.push(widgetBox(svc.widget));
  const cls = `card ${status}${href ? '' : ' homeonly'}`;
  const a = href
    ? h('a', { class: cls, href, target: prefs.newTab ? '_blank' : null, rel: 'noopener noreferrer' }, ...body)
    : h('div', { class: cls, title: t('Only reachable on the home network. Switch to Home at the top if you are there.') }, ...body);
  if (status === 'down' && svc.detail) a.append(h('div', { class: 'problem', text: t(svc.detail) }));
  if (homeOnly && href) a.append(h('div', { class: 'tag', text: t('home network only') }));
  a.append(meta);

  // The pin button sits next to the card (a button inside a link is not valid HTML).
  const key = pinKey(groupName, svc);
  const pinned = pins.includes(key);
  const pin = h('button', {
    type: 'button',
    class: `pin${pinned ? ' on' : ''}`,
    'aria-pressed': pinned ? 'true' : 'false',
    'aria-label': t(pinned ? 'Unpin {name}' : 'Pin {name}', { name: svc.name }),
    title: pinned ? t('Unpin') : t('Pin to the top')
  });
  pin.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M9 3h6l-1 6 3 3v2h-4v6l-1 1-1-1v-6H7v-2l3-3z"/></svg>'; // fixed markup, no config text
  pin.addEventListener('click', () => togglePin(key));
  // straight to this card in the editor (cards made from Docker labels are not in the config)
  let edit = null;
  if (data?.editor && !svc.fromDocker) {
    edit = h('button', { type: 'button', class: 'pin edit', 'aria-label': t('Edit {name}', { name: svc.name }), title: t('Edit') });
    edit.innerHTML = PENCIL; // fixed markup, no config text
    edit.addEventListener('click', () => openEditor({ group: groupName, service: svc.name }));
  }
  return h('div', { class: `cardwrap${edit ? ' editable' : ''}` }, a, edit, pin);
}

// ---- open / closed servers: remembered in this browser ----
let collapsed = {}; // group name -> true (closed) / false (open); missing = automatic
try {
  const saved = JSON.parse(localStorage.getItem('hub-collapsed') ?? '{}');
  if (saved && typeof saved === 'object' && !Array.isArray(saved)) collapsed = saved;
} catch {
  // storage blocked or damaged: automatic
}
function toggleGroup(name, close) {
  collapsed[name] = close;
  try {
    localStorage.setItem('hub-collapsed', JSON.stringify(collapsed));
  } catch {
    // storage blocked: lasts until reload
  }
  renderGroups();
}

const GROUP_LABEL = { up: 'All online', down: 'Offline', partial: 'Some offline', none: 'Not checked yet' };

/** green = all online, red = all offline, amber = some offline; services without a verdict don't count. */
/** "3 of 4 online" (plain links are not counted), or "5 links" for a group of plain links only. */
function groupCount(g, up) {
  const checked = g.services.filter((s) => s.status !== 'none').length;
  if (checked > 0) return t('{n} of {m} online', { n: up, m: checked });
  const links = g.services.filter((s) => !s.tile).length;
  if (links === 0) return g.services.length === 1 ? t('1 widget') : t('{n} widgets', { n: g.services.length });
  return links === 1 ? t('1 link') : t('{n} links', { n: links });
}

function groupState(g) {
  let up = 0;
  let down = 0;
  for (const s of g.services) {
    if (s.status === 'up') up++;
    else if (s.status === 'down') down++;
  }
  const state = up > 0 && down === 0 ? 'up' : up === 0 && down > 0 ? 'down' : up > 0 ? 'partial' : 'none';
  return { up, down, state };
}

function renderGroups() {
  const q = els.filter.value.trim().toLowerCase();
  els.groups.replaceChildren();
  const matches = (s, g) => !q || `${s.name} ${s.description ?? ''} ${hostOf(s.url || s.localUrl)} ${g.name}`.toLowerCase().includes(q);
  let shown = 0;

  // Pinned services come first, in the order they were pinned, and stay in their own group below too.
  const pinned = [];
  for (const key of pins) {
    for (const g of data?.groups ?? []) {
      const s = g.services.find((x) => pinKey(g.name, x) === key);
      if (s && matches(s, g)) pinned.push({ s, g });
    }
  }
  // the widget row: tiles of their own at the top
  const tiles = (data?.tiles ?? []).filter((s) => !q || `${s.name}`.toLowerCase().includes(q));
  if (tiles.length > 0) {
    shown += tiles.length;
    const cards = h('div', { class: 'cards tiles' });
    for (const s of tiles) cards.append(tileCard(s, null));
    els.groups.append(h('section', { class: 'group tilerow' }, h('h2', { text: t('Widgets') }), cards));
  }

  if (pinned.length > 0 && prefs.pinned) {
    const cards = h('div', { class: 'cards' });
    for (const { s, g } of pinned) cards.append(card(s, g.name));
    els.groups.append(h('section', { class: 'group pinned' }, h('h2', { text: t('Pinned') }), cards));
  }

  for (const g of data?.groups ?? []) {
    if (prefs.hiddenGroups.includes(g.name)) continue;
    const list = g.services.filter((s) => matches(s, g));
    if (list.length === 0) continue;
    shown += list.length;
    const { up, state } = groupState(g);
    // Open or closed: your choice if you made one, else closed only when every server in it is offline.
    // A running search opens everything so matches are never hidden.
    const closed = q ? false : collapsed[g.name] ?? state === 'down';
    const head = h(
      'button',
      { type: 'button', class: 'grouphead', 'aria-expanded': closed ? 'false' : 'true', title: closed ? t('Open') : t('Close') },
      h('span', { class: 'chev', 'aria-hidden': 'true', text: '▾' }),
      h('span', { class: `gdot ${state}`, title: t(GROUP_LABEL[state]) }),
      h('span', { class: 'gname', text: g.name }),
      h('span', { class: 'gcount', text: groupCount(g, up) })
    );
    head.addEventListener('click', () => toggleGroup(g.name, !closed));
    let editGroup = null;
    if (data?.editor && !String(g.id).startsWith('d:')) {
      editGroup = h('button', { type: 'button', class: 'gedit', 'aria-label': t('Edit {name}', { name: g.name }), title: t('Edit this group') });
      editGroup.innerHTML = PENCIL; // fixed markup, no config text
      editGroup.addEventListener('click', () => openEditor({ group: g.name }));
    }
    const section = h('section', { class: `group${closed ? ' closed' : ''}` }, h('h2', {}, head, editGroup));
    if (!closed) {
      const cards = h('div', { class: 'cards' });
      for (const s of list) cards.append(card(s, g.name));
      section.append(cards);
    }
    els.groups.append(section);
  }
  els.empty.hidden = shown > 0 || !data;
  const none = (data?.groups ?? []).every((g) => g.services.length === 0) && !(data?.tiles ?? []).length;
  els.empty.textContent = !none
    ? t('Nothing matches your filter.')
    : data?.editor
      ? t('No services yet. Open the gear menu at the top right and choose "Edit services and settings" to add your first one.')
      : t('No services yet. Add them to the config file.');
}

/**
 * The first-start guide: shown while the hub still has its starter config (or nothing at all), to
 * whoever may edit. Three steps, each a button; "Hide" puts it away for this browser.
 */
function renderGuide() {
  const host = $('guide');
  const services = (data?.groups ?? []).flatMap((g) => g.services);
  const fresh = services.length === 0 || (services.length === 1 && data.groups[0].name === 'Getting started');
  const show = Boolean(data?.editor) && fresh && !dismissed.includes('guide') && !(data.auth?.enabled && !data.auth.loggedIn);
  host.hidden = !show;
  host.replaceChildren();
  if (!show) return;
  const step = (title, text, label, onClick) => {
    const b = h('button', { type: 'button', class: 'set-btn', text: label });
    b.addEventListener('click', onClick);
    return h('li', {}, h('strong', { text: title }), h('span', { text: text }), b);
  };
  const steps = [
    step(t('Add your services'), t('One card per web page you want to reach from here. Everything is edited on this page.'), t('Open the editor'), () => openEditor()),
    step(t('Let the hub look for them'), t('It lists what runs in Docker on this server; one click turns an entry into a card.'), t('Show what was found'), () => openEditor({ section: 'cfg-found' }))
  ];
  if (data.auth?.canSet && !data.auth.enabled) {
    steps.push(step(t('Protect it'), t('Right now anyone who can reach this address can see and change everything. Fine at home; set a password otherwise.'), t('Set a password'), openPassword));
  }
  const hide = h('button', { type: 'button', class: 'guide-hide', text: t('Hide') });
  hide.addEventListener('click', () => dismiss('guide'));
  host.append(h('div', { class: 'guide-head' }, h('h2', { text: t('Welcome. Three steps to your own hub:') }), hide), h('ol', {}, ...steps));
}

// ---- password: set, change or remove it on the page (not when it comes from HUB_PASSWORD) ----
let passwordDialog = null;
function openPassword() {
  passwordDialog?.remove();
  const enabled = data?.auth?.enabled === true;
  const field = (label, name, auto) => {
    const input = h('input', { type: 'password', name, autocomplete: auto, required: true, minlength: 8 });
    return [h('label', {}, h('span', { text: label }), input), input];
  };
  const [l1, first] = field(enabled ? t('New password') : t('Password'), 'new-password', 'new-password');
  const [l2, second] = field(t('Repeat it'), 'repeat-password', 'new-password');
  const protects = h('select', {}, h('option', { value: 'all', text: t('The whole page') }), h('option', { value: 'editor', text: t('Only the editor (everyone can see the page)') }));
  protects.value = data?.auth?.mode ?? 'all';
  const error = h('p', { class: 'login-error', role: 'alert', hidden: true });
  const send = async (body) => {
    error.hidden = true;
    try {
      const res = await fetch('/api/password', { method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const answer = await res.json();
      if (res.ok) return location.reload();
      error.textContent = t(answer.error ?? 'Not saved.');
    } catch {
      error.textContent = t("Can't reach the hub right now.");
    }
    error.hidden = false;
  };
  const save = h('button', { type: 'submit', class: 'primary', text: t('Save') });
  const cancel = h('button', { type: 'button', text: t('Cancel') });
  cancel.addEventListener('click', () => passwordDialog.close());
  const buttons = h('div', { class: 'pw-buttons' }, cancel, save);
  if (enabled) {
    const remove = h('button', { type: 'button', class: 'danger', text: t('Remove the password') });
    remove.addEventListener('click', () => {
      if (confirm(t('Remove the password? Anyone who can reach the hub can then see and change everything.'))) send({ remove: true });
    });
    buttons.prepend(remove);
  }
  const form = h(
    'form',
    { class: 'pw-form' },
    h('h2', { text: enabled ? t('Change the password') : t('Set a password') }),
    h('p', { class: 'set-note', text: t('At least 8 characters. Forgotten? Delete the file hub-auth.json next to the config file on the server.') }),
    l1,
    l2,
    h('label', {}, h('span', { text: t('It protects') }), protects),
    error,
    buttons
  );
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (first.value !== second.value) {
      error.textContent = t('The two passwords are not the same.');
      error.hidden = false;
      return;
    }
    send({ password: first.value, protects: protects.value });
  });
  passwordDialog = h('dialog', { class: 'pw', 'aria-label': t('Password') }, form);
  document.body.append(passwordDialog);
  passwordDialog.showModal();
  first.focus();
}

function renderFooter() {
  const parts = [];
  if (data?.checkedAt) parts.push(t('checked {ago}', { ago: ago(data.checkedAt) }));
  if (data?.checkIntervalSeconds) parts.push(t('every {n} s', { n: data.checkIntervalSeconds }));
  gear.classList.toggle('has-update', Boolean(data?.update) && data.editor === true);
  els.updated.textContent = parts.join(' · ');
}

function render() {
  syncCustomTheme();
  if (data) {
    els.title.textContent = data.title;
    els.subtitle.textContent = data.subtitle;
    document.title = data.title;
  }
  if (applyLanguage()) drawnCards = null; // another language: the cards are drawn again
  renderSummary();
  renderNetmode();
  renderBanner();
  renderStats();
  renderGuide();
  // The cards are only rebuilt when something on them changed (most refreshes change nothing).
  const cards = JSON.stringify([data?.groups, data?.icons, data?.client?.home, data?.dockerError, data?.editor]);
  if (cards !== drawnCards) {
    drawnCards = cards;
    renderGroups();
  }
  renderFooter();
}

// ---- config editor: its script and style are fetched on the first click ----
let editorLoading = null;
/** @param {{group?: string, service?: string, section?: string}} [target]  where the editor opens (default: the top) */
async function openEditor(target) {
  // the editor needs the login (password that protects only the editor): log in first, then come back and open it
  if (data?.auth?.enabled && !data.auth.loggedIn) return location.assign('/login?next=' + encodeURIComponent('/#edit'));
  const tag = document.querySelector('script[data-editor-js]');
  editorLoading ??= Promise.all([
    import(tag.dataset.editorJs),
    new Promise((resolve, reject) => {
      const link = h('link', { rel: 'stylesheet', href: tag.dataset.editorCss });
      link.addEventListener('load', resolve);
      link.addEventListener('error', () => (link.remove(), reject(new Error('style'))));
      document.head.append(link);
    })
  ]);
  try {
    const [editor] = await editorLoading;
    editor.openEditor(target);
  } catch {
    editorLoading = null; // try again on the next click
    alert(t('The editor could not be loaded. Check the connection and try again.'));
  }
}

async function load() {
  try {
    const res = await fetch('/api/status', { cache: 'no-store', redirect: 'manual' });
    // An expired login at a proxy in front (Cloudflare Access, Authelia, ...) turns the API call into a redirect to its login page.
    if (res.status === 401) {
      return location.assign('/login?next=' + encodeURIComponent(location.pathname + location.hash)); // the hub's own login (HUB_PASSWORD)
    } else if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
      connection = 'login';
    } else if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) {
      connection = 'lost';
    } else {
      data = await res.json();
      lastOk = Date.now();
      connection = 'ok';
    }
  } catch {
    connection = 'lost';
  }
  render();
}

// ---- gear menu: what to show ----
const gear = $('gear');
const panel = $('settings');

function toggleRow(label, checked, onChange) {
  const input = h('input', { type: 'checkbox' });
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  return h('label', { class: 'opt' }, input, h('span', { text: label }));
}

/** A labelled drop-down in the gear menu. options: [value, label][] */
function selectRow(label, value, options, onChange) {
  const select = h('select', {}, ...options.map(([v, text]) => h('option', { value: v, text })));
  select.value = value;
  select.addEventListener('change', () => onChange(select.value));
  return h('label', { class: 'opt sel' }, h('span', { text: label }), select);
}

function renderSettings() {
  panel.replaceChildren(
    h('div', { class: 'set-title', text: t('Show on the page') }),
    toggleRow(t('Server stats'), prefs.stats, (on) => {
      prefs.stats = on;
      savePrefs();
      renderStats();
    }),
    toggleRow(t('Pinned'), prefs.pinned, (on) => {
      prefs.pinned = on;
      savePrefs();
      renderGroups();
    }),
    ...(data?.groups ?? []).map((g) =>
      toggleRow(g.name, !prefs.hiddenGroups.includes(g.name), (on) => {
        prefs.hiddenGroups = on ? prefs.hiddenGroups.filter((n) => n !== g.name) : [...prefs.hiddenGroups, g.name];
        savePrefs();
        renderGroups();
      })
    ),
    h('div', { class: 'set-title', text: t('Cards') }),
    toggleRow(t('Container health badges'), prefs.health, (on) => {
      prefs.health = on;
      savePrefs();
      renderGroups();
    }),
    toggleRow(t('Widget values'), prefs.widgets, (on) => {
      prefs.widgets = on;
      savePrefs();
      renderGroups();
    }),
    toggleRow(t('Compact cards'), prefs.compact, (on) => {
      prefs.compact = on;
      savePrefs();
      applyTheme();
    }),
    toggleRow(t('Open links in a new tab'), prefs.newTab, (on) => {
      prefs.newTab = on;
      savePrefs();
      renderGroups();
    }),
    h('div', { class: 'set-title', text: t('Refresh') }),
    refreshRow(),
    h('div', { class: 'set-title', text: t('Appearance') }),
    selectRow(
      t('Theme'),
      prefs.theme,
      [['auto', t('Automatic')], ...BUILTIN_THEMES.map((b) => [b.id, t(b.name)]), ...(data?.themes ?? []).map((c) => [c.id, c.name])],
      (v) => {
        chooseTheme(v);
        renderGroups();
      }
    ),
    selectRow(t('Language'), prefs.lang, [['auto', t('Automatic')], ...Object.entries(LANGUAGES)], (v) => {
      prefs.lang = v;
      savePrefs();
      render();
      renderSettings();
    }),
    h('p', { class: 'set-note', text: t('Saved in this browser only.') })
  );
  if (data?.editor) {
    const edit = h('button', { type: 'button', class: 'set-btn', text: t('Edit services and settings') });
    edit.addEventListener('click', () => {
      setPanel(false);
      openEditor();
    });
    panel.append(
      h('div', { class: 'set-title', text: t('Configuration') }),
      edit,
      h('p', { class: 'set-note', text: t('Services, groups, hosts and settings. Saved on the hub for everyone.') })
    );
  }
  if (data?.auth?.canSet && data.editor && (!data.auth.enabled || data.auth.loggedIn)) {
    const pw = h('button', { type: 'button', class: 'set-btn', text: data.auth.enabled ? t('Change the password') : t('Set a password') });
    pw.addEventListener('click', () => {
      setPanel(false);
      openPassword();
    });
    panel.append(
      h('div', { class: 'set-title', text: t('Password') }),
      pw,
      h('p', { class: 'set-note', text: data.auth.enabled ? t('The hub asks for it before it shows anything.') : t('No password is set: anyone who can reach this address can see and change everything.') })
    );
  }
  if (data?.version) {
    const line = h('p', { class: 'set-note version', text: t('Version {v}', { v: data.version }) });
    if (data.update) {
      line.append(' · ', h('a', { href: data.update.url, target: '_blank', rel: 'noopener noreferrer', text: t('{v} is available', { v: data.update.version }) }));
    }
    panel.append(line);
  }
  if (data?.auth?.loggedIn) {
    const out = h('button', { type: 'button', class: 'set-btn', text: t('Log out') });
    out.addEventListener('click', async () => {
      await fetch('/api/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => {});
      location.reload();
    });
    panel.append(out);
  }
}

/** "Refresh every [10] seconds": how often this page asks the hub for new data. */
function refreshRow() {
  const input = h('input', { type: 'number', min: MIN_REFRESH_SECONDS, max: MAX_REFRESH_SECONDS, step: 1, inputmode: 'numeric', 'aria-label': t('Refresh interval in seconds') });
  input.value = prefs.refreshSeconds;
  const hint = h('p', { class: 'set-note' });
  const showHint = (bad) => {
    hint.textContent = bad
      ? t('Enter a whole number from {min} to {max}.', { min: MIN_REFRESH_SECONDS, max: MAX_REFRESH_SECONDS })
      : t('The hub measures CPU, memory, network and storage every {stats} s and re-checks services and containers every {checks} s (both set in the YAML).', { stats: data?.statsIntervalSeconds ?? '?', checks: data?.checkIntervalSeconds ?? '?' });
    hint.classList.toggle('bad', Boolean(bad));
  };
  const apply = () => {
    const n = validRefresh(input.value);
    if (n == null) return showHint(true);
    prefs.refreshSeconds = n;
    input.value = n;
    savePrefs();
    scheduleRefresh();
    showHint(false);
  };
  input.addEventListener('change', apply);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') apply();
  });
  showHint(false);
  return h('div', {}, h('label', { class: 'opt num' }, h('span', { text: t('Refresh every') }), input, h('span', { text: t('seconds') })), hint);
}

function setPanel(open) {
  panel.hidden = !open;
  gear.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) renderSettings();
}
gear.addEventListener('click', () => setPanel(panel.hidden));
document.addEventListener('click', (e) => {
  if (!panel.hidden && !panel.contains(e.target) && !gear.contains(e.target)) setPanel(false);
});

els.netmode.addEventListener('click', () => {
  mode = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
  try {
    localStorage.setItem('hub-link-mode', mode);
  } catch {
    // storage blocked: the choice lasts until reload
  }
  renderNetmode();
  renderGroups();
});
els.filter.addEventListener('input', renderGroups);
// the config editor saved: show the new cards now, and again once they have been checked
document.addEventListener('hub:config-saved', () => {
  load();
  setTimeout(load, 2500);
});
document.addEventListener('keydown', (e) => {
  if (e.target instanceof Element && e.target.closest('dialog')) return; // typing in the config editor
  if (e.key === '/' && document.activeElement !== els.filter && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    els.filter.focus();
  } else if (e.key === 'Escape' && !panel.hidden) {
    setPanel(false);
    gear.focus();
  } else if (e.key === 'Escape' && document.activeElement === els.filter) {
    els.filter.value = '';
    els.filter.blur();
    renderGroups();
  }
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) load();
});

let refreshTimer = null;
/** (Re)starts the polling timer with the interval chosen in the gear menu. */
function scheduleRefresh() {
  clearInterval(refreshTimer);
  refreshTimer = setInterval(load, prefs.refreshSeconds * 1000);
}

applyTheme();
applyLanguage();
load().then(() => {
  // back from the login that the editor asked for
  if (location.hash === '#edit' && data?.editor) {
    history.replaceState(null, '', location.pathname);
    openEditor();
  }
});
scheduleRefresh();
setInterval(() => {
  renderBanner();
  renderFooter();
}, 5_000);
