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
| element hiding and script patches off *(and it fixed it)* | A scriptlet is patching a page global the site depends on. Reports from before the rebrand say "scriptlets off" |
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
Still fails while paused? (yes/no):
VPN or DNS ad blocker? (NetShield / NextDNS / Pi-hole / AdGuard DNS / none):
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
| Images or pages still missing with StampStack paused (or the site switched off) | DNS filter or VPN blocker outside the browser: ProtonVPN NetShield, NextDNS, Pi-hole, AdGuard DNS. The failed requests show `ERR_NAME_NOT_RESOLVED`, not `ERR_BLOCKED_BY_CLIENT` | Ask them to retest with it off, or to allow the host there (tek.no photos: `shared.cdn.smp.schibsted.com`, which NetShield blocks). Not ours: uBO or no extension fails the same. When retesting yourself on a machine behind such a resolver, use DNS over HTTPS, or the baseline fails too |
| Chrome says "This page has been blocked by an extension" | A filter that blocks the whole page. On 2.2.x, about 135 filters that should only block scripts or images did this (`/reklame/`, `-banner-ads-`, `ads.*` hosts); fixed in 2.3.0 | Ask for the version and the exact address. On 2.2.x: update. On 2.3.0 or later: find the `$doc`/`$all` rule that matched |
| Console shows "Blocked script execution in 'about:blank' because the document's frame is sandboxed and the 'allow-scripts' permission is not set", only with StampStack on (2.3.0+) | Ours, and harmless. The script-patch registrations use `matchOriginAsFallback` so friendly-iframe ads in a page's own blank frames get patched, and Chrome also tries them in sandboxed blank frames that may not run scripts, logging one line per registration (`chrome.scripting` cannot skip those frames). Expect 2 per such frame on YouTube (its bucket + broad), 1 on sites matched only by the broad script. More than that means a non-default list set, whose registrations inject their files one by one | No action; nothing is blocked or broken. Reply with the snippet below. Treat it as a real problem only if the page also misbehaves, and then triage that symptom as usual |
| Site broken only when StampStack on | Overblock | Ask them to allowlist; add exception if confirmed |
| Dark looks wrong / inverted logos | Dark engine / already-dark | `DARK_MODE_SITES.md` + smallest CSS/detection tweak |
| Clicking a Shorts link on YouTube does nothing | **Block Shorts** is on. In releases after 2.3.0 a plain click on a Shorts link stays on the page, and a Ctrl/Cmd/Shift-click opens a new tab that goes on to YouTube's home page; the video being watched stays in the tab and its history (up to 2.3.0 the tab itself jumped to Home) | Expected; the popup's **Block Shorts** switch turns it off |
| Buy / Restore fails | ExtPay / Stripe / email | Confirm published build; check ExtPay ↔ CWS link; see `RELEASE_CHECKLIST.md` |
| Dev unlock missing | Store build in `dist/` | Expected in production; local: `npm run build` then reload |

## Reply snippets

**Something missing or won't load (ask this first):**
> Does it still happen with StampStack paused, or with the site switched off in the StampStack popup? If it does, something outside StampStack is blocking it. VPN and DNS ad blockers such as ProtonVPN NetShield, NextDNS, Pi-hole or AdGuard DNS are the usual cause, so please try again with that turned off, or allow the site there. On tek.no, for example, the photos come from `shared.cdn.smp.schibsted.com`, which NetShield blocks. If it only fails with StampStack on, reply with the exact address, whether Chrome says "blocked by an extension", and whether dark mode is on.

**"Blocked script execution in 'about:blank'" in the console:**
> That line comes from StampStack and is harmless. Since 2.3.0 its script patches also reach the blank frames a page creates for itself, which is where some ads hide. Some of those frames are not allowed to run scripts at all, and Chrome logs this line when it declines to run the patch there. Nothing is blocked or broken by it. If the page itself misbehaves, tell us the address and what goes wrong.

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
