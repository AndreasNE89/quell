# Paid dark mode — design spec

**Date:** 2026-07-15  
**Status:** Implemented (MVP — smart invert + already-dark auto-off)  
**Product:** StampStack (MV3 Chromium ad/tracker blocker; repo may still be named `quell`)  
**Price point:** $2 USD one-time unlock  

---

## Part A — Current feature inventory

Snapshot of what StampStack ships today (accurate to the codebase as of this doc). Cite paths for verification.

### A.1 Network blocking (DNR)

| Capability | Behavior | Key paths |
|------------|----------|-----------|
| Static DNR rulesets | Filter lists compiled offline → `src/generated/rulesets/`. SW enables/disables via `updateEnabledRulesets`. No full network engine in the SW. | `scripts/compile-filters.mjs`, `docs/ARCHITECTURE.md`, `src/background/service-worker.ts` (`syncRulesets`) |
| List registry | `quell-seed` (built-in), EasyList, EasyPrivacy, uBO filters, uBO badware, EasyList Cookie (annoyances, off by default) | `filters/lists.json` |
| Pause | Master `paused` disables all rulesets, cosmetics registration, YouTube MAIN hooks | `Settings.paused`, `popup:setPaused` |
| Per-site allowlist | Dynamic `allowAllRequests` rules, ids ≥ `1_000_000`, priority `1_000_000`; also excludes hosts from registered generic CSS / YouTube scriptlets | `src/shared/constants.ts`, `syncAllowlist`, popup “Block on this site” |
| Redirects | WAR stubs under `src/redirects/` for `$redirect` at compile time | `src/redirects/*`, `web_accessible_resources` |
| Badge / stats | `onRuleMatchedDebug` → tab badge + `blockedTotal` — **dev/unpacked only**; packaged CWS builds report `statsReliable: false` | `service-worker.ts`, `PopupData` / `StatsData` |

Unsupported EasyList features are skipped at compile time (coverage report from `compile-filters`). Regex DNR rules share Chromium’s global budget (`MAX_NUMBER_OF_REGEX_RULES = 1000`).

### A.2 Cosmetics / scriptlets

| Kind | Mechanism | Key paths |
|------|-----------|-----------|
| Generic hide | Combined CSS registered via `chrome.scripting` (`quell-generic-cosmetic`), `document_start`, allowlist-aware `excludeMatches` | `GENERIC_CSS_SCRIPT_ID`, `syncRegisteredScripts` |
| Specific hide / unhide | Content script injects `<style data-StampStack="cosmetic">` after `cosmetic:get` | `src/content/content.ts` |
| Procedural | `src/engine/procedural.ts` + MutationObserver | content script |
| Scriptlets | Domain-scoped only (compiler drops global); MAIN-world inject on demand via `scriptlets:inject` | `src/scriptlets/library.ts`, `src/content/scriptlets-main.ts` |
| YouTube MAIN hooks | Separate registered script `quell-scriptlets-youtube` when sponsored toggle on and not paused | `YOUTUBE_SCRIPTLETS_SCRIPT_ID` |

Content script runs ISOLATED, `document_start`, `<all_urls>`, `all_frames`, `match_about_blank` (`src/manifest.json`). Only `http(s)` / `about:` start the cosmetic/YouTube path.

### A.3 YouTube features

| Toggle | Default | Behavior |
|--------|---------|----------|
| `youtubeBlockSponsored` | `true` | Hide sponsored/promoted selectors; register MAIN YouTube scriptlets to scrub player ad payloads |
| `youtubeBlockShorts` | `false` | Hide Shorts shelves/entry points; leave `/shorts/` URLs |

UI in both popup and options. Content path: `src/content/youtube-ui.ts` + storage listener for live updates. Respects pause + allowlist (`youtube:getOptions`).

### A.4 Settings / storage

- **Key:** `stampstack.settings` in `chrome.storage.local` (`STORAGE_KEY`)
- **Legacy migration:** `quell.settings`, `passblock.settings`, `blockstack.settings` → current key then removed
- **Fields today** (`Settings` in `src/shared/types.ts`):

```ts
paused: boolean
enabledLists: Record<string, boolean>
allowlist: string[]
blockedTotal: number
youtubeBlockSponsored: boolean
youtubeBlockShorts: boolean
```

