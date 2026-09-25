# Submitting StampStack 2.3.0

Blocking-correctness release. Pages that some filters wrongly blocked now load, and filter-list
script patches run before the page's own scripts. It also ships the rebrand's new icon, store
art and listing copy.

**Package:** `release/stampstack-2.3.0.zip`
**sha256:** `df71c51bd555f467177b91d05f12964a496accb44e3c284fe34de9723f29691d`
**Size:** 3.57 MiB (3,740,064 bytes) · 126 files · 129,712 DNR rules across 8 rulesets
(114,746 in the five on by default; 228 of 1,000 regex slots)
**Toolchain:** node v22.23.2, Windows, `core.autocrlf=true`
**Built from:** the uncommitted 2.3.0 working tree on top of `39fbe1b`
**Tagged commit:** _not yet: fill in `git rev-parse v2.3.0^{commit}` (see section 5)_

Built with `npm run build:store`, then `npm run package -- --skip-lists`. Both runs of
`npm run package -- --skip-lists` gave byte-identical zips with the hash above.
`npm run scan-package` and `npm run smoke-extpay` passed, and `npm run check-lists` matches the
lock (8 lists, stamped 2026-09-07, the same pull as 2.2.2).

`--skip-lists` is deliberate. A plain `npm run package` downloads the lists again and re-stamps
`filters/lists.lock.json`, which would give a different build from the tree that passed the gate.

---

## 0. Store state

