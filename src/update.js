// "A newer version is available": asks GitHub twice a day which release is the latest and compares
// it with the version that is running. Only a version number is fetched; nothing is sent.
// Switch off with UPDATE_CHECK=off. A fork can point it at its own repository with UPDATE_REPO=owner/name.
export const DEFAULT_REPO = 'simonholzer/Homelab-Hub';

/** "v1.2.3" / "1.2.3" -> [1, 2, 3]; null when it is not a plain version number. */
export function parseVersion(text) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(text ?? '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function isNewer(candidate, current) {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

async function fetchLatestRelease(repo) {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    signal: AbortSignal.timeout(8000),
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'homelab-hub (update check)' }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  return { tag: j.tag_name, url: j.html_url };
}

/**
 * @param {object} o
 * @param {string} o.current  the running version
 * @param {string} [o.repo]
 * @param {(repo: string) => Promise<{tag: string, url: string}>} [o.fetchLatest]
 */
export function createUpdateChecker({ current, repo = DEFAULT_REPO, fetchLatest = fetchLatestRelease, intervalMs = 12 * 60 * 60 * 1000 }) {
  let latest = null; // {version, url}
  let timer = null;
  const check = async () => {
    try {
      const { tag, url } = await fetchLatest(repo);
      if (parseVersion(tag)) latest = { version: String(tag).replace(/^v/, ''), url: typeof url === 'string' && url.startsWith('https://') ? url : `https://github.com/${repo}/releases` };
    } catch {
      // offline or GitHub unreachable: keep what is known, try again next time
    }
  };
  return {
    check,
    start() {
      check();
      timer = setInterval(check, intervalMs);
      timer.unref?.();
    },
    stop: () => clearInterval(timer),
    /** null, or {version, url} when a newer version than the running one exists */
    available: () => (latest && isNewer(latest.version, current) ? latest : null)
  };
}
