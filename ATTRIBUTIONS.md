# Attributions

StampStack compiles third-party filter lists into its packaged rulesets at build time. Those
lists are the work of their respective projects and remain under their own licenses. StampStack
does not modify their intent — it translates the rules into Chrome's Declarative Net Request
format, dropping any rule the format cannot express.

This file and [`docs/attributions.html`](./docs/attributions.html), which ships inside the
extension, say the same thing; `test/attributions.test.mjs` checks that they do.

## Filter lists

| List | Project | License |
|------|---------|---------|
| EasyList | [easylist.to](https://easylist.to) | [GPLv3](https://www.gnu.org/licenses/gpl-3.0.html) / [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/) |
| EasyPrivacy | [easylist.to](https://easylist.to) | [GPLv3](https://www.gnu.org/licenses/gpl-3.0.html) / [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/) |
| EasyList Cookie List | [easylist.to](https://easylist.to) | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) |
| EasyList China | [easylist/easylistchina](https://github.com/easylist/easylistchina) | [GPLv3](https://www.gnu.org/licenses/gpl-3.0.html) / [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/) |
| CJX's Annoyance List | [cjx82630/cjxlist](https://github.com/cjx82630/cjxlist) | [LGPLv3](https://www.gnu.org/licenses/lgpl-3.0.html) |
| uBlock Origin filters (Ads) | [uBlock Origin](https://github.com/uBlockOrigin/uAssets) | [GPLv3](https://www.gnu.org/licenses/gpl-3.0.html) |
| uBlock Origin Badware risks | [uBlock Origin](https://github.com/uBlockOrigin/uAssets) | [GPLv3](https://www.gnu.org/licenses/gpl-3.0.html) |
| uBlock Origin Unbreak | [uBlock Origin](https://github.com/uBlockOrigin/uAssets) | [GPLv3](https://www.gnu.org/licenses/gpl-3.0.html) |

The exact source URL for each list is recorded in [`filters/lists.json`](./filters/lists.json).

## Bundled software

These packages are compiled, unmodified, into the extension's scripts (`background.js` and
`extpay-bridge.js`).

| Package | Version | License | Source |
|---------|---------|---------|--------|
| ExtPay (ExtensionPay) | 3.1.2 | Stated two ways by the package: AGPL-3.0-or-later in its package.json and source header, LGPL-3.0 in its LICENSE file | [npm](https://registry.npmjs.org/extpay/-/extpay-3.1.2.tgz) · [GitHub](https://github.com/Glench/ExtPay) |
| webextension-polyfill | 0.7.0 | MPL-2.0 | [npm](https://registry.npmjs.org/webextension-polyfill/-/webextension-polyfill-0.7.0.tgz) · [GitHub](https://github.com/mozilla/webextension-polyfill) |

## License texts

[`docs/licenses/`](./docs/licenses/) holds the notices and the license texts that must travel
with a copy: [`THIRD_PARTY_NOTICES.txt`](./docs/licenses/THIRD_PARTY_NOTICES.txt),
[GPL-3.0](./docs/licenses/GPL-3.0.txt), [LGPL-3.0](./docs/licenses/LGPL-3.0.txt) and
[MPL-2.0](./docs/licenses/MPL-2.0.txt). `scripts/build.mjs` copies the folder into the package as
`licenses/`, next to `attributions.html`. The Creative Commons licenses allow a link in place of
the text.

## Scriptlets and redirect resources

StampStack's scriptlet library and redirect stubs are original implementations written against
the behavior documented by [uBlock Origin](https://github.com/gorhill/uBlock/wiki/Resources-Library);
no uBO source is copied into this extension.

## Sponsor segment data

Sponsor segment data is provided by the [SponsorBlock](https://sponsor.ajay.app) community
project and is licensed [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/).
StampStack queries it only with a 4-character hash prefix of the video id; see the
[privacy policy](./docs/privacy-policy.md).

## Payments

The optional one-time dark-mode purchase is processed by
[ExtensionPay](https://extensionpay.com) (Stripe).
