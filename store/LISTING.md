# Chrome Web Store listing copy

Paste these into the Developer Dashboard. Character limits are approximate; trim if the form rejects.

## Item name

```
StampStack
```

## Summary (≤132 characters)

```
Blocks ads, trackers and popunders. See what each page tracks, hide anything with a click, and fix broken sites without unblocking.
```

## Detailed description

```
StampStack blocks ads, trackers and popunders in Chromium browsers using Manifest V3
Declarative Net Request, plus cosmetic filters and scriptlets for whatever the network layer
cannot reach.

What it blocks
• 120,000+ network rules compiled from EasyList, EasyPrivacy, EasyList Cookie and uBlock
  Origin's ads, privacy and badware lists
• Popunders and "open in new tab" hijacks
• Anti-adblock nags and paywall detectors
• Cookie-consent walls and interaction nags
• Malware and phishing hosts, including on the page you navigate to — not just its subresources

See what a page actually does
• Open the popup on any site and StampStack names the trackers that page reached out to —
  Google Analytics, Criteo, Taboola — and tells you which ones it has rules for
• It also counts the ad slots it hid on that page
• No accounts, no telemetry, nothing leaves your browser to make this work

Fix a broken site without losing protection
• Most breakage is element hiding or a script patch, not network blocking
• So instead of one on/off switch, StampStack offers graded repair: stop hiding elements →
  also stop running scriptlets → finally, turn blocking off entirely
• The first two steps keep your ad blocking on

Hide anything you like
• Click "Hide an element" (or press Alt+Shift+X), point at what annoys you, and it is gone —
  on that site, permanently
• Selectors are chosen to survive the site's next redesign, not just today's page
• Write your own filters by hand in Settings if you prefer

YouTube
• Hide promoted videos and scrub in-player ad payloads
• Block Shorts shelves and redirect Shorts URLs
• Skip sponsor segments using the community SponsorBlock database, with per-category control
  over what gets skipped — sponsors, self-promo, intros, outros and more
• Skipped something you wanted? The toast has an Undo

Optional dark mode ($2 one-time)
• A smart dark theme for ordinary pages, with per-site overrides
• Surfaces that are already dark are left alone instead of being inverted into light
• Entirely separate from ad blocking, which is and stays free

Honest about what it is doing
• The rule count reflects what Chrome actually loaded, not what was requested — if the browser's
  shared rule limit forces a list to be dropped, StampStack says so instead of quietly claiming
  full protection
• On pages it cannot run on, it says that too, rather than showing controls that do nothing

Privacy
• No account, no analytics, no telemetry to StampStack servers
• Settings and your allowlist stay in your browser's local storage
• Filter lists are compiled into the extension — nothing is downloaded while you browse
• Sponsor-segment lookups send only a 4-character hash prefix of the video id, never the video
  id or the page URL, and can be narrowed or switched off entirely in Settings
• The optional dark-mode purchase is handled by ExtensionPay / Stripe (email for receipt and
  restore only); no browsing data is shared with the payment provider
• Export and re-import your settings any time

Tips
• After install, just browse — blocking starts immediately with the packaged lists
• If a site looks wrong, open the popup and use "Site broken?" before turning anything off
• Alt+Shift+X starts the element picker without opening the popup
• Reinstalling? Restore a dark-mode purchase with the email from your receipt
```

## Category

Privacy & Security

## Official URL (Homepage)

Leave blank until a public homepage exists. Do **not** paste a private GitHub repo URL.

## Support URL

Prefer the Chrome Web Store “Support” field pointing at a public page, or leave blank and answer reviews via the dashboard. Publisher contact for payment/restore issues is the email in `docs/privacy-policy.md`. Do **not** paste a private GitHub issues URL. Triage guide: `docs/SUPPORT_TRIAGE.md`.

## Screenshots to capture

1. **Popup** — toolbar popup showing block status, YouTube rows (when on youtube.com), and dark-mode upsell or toggles.
2. **Options — Lists** — filter lists toggles.
3. **Options — YouTube / Dark mode** — behavior-first YouTube labels + dark-mode buy/restore.
4. **Before/after** (optional) — same site with StampStack on vs allowlisted (honest, not exaggerated).

Sizes: **1280×800** preferred, or **640×400**. PNG or JPEG. At least 1 screenshot required; 2–3 recommended.

```bash
npm run build
npm run store-screenshots
```

Save captures under `store/screenshots/`.

## Promo tile

Run `npm run store-assets` to generate `store/promo-small.png` (440×280).

## Single purpose (CWS privacy form)

```
Block ads and trackers using Declarative Net Request, cosmetic filters, and scriptlets. Optional related browsing aids: YouTube cleanup toggles and a paid dark-mode theme.
```

## Privacy / payments disclosure (CWS form)

When answering Chrome Web Store privacy practices, disclose:

- Optional one-time in-extension purchase via ExtensionPay (Stripe)
- Email may be collected by the payment provider for receipt / restore
- SponsorBlock: on by default; sends a 4-character SHA-256 hash prefix of the video id to sponsor.ajay.app (never the video id or page URL, no cookies), and can be turned off in Options
- No browsing history shared with the payment provider
- Update the hosted privacy policy URL after publishing `docs/privacy-policy.html`
