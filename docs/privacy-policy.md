# StampStack Privacy Policy

**Effective date:** July 13, 2026  
**Last updated:** July 24, 2026

**Host this HTML for the Chrome Web Store:** publish [`privacy-policy.html`](./privacy-policy.html) at a stable HTTPS URL (GitHub Pages, your site, etc.) and paste that URL into the Store’s Privacy practices form.

## Short version

StampStack does **not** collect, sell, or transmit your browsing history. Filtering runs on your device. Settings stay in your browser’s local storage. An optional one-time purchase for dark mode is processed by ExtensionPay (Stripe); we do not receive your browsing history as part of payment.

## Who we are

StampStack is a browser extension that blocks ads and trackers using Declarative Net Request (Manifest V3) and local cosmetic/scriptlet filters. An optional paid add-on can darken ordinary web pages.

## Data we collect

**We do not collect personal data on StampStack servers.** StampStack does not operate analytics, crash reporting, advertising identifiers, or remote logging of browsing activity.

| Category | Practice |
|----------|----------|
| Browsing activity | Not sent to us. Blocking uses Chrome’s DNR engine and packaged (or user-updated) rules. |
| Settings & allowlist | Stored locally via `chrome.storage`. Not uploaded. |
| Statistics | On-device only when available. Not synced to a StampStack server. |
| Optional purchase | If you buy dark mode, ExtensionPay / Stripe process payment and may collect an email for receipt and restore. StampStack caches a local paid flag; **browsing history and allowlist are not sent** to the payment provider. |
| Optional SponsorBlock | If you enable **Auto-skip sponsor segments**, StampStack requests segment schedules from the community SponsorBlock API (`sponsor.ajay.app`) using the YouTube **video id** only. Turn the toggle off to stop those requests. |

## Permissions

| Permission | Why |
|------------|-----|
| `declarativeNetRequest` | Apply filter rules on the network path. |
| `scripting` | Inject cosmetic filters, approved scriptlets, and optional dark-mode CSS. |
| `storage` | Save preferences, site allowlist, and license cache. |
| `webNavigation` | Apply filters consistently across navigations. |
| Host access `<all_urls>` | Required for a general-purpose ad/tracker blocker (and optional page darkening). |

## Third parties

Filter lists may be downloaded from their publishers when you update lists. StampStack does not send browsing history to list publishers as part of filtering.

**Optional payments:** Dark mode unlock uses [ExtensionPay](https://extensionpay.com) (Stripe under the hood). Contacting ExtensionPay happens only when you open checkout, restore a purchase, or the extension refreshes license status. We do not sell or share browsing data.

**Optional SponsorBlock:** When enabled, segment lookups go to the [SponsorBlock](https://sponsor.ajay.app) community service (video id only). This is off unless you turn on the YouTube skip toggle.

## Contact

Email: andreas.nelvik.engebretsen@gmail.com  
Or contact the publisher via the Chrome Web Store listing for StampStack.
