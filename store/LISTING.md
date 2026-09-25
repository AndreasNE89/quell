# Chrome Web Store listing copy

Paste these into the Developer Dashboard. Character limits are approximate; trim if the form rejects.

Voice: plain, honest, benefit first. Nothing a user reads says "Manifest V3", "DNR",
"scriptlets", "cosmetic filters" or "uBO-parity". Naming the filter lists (EasyList, EasyPrivacy,
uBlock Origin) is attribution, so it stays. The one pun, "Stamp out ads, not the site.", belongs
to the store art only. It does not appear in this copy or anywhere in the product.

## Item name

The dashboard shows "Title from package". That is the manifest `name`, which resolves to
`extName` in `src/_locales/en/messages.json` (each locale has its own). Edit it there, not in
the dashboard, and keep this copy identical. 33 characters; the store allows 75.

```
StampStack — Ad & Tracker Blocker
```

The toolbar tooltip (`action.default_title`) stays the short `StampStack`.

## Summary (≤132 characters)

The dashboard shows "Summary from package". That is the manifest `description`, which resolves
to `extDescription` in `src/_locales/en/messages.json`. Edit it there, not in the dashboard, and
keep this copy identical. 131 characters.

```
Blocks ads and trackers. See which known trackers a page contacts, hide anything with a click, and keep blocking on if sites break.
```

## Detailed description

The lines are not wrapped on purpose. The dashboard keeps every line break, so a hard-wrapped
paragraph shows up broken in the store.

```
StampStack blocks ads, trackers and pop-unders (windows that open behind yours), and hides the ads that blocking alone can't reach.
It starts working as soon as you install it. No account, no telemetry, nothing to set up.
Click its toolbar icon on any page to see which known trackers that page contacted, and which of them StampStack has rules for.
If a site breaks, fix it without turning blocking off. Point at anything else that annoys you and hide it with a click.
On YouTube, it skips sponsor segments and hides promoted videos. Ad blocking is free.

What it blocks
• Ads and trackers, with about 115,000 rules on from the start. They come from EasyList, EasyPrivacy and uBlock Origin's ads, privacy and badware filter lists. Optional lists for cookie banners and Chinese-language sites bring the total to about 130,000
• Pop-unders, and pages that hijack your click to open an ad in a new tab
• Many "please turn off your ad blocker" messages
• Cookie banners, once you turn on the EasyList Cookie list in Settings (it is off by default)
• Malware and phishing sites, including when you open one directly, not only when a page loads something from one

See what a page is doing
• Click the toolbar icon on any site to see the known trackers that page reached out to, by name (Google Analytics, Criteo, Taboola and others), and which ones StampStack has rules for
• When rules made for that site hide ad slots, it counts those too
• All of this is worked out in your browser. Nothing is sent anywhere to produce it

If a site breaks, fix it without turning blocking off
• Most broken pages come from element hiding (hiding leftover ad boxes) or a script patch (a small script StampStack adds to a page to switch off ads or ad-blocker checks), not from blocking itself
• So "Site broken?" in the popup works in steps: stop hiding elements, then also stop script patches, and only as a last resort turn blocking off for that site
• The first two steps keep ad and tracker blocking on
• Still broken? One click drafts an email to the developer, copies it when it can, and opens your email app if you have one. You read it and send it yourself; StampStack sends nothing. The draft has the site name, your StampStack version and settings, and your browser version. No page content, not even the full address

Hide anything you like
• Click "Hide an element" in the popup, or press Alt+Shift+X, then point at what annoys you. It stays hidden on that site
• StampStack avoids the auto-generated names many sites change with every update, so the rule is more likely to keep working after the site changes
• You can also write your own rules in Settings, under My filters

YouTube
• Hides promoted videos and "Sponsored" tiles, and removes ad data from the video player
• Can block Shorts: it hides Shorts shelves and sends Shorts pages back to the home page (off by default)
• Skips sponsor segments using the community SponsorBlock database. Only sponsors are skipped by default; turn on intros, outros, self-promotion and more in Settings
• Skipped something you wanted to see? The notice has an Undo
• YouTube changes often. This cuts ads down; it can't promise a YouTube with no ads

Optional dark mode ($2, one-time)
• A dark theme for ordinary web pages, with per-site overrides
• Pages that are already dark are left alone instead of being flipped to light
• It is separate from ad blocking, which is free and stays free

Honest about what it is doing
• The rule count shows what Chrome actually loaded. If Chrome's shared rule limit forces a list off, StampStack says so instead of quietly claiming full protection
• Settings shows how old the filter lists are. They are built into each release, so they update when StampStack does
• On pages it can't run on, it says so instead of showing controls that do nothing

Privacy
• No account, no analytics, no telemetry
• Your settings and site choices stay in your browser
• Filter lists are built into the extension, so no lists are downloaded while you browse
• Sponsor-segment lookups identify the video only by the first 4 characters of a hash of its ID. They never send the video ID or the page address, and carry no cookies. You can narrow them or switch them off in Settings
• The optional dark-mode purchase goes through ExtensionPay / Stripe. They may ask for your email, for the receipt and to restore the purchase later. No browsing data is shared with them
• Export your settings to a file and import them again at any time

Tips
• After you install it, just browse. Blocking starts right away
• If a site looks wrong, open the popup and use "Site broken?" before turning anything off
• Alt+Shift+X starts the element picker without opening the popup
• Reinstalling? Restore a dark-mode purchase with the email from your receipt
```

