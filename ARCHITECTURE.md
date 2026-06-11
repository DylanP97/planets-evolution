# Architecture

> Map for navigating this project. Optimized for greppability — every section here matches a `// ====== Section ======` banner in `script.js`, so you can jump from a topic to the code in one search.

The project is intentionally a flat, single-file Three.js app (`script.js`, ~8,600 lines) plus `index.html` and `style.css`. No build step, no bundler. The HTML uses an `importmap` to pull Three.js from a CDN and loads `script.js` as a module.

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
| 1   | Planet constants              | 54–162      | `BASE_RADIUS`, biome height bands, color palette, `BIOME` enum.                                         |
| 2   | Scene                         | 163–225     | `scene`, `camera`, `renderer`, `controls`, `sun` PointLight, `sunMesh`. Mouse buttons configured here.  |
| 3   | Palettes                      | 226–242     | `PLANET_PALETTE`, `MOON_PALETTE`.                                                                       |
| 4   | Body framework                | 243–281     | `BODY_HEIGHT_SCALE`, `MAX/MIN_LAND_HEIGHT`, the `bodies` registry, `smoothstep`.                        |
| 5   | Gas shader                    | 282–727     | GLSL for atmosphere + full-gas modes (`uMode = 0 \| 1`). `makeGasMaterial()` factory.                   |
| 5b  | Plasma shader                 | 728–1224    | GLSL for the animated star photosphere ("lava ocean"). `makePlasmaMaterial()` + `makeCoronaMaterial()`; lights the Sun + corona halo here, builds `plasmaTickUniforms`. |
| 6   | Ring shader                   | 1225–1378   | GLSL for planetary rings. `RING_INNER/OUTER_FACTOR`, `makeRingMaterial()`.                              |
| 7   | Body creation                 | 1379–1851   | `createBody()`, vertex writers, `applyBrushToBody()`, `commitBodyChanges()`. The body `MeshStandardMaterial`'s `onBeforeCompile` also carries the **surface-walk ground detail** (`uSurfaceDetail` / `uBodyToView`): procedural relief-normal + albedo mottle that switch on only while standing on the body (off = stock orbit render). |
| 8   | Terrain generation            | 1852–1911   | Hash/RNG, `buildTerrainBasis`, `sampleTerrainNoise` (sum-of-sines FBM).                                 |
| 9   | Archetypes                    | 1912–2050   | `ARCHETYPES`, `ARCHETYPE_MATTER`, `applyMatterToBody()`. The venusian palette is near-black basalt; its land paint is a dedicated branch (`venusianLandColor`, section 7): elevation picks slab flats → volcanic regolith/dark soil → gravel + angular rock → pale highland tessera, broken by a coherent slab-plate field + index-hash gravel speckle. |
| 10  | Gas / rings appliers + regen  | 2051–2302   | `applyGasShell`, `applyRingsToBody`, `regenerateBody`.                                                  |
| 11  | Planets (sun orbits)          | 2303–2347   | `planets[]`, `DEFAULT_SPIN`, `updatePlanetOrbits`, `registerPlanet`.                                    |
| 12  | Orbit ellipse trajectories    | 2348–2497   | The visible orbit rings: `buildOrbitLineGeometry`, `refreshOrbitLine`, `disposeOrbitLine`.              |
| 13  | Solar system bootstrap        | 2498–2568   | `SOLAR_SYSTEM_SPEC`, `spawnSolarPlanet`, initial `solarBodies[]`. Default focus = `solarBodies[2]`.     |
| 14  | Brush                         | 2569–2626   | `brushRadius`, `brushStrength`, brush ring mesh, `updateBrushRing`.                                     |
| 15  | Pointer handling              | 2627–2741   | Pointerdown/move/up wiring on the canvas. Raycast → `applyBrushToBody`.                                 |
| 16  | Moons                         | 2742–2881   | `MOON_*` constants, `moons[]`, slot allocator, `addMoon`, `updateMoons`.                                |
| 17  | Probes (satellites)           | 2882–3069   | `MAX_PROBES`, `probes[]`, `loadSatelliteTemplate` (GLB), `addSatellite`, `updateSatellites`.            |
| 18  | Cities                        | 3070–3238   | `lunar_base.glb`, `cities[]`, `addCity`, `loadCityTemplate`, `updateCityMarkers`.                      |
| 19  | Starfield                     | 3239–3265   | 2000 background points at r ≈ 2200.                                                                     |
| 19a | Galactic band                 | 3266–3399   | Procedural Milky Way band behind the starfield.                                                          |
| 19b | Eruptions                     | 3400–3589   | Solar prominences (Sun only — planets/moons don't erupt). `eruptions[]`, `spawnEruption`, `updateEruptions`. Each is a GPU particle burst (`THREE.Points` + `ERUPT_VERT`/`ERUPT_FRAG`: ballistic droplets integrated on the GPU from a `uTime` uniform, cooling hot→cool) plus a `flameTex` vent-flash sprite, parented to the sun pseudo-body's group (`sunMesh`). |
| 20  | Planet rotation               | 3590–3601   | `updatePlanetRotation` — spins each planet by its `rotationSpeed`.                                      |
| 21  | Sun light for focus           | 3602–3711   | `updateSunLightForFocus` refreshes per-body `uSunDir` uniforms (atmosphere + rings).                    |
| 22  | Focus                         | 3712–3812   | `focusedBody`, `focusedCity`, `setFocus`, `setCityFocus`, `updateFocusTracking` (chase target).         |
| 22b | Temperature / climate         | 3813–3971   | `ARCHETYPE_CLIMATE`, `sunDistanceOf`, `computeClimate`, `temperatureAtLatitude`, `tempColor`. Distance + archetype → surface temp; latitude hook for future biomes. |
| 22c | Surface gravity model         | 3972–3996   | `surfaceGravityG` — per-body surface gravity (Earth = 1 g); feeds surface-walk jump + locomotion tuning. |
| 23  | Info panel                    | 3997–4379   | Telemetry pane on the right: composition rollup, peak, **climate (mean + equator/pole)**, day period, orbit period. |
| 24  | Random names                  | 4380–4418   | `COSMIC_WORDS`, `generateCosmic`, `generateName('planet' \| 'moon' \| 'system')`.                       |
| 25  | UI (tabs + sliders)           | 4419–4699   | DOM lookups; tab switching; slider → value conversions.                                                 |
| 26  | Atmosphere sliders            | 4700–4760   | `applyAtmoSliderToFocus` (thickness, density, coverage).                                                |
| 27  | Ring controls                 | 4761–4822   | `applyRingsSliderToFocus`.                                                                              |
| 28  | Context-aware left panel      | 4823–5185   | `applyFocusToLeftPanel` — what tabs/sections are visible per focus kind.                                |
| 29  | Body orbit sliders            | 5186–5293   | Distance / orbit-speed / spin / size sliders (planet vs moon).                                          |
| 30  | Add / Remove planet           | 5294–5610   | `deployNewPlanet`, `removePlanetBody`, `renderPlanetList`, moons/probes list renderers.                 |
| 31  | Hierarchy navigation          | 5611–5846   | Bottom-nav arrows: `navUp`, `navDown`, `navSibling`, `renderNavBodies`.                                 |
| 32  | Surface walk                  | 5847–8047   | `enterPickMode` → click → `enterSurfaceMode` → `updateSurfaceCamera`. State in `surfaceState`. Avatar = `character.glb` (clip state machine incl. swim; blob shadow); `updateSurfaceOrigin` = floating-origin shift (skinned-mesh float32 fix). Also the surface-detail systems, each `build/attach/detach/update*`: astronaut avatar, `grassField`, `flowerField` (piggybacks the grass grid), `rockField` (desert + venusian; per-archetype tint via `ROCK_GROUND_TINT`), water patch (waves + crest/shore foam + fresnel + micro-ripple glints), **`groundPatch`** (near-field micro-relief patch; also hosts the **footprint decals** — boot prints stamped on soft-soil worlds, see the Surface-walk walkthrough), the **atmospheric skylight** (`surfaceSkyLight` — thick-atmosphere diffuse daylight, ramped by sun elevation in `updateSurfaceSkyEffects`), the **aerial-perspective fog + underwater murk** (`updateSurfaceSkyEffects` — submersion judged from the CAMERA's body-local radius vs the lifted waterline; liquid-tinted `FogExp2` + the `#underwaterOverlay` full-screen tint that covers the fog-immune sky shaders), wave-riding swim buoyancy (`waveHeightAtAvatar` mirrors the patch shader's `wv()`), `stepSurfaceWalk`, `sampleGroundRadius`. |
| 33  | Surface input                 | 8048–8248   | Mouse-look (Pointer Lock), scroll-zoom, WASD/arrow walking (`stepSurfaceWalk`), the satellite/moon "deploy" buttons.    |
| 34  | Renaming                      | 8249–8336   | `setBodyName`, `setSystemName`, `commitFocusName`. Triggers re-render fan-out.                          |
| 34  | Star-system load / unload     | 8337–8616   | Save/serialize + load/rebuild + teardown of a whole star system.                                        |
| 34b | Star-map overlays             | 8617–8929   | Galactic star-map overlay.                                                                              |
| 35  | Init + Resize                 | 8930–8936   | Window-resize listener (and seed moons / final `setSystemFocus()` just above it).                       |
| 36  | Animate                       | 8937–end    | The frame loop. Drives orbits, rotations, gas time, cities, lights, surface camera, render.             |

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
  climate,      // { meanK, equatorK, poleK, equilibriumK, spread, distance } — cached by computeClimate(); see Temperature model
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
{ body, name, localPos, mesh }   // mesh is a Group; lunar_base.glb clone, Y-up along localPos at baseRadius + CITY_SURFACE_LIFT
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
- The frag shader is a domain-warped value-noise FBM sampled on the local unit direction (so the pattern is radius-independent): a slow swirling convection layer plus a faster bubbling layer, a time-shifting threshold that lifts and pulses bright white-hot cells, dark sunspot lanes in the troughs, random **lava-burst flares** (`flares()` — `NFLARES` slots that swell at a random spot then pop into an expanding shock ring), and a faint fresnel limb term. Colors ramp deep-orange → orange → yellow → white-hot; `uBright` and `uFlares` scale emission and flare strength. The Sun overrides the colors toward yellow-white and bumps `uBright`.
- **Distance whitening** (`uWhiten`/`uWhitenNear`/`uWhitenFar`, on for the Sun only): the surface bleaches toward white as the camera recedes (`distance(cameraPosition, vCenter)`), so from system view the disc reads as a bright white star and the orange convection detail only shows up close.
- The Sun also gets `makeCoronaMaterial()` — an additive back-faced shell (`coronaMesh`) whose alpha is driven by the view ray's **impact parameter** (perpendicular distance from the star center), so it's a soft glow *dome* fading outward, not a hard fresnel "bubble". It's a **restless red-orange** glow: a per-direction phase + layered sines make it writhe/pulse unevenly around the limb rather than breathing as one steady ring. Fakes bloom without a postprocessing pass.
- The gas-giant (`uMode=1`) path reuses the same flowing-noise trick: a small time-scrolling turbulent domain warp churns the bands so gas planets animate too (kept subtle so the latitudinal banding still reads).
- `uTime` for the Sun, corona, and every visible plasma body is advanced by `plasmaTime` in the animate loop **every frame, paused or not** — a star never freezes (unlike `gasTime`, which stops on pause). The Sun + corona uniforms are collected in `plasmaTickUniforms`.

### Temperature / climate model

A body's surface temperature is derived, not stored as input — recompute it whenever distance, archetype, **or atmosphere** changes (orbit-distance slider, regen, atmosphere sliders). Three inputs drive it: orbital distance, archetype, and the live atmosphere.

- `sunDistanceOf(body)` resolves the body's effective distance from the star: a planet uses its own `orbit.distance`; a moon inherits its parent planet's orbital distance (its small local orbit is ignored).
- `atmosphereFactor(body)` reads the body's *live* gas state → `0` (airless) … `1` (thick/dense). A full-gas giant is `1`; an `'atmosphere'` shell grades by `gasDensity` plus the reach of `gasThickness` above the surface. This is what makes the Atmosphere sliders move the climate.
- `computeClimate(body)` starts from the **airless** equilibrium `TEMP_REF_KELVIN * sqrt(TEMP_REF_DISTANCE / d)` (anchored at Earth's orbit ≈ −18°C — Earth *without* its greenhouse; flux ∝ 1/d², blackbody re-radiates at T ∝ flux^¼). Each archetype in `ARCHETYPE_CLIMATE` then adds a fixed `base` (albedo/intrinsic) plus `greenhouse × atmosphereFactor` warming, or an internal-heat `override` (stars, lava, sunless rogues). The equator-to-pole `airSpread` is *shrunk* by the atmosphere (`× (1 − HEAT_REDISTRIBUTION·atmo)`) — so airless worlds keep a brutal gap and thick envelopes nearly erase it. **This is why Earth (atmosphere) and its Moon (none) at the same distance differ in both mean and range.** Cached on `body.climate` as `{ meanK, equatorK, poleK, atmosphere, … }`. Moons with no archetype default to `moon_like`.
- `temperatureAtLatitude(body, latRad)` returns temperature at a latitude: `cos(lat)^1.6` blends pole → equator so the tropics stay broad and the cold collapses onto the caps. Latitude on the icosphere is `asin(unitDir.y)`.
- `tempColor(k)` / `fmtTemp(k)` drive the Info panel's Climate section (mean readout + equator/pole row + a pole→equator gradient bar). `renderClimateSection` is hidden for probes and the system view; the distance and atmosphere slider handlers call it directly for a live update without a full panel re-render.

**Latitude biomes (climate coloring).** On diverse archetypes the *vegetated land* band isn't one color — it shifts with latitude. `CLIMATE_LAND_ZONES` (section 1) lists, per archetype, ordered land zones (warmest first) with a `minTempC` floor, a color, a composition label, and `beach`/`relief` flags. Only archetypes listed there vary; everything else (desert, lava, …) keeps its plain palette bands **unchanged**. Today only `terrestrial` is populated: jungle → grass → tundra → ice. `grass` reuses the palette green so temperate land is identical to before; ice/tundra/jungle are the new biomes.

  `colorBodyVertex` (and `computeBodyStats`, so the composition panel always agrees) computes a per-vertex surface temperature via `vertexTempC(body, i)` — `cos(lat)^1.6` between `body.climate.poleK`/`equatorK`, minus `CLIMATE_LAPSE_C` × elevation so peaks run colder — then `pickLandZone` selects the zone. The usual elevation cues still layer on top: a sandy shore at the waterline (`beach`), rock relief on high ground (`relief`), and a snow cap above `ROCK_TOP`. The result is a believable Earth zonation (~jungle 0–30°, grass 30–50°, tundra 50–65°, ice poleward) and altitude zonation on equatorial mountains. Untouched: ocean color, hand-painted biomes (those take their own `colorBodyVertex` branch), and non-listed archetypes.

  **Ice self-glow.** Ice sits at the poles, where the sun only ever grazes, so pure diffuse shading crushes any ice color to grey. To fix that, the body's `MeshStandardMaterial` is patched in `onBeforeCompile` to add a per-vertex emissive term `uGlowColor * aGlow`. `aGlow` is a geometry attribute (`body.glowArr`) written by `colorBodyVertex` (= `zone.glow` for ice, 0 elsewhere, cleared each repaint and flagged dirty in `commitBodyChanges`); `uGlowColor` is `ICE_GLOW_COLOR` (section 1). Ordinary terrain keeps `aGlow = 0`, so the night side stays black — only ice self-lights, reading as bright crystal even unlit.

  Ordering matters: `colorBodyVertex` only *reads* `body.climate` (a plain object) and the section-1 `CLIMATE_LAND_ZONES` — it never calls the climate *functions* in section 22b, which would be in their temporal dead zone during the bootstrap paint. So the bootstrap paints plain bands (climate still null), then a module-scope `climateReady` flag is flipped by the post-init pass (end of init), which computes every body's climate and repaints the solid planets with their zones. After that, `regenerateBody` refreshes climate before its color loop; `refreshClimateColoring(body)` (= recompute + `recolorBody`) runs from the distance/atmosphere slider `onchange` and after `deployNewPlanet` registers a planet's real orbit.

### Surface walk — the three modes

Single state variable, `viewMode`, gates everything: `'orbit' | 'pick' | 'surface'`.

- **orbit** (default): OrbitControls drive the camera. Brush works. Click `VISIT SURFACE` button → `enterPickMode`.
- **pick**: OrbitControls disabled. Next left-click on the focused body's mesh → `enterSurfaceMode`. Bodies fail the eligibility check if `matter.solid === false` (gas/ice giants).
- **surface**: Camera attached to the body's surface in body-local coords (`surfaceState.localEye`, etc.). Mouse movement = look (Pointer Lock), scroll = FOV zoom, **WASD / arrow keys walk** (Shift sprints). `stepSurfaceWalk` moves `localEye` along the tangent plane, then `sampleGroundRadius` casts a ray straight down at the mesh to find the real terrain height under the new spot (seabeds are real basins — wading off a beach sinks below sea level); the eye lerps to `support + eyeHeight` so it rises over mountains instead of clipping through them. The local frame is parallel-transported across the surface so yaw stays consistent. `updateSurfaceCamera` then reads the body's *current* world matrix every frame, so spin and orbit naturally wheel the sky overhead.

**Avatar**: `character.glb` (three.js RobotExpressive — colored, rigged) loaded once by `loadAstronaut`, driven by a clip state machine `idle | walk | run | jump | swim` (`setAstronautAction`, fuzzy clip-name matching so a Mixamo GLB can be swapped in; `jump`/`wave` are `LoopOnce` one-shots, and a wave plays on each landing). A radial-gradient **blob shadow** disc under the feet does the grounding (the sun's system-scale shadow map can't resolve the figure); it stays on the ground and fades as the body leaps.

**Swimming**: on a water world, when the seabed drops > ~1 eye-height below sea level (with hysteresis), `surfaceState.swimming` flips on and `standRadius` — the support radius the eye/feet/camera all ride — eases from `groundRadius` to just under the waterline. The avatar blends into a prone paddling pose (procedural tilt + bob; the walk clip slowed doubles as the stroke), movement halves, jumps are disabled, and the head stays above water so the underwater fog doesn't trigger.

**Floating origin**: planets sit up to ~900 world units out while the avatar is ~0.01 units tall, and skinned-mesh bone matrices upload as float32 — at those coordinates the rig visibly trembles at idle. `updateSurfaceOrigin` (called first thing each surface frame) slides the whole scene so the walker sits at the world origin. Scene children positioned from *world-space* values must subtract `scene.position` (the avatar pivot, the milkyway skybox, the moonlight rig, and the `surfaceSkyLight` do).

**Footprints** (soft-soil worlds): walking stamps boot prints into the ground. Each print is a decal evaluated in the `groundPatch` **fragment shader** (no extra meshes / no z-fighting): an oriented boot SDF (rounded sole + heel + tread bars) that darkens the soil, lightens a displaced-soil rim, and bends the shading normal into a soft depression. Prints live in the same ground-fixed treadmill coords (`grassU/grassV`) as the patch's micro-relief, so they stay put as the avatar walks away, and settle (fade) over `FOOT_LIFE` (~70 s) in a `FOOT_N`-slot ring buffer (`uFoot` vec4 array: u, v, yaw, fade). `stampFootprintsFromStep` meters alternating left/right prints every half-stride (multiple per frame are back-placed along the heading so slow frames keep even spacing); a jump landing punches both boots at once. `FOOTPRINT_GROUND` gates which archetypes print and how strongly (venusian soil full strength, its slab flats faint; desert + moon_like also print). `window.footDiag()` is the console diagnostic. GOTCHA: injected GLSL varyings are `#ifndef`-guarded because three.js can re-run `onBeforeCompile` over an already-patched string (program variants) — bare declarations land twice and fail to compile.

**Surface lighting**: while walking, two adjustments keep the ground readable and seam-free. (1) `surfaceSkyLight` — a HemisphereLight tinted by the body's `skyTint` whose base strength scales with the live gas envelope (`(density × coverage)^1.5`), so a Venus-thick shell gets bright, near-shadowless overcast daylight (the near-black basalt would otherwise crush to silhouette) while Earth-like shells get a negligible fill and airless worlds none; ramped by sun elevation each frame so night still falls. (2) The visited body's mesh stops sampling the sun's shadow map (`receiveShadow = false`, restored on exit, `material.needsUpdate` both ways): one system-scale shadow texel spans the whole landscape, so at grazing sun angles the terrain self-shadowed to black while the shadow-free `groundPatch` floating above it stayed lit — a glaring circular seam. (The patch itself also never receives shadows, same reason as the water patch.)

Returning to orbit (`exitSurfaceMode`) restores: camera `fov`/`near`/`far`, the gas mesh's side (`DoubleSide` → `BackSide` again), any `uOpaqueSky` override, the body's `receiveShadow`, the skylight (off), and zeroes the floating-origin shift.

### Focus → left panel

`focusedBody` (and `focusedCity`) drive everything visible:

- `applyFocusToLeftPanel()` shows/hides tabs based on each tab button's `data-focus` attribute (in `index.html`).
- Per kind: planets get Classify + Sats; moons share Sculpt + Envir + Colony with planets; both kinds and "no focus" (system view) show the System tab.
- When the focused body changes, `setFocus`/`setCityFocus` retarget OrbitControls toward the new world position, re-render every list, and refresh the visit-button state.

### Probes — GLB loading

The satellite GLB at `3d_objects/satellite.glb` is loaded *lazily, once*. `loadSatelliteTemplate()` caches a normalized template (scaled so its longest dimension = `PROBE_BASE_SIZE`). Each new probe `.clone(true)`s the template. Before the GLB resolves, probes get a fallback box mesh.

`lunar_base.glb` (project root) follows the same pattern for cities: `loadCityTemplate()` grounds the model (bottom at local y=0), scales to `CITY_BASE_SIZE`, and each colony `.clone(true)`s into its group. A small gold cube shows until load completes.

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
| Dynamics           | `showOrbits`, `showSatelliteOrbits`, `pauseRot`                                                                                 |
| Info panel (right) | `infoBodyName`, `infoSubtitle`, `infoComposition`, `infoClimateSection`, `infoTempMean`, `infoTempRangeRow`, `infoTempRange`, `infoTempBar`, `infoPeak`, `infoVerts`, `infoMoons`, `infoDayPeriod`, `infoDayTime`, `infoOrbit*` |
| Bottom nav         | `navBreadcrumb`, `navFocusLevel`, `navFocusName`, `navFocusSub`, `navUp/Down/Left/Right`, `navRandomBtn`, `navVisit`            |
| Surface overlay    | `surfaceOverlay`, `surfaceLocationName`, `surfaceExitBtn`, `surfaceCrosshair`, `surfaceHint`, `underwaterOverlay` (full-screen submerged tint) |
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
| `colorBodyVertex`        | 671   | Writes vertex `i`'s color from height + biome + palette + climate land zone.          |
| `vertexTempC`            | —     | Surface temp (°C) at a vertex: climate latitude gradient − elevation lapse.            |
| `pickLandZone`           | —     | Choose the `CLIMATE_LAND_ZONES` biome for a temperature (shared by color + stats).     |
| `commitBodyChanges`      | 782   | Marks `position` and `color` attributes dirty + recomputes bounds/normals.            |
| `applyBrushToBody`       | 790   | Single brush stroke (one frame). Spherical-cap falloff, height-clamped.               |
| `hashSeed`               | 834   | FNV-ish string → uint32 hash. Deterministic across runs.                              |
| `makeRNG`                | 842   | Mulberry32-style PRNG from a seed int.                                                |
| `buildTerrainBasis`      | 855   | Builds a noise basis (direction + freq + amp tuples).                                 |
| `sampleTerrainNoise`     | 879   | Sums the basis at a unit direction.                                                   |
| `applyMatterToBody`      | 942   | Switches solid/liquid/gas meshes for a body per archetype matter spec.                |
| `applyGasShell`          | 976   | Pushes `body.gas*` fields into the gas mesh's uniforms + thickness scale.             |
| `applyRingsToBody`       | 987   | Pushes `body.rings.{enabled,intensity}` into the ring mesh.                           |
| `regenerateBody`         | 998   | Reseed terrain. Resamples noise → biases → writes vertices + colors (frost-aware).    |
| `recolorBody`            | —     | Repaint all vertices without touching terrain (used when climate shifts the ice).     |
| `refreshClimateColoring` | —     | Recompute a body's climate and repaint it (distance/atmosphere change, new planet).   |
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
| `loadCityTemplate`       | —     | Lazy-load `lunar_base.glb` once; bottom-grounded, scaled to `CITY_BASE_SIZE`.         |
| `createCityMarker`       | —     | Placeholder group until the GLB resolves.                                             |
| `updateCityMarkers`      | 1652  | Visibility per day-side (dot of surface normal with toSun).                           |
| `renderCityList`         | 1675  | DOM render for the Colony tab.                                                        |
| `removeCityAt`           | 1696  | Detach + dispose.                                                                     |
| `updatePlanetRotation`   | 1742  | Spin every planet by its `rotationSpeed`.                                             |
| `updateSunLightForFocus` | 1757  | Refresh per-body `uSunDir` uniforms (atmosphere + rings).                             |
| `setFocus`               | 1810  | Change focused body. Retargets controls and resets dolly distance.                    |
| `setCityFocus`           | 1829  | Focus a city (subtler dolly, oriented by city's surface normal).                      |
| `updateFocusTracking`    | 1855  | Each frame, slide `controls.target` to follow the focused body's worldpos.            |
| `sunDistanceOf`          | —     | Effective distance from the star (planet's orbit, or its parent's for a moon).        |
| `computeClimate`         | —     | Distance + archetype → cached `body.climate` (mean / equator / pole temps).           |
| `temperatureAtLatitude`  | —     | Temp (K) at a latitude — per-vertex hook for future biome painting.                   |
| `tempColor` / `fmtTemp`  | —     | Temperature → HUD color / display string for the Climate section.                     |
| `renderClimateSection`   | —     | Fill the Info panel's Climate section from `computeClimate`.                           |
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