- Defaults: `src/background/settings.ts` (`defaultSettings`)
- **No** `chrome.storage.sync` usage today
- **No** license, purchase, account, or dark-mode fields

### A.5 UI surfaces

| Surface | Features | Paths |
|---------|----------|-------|
| Toolbar popup | Status dot, hostname, per-site allowlist toggle, tab/total blocked, global pause, YouTube toggles, link to options | `src/popup/popup.html`, `popup.ts`, `popup.css` |
| Options (tab) | Stats cards, YouTube toggles, filter list enable/disable by group, version, privacy link | `src/options/options.html`, `options.ts`, `options.css` |
| Store listing copy | Network + cosmetics + scriptlets + allowlist + list toggles; “No accounts / No analytics” | `store/LISTING.md` |
| Privacy policy | Local-only settings; no PII collection; permissions table | `docs/privacy-policy.md`, `docs/privacy-policy.html` |

Options footer links `privacy.html` (bundled at build if present); canonical policy lives under `docs/`.

### A.6 Monetization / accounts today

**None.** No payment SDK, license keys, identity, Stripe, ExtensionPay, or remote license checks. Listing and privacy policy explicitly claim no accounts and no telemetry to StampStack servers.

### A.7 Permissions already held

From `src/manifest.json` (Chrome 120+):

| Permission / host | Current use |
|-------------------|-------------|
| `declarativeNetRequest` | Static + dynamic allowlist rules |
| `scripting` | Register/inject cosmetic CSS + MAIN scriptlets |
| `storage` | Settings blob |
| `webNavigation` | Clear badge on main-frame navigate |
| Host `<all_urls>` | Content scripts + DNR + scripting matches |

**Not present:** `identity`, `declarativeNetRequestFeedback` (optional for packaged feedback), `alarms`, `cookies`, remote host permissions beyond `<all_urls>`.

### A.8 Message protocol (today)

Discriminated union in `src/shared/types.ts`: `cosmetic:*`, `scriptlets:*`, `popup:*`, `youtube:getOptions`, `lists:*`, `stats:get`. Exhaustive `never` check in SW handler.

---

## Part B — Dark mode design plan

### B.1 Product definition

**“Dark mode on any page”** = StampStack injects a visual darkening transform (or stylesheet) onto ordinary web pages so light sites become readable in a dark palette, independent of the site’s own theme.

#### Technique comparison

| Approach | How it works | Pros | Cons | MV3 fit |
|----------|--------------|------|------|---------|
| **A. Invert + hue-rotate (recommended MVP)** | `html { filter: invert(1) hue-rotate(180deg) }` + re-invert `img, video, picture, canvas, svg, iframe` (and often `[style*="background-image"]`) | Tiny CSS; works on almost any site; industry-standard for “Dark Reader lite” / invert extensions; easy to toggle | Washed/odd colors on some UIs; nested filters; PDF viewers / canvas games look wrong; sites already dark get “double dark” | Excellent — register CSS via `chrome.scripting` like generic cosmetics |
| **B. Smart darkening (Dark Reader–class)** | Parse computed styles / rewrite colors in JS; optional themes | Better quality, fewer double-darks | Heavy CPU/memory; large JS; fights SPAs; hard to ship as a paid upsell without becoming a second product | Possible but out of scope for $2 MVP |
| **C. Injected “dark theme” stylesheet** | Force `background`/`color`/`color-scheme` with broad selectors | Predictable on simple docs | Breaks complex layouts; misses shadow DOM / canvases | Weak as sole strategy |
| **D. Chrome Forced Colors / OS high-contrast** | Browser accessibility forced colors | Native a11y | Not a general “dark mode”; limited control; not what users mean by “dark mode on any page” | Wrong product |
| **E. Prefer-color-scheme spoof only** | Lie about `prefers-color-scheme: dark` | Great when sites honor it | Most light sites ignore it | Useful **addon**, not enough alone |

**Recommendation:** MVP = **Approach A** (invert + hue-rotate + media exception rules), optionally combined later with a light `color-scheme: dark` hint. Document quality caveats. Do not attempt Dark Reader parity in v1.

#### Scope (what pages get darkening)

