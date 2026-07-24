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

1. **Version bump** in `package.json` (and thus `manifest.json` via build) — must be **greater** than the last uploaded CWS version.
2. **Lists current** (or intentional skip on dark-only even releases):
   - `npm run update-lists` then `npm run compile-filters`
   - Watch compile stats for `scriptlet-obfuscated`, regex/memory skips
   - If list download fails with TLS/`unable to verify the first certificate` (corp proxy/AV): build with existing `filters/*.txt` via `npm run package -- --skip-lists` and retry lists off that network
3. **Checks**
   - `npm run typecheck`
   - `npm test`
   - `npm run smoke-extpay` (ExtPay id + store Dev-unlock gate + obfuscation scan; restores `[dev]` `dist/` after)
4. **Package**
   - `npm run package` (or `npm run package -- --skip-lists` if lists already fresh)
   - Confirm `release/stampstack-<version>.zip`
5. **Obfuscation** — `npm run package` runs `scan-package` automatically. Manually: `npm run scan-package`.

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

## Related

- First-time upload helpers: `store/CWS_UPLOAD_CHECKLIST.md`
- Monetization design: `docs/superpowers/specs/2026-07-15-paid-dark-mode-design.md`
- Blocking backlog: `docs/AD_AUDIT.md`
- Dark site triage: `docs/DARK_MODE_SITES.md`
- Support triage: `docs/SUPPORT_TRIAGE.md`
- Phase review (2026-07-24): `docs/POST_RELEASE_PHASE_REVIEW.md`
