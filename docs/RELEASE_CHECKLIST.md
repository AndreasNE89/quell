# StampStack release checklist (biweekly CWS cadence)

Prefer small store updates about every **2 weeks** over large jumps. Each zip must pass typecheck/tests and the obfuscation scan.

**Post-release focus (4–6 weeks):** trust/ops first, then alternate **odd** releases (blocking) with **even** releases (dark-mode monetize). No new headline features. Breakage inbox: [`SUPPORT_TRIAGE.md`](./SUPPORT_TRIAGE.md).

## Cadence rhythm

| Release slot | Focus |
|--------------|--------|
| Week 1 (ops) | ExtPay published smoke, listing/privacy, review triage setup |
| Odd store zips | Blocking: YouTube → Google SERP → audit leftovers; `update-lists` |
| Even store zips | Dark mode: Buy/Restore funnel + `DARK_MODE_SITES.md` checklist |
| Every zip | Version bump → checks below → upload → log breakage docs |

Tiny cross-fixes are OK when they unblock a release.

## Before every store zip

1. **Version bump** in `package.json` (and thus `manifest.json` via build) — must be **greater** than the last uploaded CWS version. Keep `src/manifest.json` and both `version` fields in `package-lock.json` in step by hand; `npm install` is not needed for that.
2. **Lists current** (or intentional skip on dark-only even releases):
   - Normally there is nothing to do here: the **Refresh filter lists** workflow runs on the 1st and 15th and opens a PR with the rule-count delta. Merge it and the lists are current.
   - That PR is opened with `GITHUB_TOKEN`, so GitHub will **not** attach the named `CI / build` check (the refresh job’s own Gate already ran the same commands, including byte-for-byte). If branch protection requires `CI / build`, either allow a bypass for that branch or open refresh PRs with a PAT/GitHub App that can trigger workflows.
   - By hand: `npm run update-lists` then `npm run compile-filters`. `npm run update-lists -- <id> …` refreshes only the named lists
   - `update-lists` checks every download (a filter list, not an HTML error page; at least half the size the lock pinned unless `-- --allow-shrink`) and writes all of them or none, so a failed run leaves `filters/` and the lock untouched and names the lists that could be refreshed alone
   - Watch compile stats for `scriptlet-obfuscated`, regex/memory skips
   - The lists are committed and pinned by `filters/lists.lock.json`. `npm run check-lists` verifies disk against the lock; `npm run lock-lists` re-stamps it after an intentional hand-edit
   - If list download fails with TLS/`unable to verify the first certificate` (corp proxy/AV): build with existing `filters/*.txt` via `npm run package -- --skip-lists` and retry lists off that network
3. **Checks** — CI runs everything except `smoke-extpay` on **pushes to `main` and on pull requests**, and asserts the build is byte-for-byte reproducible. A feature branch with no PR open is *not* covered, so run these locally until you open one:
   - `npm run typecheck`
   - `npm test`
   - `npm run smoke-extpay` (ExtPay id + store Dev-unlock gate + obfuscation scan; restores `[dev]` `dist/` after) — **not** covered by CI, because it depends on the local ExtPay configuration
