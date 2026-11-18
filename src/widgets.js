// Widgets: a few numbers from a service's own API, shown on its card (photos in Immich, streams in
// Jellyfin, ...). They are described in a second file, widgets.yaml next to services.yaml:
//
//   immich:
//     path: /api/server/statistics          # added to the card's address (or url: for a full address)
//     headers:
//       x-api-key: "{env:IMMICH_API_KEY}"   # read from the hub's environment, never sent to the page
//     fields:
//       - label: Photos
//         value: photos
//         format: number
//
// and a card uses one with  widget: immich  (or  widget: { use: immich, key: ... }  for values of its own).
// The hub asks the API on every check cycle; the page only gets the finished values.
import http from 'node:http';
import https from 'node:https';
import { parse } from 'yaml';

export const FORMATS = ['auto', 'text', 'number', 'bytes', 'percent', 'duration'];
export const FUNCTIONS = ['count', 'sum', 'min', 'max', 'avg'];
export const METHODS = ['GET', 'POST'];
const MAX_WIDGETS = 100;
const MAX_FIELDS = 6;
const MAX_ANSWER_BYTES = 2 * 1024 * 1024;
const MAX_TEXT = 80;
const USER_AGENT = 'homelab-hub/1.0 (widget)';
/** Keys of a widget in widgets.yaml (anything else is reported, so a typo doesn't go unnoticed). */
const WIDGET_KEYS = new Set(['name', 'icon', 'address', 'path', 'url', 'method', 'headers', 'body', 'insecure', 'fields']);
const FIELD_KEYS = new Set(['label', 'value', 'format', 'suffix']);
export const ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/i;

const isObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

/** What a new widgets.yaml starts with (it is only written once something is saved). */
export const WIDGETS_STARTER = `# Widgets: a few values from a service's own API, shown on its card.
# One entry per widget. A card uses one with  widget: <name>  in services.yaml (or in the editor).
# Full explanation and examples: docs/widgets.md
#
# immich:
#   path: /api/server/statistics          # added to the card's address (or url: for a full address)
#   headers:
#     x-api-key: "{env:IMMICH_API_KEY}"   # from the hub's environment (compose.yaml), never sent to the page
#   fields:
#     - label: Photos
#       value: photos                     # where the number is in the answer: photos, data.total, count(items) ...
#       format: number                    # auto, text, number, bytes, percent, duration
#     - label: Storage
#       value: usage
#       format: bytes
`;

/**
 * "photos", "data.stats.total", "items[0].name", "count(sessions.*.NowPlayingItem)", "sum(libraries.*.size)"
 * -> {fn, path: ['data', 'stats', 'total']} or {error}. An empty path (or ".") is the whole answer.
 */
export function parseValue(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { error: 'needs a value: the name of a number in the answer, e.g. photos or data.total' };
  let fn = null;
  let inner = raw;
  const call = /^([a-z]+)\s*\((.*)\)$/i.exec(raw);
  if (call) {
    fn = call[1].toLowerCase();
    if (!FUNCTIONS.includes(fn)) return { error: `"${call[1]}(...)" is unknown; use ${FUNCTIONS.join(', ')}` };
    inner = call[2].trim();
  } else if (/[()]/.test(raw)) {
    return { error: `"${raw}" is not a value; write a path like data.total, or count(items)` };
  }
  inner = inner.replace(/\[(\d+|\*)\]/g, '.$1').replace(/^\.+/, '');
  const path = inner === '' ? [] : inner.split('.');
  if (path.some((p) => p === '')) return { error: `"${raw}" has an empty part (two dots in a row?)` };
  return { fn, path };
}

/** Follows a path through the answer. `*` goes into every entry of a list (or every value of an object). */
function follow(data, path) {
  let values = [data];
  let many = false;
  for (const seg of path) {
    if (seg === '*') {
      many = true;
      values = values.flatMap((v) => (Array.isArray(v) ? v : isObject(v) ? Object.values(v) : []));
    } else {
      values = values.map((v) => {
        if (Array.isArray(v)) return seg === 'length' ? v.length : /^\d+$/.test(seg) ? v[Number(seg)] : undefined;
        return isObject(v) && Object.hasOwn(v, seg) ? v[seg] : undefined;
      });
    }
  }
  return many ? { many: true, values } : { many: false, value: values[0] };
}

const toNumber = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

