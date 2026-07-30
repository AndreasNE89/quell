# Submitting StampStack 2.1.1

Single-bug fix release. Ship it soon — 2.1.0 is live with its most useful control inert.

**Package:** `release/stampstack-2.1.1.zip`
**sha256:** `0ef9e3b0cc1e4870d7d34eb3954488a61ea4377f7bf23673e20dbbd35a730379`
**Size:** 2.61 MiB · 39 files · 121,988 DNR rules

---

## 0. Nothing to do before the dashboard

The privacy policy is unchanged and already live and correct. No permission change, no new
endpoint, no listing copy change. This is a package upload and a version bump.

---

## 1. Package

Upload `release/stampstack-2.1.1.zip`. Reproducible across two builds.

---

## 2. What changed

**"Block on this site" could not be clicked.**

The switch rendered, moved under the keyboard, and did nothing to a mouse. Turning blocking off
for one site was impossible; only "Pause everywhere" worked.

The checkbox is styled `opacity: 0` and was also sized `width: 0; height: 0`, while `.slider` is
a later absolutely-positioned sibling painting over the same spot. So the only route for a click
was a `<label>` wrapper. Every switch in the popup had one except this one, which sat in a bare
`<span class="switch">`. A brute-force hit test over all ~2,800 points of the row found zero
pixels that resolved to the input.

Introduced in **1.7.0** (`8d8d57d`, the popup redesign): that commit removed
`<label class="switch-row">` from around `#siteToggle` while re-emitting every other switch
inside one. Live for four releases.

Two fixes, either sufficient, both applied:

- `.switch input` now covers its switch (`position: absolute; inset: 0`, above `.slider`), so no
  switch depends on a label wrapper again
- the site switch is a `<label>`, matching its six siblings

---

## 3. Store listing / privacy / permissions

All unchanged from 2.1.0. Do not re-paste anything.

---

## 4. Reviewer notes

Reuse 2.1.0's notes and append:

```
2.1.1 fixes a single UI defect: the per-site "Block on this site" toggle in the popup had no
clickable area, so it could not be operated with a mouse. Fixed in popup.css and popup.html
only. No change to permissions, network behaviour, filtering logic or data handling.
```

---

## 5. Why it took a user report to find it

Worth recording, because the gap is structural rather than an oversight.

`test/site-toggle.test.mjs` drives the real service worker and asserts the whole allowlist path —
storage, the `allowAllRequests` rule, priority above every static rule, cosmetic excludes. All of
it passed throughout, because it calls the message handler directly. The message was never
dispatched. Nothing in the suite had ever looked at the popup markup.

`test/popup-controls.test.mjs` now asserts every checkbox in the popup is reachable by mouse, and
that `.switch input` keeps a hit area. Two of its cases feed the detector the exact markup and CSS
that shipped broken, so it cannot pass vacuously.

---

## 6. After publishing

- [ ] Tag: `v2.1.1`, plus `v2.0.0` (`06622bc`) and `v2.1.0` (`2e0eb30`), all still untagged
- [ ] Confirm on the published build that "Block on this site" turns blocking off for one site
- [ ] Buy → Restore still unverified against a published build
