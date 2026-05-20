# Architecture

> Map for navigating this project. Optimized for greppability — every section here matches a `// ====== Section ======` banner in `script.js`, so you can jump from a topic to the code in one search.

The project is intentionally a flat, single-file Three.js app (`script.js`, ~3,500 lines) plus `index.html` and `style.css`. No build step, no bundler. The HTML uses an `importmap` to pull Three.js from a CDN and loads `script.js` as a module.

---

## Files

| File              | What it holds                                                                 |
| ----------------- | ----------------------------------------------------------------------------- |
| `index.html`      | Canvas, tabbed left panel, info panel (right), bottom nav, surface overlay.   |
| `style.css`       | All styling. CSS variables drive the sci-fi HUD theme.                        |
| `script.js`       | The whole runtime: scene, bodies, shaders, brush, UI wiring, animation loop.  |
| `3d_objects/`     | `satellite.glb` is loaded for probe meshes (other formats are unused source). |
| `ARCHITECTURE.md` | This file. Updated when sections move.                                        |
| `README.md`       | Project intro (French, original).                                             |

---

## Section map (`script.js`)

Each row maps a banner in `script.js` to its line range. After editing, re-grep `// ======` and update.

| #   | Section                       | Lines       | Responsibility                                                                                          |
| --- | ----------------------------- | ----------- | ------------------------------------------------------------------------------------------------------- |
| 1   | Planet constants              | 54–98       | `BASE_RADIUS`, biome height bands, color palette, `BIOME` enum.                                         |
| 2   | Scene                         | 99–147      | `scene`, `camera`, `renderer`, `controls`, `sun` PointLight, `sunMesh`. Mouse buttons configured here.  |
| 3   | Palettes                      | 148–164     | `PLANET_PALETTE`, `MOON_PALETTE`.                                                                       |
| 4   | Body framework                | 165–184     | `BODY_HEIGHT_SCALE`, `MAX/MIN_LAND_HEIGHT`, the `bodies` registry, `smoothstep`.                        |
| 5   | Gas shader                    | 185–403     | GLSL for atmosphere + full-gas modes (`uMode = 0 \| 1`). `makeGasMaterial()` factory.                   |
| 5b  | Plasma shader                 | —           | GLSL for the animated star photosphere ("lava ocean"). `makePlasmaMaterial()` + `makeCoronaMaterial()`; lights the Sun + corona halo here, builds `plasmaTickUniforms`. |
| 6   | Ring shader                   | 404–557     | GLSL for planetary rings. `RING_INNER/OUTER_FACTOR`, `makeRingMaterial()`.                              |
| 7   | Body creation                 | 558–827     | `createBody()`, vertex writers, `applyBrushToBody()`, `commitBodyChanges()`.                            |
| 8   | Terrain generation            | 828–887     | Hash/RNG, `buildTerrainBasis`, `sampleTerrainNoise` (sum-of-sines FBM).                                 |
| 9   | Archetypes                    | 888–972     | `ARCHETYPES`, `ARCHETYPE_MATTER`, `applyMatterToBody()`.                                                |
| 10  | Gas / rings appliers + regen  | 973–1029    | `applyGasShell`, `applyRingsToBody`, `regenerateBody`.                                                  |
| 11  | Planets (sun orbits)          | 1030–1067   | `planets[]`, `DEFAULT_SPIN`, `updatePlanetOrbits`, `registerPlanet`.                                    |
| 12  | Orbit ellipse trajectories    | 1068–1119   | The visible orbit rings: `buildOrbitLineGeometry`, `refreshOrbitLine`, `disposeOrbitLine`.              |
| 13  | Solar system bootstrap        | 1120–1183   | `SOLAR_SYSTEM_SPEC`, `spawnSolarPlanet`, initial `solarBodies[]`. Default focus = `solarBodies[2]`.     |
| 14  | Brush                         | 1184–1226   | `brushRadius`, `brushStrength`, brush ring mesh, `updateBrushRing`.                                     |
| 15  | Pointer handling              | 1227–1319   | Pointerdown/move/up wiring on the canvas. Raycast → `applyBrushToBody`.                                 |
| 16  | Moons                         | 1320–1448   | `MOON_*` constants, `moons[]`, slot allocator, `addMoon`, `updateMoons`.                                |
| 17  | Probes (satellites)           | 1449–1625   | `MAX_PROBES`, `probes[]`, `loadSatelliteTemplate` (GLB), `addSatellite`, `updateSatellites`.            |
| 18  | Cities                        | 1626–1709   | `cities[]`, `addCity`, `createCityMarker`, `updateCityMarkers` (day-side fade).                         |
| 19  | Starfield                     | 1710–1736   | 2000 background points at r ≈ 2200.                                                                     |
| 20  | Planet rotation               | 1737–1748   | `updatePlanetRotation` — spins each planet by its `rotationSpeed`.                                      |
| 21  | Sun light for focus           | 1749–1799   | `updateSunLightForFocus` refreshes per-body `uSunDir` uniforms (atmosphere + rings).                    |
| 22  | Focus                         | 1800–1867   | `focusedBody`, `focusedCity`, `setFocus`, `setCityFocus`, `updateFocusTracking` (chase target).         |
| 23  | Info panel                    | 1868–2092   | Telemetry pane on the right: composition rollup, peak, day period, orbit period.                       |
| 24  | Random names                  | 2093–2131   | `COSMIC_WORDS`, `generateCosmic`, `generateName('planet' \| 'moon' \| 'system')`.                       |
| 25  | UI (tabs + sliders)           | 2132–2331   | DOM lookups; tab switching; slider → value conversions.                                                 |
| 26  | Atmosphere sliders            | 2332–2357   | `applyAtmoSliderToFocus` (thickness, density, coverage).                                                |
| 27  | Ring controls                 | 2358–2416   | `applyRingsSliderToFocus`.                                                                              |
| 28  | Context-aware left panel      | 2417–2671   | `applyFocusToLeftPanel` — what tabs/sections are visible per focus kind.                                |
| 29  | Body orbit sliders            | 2672–2729   | Distance / orbit-speed / spin / size sliders (planet vs moon).                                          |
| 30  | Add / Remove planet           | 2730–3028   | `deployNewPlanet`, `removePlanetBody`, `renderPlanetList`, moons/probes list renderers.                 |
| 31  | Hierarchy navigation          | 3029–3184   | Bottom-nav arrows: `navUp`, `navDown`, `navSibling`, `renderNavBodies`.                                 |
| 32  | Surface walk                  | 3185–3424   | `enterPickMode` → click → `enterSurfaceMode` → `updateSurfaceCamera`. State in `surfaceState`.          |
| 33  | Surface input                 | 3425–3539   | Drag-look, scroll-zoom, WASD/arrow walking (`stepSurfaceWalk`), the satellite/moon "deploy" buttons.    |
| 34  | Renaming                      | 3540–3632   | `setBodyName`, `setSystemName`, `commitFocusName`. Triggers re-render fan-out.                          |
| 35  | Init + Resize                 | 3633–3639   | Window-resize listener (and seed moons / final `setSystemFocus()` just above it).                       |
| 36  | Animate                       | 3640–end    | The frame loop. Drives orbits, rotations, gas time, cities, lights, surface camera, render.             |