/** Reads one value from an API answer. Returns {value} (a number or a short text) or {error}. */
export function readValue(data, expr) {
  const parsed = typeof expr === 'string' ? parseValue(expr) : expr;
  if (parsed.error) return { error: parsed.error };
  const { fn, path } = parsed;
  const where = path.join('.') || 'the answer';
  const got = follow(data, path);
  let list = got.many ? got.values : got.value;
  if (fn) {
    if (!got.many) {
      if (list === undefined) return { error: `${where} is not in the answer` };
      if (isObject(list)) list = Object.values(list);
      if (!Array.isArray(list)) return { error: `${where} is not a list, so ${fn}() can't be used on it` };
    }
    if (fn === 'count') return { value: list.filter((v) => v != null && v !== false && v !== '').length };
    const nums = list.map(toNumber).filter((n) => n != null);
    if (nums.length === 0) return fn === 'sum' ? { value: 0 } : { error: `${where} has no numbers` };
    if (fn === 'sum') return { value: nums.reduce((a, b) => a + b, 0) };
    if (fn === 'min') return { value: Math.min(...nums) };
    if (fn === 'max') return { value: Math.max(...nums) };
    return { value: nums.reduce((a, b) => a + b, 0) / nums.length };
  }
  if (got.many) return { error: `${where} is a list; use count(${where}) or sum(${where})` };
  if (list === undefined) return { error: `${where} is not in the answer` };
  if (Array.isArray(list)) return { error: `${where} is a list; use count(${where})` };
  if (isObject(list)) return { error: `${where} is a group of values; pick one inside it (${where}.…)` };
  if (list === null) return { value: '–' };
  if (typeof list === 'boolean') return { value: list ? 'yes' : 'no' };
  if (typeof list === 'number') return { value: list };
  const s = String(list);
  return { value: s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}…` : s };
}

/**
 * Validates widgets.yaml (already parsed). Returns {widgets: {id: def}, errors}.
 * A def keeps its text with the {placeholders}: they are filled in per card (see resolveWidget).
 */
export function normalizeWidgets(raw) {
  const errors = [];
  const widgets = {};
  if (raw == null) return { widgets, errors };
  if (!isObject(raw)) return { widgets, errors: ['The file must be a mapping: one entry per widget, like  immich: { path: ..., fields: [...] }'] };
  for (const [id, w] of Object.entries(raw)) {
    const where = id;
    if (!ID_RE.test(id)) {
      errors.push(`${where}: a widget name may only use letters, digits, - and _ (up to 40)`);
      continue;
    }
    if (!isObject(w)) {
      errors.push(`${where}: must be a mapping with path (or url) and fields`);
      continue;
    }
    if (Object.keys(widgets).length >= MAX_WIDGETS) {
      errors.push(`at most ${MAX_WIDGETS} widgets`);
      break;
    }
    for (const k of Object.keys(w)) if (!WIDGET_KEYS.has(k)) errors.push(`${where}.${k}: unknown key; use ${[...WIDGET_KEYS].join(', ')}`);
    const def = { id, name: w.name == null ? id : String(w.name).slice(0, 60), icon: w.icon == null ? '' : String(w.icon), method: 'GET', headers: {}, insecure: w.insecure === true, fields: [] };
    // address: where the path is asked when the widget is on a tile of its own (a card asks on its own address)
    if (w.address != null && w.address !== '') {
      if (typeof w.address !== 'string' || !/^https?:\/\/./i.test(w.address.trim())) errors.push(`${where}.address: must be a full http:// or https:// address, like http://{nas}:2283`);
      else def.address = w.address.trim();
    }
    if (w.url != null && w.path != null) errors.push(`${where}: give either path (added to the card's address) or url (a full address), not both`);
    if (w.url != null) {
      if (typeof w.url !== 'string' || !/^https?:\/\//i.test(w.url.trim())) errors.push(`${where}.url: must be a full http:// or https:// address`);
      else def.url = w.url.trim();
    } else if (w.path != null) {
      if (typeof w.path !== 'string') errors.push(`${where}.path: must be a text like /api/stats`);
      else def.path = w.path.trim();
    } else def.path = '';
    if (w.method != null) {
      const m = String(w.method).toUpperCase();
      if (!METHODS.includes(m)) errors.push(`${where}.method: must be ${METHODS.join(' or ')}`);
      else def.method = m;
    }
    if (w.insecure != null && typeof w.insecure !== 'boolean') errors.push(`${where}.insecure: must be true or false`);
    if (w.headers != null) {
      if (!isObject(w.headers)) errors.push(`${where}.headers: must be a mapping like  x-api-key: "{env:MY_KEY}"`);
      else {
        for (const [k, v] of Object.entries(w.headers)) {
          if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(k)) errors.push(`${where}.headers.${k}: not a valid header name`);
          else if (v == null || isObject(v) || Array.isArray(v)) errors.push(`${where}.headers.${k}: must be a text`);
          else def.headers[k] = String(v);
        }
      }
    }
    if (w.body != null) {
      if (def.method === 'GET') errors.push(`${where}.body: only a POST request has a body (method: POST)`);
      else def.body = typeof w.body === 'string' ? w.body : JSON.stringify(w.body);
    }
    if (!Array.isArray(w.fields) || w.fields.length === 0) {
      errors.push(`${where}.fields: needs a list of values to show, e.g.  - { label: Photos, value: photos }`);
    } else {
      if (w.fields.length > MAX_FIELDS) errors.push(`${where}.fields: at most ${MAX_FIELDS} values per card`);
      w.fields.slice(0, MAX_FIELDS).forEach((f, i) => {
        const fw = `${where}.fields[${i}]`;
        if (!isObject(f)) return void errors.push(`${fw}: must be a mapping with label and value`);
        for (const k of Object.keys(f)) if (!FIELD_KEYS.has(k)) errors.push(`${fw}.${k}: unknown key; use ${[...FIELD_KEYS].join(', ')}`);
        const parsed = parseValue(f.value);
        if (parsed.error) errors.push(`${fw}.value: ${parsed.error}`);
        const format = f.format == null ? 'auto' : String(f.format).toLowerCase();
        if (!FORMATS.includes(format)) errors.push(`${fw}.format: must be one of ${FORMATS.join(', ')}`);
        def.fields.push({
          label: f.label == null ? String(f.value ?? '') : String(f.label).slice(0, 40),
          value: String(f.value ?? ''),
          format: FORMATS.includes(format) ? format : 'auto',
          ...(f.suffix != null && f.suffix !== '' ? { suffix: String(f.suffix).slice(0, 12) } : {})
        });
      });
    }
    widgets[id] = def;
  }
  return { widgets, errors };
}

