# Support & breakage triage

Use Chrome Web Store reviews and publisher email as the breakage inbox. Aim to respond (fix, document, or reply) within one biweekly release cycle.

## In-product reports

The popup's "Site broken?" panel ends with **Still broken? Tell the developer**, which opens a
pre-filled email to the publisher address. Subject line is `StampStack breakage: <host>`, so a
filter on that string collects them.

Each one already answers most of the template below:

```
site:         shop.example.com
repair step:  element hiding off
version:      2.0.0
filter lists: 24 Jul 2026 (2d old)
rules active: 120,377
lists on:     quell-seed, easylist, easyprivacy, ubo-filters, ubo-badware
browser:      Chrome 138
```

Read `repair step` first — it says how much filtering was still on when the user gave up, which
narrows the cause before you open the site:

| `repair step` in the report | What it rules out |
|---|---|
| everything on | Nothing yet — reproduce with all layers on |
| element hiding off *(and it fixed it)* | A cosmetic rule is hiding something the site needs |
| element hiding and scriptlets off *(and it fixed it)* | A scriptlet is patching a page global the site depends on |
| blocking off (allowlisted) | Network-layer overblock — the expensive kind |

Nothing about the page is included, by design, so a report never tells you *what* on the page
broke. That still comes from the user's own description at the top of the mail.

## Triage template

For reports that arrive without the block above (a store review, say). Copy into a review reply
draft or a note in `docs/AD_AUDIT.md` / `docs/DARK_MODE_SITES.md`:

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
