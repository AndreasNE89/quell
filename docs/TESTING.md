# Testing Quell

## Automated

```bash
npm run typecheck
npm test                 # node --test — add `*.test.ts` / `*.test.mjs` beside pure logic
```

Good unit-test targets:

- `scripts/lib/parse-filter.mjs` / `to-dnr.mjs` (via small `.test.mjs` files)
- `src/shared/hostname.ts`
- `src/engine/cosmetic-match.ts`, `procedural.ts`

## Manual (extension)

1. `npm run build`
2. Load/reload `dist/` at `chrome://extensions`
3. Open a page with known ads; confirm network blocks in DevTools (or badge when feedback API fires)
4. Toggle pause / site allowlist in the popup; confirm cosmetics stop/start
5. Options page: disable a list → reload tab → coverage should drop

## After risky changes

| Change | Check |
|--------|--------|
| Filter parser / DNR emit | `npm run compile-filters` + skim skip reasons |
| Service worker / settings | Reload extension; pause + allowlist round-trip |
| Content / cosmetics | Hard-refresh tab; inspect `style[data-quell]` |
| Manifest / build | Confirm `dist/manifest.json` has `rule_resources` |
