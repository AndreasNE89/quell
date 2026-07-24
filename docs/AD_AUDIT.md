# StampStack ad-blocking audit (2026-07-13)

Automated headed Chromium run with StampStack loaded from `dist/`, pausing via popup messaging between passes. Script: `npm run ad-audit` → `scripts/ad-audit.mjs`. Raw data: `docs/ad-audit-results.json`. Screenshots: `docs/ad-audit-shots/`.

Method: for each site, measure with StampStack **ON**, then **paused (OFF)** — third-party ad-host requests, `ERR_BLOCKED_BY_CLIENT`, visible ad iframes / ad-like DOM, YouTube ad UI.

## Results summary

| Site | Network (ad hosts ON→OFF) | BLOCKED_BY_CLIENT (ON) | Visual / notes |
|------|---------------------------|------------------------|----------------|
| **YouTube** | 2 → 18 | 5 | **OFF:** clear pre-roll + sidebar Sponsored. **ON:** player shell only (empty title/body) — ads gone but page looks broken / under-loaded. |
| **Google Search** | n/a | 0 | **Inconclusive** — reCAPTCHA / unusual traffic on both passes. |
| **CNN** | 7 → 238 | 31 | Strong third-party cut; ad iframes 1→0. |
| **Forbes** | 5 → 149 | 34 | Strong third-party cut; ad iframes 1→0. |
| **weather.com** | 6 → 36 | 17 | Network better ON; **1 ad iframe still present**; cookie CMP obscured page. |
| **Speedtest.net** | 4 → 876 | 7 | Very strong; ad iframes 6→0. |
| **IMDb** | 4 → 4 | 32 | Same ad-host count but many blocks ON (requests attempted then blocked). |
| **Twitch** | 1 → 1 | 3 | Light third-party signal; some blocks ON. Homepage only (no live stream ad pod). |

## What needs fixing

### High priority

1. **YouTube first-party / player ads**
   - Pause OFF showed Maybelline pre-roll (“Sponsored 2 of 2”) + sidebar Sponsored — classic YouTube inventory StampStack must beat.
   - ON suppressed DoubleClick/syndication volume but the watch page did not fully render (skeleton UI). Fix needs both:
     - **Coverage:** YouTube-oriented scriptlets/cosmetics (uBO-style `json-prune` / player ad hooks where MV3 allows; domain-scoped only).
     - **Compatibility:** audit which DNR/scriptlet/cosmetic rules break the watch page shell; add exceptions or safer redirects so video UI still loads.
   - Expectation: full uBO parity is impossible on MV3; aim for “no pre-roll + working player,” not zero YouTube telemetry.

2. **Google Search / Google properties (manual retest)**
   - Automation hit bot check; cannot judge Sponsored results from this run.
   - **Manual:** load StampStack in your normal Chrome → search commercial query → toggle pause.
   - Likely fix if Sponsored remain: **cosmetic** rules for Google ad result blocks (first-party HTML; DNR will not remove them).

### Medium priority

3. **weather.com leftover ad iframe**
   - Network improved ON but one ad iframe remained visible.
   - Fix: site-specific cosmetics / procedural hide; ensure cookie CMP doesn’t block measurement (optional `#@#` / scriptlet for consent noise only if lists already cover it).

4. **IMDb / Twitch — weak ON/OFF delta on matched hosts**
   - Blocks happen (`BLOCKED_BY_CLIENT`) but matched EasyList-style host counts stay flat.
   - Fix: broaden audit host list *or* add coverage for first-party / uncommon ad CDNs those sites use; spot-check live Twitch stream for mid-rolls.

### Lower / process

5. **Cookie / CMP banners** (weather, etc.) hide ads and inflate “ad-like” DOM noise — improve audit dismiss list; not a product blocker.
6. **Re-run after YouTube work** with longer settle time + consent accept; optionally add `youtube.com/feed` and a live Twitch channel URL.
7. **Store note:** default-enabled DNR rules exceed Chrome’s guaranteed 30k floor (shared pool) — if some users see weaker blocking, document list toggles in Options.

## What already works well

