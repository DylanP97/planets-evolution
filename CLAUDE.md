# CLAUDE.md

Browser-based 3D planet builder / solar-system sandbox. Vanilla HTML + CSS + JS (ES modules), Three.js 0.160 from a CDN importmap, custom GLSL. **No build step, no npm, no tests** — the `src/` modules load directly in the browser.

## Run

ES modules need HTTP (file:// fails):

```bash
npx serve . -l 3000     # any static server on the project root works
```

Entry point: `index.html` → `src/main.js`.

**Asset library (standalone dev scene):** `assets/dev/` is a self-contained GLB
viewer for developing/inspecting models in isolation — it shares nothing with
`src/`. Launch it on its own port (main app on 8000 untouched):

```bash
python assets/dev/serve.py     # opens http://localhost:8001/assets/dev/
```

## Navigate the code

Read **ARCHITECTURE.md** first — it has the module map, data model, frame lifecycle, and a "where is function X" table. Every `src/` module also starts with a header comment saying what it owns. Quick orientation:

- `src/main.js` — imports everything in order, boots Sol, runs the animate loop.
- `src/core/` — scene/camera/renderer, constants, names, and **`bus.js`** (the pub/sub lower layers use to trigger UI refreshes).
- `src/framework/` — body factory, terrain, climate, archetypes, and **`state.js`** (all shared mutable state).
- `src/shaders/` — gas/plasma/corona/ring GLSL.
- `src/system/` — orbits, Sol spec, lighting, star-system load/unload.
- `src/modes/surface/` — the surface-walk feature (avatar, walk, grass, rocks, water, footprints, sky).
- `src/ui/` — left/right panels, bottom nav, star map, naming.
- `src/entities/`, `src/background/`, `src/interaction/` — moons/probes/cities, starfield/galaxy/eruptions, brush/pointer.

## Critical conventions (violating these breaks the app)

1. **Never assign to an imported binding.** Shared mutable state lives in `framework/state.js` (and a few sibling modules) behind `set*` functions: `setFocusedBody(b)`, `setViewMode('surface')`, … Reading via import is fine (live bindings).
2. **The import graph is acyclic — keep it that way.** Layering: `core → framework → entities/modes → system → ui`. A lower-layer module must never import from `ui/` (sole exception: `ui/dom.js`, a zero-import table of `getElementById` consts); when it needs a UI refresh it emits a `core/bus.js` event, and **all** subscriptions live in `ui/wire-up.js` (imported last by `main.js`, so handler order is deterministic and auditable in one place). Check with `node .claude/scc-graph.cjs` — it must print "No cycles." Details in ARCHITECTURE.md → Conventions.
3. **Call `commitBodyChanges(body)`** after mutating `body.heights` / `body.colorArr`.
4. **Don't allocate vectors in the frame loop** — reuse the module-scope `_xxx` scratch vectors (some are exported and shared between surface modules).
5. **GLSL `onBeforeCompile` patches**: guard injected varyings with `#ifndef` — three.js may re-run the patch on an already-patched shader string.

## Verify changes

**Do not run Playwright or take screenshots autonomously.** Visual verification is the user's job: after making changes, ask the user to reload the browser and describe what they see. Only run the static checks below automatically.

The Playwright scripts exist for reference but should only be run if the user explicitly asks:

```powershell
$env:NODE_PATH = npm root -g
node .claude/verify-refactor.cjs   # boot + orbit + surface walk + star map, screenshots + console errors
node .claude/verify-water.cjs      # wade/swim/underwater overlay scenario
node .claude/verify-venus.cjs      # venusian biomes + footprint decals
```

Static checks (ESLint in `.claude/tooling/` — first time, run `npm install` in that folder):

```powershell
node .claude/lint-report.cjs       # no-undef + no-import-assign over src/
node .claude/check-imports.cjs     # every named import resolves to a real export
node .claude/scc-graph.cjs         # import-cycle check — must print "No cycles."
node .claude/find-tdz.cjs          # legacy TDZ-hazard scan (moot while acyclic)
```

In-app console diagnostics: `window.grassDiag()`, `window.footDiag()`.

## Git

- **Do not create new branches unless the user explicitly asks for one.** Work directly on the current branch (usually `main`).
- Verify-script screenshots/logs land in `.claude/` and are gitignored — don't commit them.

## Docs to keep in sync

- `ARCHITECTURE.md` — update the module map + walkthroughs when modules move or subsystems change.
- Module header comments — keep the first lines of each `src/` file accurate.
- `README.md` — user-facing intro; layout table.
