# Chrome Web Store — StampStack release checklist

Use this when uploading StampStack to the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole).

**Biweekly cadence (ExtPay + obfuscation + version bump):** see [RELEASE_CHECKLIST.md](./RELEASE_CHECKLIST.md).

## Done in-repo (no dashboard login)

| Item | Status / path |
|------|----------------|
| Version | `package.json` (synced to `manifest.json` on build) |
| Store zip | `npm run package` → `release/stampstack-<version>.zip` |
| Store build flags | No `declarativeNetRequestFeedback`, no `tabs`; `DEV_BUILD=false` |
| ExtPay smoke | `npm run smoke-extpay` |
| Listing copy | [store/LISTING.md](../store/LISTING.md) |
| Permission justifications | [store/PERMISSIONS.md](../store/PERMISSIONS.md) |
| Privacy policy source | [docs/privacy-policy.html](./privacy-policy.html) (+ `.md`) |
| In-extension privacy page | Bundled as `privacy.html` in the zip |
| Icons 16/32/48/128 | `npm run icons` → `src/icons/icon-{16,32,48,128}.png` |
| Small promo tile 440×280 + marquee 1400×560 | `npm run store-assets` → `store/promo-small.png`, `store/promo-marquee.png` |
| Reviewer notes template | Below |

### Brand assets

- Masters are hand-written SVGs in `store/brand/`: `stampstack-icon.svg` (128 and the store icon,
  96×96 art in a 16px transparent margin), `stampstack-icon-48.svg` (hinted for 48),
  `stampstack-icon-small.svg` (16 and 32, drawn on the pixel grid), `promo-440x280.svg` and
  `marquee-1400x560.svg`. Edit these, never the PNGs.
- `scripts/render-brand-assets.mjs` rasterizes them with the Playwright Chromium the repo already
  installs. No Python or Pillow needed. Reruns are byte-identical.
- The store PNGs are written as 24-bit RGB with no alpha channel (flattened onto the paper colour
  `#f4ecd8`), which the dashboard requires for promo images.
- Store-art text is outlined from Lato (SIL OFL 1.1), so renders don't depend on installed fonts.
  Each outlined path carries its text in an `aria-label` and a comment. To change a line, re-outline
  it in the same font and size.

## Before you package (local)

1. Bump `version` in `package.json` when releasing a new version (manifest is synced on build).
2. Confirm filter lists are current: `npm run update-lists` (or let `npm run package` do it).
3. Run tests: `npm test` and `npm run typecheck`.
4. Run `npm run smoke-extpay`.
5. Build store zip: `npm run package` → `release/stampstack-<version>.zip`.

## Package validation (automatic in `npm run package`)

- MV3 manifest
- At least one DNR ruleset
- Icons including 128×128
- `privacy.html` bundled
- Obfuscation scan (`atob` / long base64)
- **Fails** if `declarativeNetRequestFeedback` or `tabs` is present
- **Fails** if ExtensionPay id is still a placeholder

---

## Only you can do (Chrome Web Store Dashboard)

These steps require your Google account, developer registration, and (usually) payment. No repo script can finish them.

### One-time account

