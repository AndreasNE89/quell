# Branch review findings — 2.1.0 (`ci-and-breakage-reports`)

Reviewed: `06622bc` (main) → `bf5bdce` (HEAD), 2026-07-27.

Scope: list locking, CI, scheduled refresh PRs, breakage report, list-age UI, release docs.
Filter `.txt` bulk adds were checked only for lock/CI implications.

**Verdict:** merge with fixes. No critical product bugs. Three important automation/honesty issues below.

---

## Important (should fix)

### 1. Refresh summary treats script failures as “unchanged”

- **Where:** `.github/workflows/refresh-lists.yml` (Summarize the change step, ~lines 59–70)
- **Bug:** `list-refresh-report.mjs` exits `3` when nothing moved (intentional skip). The workflow’s `if … then changed=true else changed=false` treats **any** non-zero the same as “unchanged”. A crash, OOM, or bad JSON path also sets `changed=false`, the step still succeeds, and no PR is opened.
- **Impact:** A real upstream refresh can be silently dropped with a false “unchanged” summary.
- **Fix:** Capture the exit code. Treat only `3` as unchanged; fail the job on every other non-zero.

### 2. Lock re-stamp advances list age when bytes did not change

- **Where:** `scripts/lock-lists.mjs` (~lines 23–47); consumed by `scripts/compile-filters.mjs` → `meta.generatedAt` → Options list-age UI
- **Bug:** `npm run update-lists` / `lock-lists` always writes a new `updated` ISO timestamp, even when every list `sha256` is identical. `generatedAt` prefers `lists.lock.json`’s `updated` field, so Settings can claim fresher lists than upstream actually delivered.
- **Impact:** The “compiled N days ago” line becomes dishonest after a no-op refresh stamp. Release 2.1.0 was cut partly because this already happened once.
- **Fix:** When the lock diff is clean and a previous lock exists, preserve `previous.updated` (or skip rewriting). Only bump `updated` when list hashes change.

### 3. Refresh PRs never get `ci.yml` status checks

- **Where:** `.github/workflows/refresh-lists.yml` (PR create with `GITHUB_TOKEN`); comments ~72–73 and PR body copy
- **Bug:** GitHub does not trigger other workflows for PRs opened with `GITHUB_TOKEN`. The in-job Gate runs `check-lists`, typecheck, tests, and store package, but **not** the named `CI / build` check and **not** the byte-for-byte rebuild assertion that only lives in `ci.yml`.
- **Impact:** If `main` requires the CI check, refresh PRs stall or need an admin bypass. Reviewers may also miss that reproducibility was never asserted on the refresh branch.
- **Fix:** Open the PR with a PAT / GitHub App that can trigger workflows, or explicitly exempt that check for the refresh branch; optionally run the reproducibility step inside the refresh Gate.

---

## Minor

### 4. Reproducibility step picks an arbitrary zip

- **Where:** `.github/workflows/ci.yml` (~line 62)
- **Bug:** `zip=$(ls release/*.zip | head -1)` assumes a single artifact. If `release/` ever holds more than one zip, the step can hash a stale package while rebuilding the current version and report a false “reproducible” (or false failure).
- **Fix:** Pin `release/stampstack-<version>.zip` (or sort and take the current version explicitly).

### 5. Commit/docs say “every push”; workflow is `main` + PRs

- **Where:** `.github/workflows/ci.yml` (`on:` block); commit message for `1629424`
- **Bug:** CI runs on pushes to `main`, all pull requests, and `workflow_dispatch` — not on every feature-branch push without a PR.
- **Impact:** Documentation overstates coverage; harmless for the intended gate.
- **Fix:** Align wording, or broaden `push.branches` if feature-branch CI is desired.

### 6. `ensure-local-config` comment overclaims the compile-filters hook

- **Where:** `scripts/ensure-local-config.mjs` (~line 10) vs `package.json` scripts
- **Bug:** Comment says the script is wired as a pre-hook for typecheck / test / **compile-filters**. Only `pretypecheck` and `pretest` exist.
- **Impact:** Misleading for anyone relying on `compile-filters` alone to materialize the gitignored ExtPay override (CI still compiles after typecheck/test, so runners are fine).
- **Fix:** Add `precompile-filters`, or trim the comment.

---

## Not bugs (intentional gaps)

These match the design / docs; listed so they are not re-triaged as defects.

| Item | Note |
|------|------|
| Breakage report is mailto + clipboard only | No telemetry; user sends the mail. |
| Report UI hidden while paused | By design — nothing is “ours” to have broken while paused. |
| List age is Options-only | Matches “Settings shows…”. |
| `smoke-extpay` not in CI | Needs local ExtPay configuration; documented in `RELEASE_CHECKLIST`. |
| Privacy policy must be re-hosted before CWS | Process step for store submit (`store/SUBMIT-2.1.0.md`), not a code defect. |

---

## Checks run during review

- `npm test` — 390 pass, 0 fail
- `npm run typecheck` — pass
- `npm run check-lists` — pass