| Context | Apply dark mode? | Rationale |
|---------|------------------|-----------|
| `http:` / `https:` main frames | Yes (if unlocked + enabled + site policy allows) | Core product |
| Subframes | Yes by default (`all_frames: true`, matching cosmetics) | Ads/iframes otherwise stay bright; allow per-site off if needed |
| Allowlisted hosts (blocking off) | **Still eligible** for dark mode by default | Allowlist = “don’t block ads,” not “don’t theme.” Separate dark override can force off |
| Global pause | **Dark mode still eligible** by default | Pause = “stop ad blocking,” not “stop paid features.” Open question if product wants coupling |
| `chrome://`, `chrome-extension://`, Web Store, PDF viewer (`chrome-extension://…/pdf`), `file://` | No | Content scripts / host permissions don’t apply usefully; avoid breaking browser chrome |
| Extension pages (popup/options) | Own UI theme only (optional polish) | Not “any page” |
| Already-dark sites | Apply unless user force-off or future heuristic | Heuristic “skip if dark” is polish (Phase 2) |

#### Toggle UX

**Popup (primary):**

- Row: “Dark mode” switch (on/off for *current site* effective state, or global — see open questions).
- If locked: switch disabled or opens upsell; label “Dark mode — $2” / lock icon.
- Per-site control: three-state under an overflow or long-press/options: **Follow global** | **Force on** | **Force off**.
- Short preview: toggling applies immediately to the active tab (if unlocked).

**Options (secondary):**

- Section “Dark mode (paid)”
  - Global enable
  - Purchase / restore purchase
  - License status (Paid / Free / Trial if any)
  - Optional: brightness/contrast sliders (Phase 2)
  - List or note about per-site overrides (read from storage)

**Free users see:**

- Feature visible but gated.
- Upsell copy: one-time $2, what it does, restore purchase.
- **Recommended:** no silent trial by default (privacy + complexity); optional 7-day trial via ExtensionPay if chosen later.
- Ad blocking remains fully free (gate the *enhancement*, not core value).

#### Free vs paid

| User | Ad blocking | Dark mode |
|------|-------------|-----------|
| Free | Full | Locked; UI shows upsell + Restore |
| Paid (one-time) | Full | Unlocked; global + per-site controls |

Purchase does **not** create a StampStack account in-product; payment provider may collect email for receipts/restore.

---

### B.2 Monetization ($2 one-time)

#### Chrome Web Store in-app payments (2026)

**Deprecated / unavailable** for new integrations. Google removed CWS Payments years ago; developers must use third-party checkout. Listing the extension as a “paid extension” (pay-to-install on the store) is a different model and is a poor fit for freemium (users must discover dark mode after free install).

#### Practical options

| Option | Model | Fees (typical) | Tax / MoR | Extension fit | Backend needed? |
|--------|-------|----------------|-----------|---------------|-----------------|
| **ExtensionPay** | Stripe under the hood; `ExtPay` API: `getUser()`, `openPaymentPage()`, restore via email | ~5% + Stripe | You handle tax (Stripe Tax optional) | Purpose-built for extensions; minimal code; trials supported | No (their servers) |
| **Lemon Squeezy** (or Paddle / similar MoR) | Checkout link → license key email → validate API | ~5% + fixed | Merchant of Record (VAT/sales tax handled) | Strong for license keys + global tax | Light (or LS API only) |
| **Stripe Checkout + own license** | Checkout Session → webhook → issue key | 2.9% + $0.30 | You are merchant; tax complexity | Max control | Yes (server + DB) |
| **CWS paid listing** | Pay before install | Store cut / policies | Store | Cannot freemium-gate a feature | N/A |

#### Recommendation

**Primary recommendation: ExtensionPay** for StampStack’s first paid feature.

**Why:**

1. Matches freemium MV3 pattern (free install → in-extension unlock).
2. No StampStack backend to operate at $2 ASP (average selling price).
3. Built-in payment page + restore-by-email; works with ephemeral service workers.
4. Implementation cost measured in hours, not weeks — appropriate for a $2 upsell.
5. At $2, tax/MoR overhead of self-Stripe often exceeds the engineering time saved by lower fees.

