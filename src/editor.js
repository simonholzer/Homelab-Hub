// The config editor's server side: read the YAML for the page, turn an edited model back into
// YAML without losing the comments, and save it (validated, with a backup of the file before).
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { parseDocument, isMap, isSeq, isScalar } from 'yaml';
import { parseConfigText, normalizeConfig } from './config.js';

/** Items of a list carry their position in the original file under this key, so a renamed or moved
 *  entry is still recognised (and keeps its comments). It never reaches the file. */
export const ID = '__i';
const MAX_BODY_BYTES = 1024 * 1024;
const YAML_OPTIONS = { lineWidth: 0 };

const isObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
export const versionOf = (text) => crypto.createHash('sha1').update(text).digest('hex').slice(0, 12);

/** Adds the position marker to every mapping inside a list. */
function tag(value) {
  if (Array.isArray(value)) return value.map((v, i) => (isObject(v) ? { ...tag(v), [ID]: i } : tag(v)));
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, tag(v)]));
  return value;
}

/** Removes the position markers again. */
export function strip(value) {
  if (Array.isArray(value)) return value.map(strip);
  if (isObject(value)) return Object.fromEntries(Object.entries(value).filter(([k, v]) => k !== ID && v !== undefined).map(([k, v]) => [k, strip(v)]));
  return value;
}

/** What the editor page needs to know about a YAML text. model is null when it can't be shown as a form. */
export function describe(text) {
  const doc = parseDocument(text);
  // syntax errors: the config loader words them (line and column); otherwise the text is parsed only once
  if (doc.errors.length > 0) return { text, model: null, errors: parseConfigText(text).errors, version: versionOf(text) };
  const js = doc.toJS();
  return { text, model: isObject(js) ? tag(js) : null, errors: normalizeConfig(js).errors, version: versionOf(text) };
}

const keyOf = (pair) => String(isScalar(pair.key) ? pair.key.value : pair.key);

/** A fresh node that takes over the comments of the one it replaces. */
function replaceNode(doc, old, value) {
  const node = doc.createNode(strip(value));
  if (old && node) {
    if (old.commentBefore) node.commentBefore = old.commentBefore;
    if (old.comment) node.comment = old.comment;
    if (old.spaceBefore) node.spaceBefore = true;
  }
  return node;
}

/** Makes `node` say `value`, changing as little as possible so comments and layout stay. */
function sync(doc, node, value) {
  if (isObject(value)) {
    if (!isMap(node)) return replaceNode(doc, node, value);
    const keys = Object.keys(value).filter((k) => k !== ID && value[k] !== undefined);
    node.items = node.items.filter((p) => keys.includes(keyOf(p)));
    for (const k of keys) {
      const pair = node.items.find((p) => keyOf(p) === k);
      if (pair) pair.value = sync(doc, pair.value, value[k]);
      else node.items.push(doc.createPair(k, strip(value[k])));
    }
    node.items.sort((a, b) => keys.indexOf(keyOf(a)) - keys.indexOf(keyOf(b)));
    if (keys.some((k) => typeof value[k] === 'object' && value[k] !== null)) node.flow = false;
    return node;
  }
  if (Array.isArray(value)) {
    if (!isSeq(node)) return replaceNode(doc, node, value);
    const old = node.items;
    const used = new Set();
    const spaced = old.some((n) => n?.spaceBefore);
    node.items = value.map((v, at) => {
      let i = -1;
      if (isObject(v)) {
        if (Number.isInteger(v[ID]) && old[v[ID]] && !used.has(v[ID])) i = v[ID];
      } else if (!Array.isArray(v)) {
        i = old.findIndex((n, idx) => !used.has(idx) && isScalar(n) && n.value === v);
      }
      if (i >= 0) {
        used.add(i);
        return sync(doc, old[i], v);
      }
      const fresh = doc.createNode(strip(v));
      if (spaced && at > 0) fresh.spaceBefore = true; // new entries get the blank line the others have
      return fresh;
    });
    // blank lines between entries: the first one keeps what the first had, a moved one follows the others
    node.items.forEach((n, at) => {
      if (n && typeof n === 'object') n.spaceBefore = at === 0 ? Boolean(old[0]?.spaceBefore) : n === old[0] ? spaced : n.spaceBefore;
    });
    if (value.some((v) => typeof v === 'object' && v !== null)) node.flow = false;
    return node;
  }
  if (isScalar(node)) {
    if (node.value !== value) node.value = value;
    return node;
  }
  return replaceNode(doc, node, value);
}

/**
 * The YAML library writes comments back with one space before the "#", which would undo the aligned
 * comments on every save. Lines that came out exactly as the library would write an untouched line
 * get the original line back; everything else stays as written.
 */
