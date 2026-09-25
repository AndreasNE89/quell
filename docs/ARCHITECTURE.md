# StampStack architecture

## Pipeline

```
filters/lists.json + filters/*.txt
        │
        ▼
scripts/compile-filters.mjs
        │
        ├─► src/generated/rulesets/<id>.json   (DNR static rules)
        ├─► src/generated/cosmetic.json
        ├─► src/generated/scriptlets.json          (all scriptlet rules; tests and tooling)
        ├─► src/generated/scriptlets/*.js          (the same rules as MAIN-world files, by host)
        ├─► src/generated/scriptlet-shards.json    (host index the SW registers them from)
        ├─► src/generated/generic-cosmetic/<id>.css, <id>.x-<other>.css   (+ a .revert.css twin each)
        ├─► src/generated/trackers.json            (page-report naming index)
        └─► src/generated/meta.json
        │
        ▼
scripts/build.mjs (esbuild + copy)
        │
        ├─► dist/generated/cosmetic/core.json, list.<id>.json   (cosmetic.json split for the SW)
        └─► dist/   ← load unpacked
```

## Runtime pieces

### Service worker (`src/background/service-worker.ts`)

Ephemeral process. Durable state in `chrome.storage.local` (`stampstack.settings`).

On wake / settings change it:

1. `updateEnabledRulesets` for each list in `meta.json`
2. Rebuilds dynamic allowlist (`allowAllRequests`, ids ≥ `ALLOWLIST_ID_START`)
3. Registers generic cosmetic CSS, the YouTube MAIN hooks and the list scriptlets via `chrome.scripting` (excludes allowlisted hosts and page-scoped `$generichide` paths; YouTube top frames and embeds are separate registrations; see [Scriptlets](#scriptlets))
4. Handles `Message` RPC from content / popup / options

The allowlist and breakage fixes belong to the tab's top-level page, as in uBO: subframe requests for cosmetics, scriptlets and YouTube options are decided by `sender.tab.url` (`policyHost`), while rules still match the frame's own host. Registered `excludeMatches` are tested against each frame's own URL, so the generic sheet cannot follow the top page by itself. `handleCosmetic` corrects it per frame: a frame on a switched-off page gets the sheet's revert files where the sheet reached it (not on hosts or pages the lists keep out of generic hiding), and a frame from a switched-off host on a page that is on gets the sheet. The scriptlet runtime acts only where the frame's host is the top page's.

Cosmetic data is not part of `background.js`. The build splits `cosmetic.json` into `generated/cosmetic/core.json` (exceptions and the generic-sheet plan) and one `list.<id>.json` per list; a wake reads the core only (enough to register the generic sheet), and the first `cosmetic:get` reads the enabled lists' files. Each file is fetched once per worker lifetime.

Trust boundaries:

- A content script runs in a web page's renderer, so it may only send `cosmetic:get`, `scriptlets:get`, `youtube:getOptions`, `sponsorblock:getSegments`, `darkmode:get` (answered with the decision only) and `customfilters:add` (a hide rule for the sender's own site). Every other message is answered only for the extension's own pages (popup, Options).
- `chrome.storage.local` is set to `TRUSTED_CONTEXTS` on every wake, so content scripts cannot read or write settings directly (Chromium 151; older versions lack the call on `local`). YouTube pages learn about changes through `youtube:refresh`.
- Settings are one set for normal and Incognito windows, as in uBO: a switch set in an Incognito window applies everywhere. The popup says so in Incognito.

### Network blocking

Chrome evaluates static DNR rulesets. StampStack does **not** reimplement a full network filter engine at runtime. Unsupported EasyList features are skipped at compile time (see coverage report from `compile-filters`).

### Cosmetics

| Kind | Mechanism |
|------|-----------|
| Generic hide | Per-list sheets under `generated/generic-cosmetic/` registered as content CSS (author origin, first paint), plus the same files inserted at USER origin into top-level documents, so a page `!important` cannot unhide them (as in uBO). Sheets of selectors another list excepts (`<id>.x-<other>.css`) are registered only while that list is off. |
| Generic exceptions | An exception for a host a match pattern can name excludes the registration. An entity exception (`www.google.*` search pages) gets the registered sheets' `.revert.css` twins by `insertCSS`. A `#@#` for one site is a `display: revert` rule in the content script's sheet, for selectors the registered sheet really hides. No USER-origin copy goes where something must be reverted or restyled. The SW remembers per document what it inserted, and forgets it when it sleeps; a document that asks again (`refetch`: a refresh, or a copy of the content script injected after an update) first has every file that origin could hold removed, so nothing stays behind and nothing is doubled (Chrome removes one copy per `removeCSS`). |
| Specific hide | Content script injects `<style data-StampStack>`, validated and chunked (256 selectors a rule) |
| Procedural | `src/engine/procedural.ts` + `src/content/procedural-runner.ts` (marker attributes, MutationObserver) |
| Actions (`:style()`, `:remove-attr()`, `:remove-class()`) | Compiled to `actions`, carried out by the procedural runner; never turned into hides |

The content script keeps one live copy per frame. After an update the worker runs `content.js` again in open tabs; the new copy announces itself with a DOM event, and a copy whose extension context is gone (`chrome.runtime.id` undefined) takes its sheets, marks, observers and timers down.

### Scriptlets

List scriptlets (`##+js(...)`) only work if they run before the page's own scripts, so they are registered content scripts, the uBO Lite approach. Only domain-scoped rules ship; the compiler drops global ones.

1. **Build.** `compile-filters` (`scripts/lib/scriptlet-shards.mjs`) writes each list's rules as MAIN-world data files under `generated/scriptlets/`, keyed by host. Hosts go to one of 16 buckets by site (the smallest suffix that is not a public suffix), so everything a page can match sits in one bucket file per list. Entity keys (`example.*`) and public-suffix keys, which no match pattern can name, go to one broad file per list. File names carry a content hash.
2. **Registration.** The SW registers one script per bucket (`quell-sl-<n>`) plus `quell-sl-broad`: `world: 'MAIN'`, `runAt: 'document_start'`, `allFrames`, `matchOriginAsFallback` (so a page's about:blank / srcdoc frames get them), persisted across sessions. `js` is the enabled lists' files for that bucket, then the runtime. With the default lists on, `js` is instead one bundle holding exactly those files, joined by `scripts/build.mjs` (`bundle.<n>.<hash>.js`, named after its parts): these registrations also reach sandboxed about:blank frames, and in one without `allow-scripts` Chrome logs "Blocked script execution in 'about:blank'…" once per file it may not run. `chrome.scripting` cannot leave sandboxed frames out, so one file per registration is the floor: a page matched by a bucket and the broad script (YouTube) gets 2 such lines per script-less sandboxed frame, a page matched only by the broad script 1. They are harmless. Any other set of lists registers the parts. `matches` is one `*://*.host/*` per host (`*://*/*` for the broad script, whose file checks the host before parsing anything). `excludeMatches` carries the allowlist and `injection` site fixes; Pause unregisters them. Registrations are compared by file name, and what the last sync wrote is kept in `storage.session`, so a wake where nothing changed neither writes nor reads the ~22k patterns back (the first wake after a browser start or an update asks Chrome once).
3. **Runtime.** `src/content/scriptlets-runtime.ts` takes the data the files handed over, picks the host's rules exactly as `matchScriptlets` does (suffixes, entities, `~domain` exclusions, `#@#+js` exceptions from any enabled list, each name+args once) and runs them. The hand-off property is deleted before any page script runs, and nothing else is left on `window`. The broad script ends with a copy, `scriptlets-runtime-broad.js`: Chrome injects a given file only once per document, so a shared runtime would never run after the second registration's data on a page that both match.
4. **Frames the registrations cannot serve.** `excludeMatches` sees the frame's own URL, while the switches belong to the top page, so the runtime acts only in the top frame and in frames on the top page's host (`src/shared/frame-scope.ts`). In every other frame the content script sends `scriptlets:get`; the SW decides against the top page (`policyHost`) and, if the host has rules, injects the same data files, a fallback marker and the runtime with one `executeScript` targeted at `documentIds: [sender.documentId]`. It also fills in for a registered frame whose registration is missing, leaving out the data files a live registration (or its bundle) already ran. This path runs after the frame's first scripts.

Measured in Chromium 131 with `worldfreeware.com##+js(aopr, require)`: the first inline `<head>` script is aborted in 3 of 3 loads, also with a cold SW and 50 iframes (before: the rule landed 25–38 ms after navigation start, after `load`, and 300–350 ms with the cold SW and iframes). The cost: in the store build the first script of a page with no rules starts about 1.5 ms later, nearly all of it Chrome testing the ~22k registration patterns against each frame's URL (the time grows with the pattern count, not the number of registrations).

### UI

- Popup: pause, per-site allowlist, tab/total blocked (best-effort)
- Options: enable/disable lists by group

## Message protocol

All cross-context messages live in `src/shared/types.ts` as a discriminated union (`Message`). Add a variant there first, then implement SW handler + caller.

## DNR priorities & IDs

See `scripts/lib/limits.mjs` and `src/shared/constants.ts`.

- Compile-time priorities: removeparam 500 → removeparam exception 600 → block 1000 → redirect 1500 (±499 for uBO `:N`) → allow 2000 → important 3000/3500/4000
- Runtime allowlist priority: `1_000_000`
- Dynamic id ranges: allowlist `1_000_000+`, custom reserved `2_000_000+`

## Filter lists

Registry: `filters/lists.json`. Built-in `quell-seed.txt` ships in-repo so blocking works offline before `update-lists`.