### Where the claims come from

Check these before each release. The description must not promise more than the build does.

- Rule counts: `src/generated/meta.json` after `npm run build`. For 2.2.2 that is 114,529 rules
  in the five lists on by default, and 129,482 across all eight (CHANGELOG 2.2.2). EasyList
  Cookie, EasyList China and CJX Annoyance ship off. EasyList China turns itself on for
  Chinese-language browsers (`src/shared/locale-lists.ts`).
- Pop-unders: the `no-window-open-if` script patch in `src/scriptlets/library.ts`.
- Repair steps: `src/shared/site-fix.ts`. What the breakage email contains:
  `src/shared/breakage-report.ts`.
- Tracker names and "has rules for": `src/shared/page-report.ts` and `src/generated/trackers.json`.
- The ad-slot count: `hiddenCount` in `src/content/content.ts`. It counts only what site-specific
  and procedural rules hide, not the generic element-hiding stylesheet, so the listing must not
  say it counts every ad it hid.
- Shorts off and sponsors only by default: `src/background/settings.ts` and
  `src/shared/sponsorblock.ts`.
- The 4-character hash prefix, sent without cookies: `src/background/sponsorblock-api.ts`.

## Category

Privacy & Security

## Official URL (Homepage)

Leave blank until a public homepage exists. Do **not** paste a private GitHub repo URL.

## Support URL

Prefer the Chrome Web Store “Support” field pointing at a public page, or leave blank and answer reviews via the dashboard. Publisher contact for payment/restore issues is the email in `docs/privacy-policy.md`. Do **not** paste a private GitHub issues URL. Triage guide: `docs/SUPPORT_TRIAGE.md`.

## Screenshots

Five at **1280×800**, as 24-bit PNG with no alpha. Every shot uses the same frame: a paper
background (#f4ecd8), a headline of six words or fewer and one subline on the left in deep ink
(#1f4d37), and the real UI on the right, rendered at 2x.

- Capture from a store build (`npm run build:store`), so the Dev unlock button and the dev-only
  stat cards are not in frame.
- Use only fictional `*.example` hosts and content. No real sites, brands or logos.
- Show only UI the product really shows. The tracker report appears as its collapsed "On this
  page" sentence, not with made-up rows.

1. **The benefit, and what the page contacted.** A fictional news.example page with its ad slots
   actually hidden, and the popup open on the collapsed "On this page" summary. The popup does
   not count ads hidden by generic rules, so a small labelled stamp shows the same page captured
   without StampStack, with its ads.
2. **"Site broken? Fix it, keep blocking."** The popup's repair panel open, next to a face-on
   stack of three stamps: Element hiding, Script patches, Blocking. The first two are marked
   "blocking stays on".
3. **"Hide anything with a click."** The real element picker over a fictional page, with its hint
   bar at the bottom, where the picker pins it.
4. **"Skip sponsor segments."** The popup's YouTube group plus the Settings segment picker
   (sponsors only by default). The Undo notice may sit over a plain grey video frame. No YouTube
   UI or logo.
5. **"No account. No telemetry."** Settings with the filter lists, their rule counts and the list
   age. Subline: "Nothing to sign up for. Your settings stay in your browser."

```bash
npm run build:store
npm run store-screenshots
```

Save captures under `store/screenshots/`.

## Promo assets

- `store/promo-small.png`: the small promo tile, 440×280. It shows the stamp, the StampStack
  wordmark and the tagline "Stamp out ads, not the site.", and must stay readable at half size.
- `store/promo-marquee.png`: the marquee promo tile, 1400×560. A fictional news.example page
  whose ad slot the postmark cancels, leaving an "ad slot hidden" frame. One line of trust chips:
  "No account · No telemetry · Ad blocking stays free".
- Both are 24-bit PNG with no alpha, as the dashboard requires. Regenerate them with
  `npm run store-assets`.

## Single purpose (CWS privacy form)

This one is for reviewers, so it keeps the technical terms.

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
