# Submitting StampStack 2.2.0

Chinese support: interface and filter lists.

**Package:** `release/stampstack-2.2.0.zip`
**sha256:** `605ac07ef2d0b7ea3d5f1835c7f20b6aaffdbdd8a517e680c086f85366a6deb4`
**Size:** 2.90 MiB · 46 files · 135,775 DNR rules across 8 rulesets

---

## 0. Before the dashboard

Privacy policy is **unchanged** — no new data handling. Nothing to re-host.

---

## 1. Package

Upload `release/stampstack-2.2.0.zip`. Reproducible across three consecutive builds.

---

## 2. What changed

**Interface localized.** `_locales/en`, `_locales/zh_CN`, `_locales/zh_TW`, 194 messages each,
`default_locale: en`. Chrome selects by the browser's UI language and falls back to English, so
there is no detection code and no network call. Any locale Chrome supports now falls back to
English rather than being hardcoded to it.

**Chinese filter lists.** EasyList China (12,046 rules) and CJX's Annoyance List (734). Both ship
opt-in; EasyList China is switched on at install when the UI language is `zh-*`, covering
Simplified and Traditional alike. Not default-on globally — the default set already sits near
120,000 rules, past Chrome's guaranteed 30,000, and 12,000 more for every user worldwide would
push a ruleset closer to being dropped for people who gain nothing from it.

Ruleset count goes 6 → 8. Default-enabled rule total is essentially unchanged.

---

## 3. Store listing

**Permissions: unchanged.** No new permission, no new host, no new endpoint.

**Worth doing, not required:** the Chrome Web Store supports per-locale listings. A
Simplified-Chinese listing is the single highest-leverage thing for discovery in that market now
that the product actually works there — the extension being localized does nothing for someone
who never finds it. Traditional Chinese is a separate listing locale again.

---

## 4. Reviewer notes

Reuse 2.1.1's notes and append:

```
2.2.0 adds interface localization (English, Simplified Chinese, Traditional Chinese) via the
standard _locales mechanism and chrome.i18n, and two optional Chinese filter lists compiled
into the package like the existing ones. Chinese is selected from the browser UI language; no
geolocation, no network request, no new permission. No change to blocking behaviour for
existing users.
```

---

## 5. After publishing

- [ ] Tag `v2.2.0`, plus `v2.0.0` (`06622bc`), `v2.1.0` (`2e0eb30`), `v2.1.1` (`71d198d`) — all still untagged
- [ ] Check the Chinese UI on a real Chinese-locale profile: `chrome://settings/languages`, move
      中文 to the top, restart Chrome
- [ ] Confirm EasyList China switched itself on for that profile (Settings → Filter lists)
- [ ] Buy → Restore still unverified against a published build

---

## 6. Known gap

The Chinese translations are unreviewed by a native speaker. They were produced and then
independently checked for terminology consistency, placeholder integrity and Traditional-vs-
Simplified vocabulary, and the review pass corrected 36 strings across the two locales —
including several that were grammatically wrong rather than merely awkward. That is a
reasonable starting point, not a substitute for a native reader. Wording feedback should be
expected and is cheap to act on: one file per locale, no code change.
