# CLAUDE.md — StampStack

StampStack is a private Manifest V3 Chromium extension (`stampstack-adblock`) that blocks ads/trackers using `declarativeNetRequest`, element-hiding cosmetics, and MAIN-world scriptlets. Goal: maximize EasyList / uBO filter coverage within Chrome MV3 limits.

## Quick commands

- `npm run build` — compile filters + bundle to `dist/`
- `npm run typecheck` — TypeScript strict check
- `npm run update-lists` — refresh downloadable lists under `filters/`
- `npm run smoke-extpay` — ExtPay id + store Dev-unlock gate (restores `[dev]` dist)
- `npm run watch` — JS rebuild only (re-run compile-filters after list/parser changes)

Load unpacked from `dist/`. Store cadence: `docs/RELEASE_CHECKLIST.md`. Breakage inbox: `docs/SUPPORT_TRIAGE.md`.

## Where to edit

- Runtime extension: `src/**/*.ts`, `src/**/*.html|css`, `src/manifest.json`
- Filter → DNR pipeline: `scripts/compile-filters.mjs`, `scripts/lib/{parse-filter,to-dnr,limits,redirects}.mjs`
- List registry: `filters/lists.json` (+ `.txt` files)
- Shared protocol: `src/shared/types.ts` (update all message handlers together)

Do not hand-edit `src/generated/` or `dist/`.

## Non-obvious constraints

- Static DNR rulesets are compiled offline; the SW only enables/disables them and manages dynamic allowlist rules.
- Regex DNR rules share a global budget (`MAX_NUMBER_OF_REGEX_RULES = 1000`) across lists.
- Priority bands in `scripts/lib/limits.mjs`: block < redirect < allow < important; allowlist dynamic priority is `1_000_000`.
- Generic cosmetics = injected CSS via `chrome.scripting`; specific/procedural = content script.
- Scriptlets must be domain-scoped (compiler drops global scriptlet injection).
- `src/manifest.json` has empty `rule_resources`; `scripts/build.mjs` fills them from `meta.json`.
- Settings key is `stampstack.settings` (migrates legacy `quell.settings` and short-lived rename keys).
- Ruleset id `quell-seed` stays stable; chrome.scripting ids stay `quell-*` for upgrade safety.

## Testing

Prefer `node --test` next to changed pure logic (parser, matching, hostname). There is no browser automation suite yet — verify MV3 behavior by loading `dist/` in Chrome when touching SW/DNR/content scripts.

## Style

TypeScript strict, ESM (`"type": "module"`), Chrome 120+ target. Keep comments that explain MV3/DNR rationale; avoid narrating obvious code.