**Strong alternative: Lemon Squeezy** if the developer wants MoR (global VAT out of mind) and is fine with license-key UX (“paste key” or magic-link activation). Prefer LS when selling in many EU countries without wanting to manage Stripe Tax.

**Avoid for MVP:** custom Stripe + own license server (overkill at $2); CWS paid-only listing (kills freemium discovery).

#### License storage & verification

| Concern | Design |
|---------|--------|
| Where to store | Cache paid flag + `paidAt` / `email` (if provided) in `chrome.storage.local` under settings or a sibling key `stampstack.license`. Optionally mirror a boolean to `chrome.storage.sync` for cross-device restore **without** re-login — sync has quota; keep payload tiny. |
| Source of truth | ExtensionPay (or LS) servers. Local cache is a hint for offline UX. |
| Verification cadence | On SW `onStartup` / `onInstalled`, and when user opens popup/options purchase UI. Use `chrome.alarms` optional daily recheck if we add the permission. |
| Offline grace | If last successful verify was within **N days** (recommend **14**), honor cached `paid: true` when network fails. If never verified online after install, do not unlock. |
| Restore purchase | ExtensionPay email login link / LS key paste. Surface in options prominently. |
| Uninstall | Local cache wiped; restore flow required (expected). |

#### Privacy implications

Paying introduces the **first** third-party data flow:

- Payment provider receives email + payment details (Stripe).
- Extension may call `https://extensionpay.com` (or LS API) — already covered by `<all_urls>` for fetch from SW, but **privacy policy and CWS “remote code / data use” disclosures must be updated**.
- No new manifest permission strictly required for ExtensionPay if using their documented content-script / SW pattern; confirm their current MV3 docs (may request host permission for `extensionpay.com` for clarity in CWS review).
- Do **not** send browsing history or allowlist to the payment provider.

#### Fraud / key sharing at $2

- Client-side gates are always bypassable (extension source is readable). At $2, **optimize for honest users**, not DRM.
- ExtensionPay paid status lives on their server — casual sharing of a “hacked” local flag doesn’t help across devices; determined pirates will patch the gate anyway.
- Do not invest in hardware-bound licenses or anti-tamper for this price.
- Rate-limit restore if provider supports it; accept some email-sharing leakage.

#### Recommendation summary (trade-offs)

| Choice | Trade-off |
|--------|-----------|
| **ExtensionPay** (pick this) | Fastest; slight fee premium; you may still owe tax reporting; dependency on a small vendor |
| Lemon Squeezy | Better tax/MoR; more “key management” UX; slightly more integration work |
| Own Stripe | Lowest fees long-term; highest ops burden; wrong for first $2 feature |

---

### B.3 Technical architecture

#### B.3.1 How dark mode applies

**Hybrid model (shipped MVP):**

1. **FOUC invert** — static `src/content/dark-mode.css` registered via `chrome.scripting` at `document_start` (`quell-dark-mode` / `quell-dark-mode-force`), paid + enabled, with `excludeMatches` for force-off hosts (user + auto-detected).
2. **Smart content script** (`src/content/dark-mode-smart.ts`, started from `content.ts` on http(s)):
   - Samples `html`/`body` computed colors, `color-scheme`, and `meta theme-color`.
   - **Already dark (high confidence)** → inject reset CSS (clear invert), message `darkmode:autoSkip` → persist host override `'off'` + `darkModeAutoOff` marker (unless user **Force on**).
   - **Light page** → inject `data-stampstack="dark-smart"` stylesheet: controlled invert (pre-light bg → consistent charcoal), contrast bump from sampled WCAG-ish ratio, media re-invert, `color-scheme: dark`.
3. **User Force on / Force off** always win over auto-detection; changing override clears the auto-off marker.
4. **Active tab** — after enable / override / unlock, SW `insertCSS` or reloads the active http(s) tab so the current page updates without a manual navigation.

**Pure helpers:** `src/shared/dark-mode.ts` (license/resolve), `src/shared/dark-mode-smart.ts` (luminance, already-dark, CSS builders).

**Limitations (not Dark Reader):** open shadow DOM, canvas/WebGL games, cross-origin iframes, and heavily nested `filter` trees may look wrong; already-dark detection is heuristic (high-confidence only persists auto-off).

