# Planets Evolution

Browser-based 3D planet builder and solar-system sandbox. Procedural worlds, orbital mechanics, and a sci-fi HUD — no build step, no bundler.

## What it is

A flat **HTML + CSS + JavaScript** app centered on a single Three.js module (`script.js`). You classify and regenerate bodies, sculpt terrain with a brush, paint biomes, place colonies, and manage a multi-body system: **planets orbit the sun**, **moons and probes orbit planets**. Custom GLSL handles gas atmospheres, plasma stars, and rings; terrain comes from seeded procedural noise.

**Focus modes:** orbital camera (OrbitControls), per-body editing, and first-person surface walk on solid land.

For code layout and section map, see [ARCHITECTURE.md](./ARCHITECTURE.md).

## Tech stack

| Layer | Technology |
| ----- | ------------ |
| Runtime | Vanilla **ES modules** (no npm / no bundler) |
| 3D | **[Three.js](https://threejs.org/)** `0.160.0` via CDN **import map** (`index.html`) |
| Controls | `OrbitControls` (three/addons) |
| Assets | `GLTFLoader` — probe `3d_objects/satellite.glb`, cities `lunar_base.glb` |
| Shaders | Custom GLSL (gas, plasma/corona, rings) |
| UI | Plain DOM + tabbed left panel, info panel, bottom nav |
| Styling | `style.css` (CSS variables, HUD theme) |

**Languages:** HTML, CSS, JavaScript (WebGL / GLSL inline in `script.js`).

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
| `index.html` | Canvas, UI shell, Three.js import map |
| `style.css` | All styling |
| `script.js` | Scene, bodies, shaders, brush, UI, animation loop |
| `3d_objects/` | Satellite GLB (+ unused OBJ/MTL source) |
| `lunar_base.glb` | Colony / city marker mesh |
| `ARCHITECTURE.md` | Maintainer map of `script.js` sections |

## Status

Experimental / vibe-coding friendly. Features and UI evolve quickly; there is no formal release process yet.

## Collaborators

- [@dylanP97](https://github.com/dylanP97/)
- [@fadilou-maker](https://github.com/fadilou-maker/)

## History

- **2016-12-05** — Split HTML, CSS, and JS (original French README goals: spherical 3D planet, random generation).
