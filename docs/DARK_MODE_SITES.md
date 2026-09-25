# Dark mode site triage

Known-good and known-bad list for the paid dark engine. Prefer incremental fixes over architecture rewrites. Per-page toggle and “reset to global” must stay rock-solid.

The engine does not invert pages. It reads each element's own colors and remaps them: light surfaces become charcoal, dark text becomes off-white, hues are kept (`src/content/dark-mode-dynamic.ts`, color math in `src/shared/dark-mode-dynamic.ts`). Photos, video, canvas and iframe content are never touched. The one exception is an image drawn in flat dark ink on a transparent background (a formula, a monochrome SVG logo), which is inverted so it stays visible.

Breakage from CWS reviews → triage with [`SUPPORT_TRIAGE.md`](./SUPPORT_TRIAGE.md), then log hostname + symptom here.

## Checked on 2026-09-25

Automated check, not a manual pass: headless Chromium 131, engine injected into every frame (without the extension, so the paid gate and the service worker are not exercised), 6 s after load, whole DOM scanned. "Clean" means no visible light surface over 20,000 px² and no text under 3:1 contrast against its backdrop.

| Site | Result |
|------|--------|
| Wikipedia (Pythagorean theorem) | Clean. All 99 math formulas inverted to light ink; photos untouched. Images Wikipedia gives a white backing (`.mw-file-element`) keep it. Before this release every formula was black on charcoal. |
| helsenorge.no | Clean. The cookie dialog lives in a shadow root and used to stay white. |
| MDN (CSS reference page) | Clean. 84 light elements inside shadow roots were left white before. |
| GitHub repo page, light OS theme | Clean. |
| GitHub repo page, dark OS theme | Site's own `#0d1117` canvas kept (the registered sheet used to replace it with `#1c1c1e`); green and blue buttons keep their color. |
| vg.no, Hacker News, weather.com, MkDocs Material | Clean. |
| CNN front page | Clean apart from grey placeholder boxes on images still loading. Image backgrounds are never recolored. |

## Behavior worth knowing

| Situation | Behavior |
|-----------|----------|
| Site already ships a dark theme | Its canvas and surfaces are kept, and so are accent colors (buttons, badges, a white call-to-action). Only large light panels (over 40,000 px²) are darkened, with everything inside them. Nothing is persisted, so use **off on this page** if it still looks wrong. |
| Site switches theme while open (OS light/dark, `html[dark]`, `data-theme`, Mantine, MkDocs, MUI, a stylesheet swap) | The engine re-reads the page. A second switch within 250 ms is applied up to 250 ms late. |
| Hover and focus colors | They are re-read when the pointer or focus moves, including colors reached through a CSS transition. |
| Transparent iframes (chat widgets, payment fields, social buttons) | They stay transparent once the frame's own engine has started. Before that, which is usually a fraction of a second, Chromium can show a light box. |
| Rich-text editors (Gmail compose, blog, forum and wiki editors, TinyMCE, CKEditor) | Nothing is written inside them: editors save their markup, inline styles included, so a color written there went out with the post or the email. They keep the site's own colors and show as a light box on the dark page; an editor on a surface the site made dark itself is left as it is. A page or frame that is itself the editor (`designMode`, an editable `<body>`) is left entirely alone. |
| Turning dark mode off | Each element gets back its exact original `style` attribute, including `var()` shorthands, plus any change the site made to it meanwhile. |
| Chrome Web Store / Web Store pages | Restricted. Chrome blocks page modification. |
| PDF / non-HTML viewers | Out of scope. |

## Known limitations

- Transparent PNG/GIF images drawn in dark ink stay dark unless the site marks them for inversion (MediaWiki's `skin-invert` classes and math images are recognized). Only SVG images are judged by their pixels, because a transparent product photo of a black object would look like ink. Cross-origin SVGs (logos on a CDN) cannot be read and are left as they are.
- `-webkit-text-fill-color` is lifted only when it differs from `color`. A site that sets both to the same dark value keeps dark text.
- Not observed: rules added through the CSSOM (`insertRule`, `adoptedStyleSheets`), `<link>` stylesheets inside shadow roots, `:active`/`:checked`/`:visited` states, and border colors that change through a transition.
- `::before`/`::after` inside shadow roots are not remapped.
- A closed shadow root is reached only on custom elements. A custom element that attaches its shadow root after it is defined is not seen until the pointer passes over it.
- An editor that copies its starting text from the page as it opens (CKEditor 5 created from an element does) copies the colors the engine already wrote there, and saves them. Use **off on this page** there. Editors inside shadow roots get no light box.
- about:blank and srcdoc frames are darkened only once `content.ts` starts dark mode in them.

## Regression checklist (manual — each dark-mode / even release)

1. Enable dark globally → open a Wikipedia article with formulas → text and formulas readable.
2. Toggle **off on this page** → page restores light without reload loop, including inline-styled blocks.
3. **Reset to global default** → follows global again.
4. Open a site that already ships a dark theme (GitHub with a dark OS theme) → its own canvas and button colors stay.
5. Switch the OS between light and dark with a tab open → the page stays readable.
6. Hover a dropdown menu on a light site → the hovered item is dark with light text.
7. A page with a transparent embed (chat launcher, comment widget) → no white box around it.
8. **Pause** StampStack ad blocking → dark mode still applies.
9. **Allowlist** the current site for ads → dark mode still applies.
10. Unpaid popup: Buy + Restore visible; hint mentions receipt email; **Dev unlock** absent in store builds.
11. After Dev unlock (unpacked only): global toggle works; Buy/Restore upsell hidden.
12. Edit a Wikipedia page with VisualEditor and open a TinyMCE demo → both editors are readable light boxes, and the editor's markup carries no `!important` colors.

## Funnel notes (conversion)

- Copy must stay “ad blocker first; $2 dark add-on.”
- Restore must stay visible whenever ExtPay is configured (reinstall path).
- Do not gate dark mode on pause/allowlist.

## Break log

| Date | Host | Symptom | Fix |
|------|------|---------|-----|
| 2026-09-24 | wikipedia.org | Math formulas black on charcoal | Dark-ink images inverted (M4) |
| 2026-09-24 | helsenorge.no | White panels inside web components | Shadow roots walked and observed (B70) |
| 2026-09-24 | github.com (dark theme) | Canvas replaced, accent buttons muddied | Natively dark pages keep canvas and accents |
| 2026-09-25 | Rich-text editors (TinyMCE, CKEditor, Gmail compose, VisualEditor) | Dark colors saved with the text; editor frames white text on white | Nothing written inside editors; shown as a light box |

Log new breaks with hostname + symptom; fix with the smallest CSS/detection tweak.
