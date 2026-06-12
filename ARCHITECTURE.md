# Architecture

> Map for navigating this project. The runtime is split into ES modules under `src/` — every module starts with a header comment saying what it owns, so `Grep` for a concept or skim the module map below and jump straight to the file.

The app is a **no-build** Three.js sandbox: `index.html` pulls Three.js from a CDN via an `importmap` and loads `src/main.js` as a module. Edits take effect on browser reload — no bundler, no transpile, no npm install.

---

## Files

| Path              | What it holds                                                                  |
| ----------------- | ------------------------------------------------------------------------------ |
| `index.html`      | Canvas, tabbed left panel, info panel (right), bottom nav, surface overlay, importmap. |
| `style.css`       | All styling. CSS variables drive the sci-fi HUD theme.                         |
| `src/`            | The whole runtime, ~50 ES modules (map below).                                 |
| `assets/`         | All GLB models: `character.glb` (avatar, three.js RobotExpressive), `satellite.glb` (probes), `lunar_base.glb` (colonies), `tree.glb`/`pine.glb`/`rock.glb` (surface props). |
| `ARCHITECTURE.md` | This file. Update the module map when modules move.                            |

---

## Module map (`src/`)

`main.js` is the entry point: it imports every module in dependency-safe order, issues the initial `loadStarSystem(findStarSystem('sol'))`, and runs the animate loop.

### `core/` — scene + shared primitives

| Module         | Responsibility |
| -------------- | -------------- |
| `constants.js` | Biome height bands, sea ice/steam thresholds, shared colors, `BIOME` enum, `TERRAIN_OCTAVES`, foam params. |
| `palettes.js`  | `PLANET_PALETTE`, `MOON_PALETTE`. |
| `utils.js`     | `smoothstep` and friends. |
| `scene.js`     | `scene`, `camera`, `renderer`, `controls` (OrbitControls), `sun` point light + shadow map, ambient/moon/sky lights. |
| `sun.js`       | `sunMesh` (plasma photosphere), `coronaMesh`, `plasmaTickUniforms` (ticked every frame, even paused). |
| `names.js`     | Random cosmic name generator; `systemName`. |

### `shaders/` — GLSL + material factories

| Module      | Responsibility |
| ----------- | -------------- |
| `gas.js`    | Atmosphere + full-gas shader (`uMode` 0/1), band-paint LUT (`GAS_BAND_COUNT = 16`), gas biomes, whirlpool features. |
| `plasma.js` | Star photosphere: domain-warped FBM, flares, distance whitening. |
| `corona.js` | Additive glow dome (impact-parameter falloff). |
| `ring.js`   | Planetary rings + `RING_INNER/OUTER_FACTOR`. |

### `framework/` — the body pipeline

| Module          | Responsibility |
| --------------- | -------------- |
| `state.js`      | **Central shared mutable state** (`bodies`, `planets`, `moons`, `probes`, `cities`, `focusedBody`, `viewMode`, brush/tool state, …) behind `set*` functions. See Conventions. |
| `archetypes.js` | `ARCHETYPES` (palette/amp/sea) + `ARCHETYPE_MATTER` (solid/liquid/gas/plasma + atmosphere tuning). |
| `terrain.js`    | `hashSeed`, `makeRNG`, sum-of-sines FBM basis (`buildTerrainBasis` / `sampleTerrainNoise`). |
| `materials.js`  | `onBeforeCompile` patches: ice self-glow, surface-walk ground detail, ocean waves + shoreline foam. |
| `climate.js`    | Climate model (`computeClimate`, `temperatureAtLatitude`), ocean climate coloring, `tempColor`/`fmtTemp`, `surfaceGravityG`. |
| `body.js`       | `createBody`, per-vertex write/color (incl. venusian branch + `CLIMATE_LAND_ZONES`), `applyMatterToBody`, `applyGasShell`, `applyRingsToBody`, `regenerateBody`, `recolorBody`, `refreshClimateColoring`, `applyBrushToBody`, `bakeOceanShore` (incl. the seabed texture the water patch samples). |

### `system/` — orbital mechanics + star systems