- Pause toggle correctly enables/disables rulesets (ON vs OFF deltas are large on CNN / Forbes / Speedtest).
- Third-party ad stacks (DoubleClick, syndication, large bid CDNs) are meaningfully cut on publisher sites.
- Speedtest and Forbes are strong showcase cases for network blocking.

## Follow-ups implemented (post-audit)

Shipped improvements:

- MAIN-world `scriptlets-youtube.js` registered at `document_start` (pause/allowlist aware) — fetch/XHR ad-key scrub for `youtubei` player APIs
- Scriptlet library: `json-prune`, fetch/XHR prune/replace, nested `set-constant` without inventing empty roots; JSON validity guard so bad replaces never corrupt payloads
- On YouTube, skip list-driven `set-constant` / heavy response rewrites (they hung the Chromium player); rely on the early scrub + DNR + cosmetics
- Seed cosmetics for YouTube leftovers, Google SERP, weather.com, IMDb, Twitch
- Content script starts scriptlet injection in parallel with cosmetics

### Still open (YouTube)

Pre-roll can still play from the **inline** `ytInitialPlayerResponse` blob before any fetch. **Defining getters** on that object hung the watch page in audits.

**2026-07-21 iteration (Track B):**

- Passive in-place scrub of `ytInitialPlayerResponse` / `ytplayer.config.args` for ~4s at document_start (no getters)
- Broader youtubei player URL match + `adBreakHeartbeatParams` strip
- Seed DNR for narrow `googlevideo` `initplayback?*oad=` and `ctier=L` media (must not break normal `videoplayback`)
- Skip/seek assist for `.ad-showing` + Skip button clicks
- Seed cosmetics for in-player overlay slots
- Ad-audit YouTube detector tightened (ignore empty `.ytp-ad-module` shells)

## Retest after improvements (2026-07-21)

Full suite (`npm run ad-audit`). Results in `docs/ad-audit-results.json`.

| Site | Network ON→OFF | Verdict |
|------|----------------|---------|
| YouTube | ~9→10–14 (+ BLOCKED_BY_CLIENT≈13–14) | Network improved; player usable (no hang). Automated audit can still flag visible pre-roll/companion UI — continue skip/scrub iteration. |
| Google Search | n/a | First-party SERP — limited DNR |
| CNN | 7→249 | Strong |
| Forbes | 5→659 | Strong |
| weather.com | 6→33 | Network good; leftover iframe (medium) |
| Speedtest | 1→187 | Strong |
| IMDb | 2→4 (+22 blocks) | Partial |
| Twitch homepage | 1→1 | Weak signal (need live channel) |

**Still watch:** YouTube visible pre-roll edge cases, Google SERP cosmetics (manual), weather leftover iframe, richer Twitch/IMDb.

## Post-release blocking slice (2026-07-24)

Odd-release improvements (seed + YouTube early hooks):

- Extra YouTube player ad keys stripped (`adParams`, `adBreakParams`); Shorts reel player URL match
- Faster skip/seek assist (more Skip selectors + MutationObserver on `.ad-showing`)
- Seed cosmetics: Google SERP (`#tvcap`, mobile commercial units, Sponsored aria); weather iframes/`WxuAd`; IMDb/Twitch overlay selectors; YouTube interstitial/overlay leftovers

Re-run `npm run ad-audit` after bundling when validating a store zip. Manual: commercial Google query + one YouTube watch with known pre-roll.

### Ad-audit retest (2026-07-24)

| Site | Verdict |
|------|---------|
| YouTube | Effective — ON adReqs 1 vs OFF 15; no ad-showing UI flagged |
| Google Search | Limited DNR (expected); cosmetics still the lever |
| CNN / Forbes / Speedtest | Strong network + iframe cuts |
| weather.com | Cleared — prior “1 ad iframe” was an audit **false positive** (`/ad/` matching “Radar”); detector tightened + Taboola cosmetics added |
| IMDb / Twitch homepage | Light signal; live Twitch still recommended |

Results: `docs/ad-audit-results.json`. Weather-only recheck after detector fix: `adIframes=0` ON/OFF, no medium issues.
