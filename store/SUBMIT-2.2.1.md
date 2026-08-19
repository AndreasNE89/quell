# Submitting StampStack 2.2.1

Single-issue fix: SponsorBlock skipping was far too aggressive.

**Package:** `release/stampstack-2.2.1.zip`
**sha256:** `96e2689f52fd1dd31028273429bfdb5e26a7d5155cd0715fb486aa52f48ee237`
**Size:** 2.90 MiB · 46 files · 135,775 DNR rules across 8 rulesets

---

## 0. The pending 2.2.0 submission

2.2.0 (Chinese support) is still waiting for review. This build **contains everything in it**
plus the skipping fix, so the right move is to replace the pending package with this one —
one review instead of two, and the aggressive default never reaches users who don't already
have it. The cost is a reset review clock.

Privacy policy, permissions, listing copy: all unchanged from the 2.2.0 submission. The two
Chinese listings from `store/LISTING-zh_CN.md` / `LISTING-zh_TW.md` still apply.

---

## 1. What changed

**Default skip categories: all seven → sponsor only.** Users reported skipping "a lot more
than sponsored areas, at seemingly random times". Interaction reminders, previews, intros,
outros and non-music markers are scattered mid-video; auto-skipping them by default read as
random. The new default matches the official SponsorBlock extension. Explicit user choices
are kept — only untouched toggles change behavior.

Also, all found while fixing that:
- **No skipping during YouTube ads.** The player clock belongs to the ad; segments matched
  against it fired at genuinely random places.
- **The skip toast now shows in fullscreen** (it was parented outside the fullscreen element,
  so skips there were silent and unexplained).
- **Segments ending at the video end now skip** (clamped to just short of the end); they were
  refused entirely, so outros never skipped even when opted in.
- **The hover-preview player can no longer be mistaken for the main player.**

## 2. Reviewer notes

Append to the standing notes:

```
2.2.1 changes SponsorBlock's default skip categories from all seven to sponsors only
(matching the official SponsorBlock extension), stops skips firing while a YouTube ad is
playing, and fixes toast visibility in fullscreen. No change to permissions, network
endpoints, or data handling. The sponsor.ajay.app request now defaults to the single
"sponsor" category, i.e. it discloses less than before.
```

## 3. After publishing

- [ ] Tag `v2.2.1`
- [ ] Verify on a real video: only sponsor segments skip by default; enabling a category in
      Settings makes it skip; Undo suppresses for the video
- [ ] Buy → Restore still unverified against a published build
