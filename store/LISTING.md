# Chrome Web Store listing copy

Paste these into the Developer Dashboard. Character limits are approximate; trim if the form rejects.

## Item name

```
StampStack
```

## Summary (≤132 characters)

```
Block ads and trackers with EasyList-style filters, cosmetics, and scriptlets — built for Manifest V3.
```

## Detailed description

```
StampStack blocks ads and trackers in Chromium browsers using Manifest V3 Declarative Net Request, plus cosmetic filters and scriptlets for leftover page junk.

What it does
• Network blocking with packaged filter lists (EasyList-style rules compiled for DNR)
• Cosmetic hiding for ad placeholders and overlays
• Scriptlets for common anti-block and tracking patterns where supported
• Per-site allowlist from the toolbar popup
• Options to enable or disable filter lists
• YouTube extras (optional): hide promoted videos, block Shorts, auto-skip sponsor segments (SponsorBlock community data)
• Optional paid dark mode ($2 one-time): smart dark theme for ordinary pages — a browsing add-on, not a separate product

Privacy
• No StampStack account required for ad blocking
• No analytics or telemetry to StampStack servers
• Settings stay in your browser’s local storage
• Optional dark-mode purchase is handled by ExtensionPay / Stripe (email for receipt and restore only)
• Optional SponsorBlock skip contacts the community SponsorBlock API with video ids only (when that toggle is on)
• We do not send browsing history to the payment provider
• See the privacy policy linked on the store listing

Tips
• After install, browse normally — blocking starts with the packaged lists
• Use the popup to pause StampStack on a site that breaks
• Open Options to manage lists and YouTube extras
• Restore a dark-mode purchase from the popup or Options if you reinstall
```

## Category

Productivity (Tools is fine if Productivity is unavailable)

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
- Optional SponsorBlock: video ids sent to sponsor.ajay.app only when that toggle is enabled
- No browsing history shared with the payment provider
- Update the hosted privacy policy URL after publishing `docs/privacy-policy.html`
