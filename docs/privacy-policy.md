# StampStack Privacy Policy

**Effective date:** July 13, 2026  
**Last updated:** July 13, 2026

**Host this HTML for the Chrome Web Store:** publish [`privacy-policy.html`](./privacy-policy.html) at a stable HTTPS URL (GitHub Pages, your site, etc.) and paste that URL into the Store’s Privacy practices form.

## Short version

StampStack does **not** collect, sell, or transmit your browsing history. Filtering runs on your device. Settings stay in your browser’s local storage.

## Who we are

StampStack is a browser extension that blocks ads and trackers using Declarative Net Request (Manifest V3) and local cosmetic/scriptlet filters.

## Data we collect

**We do not collect personal data.** StampStack does not operate analytics, crash reporting, advertising identifiers, or remote logging.

| Category | Practice |
|----------|----------|
| Browsing activity | Not sent to us. Blocking uses Chrome’s DNR engine and packaged (or user-updated) rules. |
| Settings & allowlist | Stored locally via `chrome.storage`. Not uploaded. |
| Statistics | On-device only when available. Not synced to a StampStack server. |

## Permissions

| Permission | Why |
|------------|-----|
| `declarativeNetRequest` | Apply filter rules on the network path. |
| `scripting` | Inject cosmetic filters and approved scriptlets. |
| `storage` | Save preferences and site allowlist. |
| `webNavigation` | Apply filters consistently across navigations. |
| Host access `<all_urls>` | Required for a general-purpose ad/tracker blocker. |

## Third parties

Filter lists may be downloaded from their publishers when you update lists. StampStack does not send browsing history to list publishers as part of filtering. We do not sell or share user data.

## Contact

Email: andreas.nelvik.engebretsen@gmail.com  
Or contact the publisher via the Chrome Web Store listing for StampStack.
