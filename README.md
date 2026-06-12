# Planets Evolution

Browser-based 3D planet builder and solar-system sandbox. Procedural worlds, orbital mechanics, and a sci-fi HUD — no build step, no bundler.

## What it is

A plain **HTML + CSS + JavaScript** app built on Three.js ES modules (`src/`). You classify and regenerate bodies, sculpt terrain with a brush, paint biomes, place colonies, and manage a multi-body system: **planets orbit the sun**, **moons and probes orbit planets** — and you can travel between procedurally generated star systems on a galaxy map. Custom GLSL handles gas atmospheres, plasma stars, and rings; terrain comes from seeded procedural noise.

**Focus modes:** orbital camera (OrbitControls), per-body editing, and third/first-person surface walk on solid land — with grass, rocks, trees, rolling water you can swim in, and footprints in soft soil.

For the code layout (module map, data model, frame lifecycle), see [ARCHITECTURE.md](./ARCHITECTURE.md).

## Tech stack

| Layer | Technology |
| ----- | ------------ |
| Runtime | Vanilla **ES modules** (no npm / no bundler) |
| 3D | **[Three.js](https://threejs.org/)** `0.160.0` via CDN **import map** (`index.html`) |
| Controls | `OrbitControls` (three/addons) |
| Assets | `GLTFLoader` — all GLB models in `assets/` (satellite, colony, avatar, surface props) |
| Shaders | Custom GLSL (gas, plasma/corona, rings, water, ground decals) |
| UI | Plain DOM + tabbed left panel, info panel, bottom nav, star-map overlays |
| Styling | `style.css` (CSS variables, HUD theme) |

**Languages:** HTML, CSS, JavaScript (WebGL / GLSL inline in the shader modules).

## Run locally

ES modules need HTTP (opening `index.html` as `file://` will fail).

```bash
npx serve . -l 3000
```

Then open [http://localhost:3000](http://localhost:3000).

Any static server on the project root works (e.g. `python -m http.server`).

## Project layout

| Path | Role |
| ---- | ---- |
| `index.html` | Canvas, UI shell, Three.js import map — loads `src/main.js` |
| `style.css` | All styling |
| `src/main.js` | Entry point: imports every module, boots Sol, runs the frame loop |
| `src/core/` | Scene, sun, constants, palettes, names, utils |
| `src/shaders/` | Gas, plasma, corona, ring GLSL |
| `src/framework/` | Body factory, terrain, climate, archetypes, shared state |
| `src/system/` | Orbits, Sol spec, lighting, star-system load/unload |
| `src/entities/` | Moons, probes, cities |
| `src/background/` | Starfield, Milky Way band, solar eruptions |
| `src/modes/` | Focus + the surface-walk feature (`surface/*`) |
| `src/ui/` | Panels, sliders, roster, nav, naming, star map |
| `assets/` | All GLB models (props, avatar, colony, satellite) |
| `ARCHITECTURE.md` | Maintainer map: modules, data model, frame lifecycle |
| `CLAUDE.md` | Quick-start + conventions for AI coding agents |

## Status

Experimental / vibe-coding friendly. Features and UI evolve quickly; there is no formal release process yet.

## Collaborators

- [@dylanP97](https://github.com/dylanP97/)
- [@fadilou-maker](https://github.com/fadilou-maker/)

## History

- **2016-12-05** — Split HTML, CSS, and JS (original French README goals: spherical 3D planet, random generation).
