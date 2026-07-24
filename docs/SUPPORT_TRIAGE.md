# Support & breakage triage

Use Chrome Web Store reviews and publisher email as the breakage inbox. Aim to respond (fix, document, or reply) within one biweekly release cycle.

## Triage template

Copy into a review reply draft or a note in `docs/AD_AUDIT.md` / `docs/DARK_MODE_SITES.md`:

```
Hostname:
Symptom (ad visible / page broken / dark wrong / purchase):
StampStack paused? (yes/no):
Site allowlisted? (yes/no):
Dark mode only? (yes/no):
Repro steps:
Expected:
Actual:
Next action: fix-in-seed | fix-in-code | document-wontfix | need-more-info
```

## Classify

| Signal | Likely cause | First response |
|--------|--------------|----------------|
| Ads on one site, pause clears them | Missing rule / first-party HTML | Seed cosmetic or DNR; log in `AD_AUDIT.md` |
| Site broken only when StampStack on | Overblock | Ask them to allowlist; add exception if confirmed |
| Dark looks wrong / inverted logos | Dark engine / already-dark | `DARK_MODE_SITES.md` + smallest CSS/detection tweak |
| Buy / Restore fails | ExtPay / Stripe / email | Confirm published build; check ExtPay ↔ CWS link; see `RELEASE_CHECKLIST.md` |
| Dev unlock missing | Store build in `dist/` | Expected in production; local: `npm run build` then reload |

## Reply snippets

**Broken site (ask allowlist):**
> Sorry about the breakage. In the StampStack popup, turn off blocking for that site (or pause StampStack), reload, and reply with the hostname if it still fails — we’ll add a fix in the next update.

**Already paid / reinstall:**
> Use **Restore purchase** in the popup or Options with the email from your ExtensionPay / Stripe receipt. Dark mode is a one-time unlock separate from ad blocking.

**YouTube ads:**
> YouTube pre-roll is partially first-party, so MV3 blockers can’t always match classic desktop blockers. Keep StampStack updated; use the YouTube toggles in the popup. Reply with a sample video URL if a specific case still fails.

## Logging

- Blocking / overblock → append a short row to [`AD_AUDIT.md`](./AD_AUDIT.md)
- Dark mode → append hostname + symptom to [`DARK_MODE_SITES.md`](./DARK_MODE_SITES.md)
- ExtPay → note under ExtensionPay in [`RELEASE_CHECKLIST.md`](./RELEASE_CHECKLIST.md) for the next cadence cycle
