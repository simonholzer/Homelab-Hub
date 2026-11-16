# Homelab Hub

A small self-hosted link page for your homelab: one card per web UI, each with a green/red **Online / Offline** dot.
Important Docker containers also show their health, and the server's stats (CPU, memory, load, network, storage) are shown at the top.
Everything you would want to change is in **one YAML file**: [config/services.yaml](config/services.yaml), which you can also edit on the page itself.

- Node.js, one dependency (`yaml`), no build step, no database, nothing loaded from the internet by the page
- Online checks over HTTP(S) or plain TCP, done by the server, so open tabs cost nothing
- Container health through a read-only Docker socket proxy
- Home network detection: at home the cards open the LAN address, away they open the public one
- Config editor on the page (form or plain YAML), with validation; a broken config never takes the page down
- Works on any Docker host; extra notes for TrueNAS in [DEPLOY.md](DEPLOY.md)

## Quick start (Docker)

```bash
git clone https://github.com/YOUR-USERNAME/homelab-hub.git
cd homelab-hub
mkdir -p data && sudo chown 1000:1000 data
docker compose up -d --build
```

Open `http://<server>:8080`. The page starts with the example config: open the gear menu → **Edit YAML** and replace the
example addresses with your own (or edit `data/services.yaml` by hand). For storage tiles, add one mount line per disk or
pool in [compose.yaml](compose.yaml).

TrueNAS: use [compose.truenas.yaml](compose.truenas.yaml) and follow [DEPLOY.md](DEPLOY.md).

> **The hub has no login of its own.** Anyone who can reach the port can see the page and use the config editor.
> Keep it on your home network, and for access from outside put it behind something that authenticates, such as
> Cloudflare Access (see [DEPLOY.md](DEPLOY.md)). To switch the editor off, set `CONFIG_EDITOR: "off"` in the compose file.

## Edit the config

In Docker the file is `/config/services.yaml` (copied from the example on the first start).
The page re-reads it every check cycle (about 30 s), no restart. A mistake never breaks the page: it keeps the last
working version and shows a red box naming the problem.

**On the page:** gear menu → **Edit YAML** opens an editor for the same file. The *Visual* tab is a form (general
settings, hosts, storage tiles, groups and services with add / remove / reorder / duplicate and an icon picker); the
*YAML* tab is the plain text. Problems are listed while you type, and a config with problems is not saved. Saving
applies at once, keeps the comments and layout of everything you did not touch, and leaves the version before in
`services.yaml.bak`. Two things to know: a comment above the *first* entry of a list stays at the top of that list when
entries are moved, and a renamed host shortcut loses the comment above it.

**Icons from a link:** in a service's icon picker, paste the link to an `.svg` file (for example one from
dashboard-icons; a GitHub page link works too) and click *Add*. The hub downloads it once into `icons/` next to the
config file and serves it itself from then on, so it survives image rebuilds and needs no internet afterwards.
Only `https` links to SVG files without scripts are accepted.

```yaml
hosts:
  nas: 192.168.1.10
groups:
  - name: NAS
    services:
      - name: Immich
        icon: immich                          # file public/icons/immich.svg (default icon if missing)
        url: https://photos.example.com       # where the card links to
        local: http://{nas}:2283              # where it links to on the home network
        check: http://{nas}:2283              # what decides the dot
        containers: ["*immich*"]              # show container health (optional)
```

| Field | Meaning |
|---|---|
| `url` | Public address the card opens. Optional if `local` is set |
| `local` | Address the card opens on the home network (optional; alone = "home network only") |
| `icon` | Name of an SVG in `public/icons/` (without `.svg`), or one added through the icon picker. Missing name or file = default icon |
| `check` | `http://…` / `https://…` (online = any answer below 500), `tcp://host:port` (port accepts connections), or `none` |
| `insecure` | `true` accepts a self-signed certificate on the check (Cockpit, Portainer) |
| `containers` | Patterns (`*` wildcard) matched against container name, compose project or service name |
| `hidden` | `true` keeps the entry but hides it |
| `hosts` | Aliases usable as `{name}` in `url`, `local` and `check` |

**Why `check` is separate from `url`:** services behind Cloudflare Access always answer with the login page, even
when the service itself is dead. Such a check shows a grey **Unknown** dot. So protected apps are checked at their real
address (server IP and port). Services without a login in front can be checked through the public address: when the
tunnel or service is down, Cloudflare answers 502/530.

**Container health states:** `healthy`, `running` (the image has no healthcheck), `starting`, `unhealthy`, `stopped`,
`no container found` (pattern matches nothing: look at `/api/containers`, linked in the footer, and fix the pattern).
A group with `autoContainers: true` gives every card a badge when a Docker container matches the card's name
(`Uptime Kuma` finds `*uptime-kuma*`); a card with its own `containers:` list uses that instead.

## Home network: local addresses

Give a service a `local:` address and its card opens that address when you are on the home network.
A service with only `local:` (no `url:`) is shown greyed out as "home network only" when you are away.

The hub decides per visit, on the server:

