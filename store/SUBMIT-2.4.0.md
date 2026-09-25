# Submitting StampStack 2.4.0

Blocking-depth and reliability release. Google Search ads are hidden again, pages that wait
for Google Analytics or Google's ad tag no longer sit blank or break, SponsorBlock stops giving
up on videos, and dark mode no longer leaks its colors into text people write. uBlock Origin's
Unbreak list is new and on by default, and the filter lists were refreshed on 25 September 2026.

**Package:** `release/stampstack-2.4.0.zip`
**sha256:** `06cae3d72ef2a7963d0b165ae9a78196622440defc7955688f20f2acfffffcff`
**Size:** 3.96 MiB (4,150,312 bytes) · 176 files · 137,221 DNR rules across 9 rulesets
(122,523 in the six on by default; 236 of 1,000 regex slots)
**Toolchain:** node v22.23.2, Windows, `core.autocrlf=true`
**Built from:** the uncommitted 2.4.0 working tree on top of `de32f7c`
**Tagged commit:** _not yet: fill in `git rev-parse v2.4.0^{commit}` (see section 5)_

Built with `npm run build:store`, then `npm run package -- --skip-lists`. Both runs of
`npm run package -- --skip-lists` gave byte-identical zips with the hash above.
`npm run scan-package` and `npm run smoke-extpay` passed, and `npm run check-lists` matches the
lock (9 lists, stamped 2026-09-25, the pull committed in `de32f7c`). The gate before packaging:
`compile-filters`, `build`, `typecheck`, `npm test` (999 of 999 pass, none skipped) and the
main_frame scan (no rule reaches `main_frame` through `excludedResourceTypes`, and no
`main_frame` rule carries an initiator or party condition).

`--skip-lists` is deliberate. A plain `npm run package` downloads the lists again and re-stamps
`filters/lists.lock.json`, which would give a different build from the tree that passed the gate.

Since 2.3.0 the build writes every text file with LF endings, `_locales/` included, so the
Linux CI runner should print the same sha256 for the tagged commit. `SUBMIT-2.3.0.md` and older
were hashed with CRLF locales; compare those only with a Windows build from their own tag.

---

## 0. Store state

Live: **2.2.3**. **2.3.0** was submitted just before this package was built. 2.4.0 contains
everything in 2.3.0.

- If 2.3.0 is published by the time you upload, upload 2.4.0 as the next version.
- If 2.3.0 is still pending review, the dashboard will not take a new package until that review
  is cancelled. Either wait for 2.3.0 to publish, or cancel its review and submit 2.4.0 instead.
  Nothing is lost by skipping 2.3.0: users on 2.2.3 update straight to 2.4.0, and that path
  was checked too (section 6).

**The name stays as it is published.** `extName` and `extDescription` are byte-identical to
2.3.0 in en, zh_CN and zh_TW.

---

## 1. What changed

The full user-facing list is under "2.4.0" in `CHANGELOG.md`. The parts a reviewer or a
support reply is most likely to need:

- **Google Search ads.** EasyList's `www.google.*` rules now apply, as do other rules written for
  a site name across all its endings and uBlock Origin's `>>` and regex-hostname rules.
- **Stand-ins that keep pages working.** The packaged Google Analytics / Tag Manager stand-in
  now runs the callbacks a page queued, the Google Publisher Tag stand-in covers the documented
  API and reports empty slots, and the AdSense stand-in looks like an unfilled ad. They are three
  existing files under `redirects/` (`google-analytics.js`, `gpt.js`, `adsbygoogle.js`); no new
  redirect files.
- **New default list: uBlock Origin — Unbreak** (`ubo-unbreak`, 1,431 DNR rules: 1,132 allow
  and 5 allowAllRequests, all scoped by URL or domain; plus element-hiding exceptions and 288
  script patches). It is uBlock Origin's own list of repairs for sites that other lists break.
  Existing installs get it on update as well, because a list the user never touched follows
  its default (checked in section 6).
- **uBlock Origin's Quick fixes list is still not shipped, on purpose.** Its YouTube playback
  rule is keyed to a timestamp and refreshed upstream every 12 hours. A copy frozen into a
  release would stop every YouTube video when that timestamp rolls over.
  `test/youtube-playback-guard.test.mjs` explains and guards this.
- **Element hiding follows uBlock Origin more closely:** `:style()` and `:remove-attr()`-type
  rules act instead of hiding, the general hide sheet is injected at user level so page
  `!important` styles cannot undo it, one malformed selector no longer cancels the rest, rules
  for `www.` stay on that host, and uBlock Origin's cross-list exceptions are honored.
