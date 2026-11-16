# Changelog

Every released version, newest first. The Docker image of a version is `ghcr.io/simonholzer/homelab-hub:<version>`.

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