---

## Data model

In-memory state is held in plain object literals (no classes). Five collection arrays own the world:

```
bodies[]   // every renderable rock/gas/ice sphere (planets + moons). Index in this array is used by raycasting.
planets[]  // entries that wrap a body and add an orbit { distance, angle, speed, inclination, line }
moons[]    // entries that wrap a body and add an orbit around a parent body
probes[]   // GLB satellites in orbit around a planet (mesh-only — no editable surface)
cities[]   // markers pinned to a body via a unit-direction localPos
```

### Body — the core unit (planets and moons)

Created by `createBody({ kind, name, baseRadius, detail, palette, hasOcean })`. Returned object's shape:

```
{
  kind: 'planet' | 'moon',
  name, baseRadius, detail,
  palette,
  group,        // THREE.Group — parented to scene (planets) or to nothing (moons get positioned each frame)
  mesh,         // solid icosphere; geometry has per-vertex displacement
  geo, posAttr, // shorthand into mesh.geometry
  N,            // vertex count
  unitDirs,     // Float32Array(N*3) — original unit direction of each vertex
  heights,      // Float32Array(N)   — signed height in body-relative units
  biomes,       // Uint8Array(N)     — BIOME.* enum tag per vertex
  colorArr,     // Float32Array(N*3) — vertex colors written by colorBodyVertex
  oceanMesh,    // SphereGeometry at baseRadius; hidden when matter.liquid === false
  gasMesh,      // SphereGeometry at baseRadius * gasThickness; uses gas shader
  plasmaMesh,   // SphereGeometry at baseRadius; animated star photosphere (plasma shader); hidden unless matter.plasma
  ringMesh,     // RingGeometry; planet-only feature
  matter: { solid, liquid, gas, plasma },  // gas: false | 'atmosphere' | 'full'; plasma: true on stars
  gasMode: 'none' | 'atmosphere' | 'full',
  gasThickness, gasDensity, gasCoverage,
  rings:  { enabled, intensity },
  archetype,    // 'terrestrial' | 'gas_giant' | … (planets only)
  rotationSpeed,
}
```