| Module           | Responsibility |
| ---------------- | -------------- |
| `orbits.js`      | Visible orbit ellipse lines (planets + satellites), `showSatelliteOrbits`. |
| `planets.js`     | `SOLAR_SYSTEM_SPEC`, planet registry, orbit advance, `updatePlanetRotation`, `spawnSolarPlanet`. |
| `lighting.js`    | `updateSunLightForFocus` (per-body `uSunDir`, shadow framing), `updateMoonLight`. |
| `starsystems.js` | `galaxy` catalog, procedural system generation, `loadStarSystem` / `unloadStarSystem` / `bootstrapSolSystem`, `viewLevel`. |

### `interaction/` — canvas input (orbit mode)

| Module       | Responsibility |
| ------------ | -------------- |
| `brush.js`   | Brush cursor ring, shared `raycaster`/`pointer`, `isBrushTool`. |
| `pointer.js` | Canvas pointerdown/move/up: raycast → brush strokes, city placement, gas whirlpools. |

### `entities/` — satellites + colonies

| Module      | Responsibility |
| ----------- | -------------- |
| `moons.js`  | Moons (full editable bodies): slots/orbit planes, `addMoon`, `updateMoons`. |
| `probes.js` | GLB satellites: template cache, `addSatellite`, `updateSatellites`. |
| `cities.js` | `lunar_base.glb` colonies pinned by unit-direction, day-side dimming. |

### `background/` — sky dressing

| Module         | Responsibility |
| -------------- | -------------- |
| `starfield.js` | 2000 background points (`starMat` opacity drives daylight fade). |
| `galaxy.js`    | Procedural Milky Way band, recentered on the camera each frame. |
| `eruptions.js` | Solar prominences: GPU particle bursts off the Sun. |

### `modes/` — focus + surface walk

| Module               | Responsibility |
| -------------------- | -------------- |
| `focus.js`           | `setFocus`/`setCityFocus`/`setProbeFocus`, `focusedCity`/`focusedProbe`, `updateFocusTracking`. |
| `surface/core.js`    | `surfaceState` (the big shared state object), pick mode, visit button, `buildLocalFrame`. |
| `surface/avatar.js`  | `character.glb` loading, clip state machine, blob shadow. |
| `surface/mode.js`    | `enterSurfaceMode`/`exitSurfaceMode` — camera snap/restore, atmosphere reconfig, attach/detach all fields. |
| `surface/sky.js`     | Aerial fog, underwater murk + `#underwaterOverlay`, atmospheric skylight ramp. |
| `surface/camera.js`  | Floating-origin shift (`updateSurfaceOrigin`), surface camera transform. |
| `surface/swim.js`    | Procedural swim stroke, `updateAstronaut` (pose/facing/animation per frame). |
| `surface/grass.js`   | Instanced grass + flowers, treadmill grid, ground sampling (`sampleGrassGround`, shared `_gr*`/`_g*` scratch). |
| `surface/rocks.js`   | Instanced rocks (desert/venusian), `resolveRockCollision`. |
| `surface/water.js`   | Local water patch: waves, depth shading, crest/shore foam, `waveHeightAtAvatar`. |
| `surface/ground.js`  | Ground micro-relief patch + footprint decals (`stampFootprint*`, `FOOTPRINT_GROUND`). |
| `surface/props.js`   | Real GLB props (trees/pines/rocks) on grass worlds. |
| `surface/walk.js`    | `stepSurfaceWalk` (WASD/sprint/jump/swim buoyancy), `sampleGroundRadius`, `tryJump`. |
| `surface/input.js`   | Surface-mode listeners: drag/pointer-lock look, wheel zoom, key handling, deploy buttons. |

### `ui/` — panels + HUD

| Module             | Responsibility |
| ------------------ | -------------- |
| `info-panel.js`    | Right telemetry panel: composition rollup, climate section, `updateInfoPanel` + throttled `updateLiveInfo`. |
| `controls.js`      | Tab switching, sculpt/biome/gas-paint controls, most left-panel DOM refs. |
| `atmo-rings.js`    | Atmosphere sliders, ring controls, `onRegenClick`, `sliderTo*` conversions. |
| `left-panel.js`    | `applyFocusToLeftPanel` — context-aware section visibility + slider sync. |
| `orbit-sliders.js` | Distance/speed/spin/size + satellite orbit-plane slider handlers. |
| `roster.js`        | `deployNewPlanet`, `removePlanetBody` (cascade), roster/moons/probes list renderers. |
| `nav.js`           | Bottom-nav hierarchy (`navUp`/`navDown`/`navSibling`), `setSystemFocus`, breadcrumb. |
| `naming.js`        | Inline rename for bodies/system, re-render fan-out. |
| `star-map.js`      | Galaxy/constellation overlays, drag, create/delete/travel. |
| `wire-up.js`       | **Deferred wiring** — see the TDZ note in Conventions. Imported last by `main.js`. |

