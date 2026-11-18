# Themes

[← Back to the README](../README.md)

## Picking a theme

Gear menu (top right) → **Edit services and settings** → **Settings** → **This browser** → **Theme** (without access to the editor: gear menu → **Appearance**). The choice is kept in that browser, so a phone and a PC can use
different themes.

| Theme | |
|---|---|
| Automatic | Dark or light, following the setting of the computer or phone |
| Dark | The default: near-black with a blue accent |
| Light | Light grey and white |
| Catppuccin Mocha | Soft pastel colors on dark blue-grey ([catppuccin.com](https://catppuccin.com), MIT) |
| Nord | Calm, cool blue-grey ([nordtheme.com](https://www.nordtheme.com), MIT) |
| Gruvbox | Warm, retro browns and yellows ([gruvbox](https://github.com/morhetz/gruvbox), MIT) |
| High contrast | Black and white with strong lines; online / offline in blue / orange, which most colour-blind eyes tell apart |

Themes of your own (below) appear in the same list, for everyone who opens the hub.

## Making a theme in the editor

Gear menu → **Edit services and settings** → **Themes**.

1. **Add theme.** A new theme starts as a copy of *Dark*.
2. **Name in the menu** is what people see in the theme list. **Name in the file** is its key in the YAML (letters,
   digits, `-` and `_`; it can't be the name of a built-in theme).
3. **Starts from** picks the built-in theme it is based on. Every color you leave empty comes from there; the empty
   boxes show that color in grey.
4. Change colors with the **color picker** (the square) or type a value: `#7aa2ff`, `#7aa2ff80` (with
   transparency), `rgb(122, 162, 255)` or `hsl(222 100% 74%)`. The **×** next to a color gives it back to the base
   theme.
5. The **small preview** next to the names shows a card, the status dots, a bar and a button in the new colors.
   **Try on the page** (the eye) shows the theme on the whole hub, the editor included, until you click it again or
   close the editor.
6. **Save.** Then pick the theme under Settings → This browser → Theme.

Each theme is a box that folds: click its name to open or close it. Closed, it shows its main colors as dots.
With several themes, *Open all* / *Close all* is at the top. The buttons on a theme: try it, copy it as YAML (to
share), duplicate, remove.

### The colors

| Color | YAML key | Used for |
|---|---|---|
| Background | `bg` | The page behind everything |
| Cards | `panel` | Cards, the stats tiles, the menus |
| Card under the mouse | `panelHover` | A card or button while the mouse is on it |
| Lines | `border` | Thin lines around cards and tiles |
| Strong lines | `borderStrong` | Lines that should stand out: inputs, menus |
| Text | `text` | Normal text |
| Quiet text | `muted` | Addresses, captions, hints |
| Accent | `accent` | Links, buttons, the bars of the stats, focus rings |
| Text on accent | `onAccent` | Text on an accent-colored button |
| Online | `up` | Green dot, "healthy" |
| Offline | `down` | Red dot, errors |
| Warning | `warn` | "starting", "unhealthy", warnings |
| Unknown | `unknown` | Grey dot: not checked yet, behind a login page |
| Bar background | `track` | The empty part of a bar |
| Shadow | `shadow` | Shadows of menus and cards (usually a black with transparency) |

### Tips

- **Start from the closest built-in theme** and change three or four colors (`bg`, `panel`, `accent` is often enough).
  A theme for a light page should start from *Light*: it also tells the browser to draw light scrollbars and
  inputs.
- **Keep text readable:** `text` and `muted` need enough contrast against `panel`, and `onAccent` against `accent`.
  The preview shows both.
- **Keep the dots apart:** `up`, `down`, `warn` and `unknown` should not look alike, also for colour-blind people.
- **Logos:** the hub flips very dark logos on dark themes and very light ones on light themes, based on the base
  theme.

## Sharing a theme

**Copy:** the share button on a theme (*Copy as YAML*) puts a block like this on the clipboard:

```yaml
themes:
  purple-night:
    name: "Purple night"
    base: "dark"
    accent: "#b48eff"
    bg: "#0d0b14"
    panel: "#151221"
```

Post it anywhere (a GitHub issue, a chat, a gist).

**Import:** *Import themes…* at the top of the Themes page. Paste such a block (or load it from a file) and click
*Import*. It understands a whole `themes:` section, several themes, or just the colors of one. A theme whose name is
already taken gets a number added. Check it, then save.

## In the YAML

Themes live under `themes:` in `services.yaml`; the editor writes the same thing. You can also write them by hand,
in the editor's YAML view or in the file:

```yaml
themes:
  purple-night:                 # the key: letters, digits, - and _ (up to 40)
    name: Purple night          # shown in the menu (default: the key)
    base: dark                  # dark, light, catppuccin, nord, gruvbox or high-contrast (default: dark)
    accent: "#b48eff"           # put # colors in quotes: YAML reads # as the start of a comment
    bg: "#0d0b14"
    panel: rgb(21, 18, 33)      # rgb() and hsl() need no quotes
```

A mistake (an unknown color key, a value that isn't a color, a built-in name) is listed in the editor and in the
red box on the page, like every other config problem. Only plain color values are accepted, so nothing else can get
into the page through a theme. At most 20 themes.

## Adding a built-in theme (for contributors)

A built-in theme is in three places, and a test checks that they agree:

1. a `:root[data-theme="your-theme"] { … }` block with all 15 variables in [public/style.css](../public/style.css),
   plus `color-scheme: dark` or `light`;
2. an entry `{ id: 'your-theme', name: 'Your theme' }` in `BUILTIN` in [public/theme.js](../public/theme.js);
3. the id in `BUILTIN_THEMES` in [src/config.js](../src/config.js).

If the name needs translating, add it to [public/i18n.js](../public/i18n.js). Credit the palette in a comment above
its block and in the table above. See [CONTRIBUTING.md](../CONTRIBUTING.md).