function keepOriginalLines(base, canon, output) {
  const baseLines = base.split('\n');
  const canonLines = canon.split('\n');
  const squash = (line) => line.replace(/\s+/g, '');
  const originals = new Map(); // line as the library writes it -> the original lines, in file order
  let i = 0;
  let j = 0;
  while (i < baseLines.length && j < canonLines.length) {
    let original = baseLines[i];
    if (original.trim() === '' && canonLines[j].trim() !== '' && i + 1 < baseLines.length) {
      original = `\n${baseLines[++i]}`; // a blank line the library drops: it comes back with the line after it
    }
    if (squash(baseLines[i]) === squash(canonLines[j])) {
      if (!originals.has(canonLines[j])) originals.set(canonLines[j], []);
      originals.get(canonLines[j]).push(original);
    }
    i++;
    j++;
  }
  return output
    .split('\n')
    .map((line) => {
      const queue = originals.get(line);
      if (!queue) return line;
      return queue.length > 1 ? queue.shift() : queue[0];
    })
    .join('\n');
}

/** Applies an edited model to the YAML text it was made from. Throws when `base` isn't usable YAML. */
export function applyModel(base, model) {
  const doc = parseDocument(base);
  if (doc.errors.length > 0) throw new Error('The YAML text has syntax errors; fix them in the YAML tab first.');
  const wanted = strip(model);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (same(doc.toJS(), wanted)) return base; // nothing changed: not a single character is touched
  const canon = doc.toString(YAML_OPTIONS); // the untouched file as the library would write it
  doc.contents = sync(doc, doc.contents, model);
  const plain = doc.toString(YAML_OPTIONS);
  const kept = keepOriginalLines(base, canon, plain);
  if (kept === plain) return plain;
  // safety net: the tidied text must mean exactly the same as the plain one
  const check = parseDocument(kept);
  return check.errors.length === 0 && same(check.toJS(), wanted) ? kept : plain;
}

/** A request body is either the YAML text itself or a model plus the text it belongs to. */
function textFrom(body) {
  if (typeof body?.text === 'string') return body.text;
  if (typeof body?.base === 'string' && isObject(body?.model)) return applyModel(body.base, body.model);
  throw new Error('Send either "text" or "base" and "model".');
}

/** Writes the file through a temporary one, so a crash can't leave half a config behind. */
function writeFile(file, text) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  } catch {
    fs.rmSync(tmp, { force: true });
    fs.writeFileSync(file, text); // e.g. only the file itself is writable, not its folder
  }
}

export const BACKUPS_KEPT = 10;

/** Copies the file into backups/ next to it, named by time, and keeps only the newest ones. */
export function keepBackup(file, now = new Date()) {
  const dir = path.join(path.dirname(file), 'backups');
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const ext = path.extname(file);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(file, path.join(dir, `${path.basename(file, ext)}-${stamp}${ext}`));
  const old = fs.readdirSync(dir).filter((f) => f.endsWith(ext)).sort().reverse().slice(BACKUPS_KEPT);
  for (const f of old) fs.rmSync(path.join(dir, f), { force: true });
}

