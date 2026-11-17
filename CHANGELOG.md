# Changelog

Every released version, newest first. The Docker image of a version is `ghcr.io/simonholzer/homelab-hub:<version>`.

## 1.4.0

- **Containers on other machines.** An agent with `DOCKER_HOST` (compose.agent.yaml now brings its own read-only
  docker-proxy) sends its containers to the hub. Health badges, cards from Docker labels and the "found" list then
  work for every machine, not only the one the hub runs on.
- **Agents find themselves.** The hub searches its home network for agents and lists them in the editor under
  *Server stats → Found on the network*, with an Add button. `settings.discovery` sets networks and ports;
  `AGENT_DISCOVERY: "off"` switches the search off.
- **Editor in pages.** Instead of one long scroll, the editor has tabs: Services, Found, Machines, Host shortcuts,
  Settings, Import and backup. Each setting sits in a box with its topic, a service's fields are grouped into Card,
  Addresses and Status, and Services has a search box and "Open all / Close all".
- The agent's `/healthz` now also says its name (`AGENT_NAME`), version and whether it reports containers.

Updating needs no changes. To get the containers of another machine, update its agent with the new
compose.agent.yaml (it adds the docker-proxy).

## 1.3.0

Everything in this version is about the first hour with the hub.

- **Edit from where you are.** A pencil on every card and group opens the editor at that entry. The menu entry is
  now called "Edit services and settings" instead of "Edit YAML".
- **Found on this server.** The editor lists containers that publish a port and have no card yet; one click makes a
  card with name, icon and home address.
- **First-start guide.** A new hub shows three steps: add services, let the hub look for them, set a password.
- **Password on the page.** Set, change or remove it in the gear menu; stored as a salted hash in `hub-auth.json`.
  `HUB_PASSWORD` in the compose file still works and wins.
- **Clear hints instead of silence.** A storage tile whose path isn't mounted says which line to add; missing server
  stats say why; a hub that is set to "not on the home network" while running on a server shows a notice.
- **Import** from Homepage, Dashy and Homarr, **backup download and restore**, and the last 10 saved versions are
  kept in `backups/`.
- **Update notice.** The gear menu shows the running version and links to a newer release (`UPDATE_CHECK: "off"`
  switches the check off).
- **View options per browser:** compact cards, and links in the same tab or a new one.
- **compose.yaml** now keeps the config in a Docker volume, so a new install needs no folder and no decision.
  Existing installs keep working as they are; nothing has to be changed.

## 1.2.0

- **Plain links.** A card with `check: none` is now a bookmark: no dot, not counted as online or offline. A group
  of only links shows "3 links" instead of "0 of 3 online".
- **Description line.** `description:` (or the Description field in the editor) shows a short line under the name;
  the filter searches it too.
- **Drag and drop in the editor.** Services and groups are moved by their handle, with mouse or finger; a service
  can be dragged into another group. The up/down buttons stay.
- **Phone layout.** One column, larger touch targets, the gear menu fits the screen, and each machine's stats fold
  into one line (tap the caption to open; on larger screens they start open).
- **Install as app.** Web app manifest and icons, so browsers offer "Install" / "Add to Home screen".

Changed behaviour: a service with `check: none` used to show a grey "Unknown" dot and count as unknown; it now has
no dot. Updating needs no changes to the config.

## 1.1.0

- **Stats from other machines.** The same image runs as a small agent on another machine (`HUB_MODE=agent`,
  see `compose.agent.yaml`); the hub lists it under `stats.machines` and shows a row of tiles for each machine.
  An optional `AGENT_TOKEN` protects the agent.
- **Config editor:** other machines with their storage tiles and network cards, the default language, and the
  switch for cards from Docker labels can now be edited in the form, not only in the YAML text.
- `npm run demo` shows a second machine; new screenshots.

Updating from 1.0.0 needs no changes to the config.

## 1.0.0

First public version.

- Service cards with online checks over HTTP(S) or TCP, grouped, with pins and a filter
- Container health through a read-only Docker socket proxy; cards from Docker labels (`homelab-hub.*`)
- Server stats: CPU, memory, load, network, storage tiles
- Home network detection, also behind reverse proxies (`settings.home.clientIpHeader`), and login pages that are not
  mistaken for a running service (`settings.loginHosts`)
- Config editor on the page (form or YAML) with validation and a backup of the version before
- Icons by name from dashboard-icons, fetched once and kept
- Optional password login (`HUB_PASSWORD`), for the whole page or only the editor
- Dark and light theme, English and German
- Docker image for amd64 and arm64