- **Filter data moved out of `background.js`.** Element-hiding data is now packaged as
  `generated/cosmetic/*.json` and read with `fetch(chrome.runtime.getURL(…))` when the worker
  needs it. `background.js` went from 3.18 MB to 0.50 MB. New generic stylesheets under
  `generated/generic-cosmetic/` (`*.revert.css`, `*.x-<list>.css`) carry the cross-list
  exceptions. Script patch data is still content-addressed under `generated/scriptlets/`
  (84 files, 17 of them default-list bundles).
- **SponsorBlock:** one lookup per video with retries, skips survive settings changes, the
  notice no longer catches clicks after it fades, and it works in embedded players
  (youtube-nocookie.com included) once the user starts the video.
- **Dark mode:** editors keep the site's own colors, so dark-mode colors are no longer saved
  into what people write; transparent images, embedded widgets, late stylesheets and theme
  switches are handled.
- **Site switch and repair steps:** frames follow the top-level site for element hiding too, and
  the repair steps reach the YouTube features.
- **Security:** web pages can no longer reach the settings messages or read StampStack's
  storage, and dark-mode answers to pages no longer carry the purchase email or site list.
- **Licensing:** store bundles carry only the tracked ExtensionPay id (`stampstack-`); the Dev
  unlock gate compiles to a constant false (`smoke-extpay` checks both).
- **Licenses ship in the package:** `licenses/` (GPL-3.0, LGPL-3.0, MPL-2.0 and third-party
  notices), linked from `attributions.html`.
- **Filter lists** refreshed 2026-09-25: EasyList 56,367 network rules (+6,185), EasyPrivacy
  56,130, uBlock Origin — Ads 4,349, Badware 4,150, Unbreak 1,431, EasyList Cookie 2,101,
  EasyList China 11,862, CJX Annoyance 735.

---

## 2. Permissions and manifest

**Permissions: unchanged.** Diff between the 2.3.0 manifest (`git show v2.3.0:src/manifest.json`,
and the `manifest.json` in the 2.3.0 zip) and 2.4.0, with `key` and `update_url` left out:

| Field | 2.3.0 | 2.4.0 |
|---|---|---|
| `version` | `2.3.0` | `2.4.0` |
| `declarative_net_request.rule_resources` | 8 rulesets | 9: adds `{"id":"ubo-unbreak","enabled":true,"path":"generated/rulesets/ubo-unbreak.json"}` after `ubo-badware`. The other 8 ids, paths and default states are unchanged |

Every other field is identical to 2.3.0:

- `permissions`: `declarativeNetRequest`, `scripting`, `storage`
- `host_permissions`: `<all_urls>`
- `content_scripts`, `background`, `commands`, `options_ui`, `icons`, `action`, `name`,
  `description`, `default_locale` and `minimum_chrome_version` (120)
- `web_accessible_resources`: still only `redirects/*` with `use_dynamic_url`. **No new
  web-accessible resources:** `redirects/` holds the same 18 files as 2.3.0; three of them have
  new content (see section 1). The new `generated/cosmetic/*.json` files are read by the
  service worker only and are not web-accessible.

Against the live 2.2.3, the only other differences are the ones 2.3.0 already brought:
`name` and `description` became `__MSG_extName__` / `__MSG_extDescription__` (en resolves to
the same name), see `SUBMIT-2.3.0.md`.

There are no `optional_permissions`. `declarativeNetRequestFeedback`, `webNavigation` and `tabs`
are absent. Dev unlock is compiled out of the store build.

**No new network endpoints.** The extension still contacts only sponsor.ajay.app (SponsorBlock)
and extensionpay.com (the ExtensionPay library). The one new `fetch` reads the extension's own
files through `chrome.runtime.getURL`. The only new hostnames in the packaged JS and HTML are
the license links on `attributions.html` (creativecommons.org, gnu.org, registry.npmjs.org).
The thousands of filter-data hostnames 2.3.0 carried inside `background.js` now sit in
`generated/cosmetic/*.json`.

**Privacy policy: changed.** The packaged `privacy.html` and `docs/privacy-policy.html` now say
that the ExtensionPay library keeps its data (install date; after checkout or restore, a license
key and the purchase email) in `chrome.storage.sync`, that settings are shared between normal
and Incognito windows, and what a breakage report contains. The hosted copy must be updated
(section 3).

---

## 3. Store listing

- **Item name and summary:** nothing to type. They come from the package and are unchanged.
- **Detailed description:** changed in en, zh_CN and zh_TW. Paste the fenced block under
  "Detailed description" from `store/LISTING.md`, `store/LISTING-zh_CN.md` and
  `store/LISTING-zh_TW.md`. Two changes against the 2.3.0 copy:
  - A new Privacy bullet: starting a purchase or a restore stores an ExtensionPay license key
    (and, once paid or signed in, the purchase email) in Chrome's synced storage.
  - "What it blocks": about 120,000 rules on from the start (was 115,000; 2.4.0 has 122,523)
    and about 135,000 in total (was 130,000; 2.4.0 has 137,221). It now names uBlock Origin's
    ads and badware lists plus the Unbreak list. The old copy also claimed uBlock Origin's
    privacy list, which StampStack has never shipped.