function isWritable(file) {
  try {
    fs.accessSync(file, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Only the hub's own page may change the config: a request made by another website in the visitor's
 * browser is refused. Browsers say where a request comes from (Sec-Fetch-Site, Origin), and the JSON
 * content type can't be sent across sites without the hub's permission.
 */
export function fromOwnPage(req) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return false;
  const site = req.headers['sec-fetch-site'];
  if (site) return site === 'same-origin';
  const origin = req.headers.origin;
  if (!origin) return true; // not a browser (curl, tests)
  try {
    const host = new URL(origin).host;
    return host === req.headers.host || host === req.headers['x-forwarded-host'];
  } catch {
    return false;
  }
}

export function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('The request is not valid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

const MAX_ICON_BYTES = 512 * 1024;

/** A link to a file's page on GitHub is turned into the link to the file itself. */
export function directLink(link) {
  const u = new URL(link);
  const m = u.hostname === 'github.com' && /^\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/.exec(u.pathname);
  return m ? `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}` : u.href;
}

/** "https://…/svg/Open-WebUI.svg" -> "open-webui"; null when the link gives no usable name. */
export function iconNameFrom(link) {
  const last = decodeURIComponent(new URL(link).pathname.split('/').pop() ?? '');
  const name = last.replace(/\.svg$/i, '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|-+$/g, '').slice(0, 60);
  return /^[a-z0-9][a-z0-9_-]*$/.test(name) ? name : null;
}

/** Fetches an SVG from the internet. Only https links to public host names; throws a readable message otherwise. */
export async function downloadSvg(link) {
  const u = new URL(link);
  if (u.protocol !== 'https:') throw new Error('The link must start with https://');
  if (net.isIP(u.hostname.replace(/^\[|\]$/g, '')) !== 0 || !u.hostname.includes('.')) throw new Error('The link must point to a website, not to an address on the network.');
  let res;
  try {
    res = await fetch(u, { signal: AbortSignal.timeout(10_000), headers: { accept: 'image/svg+xml,*/*' } });
  } catch (err) {
    throw new Error(`Could not download the icon: ${err.name === 'TimeoutError' ? 'no answer in time' : err.cause?.code ?? err.message}`);
  }
  if (!res.ok) throw new Error(`Could not download the icon: the site answered ${res.status}`);
  if (Number(res.headers.get('content-length') ?? 0) > MAX_ICON_BYTES) throw new Error('The file is too large for an icon (over 512 KB).');
  const data = Buffer.from(await res.arrayBuffer());
  if (data.length > MAX_ICON_BYTES) throw new Error('The file is too large for an icon (over 512 KB).');
  return data.toString('utf8');
}

/** Throws unless the text is a plain SVG picture. */
export function checkSvg(text) {
  if (!/<svg[\s>]/i.test(text.slice(0, 4000))) throw new Error('That link is not an SVG picture. Use the link to the .svg file itself.');
  if (/<script|<foreignObject|\son[a-z]+\s*=|javascript:/i.test(text)) throw new Error('This SVG contains scripts or embedded pages, so it is not accepted.');
}

/**
 * The /api/config routes.
 *   GET  /api/config         the file: text, model for the form, problems, available icons
 *   POST /api/config/render  {base, model} or {text} -> the resulting YAML text and its problems (saves nothing)
 *   PUT  /api/config         same body plus "version" -> validates and saves
 *   POST /api/config/icon    {url} -> downloads the SVG once into the icons folder; cards then use it by name
 * @param {object} o
 * @param {() => string} o.getFile   path of the YAML file in use
 * @param {() => object} [o.getIcons]  icon name -> version
 * @param {() => void} [o.onSaved]
 * @param {string|null} [o.iconsDir]  where downloaded icons are kept
 * @param {(url: string) => Promise<string>} [o.download]
 * @param {() => void} [o.onIcon]  called after an icon was added
 * @returns {(req, res, pathname: string, json: Function) => Promise<void>}
 */
export function createConfigApi({ getFile, getIcons = () => ({}), onSaved = () => {}, iconsDir = null, download, onIcon = () => {} }) {
  download ??= downloadSvg;
  return async function handle(req, res, pathname, json) {
    try {
      if (pathname === '/api/config' && (req.method === 'GET' || req.method === 'HEAD')) {
        const file = getFile();
        const text = fs.readFileSync(file, 'utf8');
        return json(res, 200, { ...describe(text), file, writable: isWritable(file), icons: getIcons() });
      }
      if (pathname === '/api/config/icon' && req.method === 'POST') {
        if (!fromOwnPage(req)) return json(res, 403, { error: 'Changes are only accepted from the hub page itself.' });
        if (!iconsDir) return json(res, 400, { error: 'This hub has no folder for added icons.' });
        const body = await readBody(req);
        let link;
        let name;
        try {
          link = directLink(String(body?.url ?? '').trim());
          name = iconNameFrom(link);
        } catch {
          return json(res, 400, { error: 'That is not a link. Paste the full address of an .svg file.' });
        }
        if (!name) return json(res, 400, { error: 'The link has no file name to name the icon after.' });
        try {
          const text = await download(link);
          checkSvg(text);
          fs.mkdirSync(iconsDir, { recursive: true });
          fs.writeFileSync(path.join(iconsDir, `${name}.svg`), text);
        } catch (err) {
          return json(res, 400, { error: err.code ? `Cannot save the icon in ${iconsDir}: ${err.code}` : err.message });
        }
        onIcon();
        console.log(`[config] icon "${name}" added from ${new URL(link).host}`);
        return json(res, 200, { name, icons: getIcons() });
      }
      const save = pathname === '/api/config' && req.method === 'PUT';
      const render = pathname === '/api/config/render' && req.method === 'POST';
      if (!save && !render) return json(res, 405, { error: 'Method not allowed' });
      if (!fromOwnPage(req)) return json(res, 403, { error: 'Changes are only accepted from the hub page itself.' });
      const body = await readBody(req);
      let text;
      try {
        text = textFrom(body);
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
      if (text.length > 0 && !text.endsWith('\n')) text += '\n';
      const result = describe(text);
      if (render) return json(res, 200, result);

      const file = getFile();
      const current = fs.readFileSync(file, 'utf8');
      if (body.version !== versionOf(current)) {
        return json(res, 409, { error: 'The file was changed in the meantime (by hand or in another tab).' });
      }
      if (result.errors.length > 0) return json(res, 422, { error: 'Not saved: the config has problems.', errors: result.errors });
      if (text !== current) {
        try {
          fs.copyFileSync(file, `${file}.bak`); // the version before this save
          keepBackup(file);
        } catch {
          // no backup possible (read-only folder): the save below will say what is wrong
        }
        try {
          writeFile(file, text);
        } catch (err) {
          return json(res, 500, { error: `Cannot write ${file}: ${err.code ?? err.message}` });
        }
        console.log(`[config] saved from the page: ${file}`);
        onSaved();
      }
      return json(res, 200, { ...result, saved: true });
    } catch (err) {
      return json(res, err.status ?? 500, { error: err.status ? err.message : `Config editor: ${err.code ?? err.message}` });
    }
  };
}