/** Parses the text of widgets.yaml. Syntax errors come back as errors. A missing file (null) = no widgets. */
export function parseWidgetsText(text) {
  if (text == null || text.trim() === '') return { widgets: {}, errors: [] };
  let raw;
  try {
    raw = parse(text);
  } catch (err) {
    const pos = err.linePos?.[0];
    return { widgets: {}, errors: [`YAML syntax error${pos ? ` (line ${pos.line}, column ${pos.col})` : ''}: ${String(err.message).split('\n')[0]}`] };
  }
  return normalizeWidgets(raw);
}

/**
 * Fills in {placeholders}: first the card's own values (widget: { use: x, key: ... }), then
 * {env:NAME} from the hub's environment, then the host shortcuts. Unknown ones are reported.
 */
export function fillPlaceholders(text, { params = {}, hosts = {}, env = process.env, missingEnv = null }, where, errors) {
  return String(text).replace(/\{(env:)?([A-Za-z0-9_-]+)\}/g, (match, isEnv, key) => {
    if (isEnv) {
      if (env[key] != null && env[key] !== '') return env[key];
      // not a config error: the card says so (the config stays usable while the variable is being set up)
      if (missingEnv) missingEnv.add(key);
      else errors.push(`${where}: the environment variable ${key} is not set on the hub`);
      return '';
    }
    if (Object.hasOwn(params, key)) return String(params[key]);
    if (Object.hasOwn(hosts, key)) return String(hosts[key]);
    errors.push(`${where}: unknown placeholder {${key}} (give it on the card, e.g. widget: { use: ..., ${key}: ... }, or add it under "hosts:")`);
    return match;
  });
}

/** `widget:` on a card -> {use, params} or null (no widget). */
export function widgetRef(raw, where, errors) {
  if (raw == null || raw === false || raw === '' || (typeof raw === 'string' && ['none', 'off', 'no'].includes(raw.toLowerCase()))) return null;
  if (typeof raw === 'string') return { use: raw.trim(), params: {} };
  if (isObject(raw) && typeof raw.use === 'string' && raw.use.trim()) {
    const params = {};
    for (const [k, v] of Object.entries(raw)) {
      if (k === 'use') continue;
      if (v == null || typeof v === 'object') errors.push(`${where}.widget.${k}: must be a text or a number`);
      else params[k] = String(v);
    }
    return { use: raw.use.trim(), params };
  }
  errors.push(`${where}.widget: must be the name of a widget from widgets.yaml, or  { use: name, key: value, ... }`);
  return null;
}

/**
 * The request one card makes for its widget: placeholders filled in, path added to the card's
 * address (the home address first: the hub runs at home). Returns null when it can't be made.
 */