1. Opened **directly on the LAN** (`http://192.168.1.10:8080`) = home. (When the hub runs somewhere else than your home
   server, set `settings.home.runsAtHome: false`: a direct visit is then home only if that machine's public IP is listed in `publicIps`.)
2. Opened **through Cloudflare** (`hub.example.com`) = home when your public IP is the server's public IP
   (the hub asks Cloudflare's trace page for it, every 10 min), or one of `settings.home.publicIps` in the YAML.
3. Otherwise away. The button at the top (**Home network / Away · auto**) switches Auto → Home → Away and remembers the choice in that browser.

Why the server and not the browser: an https page may not probe `http://192.168.x.x` (mixed content), so the page cannot test for itself.
Rule 2 can be wrong (VPN, a second internet line): then add your IP to `publicIps` or use the switch. IPv6 visitors are treated as away unless listed.
Only the links change; the hub page itself is not redirected.

## Run it without Docker

```bash
npm install
npm test                      # no network needed
npm run local                 # http://localhost:1212 (set PORT to change) with config/local.yaml (a copy of services.yaml, made on the first run)
node scripts/dev-fakes.mjs    # http://localhost:8099 with fake Docker + /proc data
```

`npm run local` runs real checks against the addresses in the config. On Windows and macOS there is no `/proc`, so the stats
tiles show **this computer's** numbers (captioned "This computer · local preview"), and without Docker the container badges show "?".
`config/local.yaml` is git-ignored, so you can put your real addresses there.

Environment variables: `PORT` (8080), `CONFIG_PATH`, `DEFAULT_CONFIG_PATH`, `DOCKER_HOST` (empty = no container health),
`PROC_PATH` (`/proc`), `SYS_PATH` (`/sys`), `CONFIG_EDITOR` (`off` disables the editor).

## Open it like an app on Windows (taskbar)

```bash
powershell -ExecutionPolicy Bypass -File scripts\windows-shortcut.ps1 -Url https://hub.example.com/ -ProfileEmail you@example.com
```

Creates a **Homelab Hub** shortcut (Start menu and desktop) that opens the hub in its own Chrome window (no tabs, no
address bar) with the hub's icon. `-ProfileEmail` picks the Chrome profile signed in with that Google account;
`-ProfileDir "Profile 1"` names the profile folder instead. Pin it to the taskbar by hand: right-click the shortcut →
**Pin to taskbar** (Windows 11: *Show more options* first).

## How it works

`src/monitor.js` checks everything on a timer and keeps the result in memory; the page (`public/`) only reads
`/api/status`. Container health comes from Docker through a read-only socket proxy
(`tecnativa/docker-socket-proxy` allows only "list containers"). Host stats are read from the host's `/proc` and `/sys`.

- **Network** tile: download / upload speed, averaged over the last check cycle, summed over the physical network cards
  (read from the host's `/sys/class/net`). Pick cards with `stats.network: [eno1]` in the YAML.
- **Groups open and close:** click a group's name. A dot shows its state: green all online, amber some offline, red all offline.
  A group whose services are all offline starts closed; your own choice is remembered in the browser. A search opens everything.
- **Pins:** the pin button on a card (hover) puts it into a **Pinned** section at the top. Pins are remembered
  in that browser (localStorage), so each device has its own.
- **Storage:** one tile per entry in `stats.disks`, each pointing at a folder mounted read-only into the container
  (the hub only asks for free space). The tile shows **used / total** with a bar when the entry has a `size:`
  (e.g. `size: 3.6T`): a container can't read a ZFS pool's total, so you set it once. On a ZFS host get it with
  `zfs list -Hp -o name,used,avail -d 0` (size = used + avail). Without `size:` the tile shows just the free space.
- **Memory** "used" leaves out the ZFS cache (ARC), which is shown separately; otherwise a ZFS box always looks ~90 % full.
- **Load** = how many tasks on average are running or waiting for a CPU thread. The bar is the 1-minute value against the thread count.
- **Gear menu** (top right): choose what the page shows and how often it refreshes (saved in that browser only). Two
  timers on the server decide how fresh the data can be: stats every `statsIntervalSeconds` (default 5 s), services and
  containers every `checkIntervalSeconds` (default 30 s).

## Files

| Path | What |
|---|---|
| `config/services.yaml` | The example config (copied to the config folder on first start) |
| `src/` | `server.js` (HTTP), `monitor.js` (timer + snapshot), `config.js`, `editor.js` (config editor API), `checks.js`, `docker.js`, `stats.js`, `network.js` (home detection) |
| `public/` | The page: `index.html`, `style.css`, `app.js`; the config editor: `editor.js`, `editor.css`; `icons/` |
| `test/` | `node --test` suites, with fake servers and `/proc` fixtures |
| `Dockerfile`, `compose.yaml` | Docker deployment |
| `compose.truenas.yaml`, `scripts/`, `DEPLOY.md` | TrueNAS deployment |

## Credits and license

Code: [MIT](LICENSE).

Most icons in `public/icons/` come from [dashboard-icons](https://github.com/homarr-labs/dashboard-icons) (Apache-2.0).
The logos are trademarks of their respective owners and are used here only to identify the services.
`default`, `todo-sync`, `light`, `alarm`, `bluemap` and `terminal` were drawn for this project.
