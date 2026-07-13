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
        ├─► src/generated/scriptlets.json
        ├─► src/generated/generic-cosmetic.css
        └─► src/generated/meta.json
        │
        ▼
scripts/build.mjs (esbuild + copy)
        │
        └─► dist/   ← load unpacked
```

## Runtime pieces

### Service worker (`src/background/service-worker.ts`)

Ephemeral process. Durable state in `chrome.storage.local` (`stampstack.settings`).

On wake / settings change it:

1. `updateEnabledRulesets` for each list in `meta.json`
2. Rebuilds dynamic allowlist (`allowAllRequests`, ids ≥ `ALLOWLIST_ID_START`)
3. Registers generic cosmetic CSS via `chrome.scripting` (excludes allowlisted hosts)
4. Handles `Message` RPC from content / popup / options

### Network blocking

Chrome evaluates static DNR rulesets. StampStack does **not** reimplement a full network filter engine at runtime. Unsupported EasyList features are skipped at compile time (see coverage report from `compile-filters`).

### Cosmetics

| Kind | Mechanism |
|------|-----------|
| Generic hide | `generated/generic-cosmetic.css` registered as content CSS |
| Specific hide / unhide | Content script injects `<style data-StampStack>` |
| Procedural | `src/engine/procedural.ts` + MutationObserver |

### Scriptlets

`scriptlets.js` runs in the **MAIN** world at `document_start`. Only domain-scoped scriptlet rules from the compiler are applied.

### UI

- Popup: pause, per-site allowlist, tab/total blocked (best-effort)
- Options: enable/disable lists by group

## Message protocol

All cross-context messages live in `src/shared/types.ts` as a discriminated union (`Message`). Add a variant there first, then implement SW handler + caller.

## DNR priorities & IDs

See `scripts/lib/limits.mjs` and `src/shared/constants.ts`.

- Compile-time priorities: block 1000 → redirect 1500 → allow 2000 → important 3000/4000
- Runtime allowlist priority: `1_000_000`
- Dynamic id ranges: allowlist `1_000_000+`, custom reserved `2_000_000+`

## Filter lists

Registry: `filters/lists.json`. Built-in `quell-seed.txt` ships in-repo so blocking works offline before `update-lists`.
