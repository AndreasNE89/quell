# Submitting StampStack 2.0.0

Everything the dashboard asks for, in the order it asks. Each block is paste-ready.

The last upload was **1.6.0**. This release carries 1.7.0 → 2.0.0: the popup redesign, the
element picker, the page report, per-category SponsorBlock, ~3,300 additional scriptlet rules,
the dark-mode flash fix, and honest reporting when Chrome drops a ruleset.

---

## 0. Before you open the dashboard

**Re-host the privacy policy.** This is the one item with real downside — the hosted copy has
been inaccurate since 1.4.0, and a policy that does not match the code is what gets an item
pulled rather than merely rejected.

Publish `docs/privacy-policy.html` at its existing HTTPS URL. What changed since the hosted
version:

- `webNavigation` removed (store builds never request it — the hosted copy still claims it)
- SponsorBlock described accurately: on by default, 4-character hash prefix, per-category control
- the runtime filter-list download claim removed (lists are compiled in at build time)
- **new:** on-device page analysis disclosed, covering the page report, element picker and custom
  filters. All local, nothing transmitted — but the code visibly reads page DOM, so it is
  declared.

Confirm the live URL renders before continuing; the dashboard only stores the link.

---

## 1. Package

Upload `release/stampstack-2.0.0.zip`.

Built from merged `main`. Two consecutive builds produce an identical SHA-256, so the artifact
can be reproduced from the tag if anyone asks.

---

## 2. Store listing

**Item name**

```
StampStack
```

**Summary** — 131/132 chars

```
Blocks ads, trackers and popunders. See what each page tracks, hide anything with a click, and fix broken sites without unblocking.
```

**Description** — paste the fenced block under "Detailed description" in
[`store/LISTING.md`](./LISTING.md) (3,346 / 16,000 chars).

The live listing is still pre-1.3.3 copy that mentions none of dark mode, SponsorBlock, the
YouTube toggles, the picker, popunder blocking or the page report. Replace it wholesale.

**Category:** Privacy & Security — *not* Productivity, which is what is currently set.

**Language:** English

**Homepage / Support URL:** leave blank. Do not paste a private GitHub URL.

---

## 3. Privacy practices

**Single purpose**

```
Block ads and trackers using Declarative Net Request, cosmetic filters, and scriptlets. Optional related browsing aids: YouTube cleanup toggles and a paid dark-mode theme.
```

**Permission justifications** — paste each from [`store/PERMISSIONS.md`](./PERMISSIONS.md).
Only three fields exist; there is no `webNavigation` field to fill, because store builds do not
request it.

| Field | Source |
|---|---|
| `declarativeNetRequest` | PERMISSIONS.md |
| `scripting` | PERMISSIONS.md |
| `storage` | PERMISSIONS.md |
| Host permission `<all_urls>` | PERMISSIONS.md |

**Remote code:** No.

**Data usage:** tick nothing. The extension collects no user data. Certify all three
limited-use disclosures.

**Privacy policy URL:** the live URL from step 0.

---

## 4. Reviewer notes

```
StampStack is a Manifest V3 ad, tracker and popunder blocker.

Single purpose: block ads and trackers using Declarative Net Request, cosmetic filters and
scriptlets. Optional related browsing aids: YouTube cleanup toggles and a paid dark-mode theme.

Permissions:
- declarativeNetRequest: apply the packaged EasyList/uBO-derived rulesets
- scripting: inject cosmetic CSS and the bundled scriptlet library
- storage: local settings, site allowlist and license cache only
- host <all_urls>: required for a general-purpose blocker

No remote code. Every filter list and scriptlet is compiled into the package at build time;
nothing is downloaded or evaluated at runtime. There is no eval of fetched content — the
"prevent-eval-if" scriptlet REPLACES the page's eval in order to stop code running.

Network requests the extension makes:
- sponsor.ajay.app — optional SponsorBlock segment lookup, sending only a 4-character SHA-256
  hash prefix of a YouTube video id, without cookies. User-configurable per category and fully
  disableable in Options.
- extensionpay.com — only for the optional one-time dark-mode purchase and license check.

To verify:
1. Load the zip and visit a news site — ads and tracker requests are blocked.
2. Open the toolbar popup: it lists the third-party trackers that page reached out to. This is
   computed locally from the page's own DOM; nothing is transmitted.
3. Click "Hide an element", pick something, and it is hidden on that site only.
4. Options -> Filter lists: toggle a list and confirm the rule count changes.

Privacy policy: <PASTE_YOUR_HTTPS_URL>
```

---

## 5. Assets

- **Icon 128×128** — in the zip at `icons/icon-128.png`
- **Small promo 440×280** — `npm run store-assets` → `store/promo-small.png`
- **Screenshots** (≥1, 2–3 better) — 1280×800 or 640×400

Worth capturing for this release, because they show what is new and what competitors' listings
do not have:

1. The popup with the page report expanded, naming real trackers on a news site
2. The element picker mid-pick, highlight box and selector label visible
3. The "Site broken?" repair panel open
4. Options → YouTube, showing the per-category SponsorBlock rows

---

## 6. After publishing

- [ ] Tag the release: `git tag v2.0.0 && git push origin v2.0.0`
- [ ] Note the item ID and public URL
- [ ] Watch the developer email — this item has been rejected before; the two historical causes
      (permission/disclosure mismatch and obfuscation flags) are both addressed, but respond fast
      if anything comes back
- [ ] Run the published Buy → Restore check by hand. It is the one thing no automated gate here
      can cover, and it is the paid path.