4. **Commit and tag first.** The zip you upload must be built from a committed, tagged tree, and nothing else:
   - Commit everything that goes into the zip, version bump and `CHANGELOG.md` included. `git status --porcelain -- src scripts filters package.json package-lock.json` must print nothing. Untracked notes elsewhere (`docs/REVIEW_*.md`) never reach the zip and can stay.
   - Tag that commit `git tag v<version>` and package from it.
   - Put the sha256 that `npm run package` prints, and the tagged commit (`git rev-parse v<version>^{commit}`), in `store/SUBMIT-<version>.md`, then commit the doc. It is not in the zip, so committing it after the tag changes nothing in the package.
   - **Check the SUBMIT hash before uploading:** `npm run package` must print the sha256 the SUBMIT doc quotes, with the Node version the doc names. It warns when they differ. A mismatch means the zip is not the tagged tree: rebuild from the tag, or find what changed, before uploading.
   - Why: 2.2.3 was uploaded from an uncommitted tree (see [Release history gaps](#release-history-gaps)).
   - In releases after 2.3.0 the build writes every text file with LF endings, locales included, so a Windows checkout and the Linux CI runner print the same sha256 for the same commit. `SUBMIT-2.3.0.md` and older were hashed with CRLF locales: compare those only with a build from their own tag.
5. **Package**
   - `npm run package` (or `npm run package -- --skip-lists` if lists already fresh)
   - Confirm `release/stampstack-<version>.zip`
   - `package` also runs `lock-lists --check`, refuses a list below its `minRules` floor in `filters/lists.json`, a missing default list and a manifest over Chrome's ruleset limits, requires `attributions.html` and `licenses/`, and warns when `filters/` has uncommitted changes
6. **Obfuscation** — `npm run package` runs `scan-package` automatically. Manually: `npm run scan-package`.

**Local QA note:** `smoke-extpay` / `build:store` / `package` leave or briefly use a store build. After smoke, `dist/` is restored to `[dev]`. After `package`, run `npm run build` before expecting **Dev unlock**.

## ExtensionPay (paid dark mode)

| Item | Value |
|------|--------|
| CWS item id | `hfioggmggaefiiaehnfoiaajcdodnkkd` |
| ExtensionPay slug (tracked) | `EXTPAY_EXTENSION_ID_TRACKED` in `src/shared/extpay-config.ts` |
| Plan | **$2 USD one-time**, no trial |

Week-1 / after linking ExtPay ↔ CWS:

- [x] ExtensionPay id tracked in-repo (`stampstack-`) + CWS item id documented
- [x] `npm run smoke-extpay` passes (automated gate; restores `[dev]` `dist/`)
- [ ] ExtensionPay dashboard linked to the live CWS item *(publisher confirms in ExtPay UI)*
- [ ] **Published** build smoke (not unpacked): Buy → paid → dark toggle works
- [ ] Restart Chrome → still unlocked
- [ ] Clear extension storage → Restore purchase → unlocked again
- [x] Confirm **Dev unlock** is absent in store builds (`smoke-extpay` hard-gate)

Support loop:

- [x] Triage guide: [`SUPPORT_TRIAGE.md`](./SUPPORT_TRIAGE.md)
- [x] Odd/even cadence + breakage logging wired in this checklist
- [ ] First CWS review replied using triage template *(when a review arrives)*

## Listing / privacy

- [ ] `store/LISTING.md` matches shipped features (ad blocker first; dark mode $2 add-on; YouTube toggles)
- [ ] Hosted privacy policy (`docs/privacy-policy.html`) matches disclosures (ExtPay email; SponsorBlock when enabled)
- [ ] Screenshots refreshed if UI rows changed: `npm run build:store && npm run store-screenshots` (then `npm run build` for local Dev unlock)
- [ ] Support / contact path documented (publisher email in privacy policy; CWS review replies use [`SUPPORT_TRIAGE.md`](./SUPPORT_TRIAGE.md))

## Reviewer notes (paste short)

```
Single purpose: block ads/trackers (DNR + cosmetics + scriptlets). Optional $2 dark-mode unlock via ExtensionPay (no remote code). Filter lists packaged; no remote code execution.
```

## After upload

- Dashboard: version pending/published as expected
- Update `docs/AD_AUDIT.md` if the release includes blocking changes
- Update `docs/DARK_MODE_SITES.md` if the release includes dark-mode fixes
- Note ExtPay/listing/review issues for the next cadence cycle
- Triage any new CWS reviews with [`SUPPORT_TRIAGE.md`](./SUPPORT_TRIAGE.md)

## Release history gaps

Uploads that did not follow the rules above, so nobody goes looking for a commit that does not exist.

| Store version | What happened | What the repo has |
|---|---|---|
| 2.2.3 (published) | Uploaded from an uncommitted working tree. The code is byte-identical to 2.2.2. Only two manifest fields changed: `name` became "StampStack — Ad & Tracker Blocker" and `version` became 2.2.3. | No commit, no `v2.2.3` tag and no `store/SUBMIT-2.2.3.md`. 2.3.0 takes the name over properly as `extName` in `src/_locales/*/messages.json`, so the store name comes from the package in every language. |

## Related

- First-time upload helpers: `store/CWS_UPLOAD_CHECKLIST.md`
- Monetization design: `docs/superpowers/specs/2026-07-15-paid-dark-mode-design.md`
- Blocking backlog: `docs/AD_AUDIT.md`
- Dark site triage: `docs/DARK_MODE_SITES.md`
- Support triage: `docs/SUPPORT_TRIAGE.md`
- Phase review (2026-07-24): `docs/POST_RELEASE_PHASE_REVIEW.md`