---

## Module conventions

- **Shared mutable state lives in `framework/state.js`.** ES-module live bindings mean any module can *read* `focusedBody` directly via import, but assigning to an import is a TypeError — so every reassignable variable has a `set*` function (`setFocusedBody(b)`, `setViewMode('pick')`, …). A few module-local ones follow the same pattern (`setFocusedCity` in `modes/focus.js`, `setViewLevel` in `system/starsystems.js`, `setPlanetCurrentSeed` in `ui/info-panel.js`). Arrays/objects (`bodies`, `surfaceState`, `gasPaintColor`) are mutated in place and need no setters.
- **The ui/ modules form import cycles** (controls ↔ atmo-rings ↔ left-panel ↔ roster ↔ nav ↔ star-map ↔ starsystems …). A module evaluated mid-cycle must NOT touch another cycle member's `const`s at its own module scope — they are still in their temporal dead zone (TDZ) and throw `Cannot access 'x' before initialization`, which kills the whole app. Function *calls inside handlers* are always fine (they run later). Wiring that genuinely needs cross-cycle consts at init time lives in `ui/wire-up.js`, which `main.js` imports last. If you add module-scope statements to a ui/ module, prefer `document.getElementById(...)` over importing another module's element const.
- **`main.js` import order mirrors the original monolith's section order** — keep new modules in a sensible spot and keep `wire-up.js` last, followed only by the `loadStarSystem` bootstrap call.
- **`commitBodyChanges(body)`** — always call after mutating `heights` / `colorArr`, otherwise the GPU sees stale data and normals.
- **Reusable scratch vectors**: modules keep `_xxx` `THREE.Vector3` instances at module scope to avoid allocation in the frame loop (some are exported and shared across the surface modules — e.g. `grass.js`'s `_gr*` sampler outputs are read by rocks/ground/props). Reuse them; don't allocate per-frame in hot code.
- **`body.kind`**: `'planet'` or `'moon'`. Many UI branches gate on this.
- **Sea level**: `SEA_LEVEL = 0`. Heights below 0 are submerged (and invisible if `matter.liquid`).
- **GLSL injection**: injected varyings in `onBeforeCompile` patches are `#ifndef`-guarded because three.js can re-run the patch over an already-patched string (program variants) — bare declarations land twice and fail to compile.
- **No build step**: reload the browser to see changes. ES modules need HTTP — serve the project root (`npx serve . -l 3000`).

---

## Data model

In-memory state is held in plain object literals (no classes). Five collection arrays (all in `framework/state.js`) own the world:

```
bodies[]   // every renderable rock/gas/ice sphere (planets + moons). Index in this array is used by raycasting.
planets[]  // entries that wrap a body and add an orbit { distance, angle, speed, inclination, line }
moons[]    // entries that wrap a body and add an orbit around a parent body
probes[]   // GLB satellites in orbit around a planet (mesh-only — no editable surface)
cities[]   // markers pinned to a body via a unit-direction localPos
```

### Body — the core unit (planets and moons)

Created by `createBody({ kind, name, baseRadius, detail, palette, hasOcean })` in `framework/body.js`. Returned object's shape:

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
  glowArr,      // Float32Array(N)   — per-vertex emissive (ice self-glow)
  oceanMesh,    // SphereGeometry at baseRadius; hidden when matter.liquid === false
  gasMesh,      // SphereGeometry at baseRadius * gasThickness; uses gas shader
  plasmaMesh,   // SphereGeometry at baseRadius; animated star photosphere; hidden unless matter.plasma
  ringMesh,     // RingGeometry; planet-only feature
  matter: { solid, liquid, gas, plasma },  // gas: false | 'atmosphere' | 'full'
  gasMode: 'none' | 'atmosphere' | 'full',
  gasThickness, gasDensity, gasCoverage,
  rings:  { enabled, intensity },
  archetype,    // 'terrestrial' | 'gas_giant' | … (planets only)
  rotationSpeed,
  climate,      // { meanK, equatorK, poleK, spread, … } — cached by computeClimate()
  seabedTex,    // equirect DataTexture of seabed heights — sampled by the surface water patch
}
```

World radius at vertex `i` is `baseRadius * (1 + heights[i] * BODY_HEIGHT_SCALE)`. Heights are *relative* — a peak of `MAX_LAND_HEIGHT = 2.5` is ~6% of the body's radius regardless of scale.

### Planet entry — `{ body, orbit: { distance, angle, speed, inclination, line } }`

`line` is the visible orbit ellipse. Toggled via the System tab's "Show Orbits".

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
{ mesh, parent, name, seed, angle, inclination, node, size, distance, speed, slot, spin }
```