- [ ] Register as a [Chrome Web Store developer](https://chrome.google.com/webstore/devconsole) ($5 one-time fee if not already paid)
- [ ] Accept the developer agreement

### Privacy URL (required before submit)

- [ ] Host `docs/privacy-policy.html` at a **public HTTPS** URL  
  - Suggested: GitHub → Settings → Pages → Deploy from branch → `/docs`  
  - Expected URL: `https://andreasne89.github.io/quell/privacy-policy.html` (repo folder may still be named `quell`)
- [ ] Open that URL in a private window and confirm it loads
- [ ] Paste the live URL into **Privacy practices → Privacy policy**

### Product / listing

- [ ] **Upload package:** `release/stampstack-<version>.zip` (Package tab) - the path `npm run package` printed
- [ ] **Item name:** StampStack
- [ ] **Summary:** from [store/LISTING.md](../store/LISTING.md) (≤132 chars)
- [ ] **Description:** from LISTING.md
- [ ] **Category:** Privacy & Security
- [ ] **Language:** English
- [ ] **Official URL / Homepage:** leave blank until a public homepage exists (do **not** paste a private GitHub URL)
- [ ] **Support URL:** leave blank until a public support channel exists (do **not** paste a private GitHub issues URL)

### Store assets (upload in dashboard)

- [ ] **Icon** 128×128 — from the zip (`icons/icon-128.png`) or `src/icons/icon-128.png`
- [ ] **Small promo** 440×280 — `store/promo-small.png`
- [ ] **Marquee** 1400×560 — `store/promo-marquee.png`
- [ ] **Screenshots** (≥1 required) — upload the five **1280×800** shots in `store/screenshots/`. Regenerate them with `npm run build:store && npm run store-screenshots`, then `npm run bundle` for a dev `dist/` again. Plan in LISTING.md, how they are made in `store/screenshots/README.md`

### Privacy practices form

- [ ] Single purpose (short purpose only — do **not** paste host-permission text): paste the
  "Single purpose" block from [store/LISTING.md](../store/LISTING.md) verbatim. That is the only
  variant that covers the dark-mode theming; do not retype a shorter one.
- [ ] Declare you **do not** collect user data (no remote analytics)
- [ ] Remote code: **No** (extension does not load remote code)
- [ ] Paste permission justifications from [store/PERMISSIONS.md](../store/PERMISSIONS.md) — each field once, matching that permission
- [ ] Certify limited-use / privacy compliance checkboxes

### Reviewer notes

- [ ] Paste the template below; replace `<PASTE_YOUR_HTTPS_URL>` with your live privacy URL
- [ ] Submit for review and watch the developer email for questions / rejection

### After publish

- [ ] Save the item ID and public listing URL
- [ ] Tag the git release: `git tag v<version> && git push origin v<version>` (when you choose to push)
- [ ] Update README with the Chrome Web Store badge/link
- [ ] Respond to any review follow-ups within the deadline

---

## Review notes (paste into “Notes for reviewer”)

```
StampStack is a Manifest V3 ad/tracker blocker.

Single purpose: Block ads and trackers using Declarative Net Request, cosmetic filters, and scriptlets. Optional related browsing aids: YouTube cleanup toggles and a paid dark-mode theme.

Permissions:
- declarativeNetRequest: apply packaged EasyList-style rulesets
- scripting: inject cosmetic CSS and allowlisted scriptlets
- storage: local settings and site allowlist only
- host <all_urls>: required for general-purpose blocking on websites

No remote code execution. No analytics. Privacy policy: <PASTE_YOUR_HTTPS_URL>

To verify:
1. Load the packaged zip / published build
2. Visit a page with ads (e.g. news site) — network ads should be reduced
3. Open popup → Options → enable/disable a list and confirm behavior
4. Allowlist a site from the popup and confirm blocking stops on that host
```

## Common rejection causes (avoid)

- Privacy policy missing, not HTTPS, or not matching actual behavior  
- Remote code / eval of downloaded scripts (we don’t)  
- Vague single purpose or unrelated features  
- Screenshots that don’t show the extension UI  
- Requesting unused permissions (`tabs`, feedback APIs, etc.)

## Hosting the privacy policy (required)

The Store needs a **public HTTPS** privacy URL (not only the in-extension `privacy.html`).

Options:

1. **GitHub Pages** on this repo: enable Pages → deploy `/docs` → use  
   `https://andreasne89.github.io/quell/privacy-policy.html`
2. Any static host: upload `docs/privacy-policy.html` and paste the URL in the dashboard.

Until that URL is live, submission will fail the privacy step.

## DNR rule budget note

Default-enabled static rules can exceed Chrome’s **guaranteed** 30 000-rule floor; Chrome may allocate from the shared global pool. If enabling a list fails on a crowded profile, users can disable lists in Options. This matches other MV3 blockers and is expected — mention it only if review asks.
