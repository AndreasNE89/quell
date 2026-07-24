# Post-release phase review (2026-07-24)

In-depth review of the trust + blocking + monetize plan after implementation.
Scope: in-repo automation, docs, seed/scriptlet/funnel changes. Live CWS Buy/Restore remains a publisher manual gate.

## Summary verdict

| Phase | Status | Confidence |
|-------|--------|------------|
| 0 Trust & ops | **Shippable ops baseline** | High for automation; medium until published ExtPay smoke is done by a human |
| 1 Blocking (odd) | **Solid slice** | High on publisher sites + YouTube network delta; Google SERP still cosmetics-bound |
| 2 Dark monetize (even) | **Conversion copy + independence verified** | High for UX/docs; quality still manual (no headed dark-mode suite) |
| Cadence | **Documented and wired** | High — odd/even rhythm + triage paths exist |

Overall: the three tracks no longer collide (ops docs, blocking code, funnel copy are separated). The product is ready for the next biweekly zip **after** version bump + list refresh (when TLS allows) + your published ExtPay checklist.

---

## Phase 0 — Trust & ops

### What landed

- [`SUPPORT_TRIAGE.md`](./SUPPORT_TRIAGE.md): classify breakage (ad / overblock / dark / purchase), reply snippets, logging targets.
- [`RELEASE_CHECKLIST.md`](./RELEASE_CHECKLIST.md): biweekly rhythm, odd=blocking / even=dark, Dev-unlock footgun, TLS list-download fallback, ExtPay checkboxes with automated items marked done.
- Listing/privacy polish; `npm run smoke-extpay` hard-gates store Dev unlock and restores `[dev]` `dist/`.

### Strengths

- Clear separation between what agents can prove (ExtPay id present, Dev unlock off in store builds) and what only the publisher can prove (Stripe checkout on the live CWS item).
- Support loop no longer depends on tribal knowledge — reviews map to AD_AUDIT / DARK_MODE_SITES.

### Gaps / risks

1. **Published Buy → Restore** still unchecked (needs Chrome Web Store install + real payment/test card).
2. Local `main` is **behind `origin/main` by many commits** — next release should merge/rebase before version bump to avoid shipping from a stale tip.
3. `update-lists` failed here with TLS intercept — release machines need a clean network or `--skip-lists`.

### Recommendation

Treat Week-1 as “ops ready, payment not dual-checked.” Do the published ExtPay smoke before marketing the $2 unlock hard.

---

## Phase 1 — Blocking quality

### What landed

- YouTube early hooks: more ad keys (`adParams`, `adBreakParams`), broader player URL match, faster Skip/seek + MutationObserver ([`src/scriptlets/library.ts`](../src/scriptlets/library.ts)).
- Seed cosmetics: Google SERP (`#tvcap`, mobile commercial units), weather/Taboola, IMDb/Twitch, YouTube overlay leftovers ([`filters/quell-seed.txt`](../filters/quell-seed.txt)).
- Ad-audit detector fixed: bare `/ad/` no longer flags “Radar” as an ad iframe ([`scripts/ad-audit.mjs`](../scripts/ad-audit.mjs)).
- Full audit (earlier) + weather-only recheck: weather **no medium issues**, adIframes 0.

### Strengths

- YouTube ON vs OFF showed a large ad-request drop without reintroducing hanging getters.
- CNN/Forbes/Speedtest remain showcase-strong.
- Audit false-positive fix prevents chasing ghosts on weather.com.

### Gaps / risks

1. **Google SERP** remains first-party HTML — cosmetics help, DNR will not “remove Sponsored.” Manual commercial-query check still required each blocking release.
2. **YouTube pre-roll** can still win races before scrub; mid-rolls need human spot-checks beyond the Rickroll sample.
3. **Default-enabled DNR rules ≫ 30k** guaranteed floor — document list toggles for users on constrained Chromium builds (already noted in AD_AUDIT).
4. Twitch homepage is a weak signal; live streams not automated.

### Recommendation

Next odd release: one manual Google SERP pass + one fresh YouTube mid-roll sample; keep seed edits small. Do not chase uBO parity claims in listing copy.

---

## Phase 2 — Monetize dark mode

### What landed

- Popup/options copy: Restore + receipt email + “ad blocking stays free” when unpaid + ExtPay configured.
- [`DARK_MODE_SITES.md`](./DARK_MODE_SITES.md): expanded regression checklist (pause/allowlist independence, Dev unlock absent in store).
- Unit test clarifying `resolveDarkModeForHost` has no pause/allowlist inputs (independence by design).
- SW already registers dark CSS independently of pause/allowlist ([`syncDarkModeScripts`](../src/background/service-worker.ts)).

### Strengths

- Funnel reduces “I paid / reinstalled” support load without new features.
- Independence is architectural, not accidental — cosmetics pause path is separate from dark registration.

### Gaps / risks

1. No automated headed dark-mode regression (Wikipedia/HN/GitHub still manual).
2. High-chroma news (CNN/Forbes under dark) still “watch carefully” — fix only on user reports.
3. Conversion metrics are intentionally absent (no analytics) — success = fewer Restore tickets + ExtPay dashboard sales.

### Recommendation

Next even release: run the DARK_MODE_SITES checklist once on a paid (or Dev-unlock) build; only ship CSS/detection tweaks for reported hosts.

---

## Cadence & process

| Mechanism | Assessment |
|-----------|------------|
| Odd/even release focus | Clear in RELEASE_CHECKLIST — prevents feature soup |
| smoke-extpay | Must stay in every zip; restores dev dist (good) |
| SUPPORT_TRIAGE | Ready when first 1★ review lands |
| Behind origin | **Process risk** — sync before packaging |

---

## Proof run (this session)

- `npm run compile-filters` — seed cosmetics 90
- `npm run bundle` — `[dev]` dist
- `node scripts/ad-audit.mjs weather` — no medium/high issues (`adIframes=0`)
- `npm run typecheck` — clean
- `npm test` — 164 pass
- `npm run smoke-extpay` — pass; Dev unlock hard-gated; `[dev]` dist restored

---

## Explicitly still human

- ExtPay dashboard ↔ CWS link confirmation  
- Published Buy / restart / clear-storage Restore  
- CWS version upload and review replies  
- `git pull`/merge of the 15 commits currently ahead on `origin/main`