World radius at vertex `i` is `baseRadius * (1 + heights[i] * BODY_HEIGHT_SCALE)`. So heights are *relative* — a peak of `MAX_LAND_HEIGHT = 2.5` is ~6% of the body's radius regardless of scale.

### Planet entry — wraps a body with an orbit

```
{ body, orbit: { distance, angle, speed, inclination, line } }
```

`line` is the visible orbit ellipse (`THREE.Line`). Toggled via the System tab's "Show Orbits".

### Moon entry

```
{ body, parent, seed,
  angle, inclination, node,   // Keplerian-ish; node = longitude of ascending node
  size, distance, speed,
  slot }                       // slot index into moonSlotsByParent for plane spacing
```

Moons are built at `MOON_BASE_RADIUS = 1` and scaled via `group.scale` so the size slider doesn't rebuild geometry.

### Probe entry

```
{ mesh, parent, name, seed,
  angle, inclination, node,
  size, distance, speed, slot,
  spin }                       // per-frame self-rotation
```

`mesh` is a clone of the loaded GLB (or a tiny fallback box if the GLB hasn't finished loading).

### City entry

```
{ body, name, localPos, mesh }   // localPos is unit-normalized; world position is body.group * (localPos * (baseRadius + 0.1))
```

---

## How a frame runs

The loop is the bottom of `script.js`. Read it top to bottom for the canonical lifecycle:

1. `dt = clock.getDelta()`.
2. If not `paused`: advance planet orbits, rotations, and `gasTime` (cloud drift).
3. Always: `updateMoons`, `updateSatellites` (probes), `updateCityMarkers` (day-side dimming), `updateSunLightForFocus`.
4. `updateFocusTracking` keeps the camera chasing the focused body's world position.
5. `controls.update()` (OrbitControls).
6. If `viewMode === 'surface'`, `updateSurfaceCamera()` overrides the camera transform.
7. If a brush stroke is active, `applyBrushToBody(activeBrushBody, lastHitLocal, dt)`.
8. Throttled (~10 Hz): `updateLiveInfo()` writes the info panel.
9. `renderer.render(scene, camera)`.

Pausing freezes orbits, spin, and cloud drift; moons + probes + brush keep going (intentional — that's how the user can sculpt without the world spinning out from under them).

---

## Subsystem walkthroughs

### Terrain — `regenerateBody` and the brush

- `buildTerrainBasis(seedNum, count)` returns an array of `count` direction-vector + frequency + amplitude tuples — a sum-of-sines noise basis on the sphere. Seeded by `hashSeed(seedStr)`.
- `sampleTerrainNoise(basis, ux, uy, uz)` evaluates the basis at a unit direction. O(`TERRAIN_OCTAVES` = 24) per vertex.
- `regenerateBody(body, seedStr, amplitude, seaCoverage)` resamples noise per vertex, then *biases* the heights so that `seaCoverage` of them sit below 0 (the sea level). Without the percentile bias, sea coverage would drift with seed.
- `applyBrushToBody(body, centerLocal, dt)` mutates heights in a spherical cap (angular radius = `brushRadius` in radians). Falloff = `(1 - t²)²` where `t` is angular distance / brush radius. Per-vertex height is clamped to `[MIN_LAND_HEIGHT, MAX_LAND_HEIGHT]`.

### Shaders — gas + rings

- Both are `THREE.ShaderMaterial`. Per-body materials, so each can have its own `uSunDir`.
- `GAS_FRAG` branches on `uMode`:
  - `0` = atmosphere: noise-thresholded clouds, soft fresnel edge, wind drift via `uTime` × `uWindSpeed`.
  - `1` = full gas (gas giants): latitudinal banding + fresnel falloff so the silhouette stems out into space.
- `uOpaqueSky` is flipped on during surface mode for dense atmospheres so the sky reads as solid, not see-through.
- Rings (`RING_*`): one body-aligned thin disk; alpha falls off radially and is darkened in the planet's shadow cone.

### Shaders — plasma (the fourth matter type)

- `makePlasmaMaterial()` builds the emissive, self-lit star surface used by the Sun (`sunMesh.material` is swapped to it after the factory exists) and by any body with `matter.plasma` (the `star` archetype). It's opaque, casts/receives no shadows, and ignores `uSunDir` — a star lights itself.
- The frag shader is a domain-warped value-noise FBM sampled on the local unit direction (so the pattern is radius-independent): a slow swirling convection layer plus a faster bubbling layer, a time-shifting threshold that lifts and pulses bright white-hot cells, dark sunspot lanes in the troughs, and a fresnel limb term. Colors ramp deep-orange → orange → yellow → white-hot.
- The Sun also gets `makeCoronaMaterial()` — an additive back-faced halo shell (`coronaMesh`) that fakes bloom without a postprocessing pass.
- `uTime` for the Sun, corona, and every visible plasma body is advanced by `plasmaTime` in the animate loop **every frame, paused or not** — a star never freezes (unlike `gasTime`, which stops on pause). The Sun + corona uniforms are collected in `plasmaTickUniforms`.

### Surface walk — the three modes

Single state variable, `viewMode`, gates everything: `'orbit' | 'pick' | 'surface'`.

- **orbit** (default): OrbitControls drive the camera. Brush works. Click `VISIT SURFACE` button → `enterPickMode`.
- **pick**: OrbitControls disabled. Next left-click on the focused body's mesh → `enterSurfaceMode`. Bodies fail the eligibility check if `matter.solid === false` (gas/ice giants).
- **surface**: Camera attached to the body's surface in body-local coords (`surfaceState.localEye`, etc.). Drag = look, scroll = FOV zoom, **WASD / arrow keys walk** (Shift sprints). `stepSurfaceWalk` moves `localEye` along the tangent plane, then `sampleGroundRadius` casts a ray straight down at the mesh to find the real terrain height under the new spot (clamped to sea level on ocean bodies); the eye lerps to `ground + eyeHeight` so it rises over mountains instead of clipping through them. The local frame is parallel-transported across the surface so yaw stays consistent. `updateSurfaceCamera` then reads the body's *current* world matrix every frame, so spin and orbit naturally wheel the sky overhead.

Returning to orbit (`exitSurfaceMode`) restores: camera `fov`/`near`/`far`, the gas mesh's side (`DoubleSide` → `BackSide` again), and any `uOpaqueSky` override.

### Focus → left panel

`focusedBody` (and `focusedCity`) drive everything visible:

- `applyFocusToLeftPanel()` shows/hides tabs based on each tab button's `data-focus` attribute (in `index.html`).
- Per kind: planets get Classify + Sats; moons share Sculpt + Envir + Colony with planets; both kinds and "no focus" (system view) show the System tab.
- When the focused body changes, `setFocus`/`setCityFocus` retarget OrbitControls toward the new world position, re-render every list, and refresh the visit-button state.

### Probes — GLB loading

The satellite GLB at `3d_objects/satellite.glb` is loaded *lazily, once*. `loadSatelliteTemplate()` caches a normalized template (scaled so its longest dimension = `PROBE_BASE_SIZE`). Each new probe `.clone(true)`s the template. Before the GLB resolves, probes get a fallback box mesh.

---

## DOM element index (`index.html`)

Anything referenced from JS by id, grouped by panel:

| Panel              | ids                                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Tabs (left)        | `tab-classify`, `tab-sculpt`, `tab-environment`, `tab-colonies`, `tab-satellites`, `tab-system`                                 |
| Classify           | `archetypeSelect`, `seedInput`, `randomSeedBtn`, `genAmp`, `genSea`, `regenBtn`                                                  |
| Sculpt             | `sculptRaise`, `sculptLower`, `brushRadius`, `brushStrength`                                                                    |
| Environment        | `biomeSelect`, `brushRadiusB`, `atmoThick`, `atmoDensity`, `atmoCoverage`, `ringsEnabled`, `ringsIntensity`                     |
| Colonies           | `cityNameInput`, `cityList`                                                                                                     |
| Satellites         | `moonsList`, `addMoon`, `probesList`, `addProbe`                                                                                |
| System             | `planetList`, `deployPlanetBtn`, `bodyDistInput`, `bodySpeedInput`, `bodyMoonSpeedInput`, `bodySpinInput`, `bodySizeInput`      |
| Dynamics           | `showOrbits`, `pauseRot`                                                                                                        |
| Info panel (right) | `infoBodyName`, `infoSubtitle`, `infoComposition`, `infoPeak`, `infoVerts`, `infoMoons`, `infoDayPeriod`, `infoDayTime`, `infoOrbit*` |
| Bottom nav         | `navBreadcrumb`, `navFocusLevel`, `navFocusName`, `navFocusSub`, `navUp/Down/Left/Right`, `navRandomBtn`, `navVisit`            |
| Surface overlay    | `surfaceOverlay`, `surfaceLocationName`, `surfaceExitBtn`, `surfaceCrosshair`, `surfaceHint`                                    |
| Misc               | `c` (the WebGL canvas), `pickHint`, `pickToast`, `scanOverlay`                                                                  |

---

## Function index

Grouped by section. Line numbers will drift — re-grep `^\s+function\s+\w+` after edits.

| Function                 | Line  | What it does                                                                          |
| ------------------------ | ----- | ------------------------------------------------------------------------------------- |
| `smoothstep`             | 180   | Hermite step `[a..b] → [0..1]`. Used everywhere bands need soft transitions.          |
| `makeGasMaterial`        | 383   | Builds a per-body `ShaderMaterial` for atmosphere/gas-giant rendering.                |
| `makeRingMaterial`       | 533   | Builds a per-body `ShaderMaterial` for planetary rings.                               |
| `createBody`             | 561   | The factory. Returns a Body (see Data model). Caller adds `group` to scene.           |
| `writeBodyVertex`        | 664   | Writes vertex `i`'s position from `unitDirs[i] * (baseRadius * (1 + heights[i]*…))`.  |
| `colorBodyVertex`        | 671   | Writes vertex `i`'s color from height + biome + palette.                              |
| `commitBodyChanges`      | 782   | Marks `position` and `color` attributes dirty + recomputes bounds/normals.            |
| `applyBrushToBody`       | 790   | Single brush stroke (one frame). Spherical-cap falloff, height-clamped.               |
| `hashSeed`               | 834   | FNV-ish string → uint32 hash. Deterministic across runs.                              |
| `makeRNG`                | 842   | Mulberry32-style PRNG from a seed int.                                                |
| `buildTerrainBasis`      | 855   | Builds a noise basis (direction + freq + amp tuples).                                 |
| `sampleTerrainNoise`     | 879   | Sums the basis at a unit direction.                                                   |
| `applyMatterToBody`      | 942   | Switches solid/liquid/gas meshes for a body per archetype matter spec.                |
| `applyGasShell`          | 976   | Pushes `body.gas*` fields into the gas mesh's uniforms + thickness scale.             |
| `applyRingsToBody`       | 987   | Pushes `body.rings.{enabled,intensity}` into the ring mesh.                           |
| `regenerateBody`         | 998   | Reseed terrain. Resamples noise → biases → writes vertices + colors.                  |
| `updatePlanetOrbitPosition` | 1041 | Position one planet on its orbit from `angle/distance/inclination`.                  |
| `updatePlanetOrbits`     | 1050  | Per-frame advance of every planet's `angle` and reposition.                           |
| `registerPlanet`         | 1057  | Push a planet entry + draw its orbit line.                                            |
| `buildOrbitLineGeometry` | 1077  | Float32Array of points on an inclined circle.                                         |
| `refreshOrbitLine`       | 1094  | Rebuild a planet's orbit line geometry (after distance/inclination changes).          |
| `disposeOrbitLine`       | 1112  | Tear down the orbit line when a planet is removed.                                    |
| `spawnSolarPlanet`       | 1145  | Builds a Sol-system planet from a `SOLAR_SYSTEM_SPEC` entry; calls `regenerateBody`.  |
| `updateBrushRing`        | 1214  | Positions/orients the on-surface brush preview disc.                                  |
| `brushArcWorldRadius`    | 1223  | Brush angular radius (radians) → world-distance radius for the preview ring.          |
| `setPointerFromEvent`    | 1228  | Mouse client coords → NDC `pointer`.                                                  |
| `raycastBodies`          | 1235  | Raycast against every visible body mesh. Returns `{ body, hit }` or `null`.           |
| `worldToBodyLocal`       | 1249  | Worldspace point → body's mesh-local space.                                           |
| `endPaint`               | 1304  | Pointerup/cancel: clear painting state, release pointer capture.                      |
| `moonOrbitPlane`         | 1337  | Slot index → `{ inclination, node, phase }` so concurrent moons don't overlap.        |
| `allocateMoonSlot`       | 1345  | Lowest free slot (per parent), up to `MAX_MOONS`.                                     |
| `freeMoonSlot`           | 1354  | Release a slot.                                                                       |
| `updateMoonPosition`     | 1359  | Place a moon in worldspace from its orbit params + parent position.                   |
| `addMoon`                | 1375  | Create + register a moon. Builds a new body via `createBody`.                         |
| `removeMoonAt`           | 1412  | Tear down a moon (geometry, slot, focus fallback).                                    |
| `setMoonSize` / `…Distance` | 1426 | Mutate one moon and refresh.                                                       |
| `updateMoons`            | 1440  | Per-frame orbit advance (Kepler-ish: `ω ∝ d^-1.5`).                                   |
| `loadSatelliteTemplate`  | 1466  | GLB loader, cached. Normalizes scale.                                                 |
| `probeOrbitPlane` / `allocateProbeSlot` / `freeProbeSlot` | 1497 | Same idea as moons.                                            |
| `updateProbePosition`    | 1521  | Place a probe.                                                                        |
| `addSatellite`           | 1534  | Create + register a probe.                                                            |
| `removeSatelliteAt`      | 1586  | Tear down a probe, including disposing cloned GLB materials/geometries.               |
| `setSatelliteSize` / `…Distance` | 1603 |                                                                                |
| `updateSatellites`       | 1617  | Per-frame orbit + self-spin.                                                          |
| `addCity`                | 1632  | Pin a city to a body at a unit-local direction.                                       |
| `createCityMarker`       | 1645  | Small glowing box mesh.                                                               |
| `updateCityMarkers`      | 1652  | Visibility per day-side (dot of surface normal with toSun).                           |
| `renderCityList`         | 1675  | DOM render for the Colony tab.                                                        |
| `removeCityAt`           | 1696  | Detach + dispose.                                                                     |
| `updatePlanetRotation`   | 1742  | Spin every planet by its `rotationSpeed`.                                             |
| `updateSunLightForFocus` | 1757  | Refresh per-body `uSunDir` uniforms (atmosphere + rings).                             |
| `setFocus`               | 1810  | Change focused body. Retargets controls and resets dolly distance.                    |
| `setCityFocus`           | 1829  | Focus a city (subtler dolly, oriented by city's surface normal).                      |
| `updateFocusTracking`    | 1855  | Each frame, slide `controls.target` to follow the focused body's worldpos.            |
| `hexFromNumber`          | 1917  | `0xff00aa` → `"#ff00aa"`. Used by the composition swatches.                           |
| `bandMeta`               | 1923  | Resolve `(body, key)` → display label + swatch color for the info panel.              |
| `computeBodyStats`       | 1943  | Aggregate per-vertex bands and find peak. Source of the composition rollup.           |
| `fmtPct`, `fmtSeconds`   | 1976  | Number formatters for the info panel.                                                 |
| `peakWorldHeight`        | 1990  | `peak` (height units) → world-space height above sea level.                           |
| `updateInfoPanel`        | 2012  | Full re-render of the right info panel.                                               |
| `updateLiveInfo`         | 2067  | ~10 Hz tick. Updates only the values that change continuously (day time, orbit).      |
| `generateCosmic`         | 2107  | Random sci-fi-flavored name root.                                                     |
| `generateName`           | 2128  | `generateCosmic(kind)` + numeral/suffix appropriate to `'planet' \| 'moon' \| 'system'`. |
| `updateBiomeTools`       | 2197  | Rebuild the biome select per focused body (moon vs planet have different palettes).   |
| `syncBrushRadius`        | 2293  | Two sliders (Sculpt + Envir) share a value — this keeps them in sync.                 |
| `applyAtmoSliderToFocus` | 2343  | Three atmo sliders → focused body's gas mesh.                                         |
| `applyRingsSliderToFocus`| 2364  | Rings checkbox + intensity slider → focused body's ring mesh.                         |
| `sliderTo*`              | 2404  | Slider integer → physical value.                                                      |
| `syncGenLabels`          | 2409  | Refresh the "Amplitude / Sea Level" value chips.                                      |
| `setRange`               | 2468  | Update an `<input range>`'s min/max attributes safely.                                |
| `applyFocusToLeftPanel`  | 2477  | Show/hide tabs + sections per focus kind. Big function — the heart of context-aware UI. |
| `syncAtmoSlidersToFocus` | 2606  | Pull body.gas* into the atmo sliders. Inverse of `applyAtmoSliderToFocus`.            |
| `syncRingsToFocus`       | 2646  | Pull body.rings into the rings UI.                                                    |
| `nextPlanetName`         | 2732  | First unused `Planet I`, `Planet II`, …                                               |
| `deployNewPlanet`        | 2742  | Create a new planet; auto-picks a free archetype and a farther orbit.                 |
| `removePlanetBody`       | 2786  | Tear down a planet, including all its moons, probes, cities. Re-focuses elsewhere.    |
| `renderPlanetList`       | 2856  | DOM render for the System tab's planet roster.                                        |
| `renderMoonsList`        | 2883  | DOM render for the Satellites tab's moons list.                                       |
| `renderProbesList`       | 2957  | DOM render for the Satellites tab's probes list.                                      |
| `renderFocusBadges`      | 3022  | Footer text: focused body's name + archetype.                                         |
| `setNavNameText`         | 3044  | Write the bottom-nav focus name without colliding with caret state.                   |
| `setSystemFocus`         | 3049  | Zoom out to system view (no focused body). Used at startup and from `navUp`.          |
| `navUp` / `navDown`      | 3065  | Up: focused body → parent / system. Down: planet → first moon → first city.           |
| `navSibling(dir)`        | 3095  | Cycle planets / moons / cities at the current level (`dir` ∈ {-1, +1}).               |
| `renderNavBodies`        | 3122  | Refresh the bottom-nav text (level, name, sub, breadcrumb) from current focus.        |
| `isBodyVisitable`        | 3225  | Eligibility for surface walk (planet/moon AND `matter.solid`).                        |
| `updateVisitButtonState` | 3231  | Visit button enabled/disabled + label per viewMode.                                   |
| `flashPickToast`         | 3246  | Transient bottom-of-screen status during pick mode.                                   |
| `enterPickMode` / `exitPickMode` | 3254 | Arms/disarms the click-to-land state. Disables OrbitControls while armed.       |
| `buildLocalFrame`        | 3281  | Orthonormal basis at a body-local point (avoids singularity at the poles).            |
| `enterSurfaceMode`       | 3290  | Snap camera to ground at hit point. Saves orbit camera state for restore.             |
| `exitSurfaceMode`        | 3364  | Restore orbit camera + gas mesh material state.                                       |
| `updateSurfaceCamera`    | 3402  | Each frame: rebuild camera transform from body's current world matrix + yaw/pitch.    |
| `setBodyName`            | 3545  | Single fan-out for renaming — touches nav, lists, info, biome tools.                  |
| `setSystemName`          | 3560  | Rename the star system. Re-renders nav + info.                                        |
| `commitFocusName`        | 3567  | Inline-edit commit handler. Dispatches to `setBodyName`/`setSystemName`/city.         |

---

## Conventions

- **Indentation**: 4 spaces. The whole file is inside an implicit module scope; no top-level `<script>` wrapping logic.
- **Closures over arrays/state**: Almost all state (`bodies`, `planets`, `focusedBody`, brush state) lives at module scope. Functions reach in directly. Adding new collections is fine, but document them here.
- **`body.kind`**: `'planet'` or `'moon'`. Many UI branches gate on this; check it before adding kind-specific behavior.
- **Sea level**: `SEA_LEVEL = 0`. Heights below 0 are submerged (and invisible if `matter.liquid`).
- **`commitBodyChanges`**: Always call after mutating `heights` / `colorArr` — otherwise the GPU sees stale data and normals.
- **Reusable scratch vectors**: Several modules keep `_xxxTmp` `THREE.Vector3()` instances at module scope to avoid allocation in the frame loop. Reuse them; don't create new vectors per-frame in hot code.
- **No build step**: Edits to `script.js` take effect on browser reload. No source maps, no transpile.
