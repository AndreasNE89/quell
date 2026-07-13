# Deep review fixes — status

Fixes from the MV3 / filter-pipeline deep review. **Uncommitted** (restart pass verified 2026-07-13).

## Summary table

| # | Severity | Issue | Status | Evidence |
|---|----------|--------|--------|----------|
| 1 | HIGH | `$options` dropped on path-anchored filters (`findOptionsDollar`) | **verified** | Unit: `path-anchored filter…` in `test/converter.test.mjs`. Red-green: old “any `/…/` is regex” → actual `'/ad/image/*$image'`; restore → pass. |
| 2 | MEDIUM | `$badfilter` cancellation | **verified** | Parse/identity tests in `converter.test.mjs`. Compile: `badfilter` 35 + `badfilter-cancelled` 5. |
| 3 | MEDIUM | Legacy scriptlet unregister wrong id | **verified** | SW unregisters `['StampStack-scriptlets', SCRIPTLETS_SCRIPT_ID]` (`quell-scriptlets`). Code review (no chrome.scripting harness). |
| 4 | MEDIUM | Invalid allowlist host (IPv6) aborts script registration | **verified** (+ gap closed) | `isValidMatchPatternHost` moved to `hostname.ts`; used by SW allowlist/excludeMatches. Unit: `should reject IPv6 and garbage hosts…`. |
| 5 | MEDIUM | `abort-current-inline-script` no-op setter | **verified** (+ gap closed) | Mutable `held` setter in `library.ts`. Unit: `abort-current-inline-script setter retains assigned values`. |
| 6 | MEDIUM | Entity domains `example.*` | **verified** | `hostMatchesDomain` + `entityDomainKeys` + `matchCosmetic` entity key test in `engine.test.mjs`. |
| 7 | MEDIUM | Procedural trailing selectors | **verified** | `should keep trailing CSS after a procedural op` (+ trailing `:not`) in `engine.test.mjs`. |
| 8 | a11y | Options/popup switches | **verified** | `aria-label` on popup/options switches; list toggles set in `options.ts`; `:focus-visible` on `.slider` in both CSS files. |

## Bug 1 detail (highest impact)

**Root cause:** `findOptionsDollar` treated any `/…/…` string as a full regex. For `/ad/image/*$image` the char after the last `/` is `*`, so it returned −1 and `$image` stayed in `urlFilter`.

**Fix:** In the regex branch, return −1 only when the closing `/` is the final character; return the `$` index when followed by `$options`; otherwise fall through to the first-unescaped-`$` scan.

## Checks run (this restart)

```text
npm test          → 70 pass, 0 fail
npm run typecheck → exit 0
npm run compile-filters → exit 0
  DNR network rules ≈70451; regex 205/1000
  skipped: badfilter 35, badfilter-cancelled 5
```

## Deferred / notes

- Item 3 has no automated chrome.scripting test (SW-only unregister call).
- Two residual odd skips (`unsupported:.min.js|$script`, `unsupported:web/*index.html$doc`) look like other mis-split edge cases — not addressed here.
- Cross-list `$badfilter` is collected in a global pre-pass before any ruleset emit.