**Do not** rely solely on late content-script injection for the global path — registered CSS at `document_start` still covers FOUC; smart script upgrades or resets after paint samples.

#### B.3.2 Interaction with existing features

| Feature | Interaction |
|---------|-------------|
| Cosmetics (`data-StampStack`) | Orthogonal. Invert applies to whole document including hidden ads (irrelevant). Keep separate style tags / registered CSS. |
| Scriptlets / YouTube | Orthogonal. Dark CSS must not target StampStack’s own injected nodes specially unless they break. |
| Allowlist | Does **not** auto-disable dark mode (see scope). |
| Pause | Does **not** auto-disable dark mode (see scope). `syncRegisteredScripts` today ties cosmetics to `!paused` — dark registration must be a **separate** sync function so pause doesn’t tear down paid dark CSS. |
| Popup stats | Unrelated. |

#### B.3.3 Settings schema additions

Extend `Settings` **or** split license into its own storage key to avoid bloating the hot settings blob. Recommendation: keep UX flags in `Settings`, license cache beside it.

```ts
// Additions to Settings (illustrative)
darkModeEnabled: boolean;           // global preference (default false)
darkModeSiteOverrides: Record<string, 'on' | 'off'>; // hostname → force; absent = follow global

// Separate key stampstack.license (illustrative)
interface LicenseState {
  paid: boolean;
  provider: 'extensionpay' | 'lemonsqueezy' | 'none';
  verifiedAt: number | null;        // epoch ms
  email?: string;                   // if provider returns it; optional
  // provider-specific ids as needed
}
```

Defaults: `darkModeEnabled: false`, `darkModeSiteOverrides: {}`, `paid: false`.

Update `defaultSettings()`, migration remains merge-with-defaults.

#### B.3.4 Message protocol changes

Add variants to `Message` (keep exhaustive SW switch):

| Message | Purpose |
|---------|---------|
| `darkmode:get` | Popup/options: effective state for hostname + license summary |
| `darkmode:setEnabled` | Set global on/off (no-op / error if unpaid) |
| `darkmode:setSiteOverride` | `hostname`, `override: 'on' \| 'off' \| null` |
| `license:get` | Paid flag, verifiedAt, grace status |
| `license:openCheckout` | SW opens ExtensionPay payment page / tab |
| `license:openRestore` | SW opens restore flow |
| `license:refresh` | Re-fetch provider status; update cache; resync CSS registration |

Response shapes: `DarkModeData`, `LicenseData` in `types.ts`.

#### B.3.5 Performance & FOUC

- Prefer **registered CSS** at `document_start` over messaging round-trips.
- Avoid waiting on license network before applying: use **cached paid + enabled**; refresh license async.
- Keep CSS tiny (tens of lines). No per-element JS on every mutation in MVP.
- `all_frames: true` has cost but matches blocker norms; revisit if profiling shows issues.

#### B.3.6 Accessibility / contrast caveats

- Document that invert is imperfect: gradients, box-shadows, brand colors, nested iframes with separate documents.
- Images/video re-inverted to look natural; broken if site applies its own filters.
- Users with vestibular sensitivity: full-page filter can feel “swimmy” on scroll (rare); no animation in our CSS.
- Respect future `prefers-reduced-transparency` only if we add glass effects (we won’t in MVP).
- Do not claim WCAG conformance for forced invert.

#### B.3.7 Testing plan

| Layer | What |
|-------|------|
| Unit | Hostname override resolution: global × override × paid → inject? Pure function next to settings |
| Unit | Grace window: `verifiedAt` + offline → still paid / expired |
| Manual MV3 | Load `dist/`; free user cannot enable; mock/paid user enables; reload page → no FOUC; toggle off removes CSS |
| Manual | Allowlisted site still darkens; paused still darkens; force-off wins |
| Manual | YouTube + invert coexistence; image colors sane |
| Manual | PDF / chrome:// ignored |
| Payment sandbox | ExtensionPay test mode: pay → unlock → restore after clearing storage |
| Store | Privacy questionnaire + listing text updated before publish |
| Regression | Existing allowlist / lists / YouTube toggles unchanged (`npm test`, `npm run typecheck`) |

No browser automation suite yet (per `AGENTS.md`) — manual Chrome load remains the MV3 truth.

---

### B.4 Implementation phases

