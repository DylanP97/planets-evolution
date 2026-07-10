# Planets Exploration

Browser-based 3D planet builder and solar-system sandbox. Procedural worlds, orbital mechanics, and a sci-fi HUD — no build step, no bundler.

## What it is

A plain **HTML + CSS + JavaScript** app built on Three.js ES modules (`src/`). You classify and regenerate bodies, sculpt terrain with a brush, paint biomes, place named locations, and manage a multi-body system: **planets orbit the sun**, **moons and probes orbit planets** — and you can travel between procedurally generated star systems on a galaxy map. Custom GLSL handles gas atmospheres, plasma stars, and rings; terrain comes from seeded procedural noise.

**Focus modes:** orbital camera (OrbitControls), per-body editing, and third/first-person surface walk on solid land — with grass, rocks, trees, rolling water you can swim in, and footprints in soft soil.

For the code layout (module map, data model, frame lifecycle), see [ARCHITECTURE.md](./ARCHITECTURE.md).

## Tech stack

| Layer | Technology |
| ----- | ------------ |
| Runtime | Vanilla **ES modules** (no npm / no bundler) |
| 3D | **[Three.js](https://threejs.org/)** `0.160.0` via CDN **import map** (`index.html`) |
| Controls | `OrbitControls` (three/addons) |
| Assets | `GLTFLoader` — all GLB models in `assets/` (satellite, avatar, surface props) |
| Shaders | Custom GLSL (gas, plasma/corona, rings, water, ground decals) |
| UI | Plain DOM + tabbed left panel, info panel, bottom nav, star-map overlays |
| Styling | `styles/` (CSS variables, HUD theme — one file per panel) |

**Languages:** HTML, CSS, JavaScript (WebGL / GLSL inline in the shader modules).

## Run locally

ES modules need HTTP (opening `index.html` as `file://` will fail).

```bash
npx serve . -l 3000
```

Then open [http://localhost:3000](http://localhost:3000).

Any static server on the project root works (e.g. `python -m http.server`).

### Asset library (dev scene)

`assets/dev/` is a standalone scene for developing and inspecting GLB models in
isolation — it shares nothing with the main app except the `.glb` files. Serve
it on its **own port**, independent of the main app. The simplest way is the
bundled launcher — it serves on port `8001` and opens the library for you, while
your main app on `8000` is untouched:

```bash
python assets/dev/serve.py        # opens http://localhost:8001/assets/dev/
python assets/dev/serve.py 9000   # or pick another port
```

The launcher serves the **project root** (so the scene can reach the GLBs in
`assets/`) but points the browser straight at the library. If you'd rather use
your own static server, do the same thing by hand — serve the project root, then
open `/assets/dev/`:

```bash
npx serve . -l 8001     # then open http://localhost:8001/assets/dev/
```

> Don't root a server at `assets/dev/` — the `.glb` files live one level up in
> `assets/`, so they'd sit outside the server and every model would 404.

Click a model in the sidebar (or drag-and-drop a `.glb` onto the page) to load
it; toggle grid/wireframe/bounding-box, scrub animation clips, and read its
size / vertex / triangle / material counts. Register new models by adding an
entry to `ASSETS` in `assets/dev/dev-scene.js`.

## Project layout

| Path | Role |
| ---- | ---- |
| `index.html` | Canvas, UI shell, Three.js import map — loads `src/main.js` |
| `styles/` | All styling, one file per panel (`base.css` holds the theme variables) |
| `src/main.js` | Entry point: imports every module, boots Sol, runs the frame loop |
| `src/core/` | Scene, sun, constants, palettes, names, utils |
| `src/shaders/` | Gas, plasma, corona, ring GLSL |
| `src/framework/` | Body factory, terrain, climate, archetypes, shared state |
| `src/system/` | Orbits, Sol spec, lighting, star-system load/unload |
| `src/entities/` | Moons, probes, locations |
| `src/background/` | Starfield, Milky Way band, solar eruptions |
| `src/modes/` | Focus + the surface-walk feature (`surface/*`) |
| `src/ui/` | Panels, sliders, roster, nav, naming, star map |
| `assets/` | All GLB models (props, avatar, satellite) |
| `assets/dev/` | Standalone **asset library** dev scene — preview/inspect any GLB in isolation (own server/port; see below) |
| `ARCHITECTURE.md` | Maintainer map: modules, data model, frame lifecycle |
| `CLAUDE.md` | Quick-start + conventions for AI coding agents |

## Status

Experimental / vibe-coding friendly. Features and UI evolve quickly; there is no formal release process yet.

## Collaborators

- [@dylanP97](https://github.com/dylanP97/)
- [@fadilou-maker](https://github.com/fadilou-maker/)

## History

- **2016-12-05** — Split HTML, CSS, and JS (original French README goals: spherical 3D planet, random generation).
