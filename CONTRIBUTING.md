# Contributing

Thanks for helping. This is a small project, so the rules are short.

## Getting it running

```bash
npm install
npm test          # all tests, no network needed
npm run demo      # http://localhost:8099 with made-up data: the quickest way to see a change
```

Node.js 22 or newer. There is no build step: edit a file in `public/` and reload the page; `npm run dev` restarts the
server when a file in `src/` changes.

## What a change should keep

- **No new dependencies** unless there is no reasonable way around it. The hub has one (`yaml`) on purpose.
- **No build step, no framework.** The page is plain HTML, CSS and JavaScript modules.
- **A broken config never takes the page down.** New settings are validated in `src/config.js` and get a readable error.
- **Text from the config never becomes HTML.** Use `textContent` (the `h()` helper does).
- **Tests for behaviour changes.** They live in `test/` and run with `node --test`.
- Document new settings in `config/services.yaml` (the full example) and the README.

## Translations

All texts of the page are in [public/i18n.js](public/i18n.js). The English text is the key:

```js
const de = {
  'Online': 'Online',
  '{n} of {m} online': '{n} von {m} online',
  ...
};
```

To add a language: copy the `de` block, translate the right-hand sides (keep the `{placeholders}`), add the block to
`DICTIONARIES` and the language to `LANGUAGES` in that file and in `src/config.js`. A missing entry falls back to
English, so a partial translation is fine.

New text in the page goes through `t('…')` (in the config editor, `h()` translates `text`, `title`, `aria-label` and
`placeholder` by itself), with an entry in every dictionary.

## Icons

Icons are not added to the repository any more: the hub fetches them by name from
[dashboard-icons](https://github.com/homarr-labs/dashboard-icons). If one is missing there, contribute it upstream.

## Reporting a bug

Please include the hub's version or image tag, how it runs (Docker, TrueNAS, Node), the relevant part of the config
**with addresses and domains replaced**, and what `/api/status` or the container log says. Never post passwords or
your real public IP.

## Security problems

Please don't open a public issue for a security problem. Use GitHub's private vulnerability reporting
(repository → Security → Report a vulnerability).
