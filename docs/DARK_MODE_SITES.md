# Dark mode site triage

Short known-good / known-bad list for the paid dark engine. Prefer incremental fixes over architecture rewrites. Per-page toggle and “reset to global” must stay rock-solid.

Breakage from CWS reviews → triage with [`SUPPORT_TRIAGE.md`](./SUPPORT_TRIAGE.md), then log hostname + symptom here.

## Known good (expect clean invert / dynamic recolor)

| Site | Notes |
|------|--------|
| Wikipedia | Article pages; media cancels correctly |
| Hacker News | Dense text; already-dark auto-off rarely triggers |
| GitHub | Repo / issues; watch code blocks for contrast |
| example.com | Baseline smoke host |

## Color-heavy / news (watch carefully)

| Site | Notes |
|------|--------|
| vg.no-class news | High chroma heroes; report washed text or inverted logos |
| CNN / Forbes article | Ads may leave light boxes when blocking is partial |
| weather.com | CMP overlays + leftover iframes can look wrong under dark |

## Known awkward / expected auto-off

| Situation | Behavior |
|-----------|----------|
| Site already ships dark theme | Smart detector force-off; user can Force on from popup |
| Chrome Web Store / Web Store pages | Restricted — Chrome blocks page modification |
| PDF / non-HTML viewers | Out of scope |

## Regression checklist (manual — each dark-mode / even release)

1. Enable dark globally → open Wikipedia → readable.
2. Toggle **off on this page** → page restores light without reload loop.
3. **Reset to global default** → follows global again.
4. Open a site that already looks dark → auto-off note appears; Force on works.
5. **Pause** StampStack ad blocking → dark mode still applies.
6. **Allowlist** the current site for ads → dark mode still applies.
7. Unpaid popup: Buy + Restore visible; hint mentions receipt email; **Dev unlock** absent in store builds.
8. After Dev unlock (unpacked only): global toggle works; Buy/Restore upsell hidden.

## Funnel notes (conversion)

- Copy must stay “ad blocker first; $2 dark add-on.”
- Restore must stay visible whenever ExtPay is configured (reinstall path).
- Do not gate dark mode on pause/allowlist.

## Break log

| Date | Host | Symptom | Fix |
|------|------|---------|-----|
| | | | |

Log new breaks with hostname + symptom; fix with the smallest CSS/detection tweak.
