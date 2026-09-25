# Chrome Web Store upload checklist (first publish)

For recurring biweekly releases, prefer **[docs/RELEASE_CHECKLIST.md](../docs/RELEASE_CHECKLIST.md)** (version bump, ExtPay, obfuscation scan, reviewer notes).

Use your **normal Chrome** at: https://chrome.google.com/webstore/devconsole

## Package

| Field | Value |
|-------|--------|
| Zip | `release/stampstack-<version>.zip` (whatever `npm run package` just printed) |
| Version | matches `package.json` / `src/manifest.json` |
| Icon 128 | `C:\Users\hakka\WebstormProjects\Extensions\quell\src\icons\icon-128.png` |
| Promo 440×280 | `C:\Users\hakka\WebstormProjects\Extensions\quell\store\promo-small.png` |
| Marquee 1400×560 | `C:\Users\hakka\WebstormProjects\Extensions\quell\store\promo-marquee.png` |

Regenerate the icons with `npm run icons` and both promo images with `npm run store-assets`. Both
render from the SVG masters in `store/brand/`. The promo PNGs are 24-bit with no alpha, as the
dashboard requires.

## Listing (paste)

**Name** — nothing to paste. The dashboard shows "Title from package": `extName` in
`src/_locales/*/messages.json` (see `store/LISTING.md`). In English:

```
StampStack — Ad & Tracker Blocker
```

**Summary** — nothing to paste. The dashboard shows "Summary from package": `extDescription` in
`src/_locales/*/messages.json` (see `store/LISTING.md`). Change it there and rebuild the zip.

**Detailed description** — copy from `store/LISTING.md` (Detailed description section).

**Category:** Privacy & Security  

**Homepage:** leave blank (private repo — do not paste GitHub until public)  

**Support:** leave blank (private repo — do not paste GitHub until public)

## Permissions (paste from `store/PERMISSIONS.md`)

- `declarativeNetRequest` — DNR rulesets for ads/trackers  
- `scripting` — cosmetic CSS + scriptlets  
- `storage` — local settings / allowlist only  
- Host `<all_urls>` — general-purpose blocker across sites  

## Privacy practices (critical paste targets)

**Single purpose** (purpose only — never paste host-permission text here).
Single source of truth: the "Single purpose" block in [LISTING.md](./LISTING.md). Paste that text
verbatim — it is the only variant that covers the dark-mode theming, and a narrower one has been
submitted before.

**Remote code:** No (this extension does not load remote code).

**Privacy policy URL:**

```
https://andreasne89.github.io/quell/privacy-policy.html
```

Homepage / Official URL: leave blank until a public site exists. Do not paste the private GitHub repo.

## Still required from you

1. Register as developer (eligible adult Google account; $5 fee if prompted).
2. **New item** → upload the zip above.
3. **Privacy policy HTTPS URL** — already hosted at the URL above; confirm it still loads.
4. **Screenshots** — the five 1280×800 shots from `npm run build:store && npm run store-screenshots`
   (then `npm run bundle` to get a dev `dist/` back). They land in `store/screenshots/`; see its README.
5. Privacy practices — no account, no remote telemetry, settings local-only (match privacy policy).
6. **Settings:** provide + verify publisher contact email (blocks Submit until done).
7. Submit for review only when the dashboard shows no required-field errors.

Full copy: `store/LISTING.md`, `store/PERMISSIONS.md`, `docs/CHROME_WEB_STORE.md`.
