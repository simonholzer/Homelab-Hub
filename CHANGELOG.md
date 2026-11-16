# Changelog

Every released version, newest first. The Docker image of a version is `ghcr.io/simonholzer/homelab-hub:<version>`.

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
