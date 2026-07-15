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
• Options to enable or disable filter lists and tune behavior
• Optional paid dark mode ($2 one-time): simple invert theme for ordinary pages — a browsing add-on, not a separate product

Privacy
• No StampStack account required for ad blocking
• No analytics or telemetry to StampStack servers
• Settings stay in your browser’s local storage
• Optional dark-mode purchase is handled by ExtensionPay / Stripe (email for receipt and restore only)
• We do not send browsing history to the payment provider
• See the privacy policy linked on the store listing

Tips
• After install, browse normally — blocking starts with the packaged lists
• Use the popup to pause StampStack on a site that breaks
• Open Options to manage which lists are enabled
• Restore a dark-mode purchase from Options if you reinstall
```

## Category

Productivity (Tools is fine if Productivity is unavailable)

## Official URL (Homepage)

Leave blank until a public homepage exists. Do **not** paste a private GitHub repo URL.

## Support URL

Leave blank until a public support channel exists. Do **not** paste a private GitHub issues URL.

## Screenshots to capture (manual)

1. **Popup** — toolbar popup on a normal page (show block status / allowlist control).
2. **Options — Lists** — filter lists toggles.
3. **Before/after** (optional) — same site with StampStack on vs allowlisted (honest, not exaggerated).
4. **Dark mode** (optional) — popup dark-mode section or a page before/after invert (keep secondary to blocking).

Sizes: **1280×800** preferred, or **640×400**. PNG or JPEG. At least 1 screenshot required; 2–3 recommended.

Save captures under `store/screenshots/` (gitignored binaries OK; keep this folder documented).

## Promo tile

Run `npm run store-assets` to generate `store/promo-small.png` (440×280).

## Privacy / payments disclosure (CWS form)

When answering Chrome Web Store privacy practices, disclose:

- Optional one-time in-extension purchase via ExtensionPay (Stripe)
- Email may be collected by the payment provider for receipt / restore
- No browsing history shared with the payment provider
- Update the hosted privacy policy URL after publishing `docs/privacy-policy.html`