Live: **2.2.3**. Its code is byte-identical to 2.2.2. Only its manifest `name` ("StampStack — Ad &
Tracker Blocker") and `version` differ. 2.2.3 was uploaded from a tree that was never committed.
See "Release history gaps" in `docs/RELEASE_CHECKLIST.md`. If anything else is pending review,
replace it with this package, because 2.3.0 contains everything in it.

**The name stays as it is published.** The English manifest name now comes from `extName` in
`src/_locales/en/messages.json`. It resolves to exactly "StampStack — Ad & Tracker Blocker", the
same bytes as the live 2.2.3 name. Users and the English listing see no rename.

---

## 1. What changed

- **Over-blocking.** About 135 filters written to block a page's scripts or images also blocked
  the page itself ("This page has been blocked by an extension"). Examples: `/reklame/`,
  `-banner-ads-`, ads.google.com, newsletter click-through links, and an EasyList China rule
  that blocked every outbound link on 57 sites. Only `$document`, `$doc`, `$all` and
  `$removeparam` filters now produce page-level (`main_frame`) rules. `compile-filters` fails
  the build if any other filter produces one.
- **Scam and malware blocks stop the right page.** They block the bad site itself, also when it
  is typed or opened from a bookmark. They no longer block links leaving it, and no longer block
  the real site they protect (discord.gift from discord.com).
- **Script patches no longer break news sites.** A patch meant for one ad script took basic DOM
  functions away from every script on about 2,400 sites (arstechnica.com, nypost.com, nbcnews.com
  and others).
- **Script patches run before the page does.** They are now registered with
  `chrome.scripting.registerContentScripts` at `document_start` in the MAIN world. Before, they
  were injected with `executeScript` 30–200 ms after the page started. The data files are
  packaged under `generated/scriptlets/` (50 content-addressed files), next to
  `scriptlets-runtime.js`. They replace the single `scriptlets.js`. With the default lists on,
  each registration injects one bundle of its data files and runtime instead
  (`generated/scriptlets/bundle.<n>.<hash>.js`, 17 files, about 1.4 MB unpacked and 0.5 MiB of
  the zip). Chrome logs "Blocked script execution in 'about:blank' because the document's frame
  is sandboxed…" once per injected file in a sandboxed blank frame that may not run scripts, and
  `chrome.scripting` cannot skip those frames. With the bundles that is 2 lines per such frame on
  YouTube and 1 on most sites, down from 8 and 3. 2.2.3 logged none, because its patches did not
  reach blank frames. The line is harmless and documented in `docs/SUPPORT_TRIAGE.md` and the
  changelog.
- **Chinese installs keep element hiding.** A broken EasyList China entry made Chrome refuse all
  of the element hiding. That entry is now skipped. If Chrome refuses an update, the previous
  working setup stays in place.
- **Switching a site off follows the top-level page.** If Chrome refuses the allowlist update,
  the popup and Settings now say the change did not take effect. They no longer show the site as
  switched off.
- **Silent stand-ins for ads.** New files under `redirects/` (a GIF, PNGs, a silent MP3 and MP4,
  VAST/VMAP stubs, `noop.json`) answer ad requests locally, as uBlock Origin does. `redirects/*`
  was already web-accessible with `use_dynamic_url`.
- **Rebrand.** A new postage-stamp icon. "Scriptlets" are now called "script patches" in the UI,
  and the name and description are localized for en, zh_CN and zh_TW.

The full user-facing list is under "2.3.0" in `CHANGELOG.md`.

---

## 2. Permissions and manifest

**Permissions: unchanged.** This is the diff between the published 2.2.3 `manifest.json` and the
2.3.0 one, with `key` and `update_url` left out (the store adds both):

| Field | 2.2.3 (live) | 2.3.0 |
|---|---|---|
| `name` | `StampStack — Ad & Tracker Blocker` | `__MSG_extName__`. en is the same string. zh_CN is `StampStack — 广告与跟踪器拦截器` and zh_TW is `StampStack — 廣告與追蹤器攔截器` |
| `description` | `Block ads and trackers with EasyList-style filters, cosmetics, and scriptlets — built for Manifest V3.` | `__MSG_extDescription__`. en: `Blocks ads and trackers. See which known trackers a page contacts, hide anything with a click, and keep blocking on if sites break.` (131 chars) |
| `version` | `2.2.3` | `2.3.0` |

Every other field is identical:

- `permissions`: `declarativeNetRequest`, `scripting`, `storage`
- `host_permissions`: `<all_urls>`
- `content_scripts`, `web_accessible_resources`, `background`, `commands`, `options_ui`, `icons`
  and `minimum_chrome_version` (120)
- `rule_resources`: the same 8 ids, paths and default states

There are no `optional_permissions`. `declarativeNetRequestFeedback`, `webNavigation` and `tabs`
are absent. Dev unlock is compiled out: `background.js` has no `DEV_BUILD=true`, keeps the "Dev
unlock is only available" hard gate, and the popup hides the button.

**No new network endpoints.** The only `fetch` in the source is still the SponsorBlock lookup
to sponsor.ajay.app. ExtensionPay talks to extensionpay.com. The URL strings in the packaged JS
outside `generated/` and `redirects/` are a subset of 2.2.3's: four filter-data strings were
dropped and none were added.

**Privacy policy: unchanged.** `privacy.html` differs from 2.2.3 only in its accent colour, so
the hosted policy needs no update.

The unpacked zip was also loaded in Playwright Chromium:

- English profile: the name resolves to the string above and version is 2.3.0.
- zh-CN profile: the name is `StampStack — 广告与跟踪器拦截器`, and EasyList China switched
  itself on.
- Both profiles: the five default rulesets are on, 20 content scripts are registered, the popup
  shows no Dev unlock button, and the service worker logged no errors.

---

## 3. Store listing

The whole listing is the rebrand copy. Change all of it in one pass:

- **Item name:** nothing to type. The dashboard shows "Title from package". It stays "StampStack
  — Ad & Tracker Blocker" in English. The Chinese listings get their localized names (above).
- **Summary:** nothing to type. It comes from the package, and it changes from the 2.2.3 literal
  to `extDescription` (en above). zh_CN and zh_TW each get their own, 50 characters long.
- **Detailed description:** paste the fenced block under "Detailed description" in
  `store/LISTING.md`. The copy is plain language: no "Manifest V3", "DNR" or "scriptlets". It
  claims about 115,000 rules on by default and about 130,000 in total, and 2.3.0 has 114,746 and
  129,712. Do the same for the zh_CN and zh_TW listings from `store/LISTING-zh_CN.md` and
  `store/LISTING-zh_TW.md`.
- **Store icon (128×128):** `src/icons/icon-128.png`, the new postmarked stamp. It is
  byte-identical to `icons/icon-128.png` in the zip.
- **Small promo tile (440×280):** `store/promo-small.png`. It shows the stamp, the wordmark and
  "Stamp out ads, not the site.".
- **Marquee (1400×560):** `store/promo-marquee.png`. A news.example page with its ad slot
  postmarked out, and the "No account · No telemetry · Ad blocking stays free" chips.
- **Screenshots:** replace all of them with the five 1280×800 PNGs in `store/screenshots/`, in
  file order (01 to 05). `store/screenshots/README.md` describes each one. The two promo images
  and the five screenshots are all 24-bit RGB with no alpha.

Shot 5 was captured from a build before 2.3.0. Its per-list counts are slightly behind this
package:

| List | Shot 5 | 2.3.0 |
|---|---|---|
| EasyList | 50,183 | 50,191 |
| EasyPrivacy | 55,989 | 55,998 |
| uBlock Origin filters | 4,145 | 4,301 |
| uBlock Origin badware | 4,109 | 4,153 |

Nothing it claims is wrong. If the numbers should match exactly, run
`npm run build:store && npm run store-screenshots` and then `npm run build`. The screenshot PNGs
are not tracked in git, so they exist only on this machine.

---

## 4. Reviewer notes

Keep the standing notes from `docs/CHROME_WEB_STORE.md` and add this:

```
2.3.0 fixes over-blocking and makes filter-list script patches run earlier. Some network
filters written for a page's scripts or images also blocked the whole page; only filters
written for whole pages ($document) now do, and the build fails if any other filter produces
a page-level rule. Filter-list scriptlets are now registered with
chrome.scripting.registerContentScripts at document_start (MAIN world) instead of being
injected with executeScript after load. They are static files inside the package
(generated/scriptlets/, scriptlets-runtime.js); nothing is downloaded or evaluated from the
network. New silent media and image placeholders under redirects/ answer ad requests locally.
The extension name and description are now localized through _locales; the English name is
unchanged. No change to permissions, host permissions, network endpoints, or data handling.
```

---

## 5. Before uploading

`docs/RELEASE_CHECKLIST.md` step 4 says to commit and tag first:

- [ ] Commit the 2.3.0 tree. `git status --porcelain -- src scripts filters package.json package-lock.json`
      must print nothing. Leave `docs/REVIEW_*.md`, `undefined/`, `dist/`, `release/` and
      `store/screenshots/*.png` out of the commit.
- [ ] `git tag v2.3.0`, then fill in "Tagged commit" at the top and commit this doc.
- [ ] From the tag, run `npm run build:store` and then `npm run package -- --skip-lists`. It
      must print the sha256 above with node v22.23.2. `package.mjs` warns if it prints a
      different one. A mismatch means the zip is not the tagged tree.
- [ ] Expect CI to print a **different** sha256 for the same commit. `scripts/build.mjs` copies
      `_locales/` with `cpSync` instead of `copyText`, so the three `messages.json` files keep
      the checkout's line endings. They are CRLF in this zip and LF on the Linux runner. 2.2.2
      and 2.2.3 shipped CRLF too. Chrome does not care. It only affects "reproducible from the
      tag" across operating systems, so compare against a Windows build.

## 6. After publishing

- [ ] Check the name on the extensions page in English and in a zh-CN profile
- [ ] A URL containing `/reklame/` and an ads.google.com page load instead of showing "blocked
      by an extension"
- [ ] Switch a site off and back on from the popup. Blocking follows the top-level page
- [ ] Buy → Restore still unverified against a published build
