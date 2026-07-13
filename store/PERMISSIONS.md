# Permission justifications (Chrome Web Store)

Paste into the dashboard when asked why each permission is needed. Keep answers factual and tied to the single purpose: **blocking ads and trackers**.

## declarativeNetRequest

Required to apply Declarative Net Request rulesets that block or redirect ad and tracker network requests. This is the primary Manifest V3 mechanism for an ad blocker.

## scripting

Required to inject cosmetic CSS and approved scriptlets into pages so leftover ad UI and common tracking scripts can be neutralized after the network layer.

## storage

Required to persist user settings (enabled filter lists, preferences) and the per-site allowlist locally on the device. Data is not uploaded to Quell servers.

## webNavigation

Required to detect navigations so cosmetic filters and scriptlets can be applied consistently when users move between pages and frames.

## Host permission: &lt;all_urls&gt;

Required for a general-purpose ad and tracker blocker that works across websites the user visits. Without broad host access, Quell cannot apply blocking and cosmetics on arbitrary sites.

## Not requested (intentionally)

| Permission | Why omitted |
|------------|-------------|
| `tabs` | Not needed; host access covers URL context for our use cases. |
| `declarativeNetRequestFeedback` | Dev-only (`npm run build -- --dev-feedback`). Store builds omit it so we do not request unused capabilities. |
| `webRequest` / `webRequestBlocking` | MV2-era; not used. |
| `cookies` / `history` / `identity` | Not used. |