`mesh` is a clone of the loaded GLB (or a tiny fallback box until the GLB resolves).

### City entry — `{ body, name, localPos, mesh }`

`mesh` is a `lunar_base.glb` clone, Y-up along `localPos` at `baseRadius + CITY_SURFACE_LIFT`.

---

## How a frame runs

The loop is the bottom of `src/main.js`. Read it top to bottom for the canonical lifecycle:

1. `dt = clock.getDelta()`; `plasmaTime` always advances (stars never freeze).
2. If not `paused`: advance planet orbits, rotations, `gasTime` (cloud drift + ocean waves).
3. Always: `updateMoons`, `updateSatellites`, `updateEruptions`, `updateCityMarkers`, `updateSunLightForFocus`, `updateMoonLight`.
4. `updateFocusTracking` keeps the camera chasing the focused body's world position.
5. `controls.update()` (OrbitControls).
6. If `viewMode === 'surface'`: `updateSurfaceOrigin` → `stepSurfaceWalk` → `updateSurfaceCamera` → `updateAstronaut` → grass/rocks/water/ground/props updates → `updateSurfaceSkyEffects`.
7. If a brush stroke is active, `applyBrushToBody(activeBrushBody, lastHitLocal, dt)`.
8. Galactic band recentered on the camera; brightness follows the starfield fade.
9. Throttled (~10 Hz): `updateLiveInfo()`.
10. `renderer.render(scene, camera)`.

Pausing freezes orbits, spin, cloud drift, and waves; moons + probes + brush keep going (intentional — the user can sculpt without the world spinning out from under them).

---

## Subsystem walkthroughs

### Terrain — `regenerateBody` and the brush (`framework/body.js`, `framework/terrain.js`)

- `buildTerrainBasis(seedNum, count)` returns `count` direction + frequency + amplitude tuples — a sum-of-sines noise basis on the sphere. Seeded by `hashSeed(seedStr)`.
- `sampleTerrainNoise(basis, ux, uy, uz)` evaluates the basis at a unit direction. O(`TERRAIN_OCTAVES` = 24) per vertex.
- `regenerateBody(body, seedStr, amplitude, seaCoverage)` resamples noise per vertex, then *biases* heights so `seaCoverage` of them sit below 0. Submerged terrain is deepened by `OCEAN_DEPTH_BOOST` on liquid worlds (coastline unchanged).
- `applyBrushToBody(body, centerLocal, dt)` mutates heights in a spherical cap (angular radius = `brushRadius` radians). Falloff `(1 - t²)²`; clamped to `[MIN_LAND_HEIGHT, MAX_LAND_HEIGHT]`.

### Shaders — gas + rings (`shaders/gas.js`, `shaders/ring.js`)

- Per-body `ShaderMaterial`s, so each can have its own `uSunDir`.
- `GAS_FRAG` branches on `uMode`: `0` = atmosphere (noise-thresholded clouds, fresnel edge, wind drift), `1` = full gas (latitudinal banding + churn).
- `uOpaqueSky` is flipped on during surface mode for dense atmospheres so the sky reads as solid.
- Rings: one body-aligned thin disk; alpha falls off radially, darkened in the planet's shadow cone.

### Shaders — plasma (`shaders/plasma.js`, `shaders/corona.js`, `core/sun.js`)

- `makePlasmaMaterial()` is the emissive star surface used by `sunMesh` and any body with `matter.plasma`. Domain-warped value-noise FBM on the local unit direction: slow convection + fast bubbling, pulsing white-hot cells, sunspot lanes, random lava-burst flares, fresnel limb.
- **Distance whitening** (Sun only): bleaches toward white as the camera recedes, so the system view reads a bright white star.
- `makeCoronaMaterial()` — additive back-faced dome whose alpha is driven by the view ray's impact parameter; a restless red-orange glow, faking bloom without postprocessing.
- `plasmaTime` advances **every frame, paused or not**; the Sun + corona uniforms live in `plasmaTickUniforms` (`core/sun.js`).

