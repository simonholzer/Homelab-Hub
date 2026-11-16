// Import from other dashboards: turns their config into groups of cards for the editor.
//   Homepage (gethomepage.dev)  services.yaml: a list of groups, each a list of {Name: {href, icon, description}}
//   Dashy                       conf.yml: sections: [{name, items: [{title, url, icon, description}]}]
//   Homarr (older JSON export)  {apps: [{name, url, appearance: {iconUrl}, area}], categories: [{id, name}]}
// Only what a link hub needs is taken over: name, address, icon, description. Widgets are ignored.
import { parse } from 'yaml';

const isObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const isAddress = (v) => typeof v === 'string' && /^https?:\/\/\S+$/i.test(v.trim());

/** "jellyfin.png", "hl-jellyfin", ".../svg/jellyfin.svg" -> "jellyfin"; icon fonts and other pictures -> "". */
export function iconName(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw.trim();
  if (/^https?:\/\//i.test(s)) {
    if (!/dashboard-icons|homarr-labs|walkxcode/i.test(s)) return '';
    s = s.split(/[?#]/)[0].split('/').pop() ?? '';
  }
  if (/^(mdi|si|fa[bsrl]?|far|fas|favicon|generative)\b[-: ]?/i.test(s) || s === 'favicon') return '';
  s = s.replace(/^hl-/i, '').replace(/\.(png|svg|webp|jpe?g)$/i, '').toLowerCase();
  return /^[a-z0-9][a-z0-9_-]*$/.test(s) ? s : '';
}

function card(name, address, icon, description) {
  if (typeof name !== 'string' || !name.trim() || !isAddress(address)) return null;
  const out = { name: name.trim(), url: address.trim() };
  const ic = iconName(icon);
  if (ic) out.icon = ic;
  if (typeof description === 'string' && description.trim()) out.description = description.trim();
  return out;
}

function fromDashy(doc) {
  return doc.sections.filter(isObject).map((s) => ({
    name: String(s.name ?? 'Imported'),
    services: (Array.isArray(s.items) ? s.items : []).filter(isObject).map((i) => card(i.title, i.url, i.icon, i.description)).filter(Boolean)
  }));
}

function fromHomepage(doc) {
  const groups = [];
  for (const entry of doc) {
    if (!isObject(entry)) continue;
    for (const [groupName, items] of Object.entries(entry)) {
      if (!Array.isArray(items)) continue;
      const services = [];
      for (const item of items) {
        if (!isObject(item)) continue;
        for (const [name, v] of Object.entries(item)) {
          const made = isObject(v) ? card(name, v.href, v.icon, v.description) : null;
          if (made) services.push(made);
        }
      }
      groups.push({ name: groupName, services });
    }
  }
  return groups;
}

function fromHomarr(doc) {
  const categories = new Map((Array.isArray(doc.categories) ? doc.categories : []).filter(isObject).map((c) => [c.id, String(c.name ?? 'Homarr')]));
  const groups = new Map();
  for (const app of doc.apps) {
    if (!isObject(app)) continue;
    const made = card(app.name, app.behaviour?.externalUrl || app.url, app.appearance?.iconUrl, '');
    if (!made) continue;
    const groupName = categories.get(app.area?.properties?.id) ?? 'Homarr';
    if (!groups.has(groupName)) groups.set(groupName, { name: groupName, services: [] });
    groups.get(groupName).services.push(made);
  }
  return [...groups.values()];
}

/**
 * @param {string} text  the other dashboard's config file
 * @returns {{format: string, groups: {name: string, services: object[]}[]}}
 * @throws with a readable message when the text is not a config this understands
 */
export function importServices(text) {
  let doc;
  try {
    doc = parse(String(text));
  } catch {
    throw new Error('That file is neither YAML nor JSON.');
  }
  let format;
  let groups;
  if (isObject(doc) && Array.isArray(doc.sections)) [format, groups] = ['Dashy', fromDashy(doc)];
  else if (isObject(doc) && Array.isArray(doc.apps)) [format, groups] = ['Homarr', fromHomarr(doc)];
  else if (Array.isArray(doc)) [format, groups] = ['Homepage', fromHomepage(doc)];
  else throw new Error('This file was not recognised. Supported: services.yaml of Homepage, conf.yml of Dashy, a JSON export of Homarr.');
  groups = groups.filter((g) => g.services.length > 0);
  if (groups.length === 0) throw new Error(`This looks like a ${format} file, but it has no entries with a name and an http(s) address.`);
  return { format, groups };
}
