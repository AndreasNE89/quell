# Chrome Web Store — StampStack release checklist

Use this when uploading StampStack to the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole).

## Done in-repo (no dashboard login)

| Item | Status / path |
|------|----------------|
| Version `1.1.0` | `package.json` + `src/manifest.json` (synced on build) |
| Store zip | `npm run package` → `release/stampstack-1.1.0.zip` |
| Store build flags | No `declarativeNetRequestFeedback`, no `tabs` |
| Listing copy | [store/LISTING.md](../store/LISTING.md) |
| Permission justifications | [store/PERMISSIONS.md](../store/PERMISSIONS.md) |
| Privacy policy source | [docs/privacy-policy.html](./privacy-policy.html) (+ `.md`) |
| In-extension privacy page | Bundled as `privacy.html` in the zip |
| Small promo tile 440×280 | `npm run store-assets` → `store/promo-small.png` |
| Reviewer notes template | Below |

## Before you package (local)

1. Bump `version` in `package.json` when releasing a new version (manifest is synced on build).
2. Confirm filter lists are current: `npm run update-lists` (or let `npm run package` do it).
3. Run tests: `npm test` and `npm run typecheck`.
4. Build store zip: `npm run package` → `release/stampstack-<version>.zip`.

## Package validation (automatic in `npm run package`)

- MV3 manifest
- At least one DNR ruleset
- Icons including 128×128
- `privacy.html` bundled
- **Fails** if `declarativeNetRequestFeedback` or `tabs` is present

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

- [ ] **Upload package:** `release/stampstack-1.1.0.zip` (Package tab)
- [ ] **Item name:** StampStack
- [ ] **Summary:** from [store/LISTING.md](../store/LISTING.md) (≤132 chars)
- [ ] **Description:** from LISTING.md
- [ ] **Category:** Productivity (or Tools)
- [ ] **Language:** English
- [ ] **Official URL / Homepage:** leave blank until a public homepage exists (do **not** paste a private GitHub URL)
- [ ] **Support URL:** leave blank until a public support channel exists (do **not** paste a private GitHub issues URL)

### Store assets (upload in dashboard)

- [ ] **Icon** 128×128 — from the zip (`icons/icon-128.png`) or `src/icons/icon-128.png`
- [ ] **Small promo** 440×280 — `store/promo-small.png`
- [ ] **Screenshots** (≥1 required; 2–3 recommended) — capture popup + Options yourself; sizes **1280×800** or **640×400**; save under `store/screenshots/` locally if you want. Guidance in LISTING.md

### Privacy practices form

- [ ] Single purpose (short purpose only — do **not** paste host-permission text):  
  `Block ads and trackers using Declarative Net Request, cosmetic filters, and scriptlets.`
- [ ] Declare you **do not** collect user data (no remote analytics)
- [ ] Remote code: **No** (extension does not load remote code)
- [ ] Paste permission justifications from [store/PERMISSIONS.md](../store/PERMISSIONS.md) — each field once, matching that permission
- [ ] Certify limited-use / privacy compliance checkboxes

### Reviewer notes

- [ ] Paste the template below; replace `<PASTE_YOUR_HTTPS_URL>` with your live privacy URL
- [ ] Submit for review and watch the developer email for questions / rejection

### After publish

- [ ] Save the item ID and public listing URL
- [ ] Tag the git release: `git tag v1.1.0 && git push origin v1.1.0` (when you choose to push)
- [ ] Update README with the Chrome Web Store badge/link
- [ ] Respond to any review follow-ups within the deadline

---

## Review notes (paste into “Notes for reviewer”)

```
StampStack is a Manifest V3 ad/tracker blocker.

Single purpose: Block ads and trackers using Declarative Net Request, cosmetic filters, and scriptlets.

Permissions:
- declarativeNetRequest: apply packaged EasyList-style rulesets
- scripting: inject cosmetic CSS and allowlisted scriptlets
- storage: local settings and site allowlist only
- webNavigation: apply filters on navigations
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