### Temperature / climate model (`framework/climate.js`)

Derived, not stored — recompute whenever distance, archetype, or atmosphere changes. Three inputs: orbital distance, archetype, live atmosphere.

- `sunDistanceOf(body)`: planet uses its own `orbit.distance`; a moon inherits its parent's.
- `atmosphereFactor(body)`: live gas state → 0 (airless) … 1 (thick). Makes the Atmosphere sliders move the climate.
- `computeClimate(body)`: airless equilibrium `TEMP_REF_KELVIN * sqrt(TEMP_REF_DISTANCE / d)` (Earth-anchored), plus per-archetype `base` + `greenhouse × atmosphereFactor` (or internal-heat override for stars/lava/rogues). Equator-to-pole `airSpread` shrinks with atmosphere (`× (1 − HEAT_REDISTRIBUTION·atmo)`) — why Earth and its airless Moon differ in both mean and range. Cached on `body.climate`.
- `temperatureAtLatitude(body, latRad)`: `cos(lat)^1.6` pole→equator blend.
- `tempColor(k)` / `fmtTemp(k)` drive the info panel's climate section.

**Latitude biomes.** `CLIMATE_LAND_ZONES` (`framework/body.js`) lists per-archetype ordered land zones (warmest first) with `minTempC`, color, label, `beach`/`relief` flags. Only listed archetypes vary (today: `terrestrial` — jungle → grass → tundra → ice). `colorBodyVertex` computes per-vertex temp via `vertexTempC` (latitude gradient − elevation lapse), `pickLandZone` selects the zone; beach/relief/snow cues layer on top. Hand-painted biomes and non-listed archetypes are untouched.

**Ice self-glow.** The body material is patched (`framework/materials.js`) with a per-vertex emissive `uGlowColor * aGlow`; `colorBodyVertex` writes `body.glowArr` (= `zone.glow` for ice, 0 elsewhere), so only ice self-lights and night sides stay black.

**Bootstrap ordering.** The first paint runs with `climate` still null (plain bands); after init, `setClimateReady(true)` + a repaint pass gives every body its zones. `regenerateBody` refreshes climate before its color loop; `refreshClimateColoring(body)` runs from the distance/atmosphere sliders and after `deployNewPlanet`.

### Surface walk (`modes/surface/*`)

Single state variable, `viewMode` (`framework/state.js`): `'orbit' | 'pick' | 'surface'`.

- **orbit** (default): OrbitControls. Brush works. `VISIT SURFACE` → `enterPickMode` (`surface/core.js`).
- **pick**: OrbitControls disabled; next left-click on the focused body → `enterSurfaceMode` (`surface/mode.js`). Bodies with `matter.solid === false` fail eligibility.
- **surface**: camera rides the body in body-local coords (`surfaceState`). Mouse-look (Pointer Lock), scroll = FOV zoom, WASD walks (Shift sprints). `stepSurfaceWalk` (`surface/walk.js`) moves along the tangent plane; `sampleGroundRadius` raycasts the real terrain height; the local frame is parallel-transported so yaw stays consistent. `updateSurfaceCamera` re-reads the body's world matrix every frame, so spin/orbit wheel the sky overhead.

**Avatar** (`surface/avatar.js`): `character.glb`, clip state machine `idle | walk | run | jump | swim` with fuzzy clip-name matching; blob shadow disc does the grounding.

**Swimming** (`surface/walk.js` + `surface/swim.js`): when the seabed drops > ~1 eye-height below sea level (hysteresis), `surfaceState.swimming` flips; `standRadius` eases to just under the waterline and rides `waveHeightAtAvatar` (`surface/water.js`) so the swimmer bobs with the rolling waves. Prone paddling pose; jumps disabled.

**Floating origin** (`surface/camera.js`): planets sit ~900 units out while the avatar is ~0.01 units tall; skinned-mesh bones upload as float32 and tremble at those coordinates. `updateSurfaceOrigin` slides the whole scene so the walker sits at the world origin. Scene children positioned from world-space values must subtract `scene.position` (avatar pivot, milkyway, moonlight rig, skylight do).

**Water patch** (`surface/water.js`): a local high-res grid replacing the global ocean sphere during the visit — rolling waves (`wv()` mirrored by `waveHeightAtAvatar` for buoyancy), per-fragment depth shading from `body.seabedTex` (baked in `bakeOceanShore`), crest + shoreline crash foam, fresnel, micro-ripple glints.

