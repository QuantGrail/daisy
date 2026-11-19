# Contributing

[中文](CONTRIBUTING.zh-CN.md)

Thanks for helping improve Daisy. Below: dev setup, tests, conventions, and how to submit a change.

## Setup

- Node.js 24 or later (`node --version`); npm comes with Node. You can develop on Linux, macOS or Windows.

```sh
npm ci                   # install dependencies
npm start                # run Daisy from source (foreground)
npm run build:web        # build the local web page
npm run daisy -- --help  # the `daisy` command from source
```

From a checkout, Daisy keeps its data in `.data/` inside the checkout and never touches your everyday Daisy. Set `DAISY_DATA` to put it elsewhere, and `DAISY_PORT` if the port is taken.

## Tests

```sh
npm test                                   # behaviour tests
npm run typecheck
npm run gen:api -- --check                 # docs/api matches the route table
TZ=UTC LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 node scripts/ci-test.mjs   # the local gate: every test
```

- Tests never touch the network: `tests/no-network.mjs` refuses every connection and name lookup except to this machine. Tests never use a real harness, login or quota; use the fake programs in `tests/fixtures/`.
- Tests not yet supported on one OS are listed in `tests/platform-pending.json` with a reason; that list may only shrink.
- A behaviour change comes with a test of that behaviour first. Changes to permissions, authentication or protocols always need a behaviour test.

## Conventions

- Product and command names come only from `packages/contracts/src/names.ts`.
- The local API is defined once (`packages/contracts/src/api/`): add or change a route there; the command line and `docs/api` are generated from it (`npm run gen:api`).
- A database schema change appends a migration step in `packages/daisy/src/store/schema.ts`; existing steps are never edited.
- Text people read and the AI's prompts live only in the language packs (see [Language packs](#language-packs)); source code names keys. Code comments and log lines are in English. No credentials, tokens or PINs in logs, error messages or tests.
- The user guide has Chinese (`docs/guide/zh-CN`) and English (`docs/guide/en`) pages with the same names and sections; when you change one, change the other in the same commit.
- The core never names a plugin; plugins plug in only through `@daisy-ai/daisy/plugin`.

## Language packs

Daisy's text lives per language in `packages/contracts/locales/<language>/`: one folder per language (named by its BCP 47 tag, such as `en` or `zh-CN`), one flat JSON file per area (`cli.json`, `ui-chat.json`, …) whose keys start with the file's name (`cli.json` holds only `cli.*`); long prompts are `prompts/*.md`. Parameters are written `{name}`; a count that changes the words is a plural choice, `{count, plural, one {# step} other {# steps}}` (`#` is the number; a language without plural forms just writes `{count} …`). The design is in `docs/adr/ADR-159-language-packs.md`.

**Adding or changing text**

- Add the key to the file of the same name in both `en` and `zh-CN` (the same key, the same `{params}`), run `npm run gen:i18n`, and say it in code with `t("area.…", { … })`. Put whole sentences in the pack, never pieces to join. `en` is the reference pack: the typed keys are generated from it.
- `tests/i18n.test.ts` checks that both shipped packs have exactly the same keys, the same params and no empty text; `scripts/i18n-scan.ts` keeps Chinese from coming back into source code (`tests/i18n-pending.json` stays empty; the few deliberate exceptions are in `tests/i18n-kept.json`, each with a reason).
- Tests default to Chinese (`tests/test-env.mjs` sets `DAISY_LANG=zh-CN`); test new text in both languages (`--lang en`, `Accept-Language: en`, `setUiPack("en", …)`).

**Improving a translation** — edit the entry in that language's folder; the key stays. Changing a prompt the AI reads (`prompt*.json`, `prompts/*.md`) also means updating that language's pinned sample in `tests/fixtures/`; say so in the pull request.

**Adding a language**

1. Try it on your own Daisy first: copy `packages/contracts/locales/en/` to `<data dir>/locales/<language tag>/` and translate it. Within a few seconds it can be chosen in Settings › Display language and with `daisy language` (no restart; keys it lacks show in English).
2. To ship it with Daisy, add every file (including `prompts/*.md`) under `packages/contracts/locales/<language tag>/` — no code changes: the list of languages is these folders. A shipped pack must be complete (the same keys and params as `en`) and comes with a pinned prompt sample. A review by a native speaker is very welcome.

## Commits and pull requests

- Commit messages: `type(scope): summary`, for example `fix(relay): …`, `feat(cli): …`, `docs: …`, `test(a2a): …`. One change per commit.
- In the pull request, say what changed, why, how you tested it (which tests, on which OS), and whether existing behaviour or data changes.
- Report security issues privately as described in [SECURITY.md](SECURITY.md), not in public issues or pull requests.

## License

Daisy is released under the [Apache License 2.0](LICENSE). Contributions are accepted under the same license (Section 5 of the license, inbound = outbound): no contributor license agreement (CLA) and no `Signed-off-by` are required. Only submit code you have the right to license this way.

Please follow the [Code of Conduct](CODE_OF_CONDUCT.md).
