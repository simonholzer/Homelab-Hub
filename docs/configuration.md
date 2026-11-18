# Configuration

[← Back to the README](../README.md)

Everything the hub shows comes from one YAML file. In Docker it is `/config/services.yaml` (in the `hub-config`
volume, or in the folder you mounted), created on the first start. [config/services.yaml](../config/services.yaml) is
a full example with every option.

The hub re-reads the file every check cycle (about 30 s), no restart. A mistake never breaks the page: it keeps the
last working version and shows a red box naming the problem.

## The editor on the page

Gear menu → **Edit services and settings**, or the pencil on a card or group.

The *Visual* tab is a form with a page for each part of the file:

| Page | What is there |
|---|---|
| Services | Groups and their cards. Add, remove, duplicate, icon picker. Drag the handle (⠿) to reorder, also into another group, with mouse or finger |
| Found | Containers that publish a port and have no card yet (see below) |
| Machines | The stats tiles: this server's storage, and other machines ([machines.md](machines.md)) |
| Host shortcuts | Short names for addresses (`{nas}`) |
| Settings | Title, language, timing, home network, reverse proxy, Docker labels, agent search |
| Themes | Color themes of your own ([themes.md](themes.md)) |
| Import and backup | Import from other dashboards, download a backup, restore one |

The *YAML* tab is the same file as plain text, with color coding: keys, values, strings, numbers, comments and
`{host}` shortcuts each have their own color, and a color value is underlined in that color.

Problems are listed while you type, and a config with problems is not saved. Saving applies at once, keeps the
comments and layout of everything you did not touch, and leaves the version before in `services.yaml.bak`; the last 10
saved versions are kept in `backups/` next to the config. To switch the editor off, set `CONFIG_EDITOR: "off"`.

- **Found on this server** lists containers that publish a port and have no card yet. *Add* makes a normal card with
  the home address filled in; you add the public address if there is one. Databases, caches and tunnels are left out.
  It needs the docker-proxy from `compose.yaml`. The hub can't know your public addresses or which port is the web
  page when a container publishes several, so check the card after adding.
- **Import and backup:** import the config of Homepage (`services.yaml`), Dashy (`conf.yml`) or Homarr (JSON
  export); names, addresses, icons and descriptions are taken over, widgets are not. *Download a backup* saves the
  config as a file, *Restore from a file* loads one.

Each browser can also choose in the gear menu what it shows: server stats, pinned cards, groups, container badges,
**compact cards** (more per row, one line each), whether links open in a **new tab**, the theme and the language.

## Services

```yaml
hosts:
  nas: 192.168.1.10
groups:
  - name: NAS
    services:
      - name: Immich
        icon: immich                          # an icon name from dashboard-icons
        url: https://photos.example.com       # where the card links to
        local: http://{nas}:2283              # where it links to on the home network
        check: http://{nas}:2283              # what decides the dot
        containers: ["*immich*"]              # show container health (optional)
```

| Field | Meaning |
|---|---|
| `url` | Public address the card opens. Optional if `local` is set |
| `local` | Address the card opens on the home network (optional; alone = "home network only"), see [access.md](access.md#home-network-local-addresses) |
| `icon` | Icon name (see below). Missing = default icon |
| `description` | A short line under the name (optional) |
| `check` | `http://…` / `https://…` (online = any answer below 500), `tcp://host:port` (port accepts connections), or `none` for a plain link |
| `insecure` | `true` accepts a self-signed certificate on the check (Cockpit, Portainer) |
| `containers` | Patterns (`*` wildcard) matched against container name, compose project or service name |
| `widget` | A widget from `widgets.yaml`: values from the service's API on the card, see [widgets.md](widgets.md) |
| `type` | `widget` makes the entry a widget tile (only a widget's values), see [widgets.md](widgets.md#on-a-card-or-on-a-tile-of-its-own) |
| `hidden` | `true` keeps the entry but hides it |
| `hosts` | Aliases usable as `{name}` in `url`, `local` and `check` |

**Plain links:** a card with `check: none` is a bookmark: no dot, not counted as online or offline. Use it for
things that are not services of yours, such as the router's page, a provider's dashboard or your notes.

```yaml
      - name: Router
        description: Port forwarding, DHCP, Wi-Fi
        local: http://192.168.1.1
        check: none
```

**Icons:** write the name of any icon from [dashboard-icons](https://github.com/homarr-labs/dashboard-icons)
(`jellyfin`, `home-assistant`, `pi-hole` …). If the hub doesn't have it yet, it downloads the SVG once into `icons/`
next to the config file and serves it itself from then on. In the editor's icon picker you can also paste a link to any
`.svg` file. Only SVGs without scripts are accepted. `ICON_DOWNLOAD: "off"` stops the hub from fetching icons by itself.

**Container health:** `healthy`, `running` (the image has no healthcheck), `starting`, `unhealthy`, `stopped`,
`no container found` (the pattern matches nothing: look at `/api/containers`, linked in the footer).
A group with `autoContainers: true` gives every card a badge when a container matches the card's name
(`Uptime Kuma` finds `*uptime-kuma*`).

On the page, a click on a group's name opens or closes it (a group whose services are all offline starts closed), and
the pin on a card puts it into a **Pinned** section at the top, remembered per browser.

## Cards from Docker labels

Instead of writing a card into the YAML, put labels on the container. The card appears on the next check and goes
away with the container:

```yaml
services:
  grafana:
    image: grafana/grafana
    labels:
      homelab-hub.name: Grafana                      # default: the compose service name
      homelab-hub.url: https://grafana.example.com   # url and/or local is required
      homelab-hub.local: http://{nas}:3000           # {host} shortcuts from the YAML work
      homelab-hub.group: Monitoring                  # default: "Docker"
      homelab-hub.icon: grafana
      homelab-hub.check: http://{nas}:3000           # optional, like `check:` in the YAML
```

Also understood: `homelab-hub.description`, `homelab-hub.widget` ([widgets.md](widgets.md)), `homelab-hub.insecure: "true"`, `homelab-hub.hide: "true"`.
Label cards join the group of the same name from the YAML (a card with the same name in the YAML wins), show the
health of their container, and need the docker-proxy from `compose.yaml`. A label with a mistake is listed under
`labelErrors` in `/api/containers`. Switch the feature off with `settings.dockerLabels: false`. Labels on containers
of other machines work too ([machines.md](machines.md#containers-on-other-machines)).

## Settings

```yaml
settings:
  checkIntervalSeconds: 30   # how often every service and container is checked (5 to 3600)
  statsIntervalSeconds: 5    # how often CPU, memory, network and storage are measured (1 to 3600)
  timeoutSeconds: 4          # a check that takes longer counts as offline (1 to 30)
  language: auto             # default language: auto (the browser's), en, de
```

The home network, reverse proxy and login settings are in [access.md](access.md); agent search in
[machines.md](machines.md#finding-agents-on-the-network); themes in [themes.md](themes.md).

## Language

Gear menu → *Appearance* → *Language*: automatic / English / Deutsch, remembered per browser.
`settings.language: de` in the YAML sets the default for everyone who has not chosen. Texts that come from the server
(config problems, some check details) are English. Another language is one block in
[public/i18n.js](../public/i18n.js); see [CONTRIBUTING.md](../CONTRIBUTING.md).