#### Phase 0 — Decisions (no code)

Resolve open questions in §B.5. Pick provider. Confirm privacy URL hosting for updated policy.

#### Phase 1 — MVP dark engine (can ship behind a hidden flag)

1. Add `dark-mode.css` (invert + media exceptions).
2. Settings fields + SW `syncDarkModeScript()` independent of pause.
3. Messages + popup/options toggles **without** payment (dev flag `darkModeDevUnlock` or always-on in unpacked) to validate quality.
4. Per-site force off/on.
5. Typecheck + manual matrix.

#### Phase 2 — Polish

1. FOUC audit; tighten matches; optional already-dark heuristic.
2. Options copy, preview screenshot for store.
3. Optional brightness/contrast.
4. Popup three-state UX refinement.

#### Phase 3 — Payment

1. Integrate ExtensionPay (or LS).
2. Gate enable path on `license.paid`.
3. Checkout + restore in options; locked state in popup.
4. Offline grace; `license:refresh` on startup.
5. Update `docs/privacy-policy.md` / `.html`, `store/LISTING.md`, CWS privacy practices (payment email, remote license check).

#### Phase 4 — Store listing

1. New screenshots: dark mode before/after.
2. Description bullet: optional paid dark mode ($2 one-time).
3. Single-purpose note: still primarily an ad blocker; dark mode is an add-on (CWS single-purpose policy — ensure listing frames it as a related browsing enhancement, not a second unrelated product).
4. Submit & smoke-test published build restore flow.

---

### B.5 Risks & open questions

#### Risks

| Risk | Mitigation |
|------|------------|
| CWS “single purpose” scrutiny | Keep dark mode clearly secondary in listing; don’t rename the extension around dark mode |
| Privacy policy drift | Ship policy update in same release as payment |
| ExtensionPay vendor dependency | Abstract `LicenseProvider` interface; LS as backup |
| FOUC / quality complaints at $2 | Set expectations in UI (“simple invert”); easy refund via provider |
| Pause/allowlist confusion | Explicit copy: “Dark mode is separate from blocking” |
| Double-dark on dark sites | Phase 2 heuristic or easy per-site off |
| Client-side crack | Accept at $2; don’t over-engineer |

#### Open questions for the product owner

1. **Payment provider:** ExtensionPay (recommended) vs Lemon Squeezy vs other MoR?
2. **Trial?** None (recommended) vs 7-day ExtensionPay trial?
3. **Pause coupling:** Should global pause also disable dark mode? (Recommend **no**.)
4. **Allowlist coupling:** Should allowlisting a site disable dark mode? (Recommend **no**.)
5. **Default after purchase:** Auto-enable global dark mode on successful pay, or leave off until user toggles? (Recommend **auto-enable** once.)
6. **Per-site default UX:** Popup toggle = global, with “This site only” secondary — or popup = this site?
7. **Sync:** Use `chrome.storage.sync` for paid flag / overrides across Chrome profiles?
8. **Price localization:** Hard $2 USD only vs provider multi-currency?
9. **Refunds / support email:** Confirm contact path (privacy policy already lists an email).
10. **Frames:** Darken iframes (`all_frames: true`) or top-level only?
11. **Dev unlock:** Keep unpacked always-unlocked for QA after payment ships?

---

## Appendix — File touch list (when implementing)

| Area | Likely paths |
|------|----------------|
| Types / defaults | `src/shared/types.ts`, `src/background/settings.ts`, `src/shared/constants.ts` |
| SW | `src/background/service-worker.ts` (new sync + messages) |
| CSS | new `src/content/dark-mode.css` (or similar) |
| UI | `src/popup/*`, `src/options/*` |
| Build | `scripts/build.mjs` (ensure CSS copied) |
| Docs / store | `docs/privacy-policy.*`, `store/LISTING.md` |
| Tests | new `*.test.ts` next to override/grace helpers |

---

## Spec self-review notes

- No intentional TBDs left unresolved without an owner question in §B.5.
- Architecture matches existing `chrome.scripting` registration pattern; does not invent unsupported Chrome APIs.
- Scope is one feature (paid invert dark mode), not a Dark Reader rewrite.
- Monetization recommendation is explicit; alternatives documented with trade-offs.
