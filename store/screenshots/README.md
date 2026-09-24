# Store screenshots

Five 1280×800 screenshots for the Chrome Web Store listing, saved as 24-bit PNG with no alpha.
Upload them in this order.

| # | File | Headline | What the UI shows |
|---|------|----------|-------------------|
| 1 | `01-blocks-ads-names-trackers.png` | Blocks ads. Names the trackers. | A fictional news.example page with its ad slots hidden by the shipped EasyList rules, and the popup's collapsed "On this page" sentence for that tab. A small tilted stamp shows the same page captured without StampStack, ads and all |
| 2 | `02-site-broken-keep-blocking.png` | Site broken? Fix it, keep blocking. | The popup's repair panel after step one on shop.example, beside a stack of three stamps: Element hiding, Script patches (both "blocking stays on") and Blocking ("last resort") |
| 3 | `03-hide-anything.png` | Hide anything with a click. | The element picker, injected by the service worker, outlining a sign-up bar on recipes.example, with its hint bar at the bottom |
| 4 | `04-skip-sponsor-segments.png` | Skip sponsor segments. | The popup's YouTube group, the "Skipped sponsor · Undo" notice over a plain grey player, and Settings → Which segments to skip (sponsors only, the default) |
| 5 | `05-no-account-no-telemetry.png` | No account. No telemetry. | The Settings header and the filter lists that are on by default, with their rule counts and the list-age line |

Headlines and sublines live in `scripts/store-shots/shots.mjs`, and they follow the plan in
`store/LISTING.md` ("Screenshots").

## Regenerate

```bash
npm run build:store        # a store build: no Dev unlock, no dev-only counters
npm run store-screenshots  # writes the five PNGs here
npm run bundle             # afterwards, put a dev build back in dist/
```

The script refuses to run against a dev build. It needs Playwright's Chromium, which is already
a dev dependency (`npx playwright install chromium` if it is missing). The frame text is set in
Lato (SIL OFL 1.1), which is not in the repo. The script looks in the usual font folders; if
Lato is somewhere else, set `STAMPSTACK_LATO_DIR` to that folder. Without Lato the text falls
back to the system sans and the script prints a warning.

## How the shots are made

`scripts/capture-store-screenshots.mjs` works in two passes.

1. **Real UI.** It loads `dist/` into Playwright's Chromium (headless, with a temporary profile)
   and opens the fixture pages in `scripts/store-shots/`. Everything that looks like product UI
   is captured from the running extension at 2x:
   - The ad slots on news.example are hidden by the shipped lists. The script checks that each
     one is really `display: none` and stops if any are still showing. For shot 1's before
     picture it loads the same page in a second browser without the extension, and checks
     that there every slot is showing.
   - The popup reports on the fixture tab that is in front. Its tracker sentence comes from the
     page's own third-party tags, and one of them (parse.ly) is a tracker StampStack has no rule
     for, which is why it reads "7 known trackers … rules for 6".
   - The repair state is set with the same message the popup's button sends. The picker is
     started the way the "Hide an element" button starts it.
   - The skip notice is drawn by the shipped content script. The one SponsorBlock lookup is
     answered locally with a single sponsor segment.
   - Settings is shown with its clock pinned to two days after the lists were stamped, so the
     list-age line reads the same on every run.
2. **Frame.** A plain browser lays those captures out on the paper frame
   (`scripts/store-shots/frame.css`) and screenshots it at exactly 1280×800. The script checks
   each PNG's header: 8-bit RGB, colour type 2, no alpha.

Nothing leaves the machine. The fixture hostnames resolve to a local server, and every other
host resolves to nothing.

Some things in the frame are not product UI: the browser window around a page, the labelled
"without StampStack" stamp in shot 1, the mouse pointer in shot 3, the small captions in shots
2 and 4, and the stamp diagram in shot 2. Where
a capture is cut short of the real panel's edge, that edge is drawn perforated, like a stamp
torn from its sheet, rather than as a finished corner.

## Rules for these images

- Only fictional `*.example` sites, with no real brands, logos or people. The player in shot 4
  is plain grey, with no YouTube UI or logo. It is served under a YouTube hostname only because
  sponsor skipping runs nowhere else, and that hostname never appears in the shot.
- Only UI the product really shows. The tracker report stays in its collapsed sentence, so there
  are no made-up rows.
- No Dev unlock, no dev-only stat cards, and no dark-mode upsell in frame.
- Refresh the shots when the popup or Settings changes, so the listing matches what ships.
