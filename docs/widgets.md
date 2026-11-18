# Widgets

A widget shows a few values from a service's own API on its card: how many photos Immich keeps, how many people are
streaming from Jellyfin, how many containers Portainer runs. You describe the widget once, and any card can use it.

Widgets live in their own file, **`widgets.yaml`**, next to the config (`/config/widgets.yaml` in Docker), so the
config stays readable. The file is made the first time you save a widget in the editor; you can also write it by hand.

## Ready-made widgets

The hub knows widgets for Immich, Jellyfin, Portainer, Sonarr, Radarr, Lidarr, Prowlarr, Jellyseerr/Overseerr,
Home Assistant, Paperless-ngx, Nextcloud, Syncthing and Proxmox VE. When a card looks like one of them (its icon,
name or container patterns), the editor offers the widget: in the card under *Widget*, and on the Widgets page under
*Ready-made widgets*. One click copies it into `widgets.yaml`; then only the key is missing, which the editor names
(for example `IMMICH_API_KEY`) and says whether it is already set on the hub. After that it is an ordinary widget
you can change. New ones go into [src/widget-templates.js](../src/widget-templates.js).

## On a card, or on a tile of its own

A widget can be shown in two ways:

- **On a card:** the values sit under the card's name (`widget:` on the card).
- **On a widget tile:** a tile with only the values, headed by the widget's name and icon, no online dot. Tiles go
  into a **widget row** (a group with `type: widgets`, which holds tiles only), or into any normal group next to the
  cards (`type: widget`).

```yaml
groups:
  - name: Widgets                         # a widget row: moved like any other group
    type: widgets
    services:
      - widget: immich
      - widget: portainer

  - name: NAS
    services:
      - name: Jellyfin
        local: http://{nas}:8096
        widget: jellyfin                  # on the card
      - type: widget                      # a tile in a normal group
        widget: jellyfin
```

A card asks the widget's path on its own address. A tile has no address of its own, so the widget gets one on the
Widgets page (**Address for tiles**, `address:` in `widgets.yaml`), which a click on the tile also opens. Taking a
ready-made widget *as its own tile*, or *Move to its own tile* on a card, fills it in from the card.

```yaml
immich:
  name: Photos                            # also the heading of its tiles
  icon: immich
  address: http://{nas}:2283              # where its tiles ask (and what they open)
  path: /api/server/statistics
  ...
```

Widgets are **made and changed only on the Widgets page**. On the Services page a card or tile only picks one of
them, and tiles are moved with their handle like cards: between groups, and into or out of widget rows (only tiles
go into a widget row). *Add widget row* makes a new row; it moves like every group.

**Hiding:** the gear menu's *All widgets* switch hides all of them (values on cards, tiles and widget rows). The small eye
on a tile, or next to the pin of a card with values, hides just that one; the gear menu lists the hidden ones under
*Hidden widgets* to show them again. Both are kept in this browser only.

## Making one in the editor

1. Gear menu → **Edit services and settings** → **Widgets** → **Add widget**.
2. **Request:** the API path, e.g. `/api/server/statistics`. It is added to the address of the card that uses the
   widget (its home address first: the hub runs at home). Or choose *A full address* and write the whole address.
3. **Headers:** most APIs want a key. Write `{env:IMMICH_API_KEY}` as the value and put the key into the hub's
   `compose.yaml` (below). Then the key is never in a file and never reaches the page.
4. **Test:** pick a card and click *Test*. The hub asks the API and lists everything in the answer
   (`photos = 48213`, `count(usageByUser) = 2` …). A click on one adds it as a value on the card.
5. **Values on the card:** a label, where the value is in the answer, and how it is shown (number, size, percent,
   duration, text). Up to six per widget.
6. In the card (Services page): **Widget** → pick it. **Save.**

On the YAML tab, the two tabs above the text switch between the config and `widgets.yaml`.

## An example: Immich

`widgets.yaml`:

```yaml
immich:
  name: Immich statistics                 # how the editor lists it (optional)
  path: /api/server/statistics            # added to the card's address
  headers:
    x-api-key: "{env:IMMICH_API_KEY}"     # an API key (Immich: Account Settings → API Keys; needs an admin's key)
  fields:
    - label: Photos
      value: photos
      format: number
    - label: Videos
      value: videos
      format: number
    - label: Storage
      value: usage
      format: bytes
```

The card in the config:

```yaml
      - name: Immich
        local: http://{nas}:2283
        widget: immich
```

`compose.yaml`, under the hub's `environment:`:

```yaml
      IMMICH_API_KEY: "the key from Immich"
```

(`docker compose up -d` again after changing it.) A non-admin key can use `/api/assets/statistics` instead, which
answers with `images`, `videos` and `total` of that user's own library.

## The fields of a widget

| Field | Meaning |
|---|---|
| `path` | Added to the card's address (`local` first, else `url`). Empty = the card's address itself |
| `url` | A full address instead of `path`. `{host}` shortcuts work |
| `method` | `GET` (default) or `POST` |
| `body` | What a `POST` sends (a text, or YAML that is sent as JSON) |
| `headers` | Headers to send, e.g. an API key |
| `insecure` | `true` accepts a self-signed certificate |
| `name` | The widget's name, also the heading of its tiles (default: its key) |
| `icon` | Icon of its tiles (an icon name, like a card's) |
| `address` | Where its tiles ask the `path` (a card uses its own address) |
| `fields` | The values on the card (1 to 6): `label`, `value`, `format`, `suffix` |

**`value`** says where the value is in the answer (JSON):

| Written | Means |
|---|---|
| `photos` | The value `photos` at the top of the answer |
| `data.stats.total` | A value inside others |
| `items.0.name` (or `items[0].name`) | An entry of a list, counted from 0 |
| `count(items)` | How many entries a list has; `count(.)` when the answer itself is a list |
| `count(items.*.playing)` | How many entries have a `playing` value (`*` = every entry) |
| `sum(items.*.size)`, `min(…)`, `max(…)`, `avg(…)` | Add up, smallest, largest, average |

**`format`:** `auto` (default), `number` (with thousands separators), `bytes` (KB, MB, GB …), `percent`,
`duration` (from seconds), `text`. **`suffix`** is written after the value (`°C`, `users` …).

**Placeholders** in `path`, `url`, `headers` and `body`:

- `{env:NAME}`: the hub's environment variable `NAME`. If it isn't set, the card says so (the rest of the page works).
- `{nas}`: a host shortcut from `hosts:`.
- `{anything}` else: a value of each card's own. The card then writes the widget as
  `widget: { use: name, anything: value }`; the editor asks for it under *Widget*. So one widget can serve two
  servers that need different values (a library id, a user name …).

A card made from Docker labels uses a widget with `homelab-hub.widget: immich`.

## Sharing

On the Widgets page, the share button (**Copy as YAML**) copies one widget. Header values that are not placeholders
are replaced by `{env:YOUR_API_KEY}` on the way, so a key isn't shared by accident. **Import widgets…** on the same
page takes such a block (or several) from someone else. A shared widget is plain YAML, so it can also be pasted
straight into `widgets.yaml`.

## When it doesn't work

The card shows the problem in place of the values; *Test* in the editor shows it with the address that was asked.

| Message | What to do |
|---|---|
| `Not set on the hub: NAME` | Add `NAME` under `environment:` in `compose.yaml`, then `docker compose up -d` |
| `HTTP 401` / `HTTP 403` | The key is wrong, or the API wants it in another header (see the service's API docs) |
| `HTTP 404` | The path doesn't exist on this service or version |
| `redirected to …` | The address goes through a login page: use the service's direct address (`local:`) |
| `The answer is not JSON` | The path leads to a web page, not to the API |
| `… is not in the answer` | The value's name is wrong; *Test* lists the names the answer has |

The hub asks every widget once per check cycle (`checkIntervalSeconds`), at the same time as the online checks, and
the page only ever gets the finished values: the address and headers stay on the hub.
