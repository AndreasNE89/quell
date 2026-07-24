# Attributions

StampStack compiles third-party filter lists into its packaged rulesets at build time. Those
lists are the work of their respective projects and remain under their own licenses. StampStack
does not modify their intent — it translates the rules into Chrome's Declarative Net Request
format, dropping any rule the format cannot express.

## Filter lists

| List | Project | License |
|------|---------|---------|
| EasyList | [easylist.to](https://easylist.to) | [GPLv3](https://www.gnu.org/licenses/gpl-3.0.html) / [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/) |
| EasyPrivacy | [easylist.to](https://easylist.to) | [GPLv3](https://www.gnu.org/licenses/gpl-3.0.html) / [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/) |
| EasyList Cookie List | [easylist.to](https://easylist.to) | [GPLv3](https://www.gnu.org/licenses/gpl-3.0.html) / [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/) |
| uBlock Origin filters (Ads/Privacy) | [uBlock Origin](https://github.com/uBlockOrigin/uAssets) | [GPLv3](https://www.gnu.org/licenses/gpl-3.0.html) |
| uBlock Origin Badware risks | [uBlock Origin](https://github.com/uBlockOrigin/uAssets) | [GPLv3](https://www.gnu.org/licenses/gpl-3.0.html) |

The exact source URL for each list is recorded in [`filters/lists.json`](./filters/lists.json).

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