**Footprints** (`surface/ground.js`): boot-print decals evaluated in the `groundPatch` fragment shader — an oriented boot SDF that darkens soil, lightens a displaced rim, and bends the shading normal. Prints live in the ground-fixed treadmill coords (`grassU/grassV`), settle over `FOOT_LIFE` (~70 s) in a `FOOT_N`-slot ring buffer. `stampFootprintsFromStep` meters alternating prints every half-stride; a jump landing punches both boots. `FOOTPRINT_GROUND` gates which archetypes print. `window.footDiag()` is the console diagnostic.

**Sky / underwater** (`surface/sky.js`): aerial-perspective `FogExp2` tinted by the archetype sky; submersion is judged from the **camera's** body-local radius vs the lifted waterline — underwater swaps fog to a liquid tint and raises the `#underwaterOverlay` full-screen tint (covers the fog-immune sky shaders). The atmospheric skylight (HemisphereLight in `core/scene.js`) scales with `(density × coverage)^1.5` and sun elevation, so Venus-thick shells get overcast daylight while airless worlds get none.

**Surface lighting gotchas**: the visited body stops sampling the sun's shadow map (`receiveShadow = false`, restored on exit) — one system-scale shadow texel spans the whole landscape and self-shadows it black at grazing angles. `window.grassDiag()` dumps grass-field state.

`exitSurfaceMode` restores: camera fov/near/far, gas mesh side + `uOpaqueSky`, the body's `receiveShadow`, skylight off, floating origin zeroed.

### Focus → left panel (`modes/focus.js`, `ui/left-panel.js`)

`focusedBody` (+ `focusedCity`/`focusedProbe`) drive everything visible. `applyFocusToLeftPanel()` shows/hides tabs based on each tab button's `data-focus` attribute in `index.html`. `setFocus`/`setCityFocus`/`setProbeFocus` retarget OrbitControls and re-render the lists.

### Star systems + maps (`system/starsystems.js`, `ui/star-map.js`)

The scene holds one star system at a time. `galaxy` is a constellations → star-systems catalog (session-only); Sol is the immutable preset rebuilt from `SOLAR_SYSTEM_SPEC`, procedural systems cache their generated `planetSpecs`. `loadStarSystem` = unload (dispose every planet/moon/probe/city) + bootstrap + `finalizeSystemLoad`. The maps are DOM overlays; `viewLevel` (`'system' | 'constellation' | 'galaxy'`) tracks where the user is; Esc steps down a level.

### GLB loading

All models live in `assets/`: `satellite.glb` (probes), `lunar_base.glb` (cities), `character.glb` (avatar), `tree/pine/rock.glb` (props) — all lazily loaded once, normalized/grounded, then `.clone(true)`d per instance. Fallback primitives show until the load resolves.

---

## DOM element index (`index.html`)

Anything referenced from JS by id, grouped by panel:

| Panel              | ids                                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Tabs (left)        | `tab-classify`, `tab-sculpt`, `tab-environment`, `tab-colonies`, `tab-satellites`, `tab-system`                                 |
| Classify           | `archetypeSelect`, `seedInput`, `randomSeedBtn`, `genAmp`, `genSea`, `regenBtn`                                                  |
| Sculpt             | `sculptRaise`, `sculptLower`, `brushRadius`, `brushStrength`                                                                    |
| Environment        | `biomeSelect`, `brushRadiusB`, `atmoThick`, `atmoDensity`, `atmoCoverage`, `atmoComplexWinds`, `atmoCloudDrift`, `ringsEnabled`, `ringsIntensity` |
| Colonies           | `cityNameInput`, `cityList`                                                                                                     |
| Satellites         | `moonsList`, `addMoon`, `probesList`, `addProbe`                                                                                |
| System             | `planetList`, `deployPlanetBtn`, `bodyDistInput`, `bodySpeedInput`, `bodyMoonSpeedInput`, `bodySpinInput`, `bodySizeInput`, `bodyInclInput`, `bodyNodeInput`, `bodyRetrogradeInput` |
| Dynamics           | `showOrbits`, `showSatelliteOrbits`, `pauseRot`                                                                                 |
| Info panel (right) | `infoBodyName`, `infoSubtitle`, `infoComposition`, `infoClimateSection`, `infoTempMean`, `infoTempRangeRow`, `infoTempRange`, `infoTempBar`, `infoPeak`, `infoVerts`, `infoMoons`, `infoDayPeriod`, `infoDayTime`, `infoOrbit*` |
| Bottom nav         | `navBreadcrumb`, `navFocusLevel`, `navFocusName`, `navFocusSub`, `navUp/Down/Left/Right`, `navRandomBtn`, `navVisit`            |
| Surface overlay    | `surfaceOverlay`, `surfaceLocationName`, `surfaceExitBtn`, `surfaceCrosshair`, `surfaceHint`, `underwaterOverlay`               |
| Star map           | `mapOverlay`, `mapGalaxyArt`, `mapField`, `mapTitle`, `mapEyebrow`, `mapNewBtn`, `mapHint`, `systemTransition`                  |
| Misc               | `c` (the WebGL canvas), `pickHint`, `pickToast`, `scanOverlay`                                                                  |

