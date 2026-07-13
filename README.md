# Quell

Manifest V3 ad & tracker blocker for Chromium browsers. Compiles EasyList-style filter lists into `declarativeNetRequest` rulesets, plus cosmetic hiding and scriptlets, aiming for strong uBlock Origin–class coverage within Chrome’s MV3 rules.

## Requirements

- Node.js 18+
- Chromium-based browser (Chrome 120+)

## Setup

```bash
npm install
npm run update-lists   # optional: download EasyList / uBO / etc.
npm run build          # compile filters + bundle → dist/
```

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select the `dist/` folder

## Scripts

| Script | Purpose |
|--------|---------|
| `npm run build` | Full pipeline: compile filters, then bundle |
| `npm run compile-filters` | `filters/` → `src/generated/` |
| `npm run bundle` | esbuild + copy assets → `dist/` |
| `npm run watch` | Rebuild JS on change |
| `npm run update-lists` | Fetch remote lists into `filters/` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | `node --test` |
| `npm run clean` | Remove build artifacts |

## Project layout

```
filters/           Filter registry + source lists
scripts/           Compile + bundle tooling
src/
  background/      Service worker
  content/         Content scripts (isolated + MAIN scriptlets)
  engine/          Cosmetic / procedural matching
  popup|options/   UI
  shared/          Types & constants
  manifest.json    MV3 manifest (rulesets injected at build)
dist/              Loadable unpacked extension (generated)
```

## Agent / AI context

- Cursor: see [`AGENTS.md`](./AGENTS.md) and [`.cursor/rules/`](./.cursor/rules/)
- Claude Code: see [`CLAUDE.md`](./CLAUDE.md)
- Architecture notes: [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)
- Testing notes: [`docs/TESTING.md`](./docs/TESTING.md)

## License

Private / unpublished unless otherwise stated.