export function resolveWidget(ref, def, { base, hosts, env, insecure = false }, where, errors) {
  const before = errors.length;
  const missingEnv = new Set();
  const fill = (text, what) => fillPlaceholders(text, { params: ref.params, hosts, env, missingEnv }, `${where}.widget (${what})`, errors);
  let url;
  if (!base && def.address && !def.url) base = fill(def.address, 'address');
  if (def.url) url = fill(def.url, 'url');
  else {
    if (!base) {
      errors.push(`${where}.widget: there is no address to ask "${def.id}" on: give the widget an address (Widgets page) or the card one`);
      return null;
    }
    const path = fill(def.path ?? '', 'path');
    url = path ? `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}` : base;
  }
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error();
  } catch {
    if (errors.length === before) errors.push(`${where}.widget: "${url}" is not a valid address`);
    return null;
  }
  const headers = {};
  for (const [k, v] of Object.entries(def.headers)) headers[k] = fill(v, `header ${k}`);
  const body = def.body == null ? undefined : fill(def.body, 'body');
  if (errors.length > before) return null;
  const problem = missingEnv.size > 0 ? `Not set on the hub: ${[...missingEnv].join(', ')} (an environment variable in compose.yaml)` : null;
  return { name: def.id, request: { url, method: def.method, headers, ...(body != null ? { body } : {}), insecure: def.insecure || insecure }, fields: def.fields, ...(problem ? { problem } : {}) };
}

function describeError(err) {
  const code = err.code ?? '';
  if (code === 'ECONNREFUSED') return 'Connection refused';
  if (code === 'ETIMEDOUT' || err.message === 'timeout') return 'Timed out';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'DNS lookup failed';
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'Host unreachable';
  if (/CERT|TLS|SSL|self[- ]signed/i.test(code + err.message)) return `TLS error (${code || err.message}); set insecure: true for a self-signed certificate`;
  return code || err.message || 'Failed';
}

/** Asks the API. Resolves {data} (the parsed JSON) or {error}; never throws. */
export function requestJson({ url, method = 'GET', headers = {}, body, insecure = false }, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let settled = false;
    let req;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(hard);
      req?.destroy();
      resolve(r);
    };
    const hard = setTimeout(() => finish({ error: 'Timed out' }), timeoutMs);
    try {
      const lib = url.startsWith('https:') ? https : http;
      const sendHeaders = { 'user-agent': USER_AGENT, accept: 'application/json', ...headers };
      if (body != null) {
        sendHeaders['content-type'] ??= /^\s*[[{]/.test(body) ? 'application/json' : 'text/plain';
        sendHeaders['content-length'] = Buffer.byteLength(body);
      }
      req = lib.request(url, { method, agent: false, rejectUnauthorized: !insecure, headers: sendHeaders }, (res) => {
        const code = res.statusCode ?? 0;
        if (code >= 300 && code < 400) {
          let to = '';
          try {
            to = ` to ${new URL(res.headers.location, url).host}`;
          } catch {
            // no usable location
          }
          return finish({ error: `HTTP ${code}: redirected${to} (a login page? use the direct address of the service)` });
        }
        if (code === 401 || code === 403) return finish({ error: `HTTP ${code}: the API key or login was not accepted` });
        if (code === 404) return finish({ error: 'HTTP 404: this API path does not exist on the service' });
        if (code < 200 || code >= 300) return finish({ error: `HTTP ${code}` });
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > MAX_ANSWER_BYTES) finish({ error: 'The answer is too large (over 2 MB)' });
          else chunks.push(c);
        });
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            finish({ data: JSON.parse(text) });
          } catch {
            finish({ error: 'The answer is not JSON (is the path right?)' });
          }
        });
        res.on('error', (err) => finish({ error: describeError(err) }));
      });
      req.on('error', (err) => finish({ error: describeError(err) }));
      req.end(body);
    } catch (err) {
      finish({ error: describeError(err) });
    }
  });
}

/** Reads every field of a widget from one answer. */
export function readFields(data, fields) {
  return fields.map((f) => {
    const r = readValue(data, f.value);
    return { label: f.label, format: f.format, ...(f.suffix ? { suffix: f.suffix } : {}), ...(r.error ? { error: r.error } : { value: r.value }) };
  });
}

/** Runs one card's widget: {fields: [{label, value|error, format, suffix?}]} or {error}. */
export async function runWidget(widget, timeoutMs, request = requestJson) {
  if (widget.problem) return { error: widget.problem };
  const answer = await request(widget.request, timeoutMs);
  if (answer.error) return { error: answer.error };
  return { fields: readFields(answer.data, widget.fields) };
}
