# Submitting StampStack 2.1.0

An update, not a fresh listing. Most dashboard fields carry over from 2.0.0 untouched — this
covers only what changes.

**Package:** `release/stampstack-2.1.0.zip`
**sha256:** `c6b0637ba6be05ab3f24630c3954f33d2cc3962eee979bd75ec917bb54d97337`
**Size:** 2.60 MiB · 39 files · 121,988 DNR rules across 6 rulesets

---

## 0. Before the dashboard — re-host the privacy policy

**This is the one blocking item.** `docs/privacy-policy.html` gained a row and must be
republished at the same HTTPS URL before you submit.

What changed: a "Breakage reports" entry describing the new report action. It states that the
extension composes a message and opens it in the user's own mail client, sends nothing itself,
and that the draft carries the hostname and StampStack's settings but nothing about the page.

The URL in the dashboard does not change — only the document behind it. A policy that omits a
visible data-handling path is what gets an item pulled rather than merely rejected, and the
code does visibly assemble a message containing a hostname.

---

## 1. Package

Upload `release/stampstack-2.1.0.zip`.

Two consecutive builds produce an identical SHA-256, and from this release that holds across
machines too — the filter lists are committed and `meta.generatedAt` derives from
`filters/lists.lock.json` rather than from file mtimes, which git does not preserve. So the
artifact really can be rebuilt from the tag, which was not true of 2.0.0.

---

## 2. Store listing

**Item name, summary, category, language:** unchanged.

**Description:** one bullet added under "Fix a broken site without losing protection" —
paste the fenced block from [`store/LISTING.md`](./LISTING.md) again (3,613 / 16,000 chars).
Summary is unchanged at 131 / 132.

---

## 3. Privacy practices

**Single purpose:** unchanged.

**Permissions:** unchanged — `declarativeNetRequest`, `scripting`, `storage`, `<all_urls>`.
2.1.0 adds no permission. The report action needs none: it composes text and opens a
`mailto:` link.

**Remote code:** No.

**Data usage:** tick nothing, as before. The report is composed locally and sent by the user
from their own mail client; the extension transmits nothing. Certify the three limited-use
disclosures again.

**Privacy policy URL:** unchanged (re-host the document per step 0).

---

## 4. Reviewer notes

Reuse the 2.0.0 notes verbatim, with this appended:

```
New in 2.1.0:

- "Still broken? Tell the developer" in the popup's repair panel. This composes a plain-text
  message and opens it with chrome.tabs.create on a mailto: URL. The extension performs no
  network request of its own for this, and nothing is sent unless the user sends it from their
  own mail client. The message contains the current tab's hostname and the extension's own
  configuration (version, filter-list date, enabled lists, repair step, browser version). It
  contains no page content and no full URL. See src/shared/breakage-report.ts.
- The Settings page now displays how old the packaged filter lists are.
- Filter lists refreshed: 121,988 network rules, up from 120,377.

No new permissions and no new network endpoints in this release.
```

---

## 5. Assets

No change. Existing icon, promo tile and screenshots remain accurate — the two new elements
are a line of text in Settings and a link in the repair panel, neither of which invalidates a
current screenshot.

Optional, if you want the listing to show it: re-capture the popup with the repair panel open
(`npm run preview -- --state=repaired`), which now shows the report action.

---

## 6. After publishing

- [ ] Tag: `git tag v2.1.0 && git push origin v2.1.0` — and `v2.0.0` on `06622bc`, still untagged
- [ ] Watch the developer email
- [ ] **Buy → Restore on the published build.** Still the one path no automated gate covers, and
      still unverified since 2.0.0 reworked the license flow
- [ ] Watch for the first breakage report. Subject lines are `StampStack breakage: <host>` —
      a filter on that string collects them. Triage guide: `docs/SUPPORT_TRIAGE.md`
