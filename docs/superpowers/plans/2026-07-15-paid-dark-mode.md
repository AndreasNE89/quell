# Paid Dark Mode Implementation Plan

> **For agentic workers:** Execute task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do not commit unless asked.

**Goal:** Ship a $2 one-time ExtensionPay-gated invert dark mode for StampStack, registered via `chrome.scripting` at `document_start`, independent of pause/allowlist.

**Architecture:** Static `dark-mode.css` registered/unregistered by the SW based on cached license + `darkModeEnabled` + per-site overrides. Smart content script upgrades invert / auto-skips already-dark hosts. License cache in `stampstack.license`; UX flags in settings. ExtensionPay behind config placeholder; unpacked builds get `license:devUnlock` for QA.

**Tech Stack:** TypeScript MV3, `extpay` npm, `chrome.scripting` CSS registration, `chrome.storage.local`.

## Global Constraints

- Technique: smart invert + hue-rotate (+ re-invert media); already-dark auto-off; FOUC-low via registered CSS
- Payment: ExtensionPay $2 one-time, no trial; auto-enable dark mode after purchase
- Pause / allowlist do **not** turn off dark mode (separate `syncDarkModeScripts`)
- Script id `quell-dark-mode` (upgrade-safe `quell-*` convention)
- Imports at top; exhaustive `never` switch; no hand-edits to `src/generated/`
- Content scripts stay IIFE; SW/popup/options ESM
- Offline grace: 14 days on cached `paid: true`
- Do not commit unless asked

## ExtensionPay setup (human, before store ship)

1. Create account at https://extensionpay.com and register StampStack
2. Set one-time plan to **$2 USD**
3. Paste ExtensionPay extension id into `src/shared/extpay-config.ts` **or** gitignored `extpay-config.local.ts`
4. `npm install extpay` (already in plan Task 4)
5. Push updated privacy policy HTML to public Pages URL; update CWS privacy questionnaire (payment email / Stripe via ExtensionPay)

---

### Task 1: Dark mode CSS + build copy

**Files:**
- Create: `src/content/dark-mode.css`
- Modify: `scripts/build.mjs` (`copyStatic`)

- [x] Add invert/hue CSS with media exceptions (`img, video, picture, canvas, svg, iframe`, background-image heuristic)
- [x] Copy `src/content/dark-mode.css` → `dist/dark-mode.css` in `copyStatic`

### Task 2: Types, constants, settings defaults

**Files:**
- Modify: `src/shared/types.ts`, `src/shared/constants.ts`, `src/background/settings.ts`

- [x] Extend `Settings` with `darkModeEnabled`, `darkModeSiteOverrides`, `darkModeAutoOff`
- [x] Add `LicenseState`, `DarkModeSiteOverride`, `DarkModeData`, `LicenseData`
- [x] Add messages: `darkmode:*`, `license:*` (+ `license:devUnlock`, `darkmode:autoSkip`)
- [x] Constants: `DARK_MODE_SCRIPT_ID`, `DARK_MODE_FORCE_ON_SCRIPT_ID`, `DARK_MODE_CSS_PATH`, `LICENSE_STORAGE_KEY`, `LICENSE_GRACE_MS`
- [x] Defaults in `defaultSettings()`

### Task 3: Pure helpers + unit tests

**Files:**
- Create: `src/shared/dark-mode.ts`, `src/shared/dark-mode-smart.ts`, `test/dark-mode.test.mjs`, `test/dark-mode-smart.test.mjs`

- [x] `isLicenseEffectivelyPaid(license, now)` — grace window
- [x] `resolveDarkModeForHost({ paid, enabled, overrides, hostname })` → `{ apply, override }`
- [x] `hostsWithForceOn` / `hostsWithForceOff` for registration matches
- [x] Luminance / already-dark / smart CSS builders + tests

### Task 4: ExtPay config + license module

**Files:**
- Create: `src/shared/extpay-config.ts`, `src/background/license.ts`
- Modify: `package.json` (`npm install extpay`)
- Modify: `src/manifest.json` (content script for ExtPay `onPaid` on `extensionpay.com`)
- Modify: `scripts/build.mjs` (bundle tiny ExtPay content stub if needed)

- [x] Placeholder id `YOUR_EXTENSIONPAY_ID` + local override file
- [x] `loadLicense` / `saveLicense` / `defaultLicense`
- [x] `isExtPayConfigured()`, `isUnpackedInstall()`
- [x] `refreshLicense()` — call ExtPay when configured; honor grace on network fail
- [x] `openCheckout` / `openRestore` (`openLoginPage`)
- [x] `devUnlock()` — only when unpacked
- [x] `onPaid` → set paid, optionally `darkModeEnabled: true`, resync dark CSS
- [x] If not configured: architecture still works; paid only via cache / dev unlock

### Task 5: SW `syncDarkModeScripts` + handlers

**Files:**
- Modify: `src/background/service-worker.ts`

- [x] `syncDarkModeScripts(settings, license)` — independent of pause
  - Global on + paid: register `quell-dark-mode` with `excludeMatches` for force-off hosts
  - Global off + force-on hosts: register `quell-dark-mode-force` with positive `matches`
- [x] Active-tab `insertCSS` / reload after enable / override / unlock
- [x] `darkmode:autoSkip` persists force-off for confidently dark hosts
- [x] Wire messages; call sync on init, settings/license changes
- [x] Exhaustive switch includes all new cases

### Task 6: Popup UI

**Files:**
- Modify: `src/popup/popup.html`, `popup.ts`, `popup.css`

- [x] Dark mode section: global toggle; locked → upsell + Buy ($2)
- [x] Dev unlock discoverable when unpacked + ExtPay not configured
- [x] Per-site select: Follow global | Force on | Force off
- [x] Auto-disabled note when host was auto-skipped
- [x] Note: dark mode separate from blocking

### Task 7: Options UI

**Files:**
- Modify: `src/options/options.html`, `options.ts`, `options.css`

- [x] Dark mode section: global toggle, Buy / Restore, license status, overrides list, unpacked Dev unlock
- [x] Override list labels auto-disabled hosts; Clear removes override

### Task 8: Privacy + listing

**Files:**
- Modify: `docs/privacy-policy.md`, `docs/privacy-policy.html`, `store/LISTING.md`

- [x] Disclose optional $2 purchase via ExtensionPay/Stripe (email for receipt/restore)
- [x] No browsing history sent to payment provider
- [x] Listing bullet for optional paid dark mode

### Task 9: Smart dark + verify

- [x] Already-dark detector + smart CSS upgrade
- [x] `npm run typecheck`
- [x] `npm test`
- [x] `npm run bundle` (or `build`) — confirm `dist/dark-mode.css` exists

## Manual QA (after load unpacked)

1. Free: toggle locked; Buy opens checkout (or fails gracefully if id placeholder); Dev unlock in popup when unpacked
2. Dev unlock (unpacked): enable dark mode; **active tab darkens without manual navigation**
3. Pause + allowlist: dark mode still applies
4. Force off on a host; Force on while global off
5. Visit a site that ships its own dark theme → auto-disabled (override off + UI note); Force on re-applies
6. Clear storage → locked again (unless ExtPay restore)
