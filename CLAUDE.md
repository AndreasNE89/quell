# CLAUDE.md — StampStack

StampStack is a private Manifest V3 Chromium extension (`stampstack-adblock`) that blocks ads/trackers using `declarativeNetRequest`, element-hiding cosmetics, and MAIN-world scriptlets. Goal: maximize EasyList / uBO filter coverage within Chrome MV3 limits.

## Quick commands

- `npm run build` — compile filters + bundle to `dist/`
- `npm run typecheck` — TypeScript strict check
- `npm run update-lists -- [ids…] [--allow-shrink]` — refresh downloadable lists under `filters/`: every download is checked, all are written or none, then the lock is re-stamped
- `npm run check-lists` — verify `filters/*.txt` against `filters/lists.lock.json`
- `npm run smoke-extpay` — ExtPay id + store Dev-unlock gate (restores `[dev]` dist)
- `npm run watch` — JS rebuild; the manifest, rulesets, CSS and static files follow `src/generated/meta.json` and their sources (run compile-filters yourself after list/parser changes)
- `npm run preview -- --page=options --state=stale-lists` — render a UI state without Chrome

Load unpacked from `dist/`. Store cadence: `docs/RELEASE_CHECKLIST.md`. Breakage inbox: `docs/SUPPORT_TRIAGE.md`.

## Where to edit

- Runtime extension: `src/**/*.ts`, `src/**/*.html|css`, `src/manifest.json`
- Filter → DNR pipeline: `scripts/compile-filters.mjs`, `scripts/lib/{parse-filter,to-dnr,limits,redirects}.mjs`
- List registry: `filters/lists.json` (+ `.txt` files); `minRules` is the package gate's per-list floor
- List and package tooling: `scripts/{update-lists,lock-lists,package}.mjs`, `scripts/lib/{list-lock,list-update,package-checks,zip}.mjs`
- License texts: `docs/licenses/` (copied to `dist/licenses/`), listed on `docs/attributions.html` and in `ATTRIBUTIONS.md`
- Shared protocol: `src/shared/types.ts` (update all message handlers together)

Do not hand-edit `src/generated/` or `dist/`.

## Non-obvious constraints

- Static DNR rulesets are compiled offline; the SW only enables/disables them and manages dynamic allowlist rules.
- Regex DNR rules share a global budget (`MAX_NUMBER_OF_REGEX_RULES = 1000`) across lists.
- Priority bands in `scripts/lib/limits.mjs`: removeparam (500) < its `@@` allow (600) < block < redirect (`1500`, plus uBO's `:N` clamped to ±499) < allow < important; allowlist dynamic priority is `1_000_000`.
- Generic cosmetics = injected CSS via `chrome.scripting`; specific/procedural = content script.
- Scriptlets must be domain-scoped (compiler drops global scriptlet injection).
- `src/manifest.json` has empty `rule_resources`; `scripts/build.mjs` fills them from `meta.json`.
- Settings key is `stampstack.settings` (migrates legacy `quell.settings` and short-lived rename keys).
- Ruleset id `quell-seed` stays stable; chrome.scripting ids stay `quell-*` for upgrade safety.
- The filter lists are committed and marked `-text` in `.gitattributes`. Without that, `core.autocrlf` rewrites them on checkout and every hash in `lists.lock.json` fails on a Linux runner.
- Lists are preprocessed like uBO's (`!#if` env: chromium, mv3, ublock, plus ubol for network lines only, since cosmetics and scriptlets run uBO MV2's engine; everything else false; see `preprocessFilterText`). `!#include` is expanded only from a file already under `filters/`, never downloaded.
- `meta.generatedAt` comes from `lists.lock.json`, not from file mtimes — mtimes do not survive a clone, and the value is embedded in the shipped bundle.

## Testing

Prefer `node --test` next to changed pure logic (parser, matching, hostname). Page behaviour is tested in real Chromium through Playwright (`*-dom.test.mjs`, `content-extension.test.mjs`); those tests skip when Chromium cannot launch. `test/build-script.test.mjs` runs `scripts/build.mjs` on a fixture tree through `STAMPSTACK_BUILD_ROOT`. Still load `dist/` in Chrome when touching SW/DNR registration.

## Style

TypeScript strict, ESM (`"type": "module"`), Chrome 120+ target. Keep comments that explain MV3/DNR rationale; avoid narrating obvious code.