- **Privacy practices form:** answer "Data usage" from the "Privacy / payments disclosure" list in
  `store/LISTING.md`, which now includes ExtensionPay's `chrome.storage.sync` use. Re-paste the
  `storage` justification from `store/PERMISSIONS.md`; it now names `chrome.storage.sync` too.
- **Privacy policy URL:** unchanged URL, new content. Publish the current
  `docs/privacy-policy.html` at the hosted URL before submitting, so the hosted policy matches
  the package. With GitHub Pages serving `docs/` (`docs/CHROME_WEB_STORE.md`), that takes a
  push of the release commit.
- **Screenshots:** replace all five with the new 1280×800 PNGs in `store/screenshots/`, in file
  order (01 to 05). They were captured from this 2.4.0 store build: shot 1 shows "122,523
  blocking rules active", and shot 5's per-list counts match 2.4.0. They are not tracked in git.
- **Store icon, small promo tile, marquee:** unchanged.

---

## 4. Reviewer notes

Keep the standing notes from `docs/CHROME_WEB_STORE.md` and add this:

```
2.4.0 makes the ad blocking deeper and more careful: element-hiding and script-patch filters
now behave as in uBlock Origin, the packaged stand-ins for Google Analytics, Tag Manager and
the Google ad tag keep pages working, and dark mode leaves text editors alone. It adds
uBlock Origin's "Unbreak" filter list as a new default ruleset (ubo-unbreak); it only narrows
or lifts blocks that break sites. Filter lists were refreshed from upstream. Element-hiding
data is now packaged as generated/cosmetic/*.json and read by the service worker from the
extension itself; nothing is downloaded or evaluated from the network. No change to
permissions, host permissions, web-accessible resources or network endpoints. The privacy
policy now also describes the ExtensionPay library's use of chrome.storage.sync.
```

---

## 5. Before uploading

`docs/RELEASE_CHECKLIST.md` step 4 says to commit and tag first:

- [ ] Commit the 2.4.0 tree. `git status --porcelain -- src scripts filters package.json package-lock.json`
      must print nothing. Leave `docs/REVIEW_*.md`, `undefined/`, `dist/`, `release/` and
      `store/screenshots/*.png` out of the commit.
- [ ] `git tag v2.4.0`, then fill in "Tagged commit" at the top and commit this doc.
- [ ] From the tag, run `npm run build:store` and then `npm run package -- --skip-lists`. It
      must print the sha256 above with node v22.23.2. `package.mjs` warns if it prints a
      different one. A mismatch means the zip is not the tagged tree.
- [ ] Publish `docs/privacy-policy.html` to the hosted privacy URL.

## 6. Verification of this zip

The zip was unpacked and loaded in Playwright Chromium (short profile paths; Cloudflare DoH for
real sites):

- **Upgrade from 2.3.0.** A 2.3.0 store build from the `v2.3.0` tag, under the store key, was
  configured with two switched-off sites, a repair step, two custom filters, EasyPrivacy off,
  EasyList Cookie on and two SponsorBlock categories. Its files were then replaced with this
  zip and the extension reloaded, then the browser restarted. All of those settings, both
  allowlist rules and the script exclusions for the switched-off sites survived; Unbreak came
  on and EasyPrivacy stayed off. The service worker logged no errors or warnings in 2.3.0, after
  the update or after the restart, and every registered script and stylesheet exists.
- **Upgrade from the live 2.2.3.** The same check from the published 2.2.3 package straight to
  this zip gave the same result, in case 2.3.0 is skipped.
- **Page-level blocking.** The main-frame navigation suite (typed, same-site link, cross-site
  link) passes: the 8 filters where StampStack once disagreed with uBlock Origin load in all
  three ways, the controls load, the intentional `$document` rule blocks, and a scam site's own
  page is blocked.
- **Real sites against 2.3.0.** tek.no, helsenorge.no and a YouTube watch page load with the
  same status, images and blocked-request counts as 2.3.0; the video plays; the extension logs
  no console errors. Load times over three alternating runs: helsenorge.no 624 to 671 ms
  (2.3.0: 577 to 980 ms), tek.no 587 to 738 ms (2.3.0: 577 to 754 ms).
- **Popup and Settings** open in English with no console errors, after the update and after a
  restart.

## 7. After publishing

- [ ] Google Search: sponsored results are hidden on www.google.com and a country domain
- [ ] A YouTube video with a known sponsor segment skips it, and Undo works once
- [ ] Settings lists "uBlock Origin — Unbreak" as on
- [ ] Buy → Restore still unverified against a published build
