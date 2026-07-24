# Chrome Web Store upload checklist (first publish)

For recurring biweekly releases, prefer **[docs/RELEASE_CHECKLIST.md](../docs/RELEASE_CHECKLIST.md)** (version bump, ExtPay, obfuscation scan, reviewer notes).

Use your **normal Chrome** at: https://chrome.google.com/webstore/devconsole

## Package

| Field | Value |
|-------|--------|
| Zip | `C:\Users\hakka\WebstormProjects\Extensions\quell\release\stampstack-1.1.0.zip` |
| Version | 1.1.0 |
| Icon 128 | `C:\Users\hakka\WebstormProjects\Extensions\quell\src\icons\icon-128.png` |
| Promo 440×280 | `C:\Users\hakka\WebstormProjects\Extensions\quell\store\promo-small.png` |

## Listing (paste)

**Name**

```
StampStack
```

**Summary**

```
Block ads and trackers with EasyList-style filters, cosmetics, and scriptlets — built for Manifest V3.
```

**Detailed description** — copy from `store/LISTING.md` (Detailed description section).

**Category:** Productivity  

**Homepage:** leave blank (private repo — do not paste GitHub until public)  

**Support:** leave blank (private repo — do not paste GitHub until public)

## Permissions (paste from `store/PERMISSIONS.md`)

- `declarativeNetRequest` — DNR rulesets for ads/trackers  
- `scripting` — cosmetic CSS + scriptlets  
- `storage` — local settings / allowlist only  
- `webNavigation` — apply cosmetics/scriptlets on navigations  
- Host `<all_urls>` — general-purpose blocker across sites  

## Privacy practices (critical paste targets)

**Single purpose** (purpose only — never paste host-permission text here):

```
Block ads and trackers using Declarative Net Request, cosmetic filters, and scriptlets.
```

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
4. **Screenshots** (≥1) — 1280×800 preferred; popup + Options. Save under `store/screenshots/`.
5. Privacy practices — no account, no remote telemetry, settings local-only (match privacy policy).
6. **Settings:** provide + verify publisher contact email (blocks Submit until done).
7. Submit for review only when the dashboard shows no required-field errors.

Full copy: `store/LISTING.md`, `store/PERMISSIONS.md`, `docs/CHROME_WEB_STORE.md`.
