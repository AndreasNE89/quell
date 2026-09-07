# Submitting StampStack 2.2.2

Reliability release: backup/restore no longer deletes custom filters, and several
blocking/cosmetic bugs from the 2026-09-07 review are fixed. Filter lists refreshed.

**Package:** `release/stampstack-2.2.2.zip`
**sha256:** `47234316f232c22f10e07ead73f8a4359eeb7df745b419897a6d7b7622d47e8b`
**Size:** 2.83 MiB · 46 files · 129,482 DNR rules across 8 rulesets
**Toolchain:** node v22.23.2

---

## 0. Pending earlier packages

2.2.0 / 2.2.1 may still be waiting for review. This build **contains everything in them**
plus the reliability fixes and a fresh list pull. Replace the pending package with this
one — one review.

Privacy policy, permissions, listing copy: unchanged. Chinese listings from
`store/LISTING-zh_CN.md` / `LISTING-zh_TW.md` still apply.

---

## 1. What changed

**Backup/restore wiped custom filters and SponsorBlock categories.** Export omitted
those fields; import then reset them to defaults. They are now portable. Older backups
that never contained the fields leave the current install's values alone.

Also, all found in the same review:

- **Scriptlet regex arguments keep their backslashes.** Facebook `SEARCH_ADS` /
  `MarketplaceFeedAdStory` (and similar) were matching `[^\n]` as `[^n]`.
- **A disabled list's `@@$generichide` no longer stays active.** Exceptions are stored
  per list and merged only for enabled lists. `$badfilter` stays compile-time global
  (static DNR cannot toggle it).
- **`:remove()`, `:matches-attr()`, `:matches-path()`, `:if()` classify as procedural**
  instead of invalid CSS. Trailing `:first-child` after a text match tests the element
  itself. Text predicates re-run when character data changes.
- **SponsorBlock category changes refetch the current video.**
- **Custom-filter edits refresh open pages** and an empty replacement removes the sheet.
- **Page report is the top document** (`frameId: 0`), not whichever iframe answered first.
- **Dark mode watches `data-theme` / `data-color-mode`** and related theme attributes.
- **Filter lists refreshed** from upstream (129,482 network rules; 224/1000 regex budget).

## 2. Reviewer notes

Append to the standing notes:

```
2.2.2 is a reliability release. Settings backup/restore now includes the user's own
filters and SponsorBlock category choices (older backups that omit those fields leave
the current values in place). Scriptlet argument parsing preserves regex backslashes.
Cosmetic exceptions from a disabled list no longer apply. No change to permissions,
network endpoints, or data handling.
```

## 3. After publishing

- [ ] Tag `v2.2.2` (and still-missing `v2.2.1` if that package never shipped)
- [ ] Export → import on the same install: custom filters and category toggles survive
- [ ] Buy → Restore still unverified against a published build
