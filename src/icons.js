// Icons by name: a card that says `icon: jellyfin` and has no such file gets the icon from the open
// dashboard-icons set (https://github.com/homarr-labs/dashboard-icons), downloaded once into the
// icons folder next to the config file. From then on the hub serves it itself.
// Switch off with ICON_DOWNLOAD=off (the hub then never contacts the icon server).
import fs from 'node:fs';
import path from 'node:path';
import { downloadSvg, checkSvg } from './editor.js';

export const ICON_SOURCE = 'https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg';
const NAME = /^[a-z0-9][a-z0-9_-]*$/;
const RETRY_MS = 6 * 60 * 60 * 1000; // a name that could not be fetched is tried again after this

/**
 * @param {object} o
 * @param {string} o.iconsDir                       where downloaded icons are kept
 * @param {(url: string) => Promise<string>} [o.download]
 * @param {() => void} [o.onIcon]                   called after an icon was added
 * @returns {(names: string[]) => Promise<void>}    fetches the names that are worth a try
 */
export function createIconFetcher({ iconsDir, download = downloadSvg, onIcon = () => {}, now = () => Date.now() }) {
  const tried = new Map(); // name -> time of the last failed try
  const busy = new Set();
  return async function fetchMissing(names) {
    await Promise.all(
      [...new Set(names.map((n) => String(n).toLowerCase()))].map(async (name) => {
        if (!NAME.test(name) || busy.has(name)) return;
        if (tried.has(name) && now() - tried.get(name) < RETRY_MS) return;
        busy.add(name);
        try {
          const text = await download(`${ICON_SOURCE}/${name}.svg`);
          checkSvg(text);
          fs.mkdirSync(iconsDir, { recursive: true });
          fs.writeFileSync(path.join(iconsDir, `${name}.svg`), text);
          tried.delete(name);
          console.log(`[icons] "${name}" downloaded from dashboard-icons`);
          onIcon();
        } catch (err) {
          tried.set(name, now());
          console.warn(`[icons] no icon "${name}": ${err.code ?? err.message}`);
        } finally {
          busy.delete(name);
        }
      })
    );
  };
}