---

## Where things are — function quick-reference

| Looking for…                          | Module |
| ------------------------------------- | ------ |
| `createBody`, `colorBodyVertex`, `commitBodyChanges`, `regenerateBody`, `applyBrushToBody`, `bakeOceanShore`, `applyMatterToBody` | `framework/body.js` |
| `computeClimate`, `colorOceanByClimate`, `tempColor`, `surfaceGravityG` | `framework/climate.js` |
| `makeGasMaterial`, `ensureGasPaint`, `randomizeGasBands`, `addGasVortex` | `shaders/gas.js` |
| `makePlasmaMaterial` / `makeCoronaMaterial` | `shaders/plasma.js` / `shaders/corona.js` |
| `spawnSolarPlanet`, `registerPlanet`, `updatePlanetOrbits`, `updatePlanetRotation` | `system/planets.js` |
| `refreshOrbitLine`, `setSatelliteOrbitLinesVisible` | `system/orbits.js` |
| `updateSunLightForFocus`, `updateMoonLight` | `system/lighting.js` |
| `loadStarSystem`, `createStarSystem`, `generateStarSystemSpec`, `bootstrapSolSystem` | `system/starsystems.js` |
| `addMoon` / `addSatellite` / `addCity` | `entities/moons.js` / `probes.js` / `cities.js` |
| `setFocus`, `updateFocusTracking` | `modes/focus.js` |
| `enterPickMode`, `surfaceState`, `isBodyVisitable` | `modes/surface/core.js` |
| `enterSurfaceMode` / `exitSurfaceMode` | `modes/surface/mode.js` |
| `stepSurfaceWalk`, `sampleGroundRadius`, `tryJump` | `modes/surface/walk.js` |
| `stampFootprint`, `footprintStrengthHere` | `modes/surface/ground.js` |
| `waveHeightAtAvatar`, `buildWaterPatch` | `modes/surface/water.js` |
| `updateInfoPanel`, `updateLiveInfo`, `computeBodyStats` | `ui/info-panel.js` |
| `applyFocusToLeftPanel` | `ui/left-panel.js` |
| `deployNewPlanet`, `removePlanetBody`, `renderPlanetList` | `ui/roster.js` |
| `navUp`, `navDown`, `setSystemFocus`, `renderNavBodies` | `ui/nav.js` |
| `setBodyName`, `commitFocusName` | `ui/naming.js` |
| `openGalaxyMap`, `travelToSystem` | `ui/star-map.js` |
| `generateName` | `core/names.js` |

---

## Verification & tooling

There is no test suite; verification is headless-browser based. Helper scripts live in `.claude/` (untracked):

- `verify-refactor.cjs` — boot smoke test: zero console errors, orbit view, surface landing + walk + jump, star map. Run with `NODE_PATH=$(npm root -g) node .claude/verify-refactor.cjs` (needs the globally installed `playwright`).
- `verify-water.cjs` / `verify-venus.cjs` / `verify-swim.cjs` / … — feature-specific scenarios with screenshots.
- In-app console diagnostics: `window.grassDiag()`, `window.footDiag()`.
- Static checks (ESLint lives in `.claude/tooling/`): `node .claude/lint-report.cjs` (no-undef + no-import-assign over `src/`), `node .claude/check-imports.cjs` (every named import resolves to a real export), `node .claude/find-tdz.cjs` (heuristic scan for the import-cycle TDZ hazard described in Conventions).
