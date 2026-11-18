# Installing, updating and running

[← Back to the README](../README.md)

For TrueNAS, see [DEPLOY.md](../DEPLOY.md).

## Versions and updates

`compose.yaml` uses the tag `latest`, which follows the newest state of the project. To stay on a version until you
decide to move, write it instead, e.g. `ghcr.io/simonholzer/homelab-hub:1.7.0` (also `:1.7` for the newest 1.7.x and
`:1` for the newest 1.x). All versions and what changed are under
[Releases](https://github.com/simonholzer/Homelab-Hub/releases) and in [CHANGELOG.md](../CHANGELOG.md). To update:

```bash
docker compose pull && docker compose up -d
```

Your config is kept. The gear menu shows the running version and, when there is one, a link to a newer release
(the hub asks GitHub at start and twice a day; `UPDATE_CHECK: "off"` stops that).

## On a phone, and as an app

The page adapts to small screens: one column of cards, and each machine's stats fold into one line (tap the caption
to open them; the choice is remembered).

To get it onto the home screen or into its own window:

- **Android (Chrome):** menu ⋮ → *Add to Home screen* / *Install app*
- **iPhone / iPad (Safari):** Share → *Add to Home Screen*
- **Desktop (Chrome, Edge):** the install icon at the right end of the address bar, or menu → *Install Homelab Hub*

Browsers only offer installing on `https://` addresses (and on `localhost`). On a plain `http://192.168.…` address
"Add to Home screen" still makes a shortcut, but it opens as a normal browser tab. The hub does not work offline: it
shows live data, so nothing is stored on the device.

### Windows taskbar shortcut

The browser's own "Install" is the simplest way. This script is the alternative for plain `http://` addresses, or to
pick a specific Chrome profile:

```bash
powershell -ExecutionPolicy Bypass -File scripts\windows-shortcut.ps1 -Url https://hub.example.com/
```

Creates a **Homelab Hub** shortcut (Start menu and desktop) that opens the hub in its own Chrome window with the hub's
icon. `-ProfileEmail you@example.com` or `-ProfileDir "Profile 1"` picks the Chrome profile. Pin it to the taskbar by
hand: right-click the shortcut → **Pin to taskbar**.

## Run it without Docker

```bash
npm install
npm test                      # no network needed
npm run demo                  # http://localhost:8099 with made-up services, containers, stats and a second machine
npm run local                 # http://localhost:1212 with config/local.yaml (a copy of the example, made on the first run)
```

Node.js 22 or newer. `npm run local` runs real checks against the addresses in `config/local.yaml` (git-ignored, so
your real addresses can go there). On Windows and macOS there is no `/proc`, so the stats tiles show this computer's
numbers, and without Docker there are no container badges.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | Port to listen on |
| `CONFIG_PATH` | `config/services.yaml` (`/config/services.yaml` in Docker) | The config file |
| `DEFAULT_CONFIG_PATH` | | Copied to `CONFIG_PATH` when that doesn't exist yet |
| `DOCKER_HOST` | empty | Docker API (`http://docker-proxy:2375`); empty = no container health, no label cards |
| `PROC_PATH`, `SYS_PATH` | `/proc`, `/sys` | Where the host's stats are mounted |
| `HUB_PASSWORD`, `HUB_PASSWORD_PROTECTS` | | Login, see [access.md](access.md) |
| `CONFIG_EDITOR` | on | `off` removes the editor |
| `ICON_DOWNLOAD` | on | `off` never fetches icons |
| `UPDATE_CHECK` | on | `off` never asks GitHub for the latest version. `UPDATE_REPO` (`owner/name`) points it at a fork |
| `AGENT_DISCOVERY` | on | `off` never searches the network for agents |
| `WIDGETS_PATH` | `widgets.yaml` next to the config | The widgets file, see [widgets.md](widgets.md). Any other variable can hold a widget's key (`{env:NAME}`) |
| `PUID`, `PGID` | `1000` | Docker only: the user the hub runs as |
| `HUB_MODE`, `AGENT_TOKEN`, `AGENT_NAME` | | Agent mode, see [machines.md](machines.md) |

## How it works

`src/monitor.js` checks everything on a timer and keeps the result in memory; the page (`public/`) only reads
`/api/status`. Container health and labels come from Docker through a read-only socket proxy
(`tecnativa/docker-socket-proxy` allows only "list containers"). Host stats are read from the host's `/proc` and
`/sys`. Two timers decide how fresh the data is: stats every `statsIntervalSeconds` (default 5 s), services and
containers every `checkIntervalSeconds` (default 30 s).

| Path | What |
|---|---|
| `config/services.yaml`, `config/starter.yaml`, `config/widgets.yaml` | Full example config; the small one a new install starts with; example widgets |
| `src/` | `server.js` (HTTP), `monitor.js` (timer + snapshot), `config.js`, `checks.js`, `docker.js`, `stats.js`, `network.js` (home detection), `auth.js` (login), `agent.js` (stats from other machines), `scan.js` (finding agents), `discover.js` (found on this server), `import.js`, `update.js`, `icons.js`, `editor.js` (config editor API), `widgets.js` (values from a service's API), `widget-templates.js` (ready-made widgets) |
| `public/` | The page: `index.html`, `app.js`, `style.css`, `i18n.js` (translations), `theme.js`, the login page, the config editor, `manifest.webmanifest` and app icons, `icons/` |
| `test/` | `node --test` suites, with fake servers and `/proc` fixtures |
| `docs/` | These pages and the screenshots |
| `Dockerfile`, `docker-entrypoint.sh`, `compose.yaml`, `compose.agent.yaml` | Docker: the hub, and the agent for other machines |
| `compose.truenas.yaml`, `scripts/`, `DEPLOY.md` | Building on a TrueNAS box, helper scripts |
| `CHANGELOG.md`, `.github/workflows/` | What changed per version; tests, image build and release on GitHub |
