# StampStack — Agent guide

Manifest V3 Chromium ad/tracker blocker aiming for uBlock Origin–class blocking within MV3 limits (`declarativeNetRequest` + cosmetics + scriptlets).

## Commands

```bash
npm install
npm run update-lists      # download lists from filters/lists.json URLs into filters/
npm run compile-filters   # filters/*.txt → src/generated/
npm run bundle            # esbuild → dist/ (needs generated/)
npm run build             # compile-filters && bundle
npm run build:store       # store build (DEV_BUILD=false, ExtPay required)
npm run package           # update-lists + store build + obfuscation scan + zip
npm run smoke-extpay      # ExtPay id + store Dev-unlock gate + obfuscation scan
npm run scan-package      # atob / long-base64 scan of dist/
npm run watch             # rebuild JS on change (does not recompile filters)
npm run typecheck         # tsc --noEmit
npm test                  # node --test (add tests next to code when touching logic)
npm run clean
```

Store release steps: `docs/RELEASE_CHECKLIST.md`. Support / breakage triage: `docs/SUPPORT_TRIAGE.md`.

Load the extension: Chrome → `chrome://extensions` → Developer mode → **Load unpacked** → `dist/`.

## Layout

| Path | Role |
|------|------|
| `src/manifest.json` | MV3 source manifest (`rule_resources` filled at build) |
| `src/background/` | Service worker: ruleset sync, allowlist, cosmetics API, badge |
| `src/content/` | Isolated content script + MAIN-world scriptlets entry |
| `src/engine/` | Cosmetic matching + procedural selectors |
| `src/scriptlets/` | Scriptlet library injected in MAIN world |
| `src/popup/`, `src/options/` | UI |
| `src/shared/` | Types, message protocol, constants |
| `src/redirects/` | WAR stubs for `$redirect` |
| `filters/` | List registry + EasyList-style `.txt` sources |
| `scripts/` | Compile + bundle toolchain |
| `src/generated/` | **Build output** (gitignored) — do not hand-edit |
| `dist/` | Unpacked extension (gitignored) |

## Architecture (short)

1. **Network**: filter lines → DNR static rulesets (`scripts/compile-filters.mjs` + `scripts/lib/*`).
2. **Cosmetics**: generic CSS registered via `chrome.scripting`; hostname-specific + procedural via content script messaging.
3. **Scriptlets**: MAIN-world IIFE (`scriptlets.js`) for domain-scoped injections.
4. **Settings**: `chrome.storage.local` key `stampstack.settings` (`paused`, `enabledLists`, `allowlist`, `blockedTotal`). Migrates from `quell.settings` / intermediate rename keys.
5. **Allowlist**: dynamic DNR `allowAllRequests` rules with ids ≥ `1_000_000`.
6. **Paid dark mode** (optional): registered invert CSS + smart content script; ExtPay-gated; pause/allowlist do not disable it.

Messages are a single discriminated union in `src/shared/types.ts`. Keep handlers and senders in sync.

### Paid dark mode / ExtensionPay

- Config: `src/shared/extpay-config.ts` (placeholder) or gitignored `extpay-config.local.ts` (from `.example`).
- Unpacked QA: popup/options **Dev unlock**.
- Smart: already-dark hosts auto force-off; user Force on/off wins.
- After bundle, confirm `dist/dark-mode.css` + `extpay-bridge.js`.

## Hard rules for agents

- Prefer **focused** changes; match existing comment/style density.
- Never commit secrets. Do not commit `src/generated/` or `dist/` (see `.gitignore`).
- After filter parser / DNR / critical-path edits: run `npm run compile-filters` (or `npm run build`) and `npm run typecheck`.
- Respect Chromium DNR budgets in `scripts/lib/limits.mjs` (static rules, regex cap 1000, priority bands).
- Content scripts declared in the manifest must stay **IIFE** bundles; SW/popup/options are **ESM**.
- Do not invent MV3 APIs that Chrome does not support (no full uBO network engine in the SW).
- Commit only when the user asks.
- Keep DNR ruleset id `quell-seed` stable for upgrades; user-visible title may say StampStack Seed.

## Load / debug tips

- After `npm run build`, click **Reload** on the extension card.
- Service worker: Inspect views → Service worker on `chrome://extensions`.
- `declarativeNetRequestFeedback` + `onRuleMatchedDebug` power the badge in dev; treat counts as best-effort.
