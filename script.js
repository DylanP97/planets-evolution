    import * as THREE from 'three';
    import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
    import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

    /*
     * ============================================================================
     *  PLANETS-EVOLUTION  ·  script.js
     * ============================================================================
     *  Single-file Three.js runtime: the scene, every body (planet/moon), shaders,
     *  brush, UI, and the animation loop all live here. See ARCHITECTURE.md for a
     *  data-model + frame-lifecycle walkthrough.
     *
     *  TABLE OF CONTENTS  (grep `// ====== <Section> ======` to jump)
     * ----------------------------------------------------------------------------
     *   1. Planet constants                  — biome bands, colors, BIOME enum
     *   2. Scene                             — scene, camera, renderer, sun
     *   3. Palettes                          — PLANET_PALETTE, MOON_PALETTE
     *   4. Body framework                    — bodies[], smoothstep, height scale
     *   5. Gas shader                        — atmosphere + full-gas GLSL
     *   6. Ring shader                       — planetary rings GLSL
     *   7. Body creation                     — createBody, vertex writers, brush apply
     *   8. Terrain generation                — hash/RNG, FBM basis, sample
     *   9. Archetypes                        — ARCHETYPES, ARCHETYPE_MATTER, applyMatter
     *  10. Gas/rings appliers + regen        — applyGasShell, applyRings, regenerateBody
     *  11. Planets (sun orbits)              — planets[], DEFAULT_SPIN, orbit advance
     *  12. Orbit ellipse trajectories        — visible orbit lines
     *  13. Solar system bootstrap            — SOLAR_SYSTEM_SPEC, spawnSolarPlanet
     *  14. Brush                             — radius/strength, ring preview
     *  15. Pointer handling                  — canvas pointerdown/move/up wiring
     *  16. Moons                             — moons[], slot allocator, addMoon
     *  17. Probes (satellites)               — GLB loader, probes[], addSatellite
     *  18. Cities                            — lunar_base.glb, cities[], addCity
     *  19. Starfield                         — 2000 background points
     *  20. Planet rotation                   — updatePlanetRotation
     *  21. Sun light for focus               — refresh per-body uSunDir
     *  22. Focus                             — focusedBody, setFocus, tracking
     *  23. Info panel                        — telemetry pane (right)
     *  24. Random names                      — generateCosmic, generateName
     *  25. UI (tabs + sliders)               — DOM lookups, tab switching
     *  26. Atmosphere sliders                — applyAtmoSliderToFocus
     *  27. Ring controls                     — applyRingsSliderToFocus
     *  28. Context-aware left panel          — applyFocusToLeftPanel
     *  29. Body orbit sliders                — distance/speed/spin/size
     *  30. Add / Remove planet               — deploy/remove + list renderers
     *  31. Hierarchy navigation              — bottom-nav arrows
     *  32. Surface walk                      — pick mode + ground camera
     *  33. Surface input                     — drag-look, scroll-zoom, deploy btns
     *  34. Renaming                          — setBodyName fan-out
     *  35. Init + Resize                     — seed moons, resize listener
     *  36. Animate                           — the frame loop
     * ============================================================================
     */

    // ====== 1. Planet constants ======
    const BASE_RADIUS = 12;          // planet radius; moons declare their own
    const SEA_LEVEL   = 0.0;         // ocean sits at body.baseRadius (heights[i] == 0)
    const ICO_DETAIL  = 7;           // planet detail; finer triangles for smoother brush strokes

    // Biome height bands (relative to sea level). Below sea level is hidden by the
    // water sphere, so colors there only show if the brush carves below water.
    const SAND_TOP   = 0.25;
    const GRASS_TOP  = 1.2;
    // Surface-walk grass grows only ABOVE the full sand→grass blend, so the sandy
    // beach/shore stays bare (no grass on sand). The non-zoned land ramp finishes
    // at SAND_TOP+0.15, so that's where real grassland — and thus blades — begins.
    const GRASS_FLOOR = SAND_TOP + 0.15;
    const ROCK_TOP   = 2.4;
    // Above ROCK_TOP we fade into snow over SNOW_FADE units.
    const SNOW_FADE  = 0.4;

    // Climate biomes: on diverse worlds the *vegetated land* band (between the
    // shore and the peaks) isn't one color — it shifts with latitude, because the
    // planet's climate (section 22b) gives each vertex a surface temperature
    // (poles cold, equator warm; elevation cools it further via a lapse rate).
    // So a terrestrial world reads ice at the caps → tundra → grass → jungle at
    // the equator. Each archetype that varies declares its own ordered zones
    // (warmest first); archetypes NOT listed here keep their plain palette bands
    // unchanged (e.g. a desert world stays desert end to end). The existing band
    // colors (ocean/sand/grass/rock/snow) are untouched — these zones only repaint
    // the mid-elevation land, and only on the listed archetypes.
    const KELVIN_ZERO_C   = 273.15;
    const CLIMATE_LAPSE_C = 14;   // °C shed per height-unit of elevation (mountains run colder)

    // Zone fields: minTempC (this zone covers everything at/above it, scanned
    // warmest→coldest), color, label (composition panel), and optional flags —
    // `beach` lets a sandy shoreline show at the waterline, `relief` lets high
    // ground grade toward rock. Grass reuses the palette green so temperate land
    // is unchanged; ice/tundra/jungle are the new climate biomes.
    const CLIMATE_LAND_ZONES = {
      terrestrial: [
        // Scorching worlds: above ~40°C the vegetation burns off into desert.
        // Because the equator is the warmest band, deserts appear there first
        // and creep poleward as the planet heats further (a Sahara-like belt).
        { key: 'desert', label: 'Desert', color: 0xd2b48c, minTempC:  40, beach: true, relief: true },
        { key: 'jungle', label: 'Jungle', color: 0x15702a, minTempC:  22, beach: true, relief: true },
        { key: 'grass',  label: 'Grass',  color: 0x4FAE4F, minTempC:   7, beach: true, relief: true },
        { key: 'tundra', label: 'Tundra', color: 0x8f9e76, minTempC:  -8 },
        // Bright crystalline ice-blue (not industrial gray). Because ice sits at
        // the poles — where the sun only ever grazes — its base color alone reads
        // grey; ICE_GLOW (below) adds a faint self-emission so it stays luminous.
        { key: 'ice',    label: 'Ice',    color: 0xdaf2ff, minTempC: -Infinity, glow: 0.55 },
      ],
    };
    // Tint of the self-emission added to glowing biomes (ice). The per-vertex
    // aGlow value (zone.glow, 0..1) scales it, so the polar caps read as bright
    // crystal even where diffuse sunlight is near zero.
    const ICE_GLOW_COLOR = new THREE.Color(0xcdeeff);

    // Sea state: a plain-water ocean's surface tracks temperature too, painted
    // per-vertex by latitude exactly like the land zones above. Below freezing
    // the open water skins over into pale sea ice (the in-between of liquid water
    // and solid land-ice); past boiling it steams and finally evaporates, leaving
    // a dried salt-flat seabed exposed. The poles freeze first (coldest) and the
    // equator boils first (hottest), so a world grows ice caps on its sea or a
    // dry equatorial basin as it cools/heats. Colored liquids (lava/acid/etc.)
    // are NOT water, so they keep their archetype color and never react.
    // Sea ice forms well below land ice (land turns icy below −8°C; open water
    // holds heat longer, so the sea only freezes in genuinely cold latitudes) and
    // its edge is broken up by noise (SEA_ICE_NOISE_C) so it reads as ragged pack
    // ice / floes rather than a clean latitude circle (a "skullcap" over the pole).
    const SEA_ICE_C       = -24;    // °C at/below which open water has fully frozen to sea ice
    const SEA_THAW_C      = -14;    // above this the sea is fully liquid (well below land ice's −8°C onset)
    const SEA_ICE_NOISE_C = 6;      // ± wobble on the freeze line so the edge breaks into floes, not a clean ring
    const SEA_BOIL_C    =  75;      // sea begins to steam / evaporate above this
    const SEA_VAPOR_C   = 110;      // at/above this the ocean has boiled away (seabed exposed)
    const SEA_ICE_GLOW  = 0.4;      // self-emission for sea ice at the (sun-grazed, dark) poles
    const SEA_ICE_COLOR   = 0xcfe6f0; // pale frosted blue — between open water and land ice
    const SEA_STEAM_COLOR = 0xb7c4c0; // murky steam-grey as the sea boils off
    const SEABED_COLOR    = 0xcabfa3; // cracked pale mineral of a dried-out basin

    const COL = {
      water:     0x3FA1DC,
      deep:      0x12243a,
      shore:     0x8fb4c8,
      sand:      0xEDDFB8,
      grass:     0x4FAE4F,
      grassDark: 0x2f7a36,
      rock:      0x7d6a5a,
      snow:      0xf0f4f8,
      forest:    0x1a4d1a,
      desert:    0xd2b48c,
      city:      0x808080,
      cityLights:0xffd700,
    };

    const BIOME = {
      AUTO: 0,
      FOREST: 1,
      DESERT: 2,
      TUNDRA: 4,
      // Moon-only biomes: a deliberately small palette of three.
      MARE: 40,
      REGOLITH: 41,
      FROST: 42,
    };

    const MOON_BIOME_OPTIONS = [
      { v: BIOME.MARE,     n: 'Mare' },
      { v: BIOME.REGOLITH, n: 'Regolith' },
      { v: BIOME.FROST,    n: 'Frost' },
    ];

    // ====== 2. Scene ======
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x02030a);

    // Far clip is generous so that the system view can frame multiple planets
    // on wide orbits (and stay behind the starfield at r=320).
    // Far plane has to clear: maxOrbit * 3 (system framing camera distance,
    // ≈ 3400 for Neptune) plus the starfield sphere on the far side of the
    // origin (+ 2200). 7000 leaves headroom without trashing depth precision.
    const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 7000);
    camera.position.set(0, 15, 28);

    const renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('c'), antialias: true });
    renderer.setPixelRatio(devicePixelRatio);
    renderer.setSize(innerWidth, innerHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 0, 0);
    // Paint mode default ON — right-button is reserved for the brush, not pan.
    controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: null,
    };

    // Sun is the only light source — night side stays black. A PointLight at
    // the sun's origin gives every body its own correct (sun → body)
    // direction automatically; a DirectionalLight only has one parallel
    // direction and would light non-focused planets from the wrong angle.
    const SUN_RADIUS = 18;
    const SUN_FAR    = 1400; // shadow camera far — must clear the outermost orbit
    const sun = new THREE.PointLight(0xfff1d4, 1.50, 0, 0); // distance=0, decay=0 → uniform brightness
    sun.position.set(0, 0, 0);
    sun.castShadow = true;
    // PointLight uses a cube shadow map (6 faces); 1024² per face keeps GPU
    // memory reasonable (~24MB) while still giving crisp terrain shadows.
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.near = SUN_RADIUS + 0.5;
    sun.shadow.camera.far  = SUN_FAR;
    sun.shadow.bias        = -0.0005;
    scene.add(sun);

    // Moonlight and night clarity. A very dim ambient light provides a "starry"
    // baseline so the dark side isn't total 0,0,0 black; a DirectionalLight
    // represents the primary moon's reflection, updated per-frame to follow
    // the host planet's moons.
    const ambientLight = new THREE.AmbientLight(0xd0d0ff, 0.04);
    scene.add(ambientLight);

    const moonLight = new THREE.DirectionalLight(0xd0e7ff, 0.0);
    scene.add(moonLight);
    scene.add(moonLight.target);

    const sunMesh = new THREE.Mesh(
      new THREE.SphereGeometry(SUN_RADIUS, 48, 24),
      new THREE.MeshBasicMaterial({ color: 0xfff0c0, fog: false })
    );
    // Sun anchors the system center; planets orbit around (0,0,0).
    sunMesh.position.set(0, 0, 0);
    scene.add(sunMesh);

    // ====== 3. Palettes ======
    const PLANET_PALETTE = {
      deep:  COL.deep,
      shore: COL.shore,
      sand:  COL.sand,
      grass: COL.grass,
      rock:  COL.rock,
      snow:  COL.snow,
    };

    const MOON_PALETTE = {
      crater:    0x322e29,
      dust:      0x6f6357,
      rock:      0xa49a8b,
      highlight: 0xe2dccf,
    };

    // ====== 4. Body framework ======
    // A "body" is a planet or moon: an icosphere whose vertices each store a unit
    // direction and a signed height. World radius at vertex i is
    // baseRadius * (1 + heights[i] * BODY_HEIGHT_SCALE) — relative so peak heights
    // stay proportional across bodies of very different sizes.
    const BODY_HEIGHT_SCALE = 0.025;

    // Hard caps on heights[i]. Keeps mountains proportional to the body — a peak at
    // MAX_LAND_HEIGHT sits ~MAX_LAND_HEIGHT * BODY_HEIGHT_SCALE * 100% above sea level
    // (≈6% of radius at the values below), so the brush can't grow needle-spikes.
    const MAX_LAND_HEIGHT = 2.5;
    const MIN_LAND_HEIGHT = -2.5;
    // On ocean worlds, below-sea-level terrain is deepened by this factor so
    // seabeds drop into real basins (you can swim/wade down into them) instead of
    // a gentle shelf. Land (height ≥ 0) is untouched, so coastlines don't move.
    const OCEAN_DEPTH_BOOST = 2.2;

    // Shoreline foam — RESERVED for a later step (crest foam + shoreline impact
    // foam). bakeOceanShore still bakes the per-vertex signed seabed height into
    // `aShore` (~0 at the coast, negative offshore) so these are ready to wire up;
    // the ocean shader currently does NOT read them (Step 1 is waves only).
    const FOAM_COLOR  = new THREE.Color(0xeef7ff);
    const FOAM_LINE_W = 0.12;  // foam line half-width (height units) — bigger = thicker
    const FOAM_SCALE  = 5.0;   // lacy break-up frequency of the foam line (world units)
    const FOAM_ALPHA  = 0.9;   // peak opacity of the whitest foam

    const bodies = [];

    // Flipped true once the module is fully initialized (after the climate model
    // in section 22b exists). Guards regenerateBody from computing climate during
    // the bootstrap paint — at that point the climate consts are still in their
    // temporal dead zone. The post-init pass sets it and repaints with frost.
    let climateReady = false;

    function smoothstep(a, b, x) {
      const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
      return t * t * (3 - 2 * t);
    }

    // ====== 5. Gas shader ======
    // Two visual modes share the same material:
    //   uMode = 0  →  Atmosphere: noise-thresholded clouds + soft edge haze. The
    //                shell is mostly transparent with sparse clumps drifting across.
    //   uMode = 1  →  Full gas (gas giants): subtle latitudinal banding + fresnel
    //                falloff at the silhouette so the body doesn't read as a hard
    //                sphere — instead the edge "stems out" softly into space.
    // Noise is sampled in the mesh's *local* normal so cloud positions stay stable
    // when gasThickness rescales the shell.
    const GAS_VERT = /* glsl */ `
      varying vec3 vWorldNormal;
      varying vec3 vWorldPos;
      varying vec3 vBodyCenter;
      varying vec3 vViewDir;
      varying vec3 vLocalNormal;
      void main() {
        vLocalNormal = normalize(position);
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        vBodyCenter = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        vWorldNormal = normalize(mat3(modelMatrix) * normal);
        vViewDir = normalize(cameraPosition - wp.xyz);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `;
    const GAS_FRAG = /* glsl */ `
      precision highp float;
      varying vec3 vWorldNormal;
      varying vec3 vWorldPos;
      varying vec3 vBodyCenter;
      varying vec3 vViewDir;
      varying vec3 vLocalNormal;
      uniform vec3  uColor;      // cloud color (white-ish on Earth, yellow on Venus, ...)
      uniform vec3  uSkyTint;    // baseline sky color away from clouds (Rayleigh tint)
      uniform vec3  uSunDir;
      uniform float uDensity;
      uniform float uMode;       // 0 = atmosphere, 1 = full gas
      uniform float uCoverage;   // 0 = empty sky, 1 = total overcast (atmosphere only)
      uniform float uOpaqueSky;  // 1 = render as solid occluding sky (used inside dense atmospheres)
      uniform float uShellScale; // gasThickness: shell radius / surface radius (orbit-halo limb math)
      uniform float uTime;       // seconds, drives cloud drift
      uniform float uWindSpeed;  // radians/sec around the body's Y axis, 0 = static
      uniform float uWindMode;   // 0 = uniform zonal drift, 1 = multi-band winds (Hadley/Ferrel/Polar)
      uniform sampler2D uBandTex; // full-gas only: 1D LUT (south→north) sampled by latitude
      uniform float uUseBands;   // 0 = ignore LUT (use uColor flat); 1 = mix bands fully

      // Whirlpool vortices (full-gas only). Each vortex rotates the sampling
      // direction in a Gaussian-decaying disc around its center, so the band
      // LUT gets *re-sampled* with twisted coordinates — bands curl inward
      // around the vortex like a real storm rather than being overpainted
      // with a flat decal.
      #define GAS_MAX_FEATURES 8
      uniform int   uFeatureCount;
      uniform vec3  uFeatureCenters[GAS_MAX_FEATURES];     // unit dir in body-local frame
      uniform float uFeatureRadii[GAS_MAX_FEATURES];       // angular radius (radians)
      uniform float uFeatureStrengths[GAS_MAX_FEATURES];   // peak rotation (radians) at center

      // Cheap value-noise FBM. Good enough for cloud shapes at this scale.
      float hash3(vec3 p) {
        p = fract(p * 0.3183099 + 0.1);
        p *= 17.0;
        return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
      }
      float vnoise(vec3 x) {
        vec3 p = floor(x);
        vec3 f = fract(x);
        f = f * f * (3.0 - 2.0 * f);
        float n000 = hash3(p + vec3(0,0,0));
        float n100 = hash3(p + vec3(1,0,0));
        float n010 = hash3(p + vec3(0,1,0));
        float n110 = hash3(p + vec3(1,1,0));
        float n001 = hash3(p + vec3(0,0,1));
        float n101 = hash3(p + vec3(1,0,1));
        float n011 = hash3(p + vec3(0,1,1));
        float n111 = hash3(p + vec3(1,1,1));
        return mix(
          mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
          mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
          f.z);
      }
      float fbm(vec3 x) {
        float v = 0.0;
        float a = 0.5;
        for (int i = 0; i < 4; i++) {
          v += a * vnoise(x);
          x *= 2.1;
          a *= 0.5;
        }
        return v;
      }

      void main() {
        float NdotV        = clamp(abs(dot(vWorldNormal, vViewDir)), 0.0, 1.0);
        float fr           = 1.0 - NdotV;             // 1 at silhouette, 0 at center
        float shellLambert = max(0.0, dot(vWorldNormal, normalize(uSunDir)));

        // Inside vs. outside the shell drives nearly every brightness/alpha
        // decision below: from orbit we want a visible terminator (per-fragment
        // shell lambert), but from the surface the *whole* daytime sky should
        // read as uniformly lit — that's determined by the camera's own
        // planetary lambert, not by which part of the shell we happen to look at.
        float shellRad = length(vWorldPos - vBodyCenter);
        float camDist  = length(cameraPosition - vBodyCenter);
        bool  inside   = camDist < shellRad;
        vec3  camDir   = normalize(cameraPosition - vBodyCenter);
        // sunElev is signed: + above local horizon, − below. Surface twilight
        // keys off this so the sky stays atmospheric while the disc is still
        // up, then fades to stars only after it has set.
        float sunElev  = dot(camDir, normalize(uSunDir));
        float camLamb  = max(0.0, sunElev);
        float dayMix   = inside ? camLamb : shellLambert;
        // Surface sky coverage: one wide curve so day→night fades gradually
        // (no sharp cliff). Orbit keeps the older limb-driven curve.
        float skyCover = inside
          ? smoothstep(-0.42, 0.12, sunElev)
          : smoothstep(-0.22, 0.05, sunElev);

        vec3  col = uColor;
        float alpha;
        float cloud = 0.0;

        if (uMode < 0.5) {
          // ---- Atmosphere ----
          // Cloud noise sampled in a wind-rotated local frame so cloud cells
          // drift around the body's Y axis (zonal winds). Rotation is in
          // local space so the body's own spin underneath doesn't double-shift it.
          //
          // uWindMode=0 → all latitudes drift the same direction (simple zonal).
          // uWindMode=1 → multi-band winds: rotation rate varies with latitude,
          //   producing alternating bands of opposing flow that look like real
          //   Hadley/Ferrel/Polar cells. Latitude-dependent rotation also adds
          //   a slow meridional drift (slight Y-axis sample offset) so cells
          //   don't track perfect latitude lines.
          float lat       = vLocalNormal.y;                          // sin of latitude
          float bandRate  = mix(1.0, sin(lat * 3.14159 * 1.5) * 1.8, uWindMode);
          float ang       = uTime * uWindSpeed * bandRate;
          float wc        = cos(ang);
          float ws        = sin(ang);
          vec3  windDir = vec3(
             wc * vLocalNormal.x + ws * vLocalNormal.z,
                  vLocalNormal.y,
            -ws * vLocalNormal.x + wc * vLocalNormal.z
          );
          // Meridional drift in band mode: a slow N-S sample offset that
          // breaks up the pure rotational shear so cloud cells appear to
          // migrate between bands instead of streaking infinitely east/west.
          windDir.y += uWindMode * sin(uTime * uWindSpeed * 0.6 + lat * 4.0) * 0.08;
          float n      = fbm(windDir * 3.5);
          float thresh = 0.95 - uCoverage * 0.90;
          cloud = smoothstep(thresh - 0.10, thresh + 0.28, n);

          // Sky color = Rayleigh tint, bleached toward the sun for forward-scatter glow.
          // During twilight (low dayMix) we warp the forward-scatter color from
          // white toward a warm dusk/dawn orange, so the bright spot near the
          // sun direction reads as a sunset glow rather than a daytime flare.
          vec3  viewDir = normalize(-vViewDir);
          float sunDot  = max(0.0, dot(normalize(uSunDir), viewDir));
          float twilightWeight = inside
            ? smoothstep(0.34, -0.04, sunElev) * smoothstep(-0.30, 0.04, sunElev)
            : smoothstep(0.30, 0.0, dayMix);
          vec3  duskTint  = vec3(1.00, 0.42, 0.08);
          vec3  bleachCol = mix(vec3(1.0), duskTint, twilightWeight);
          vec3  skyCol    = mix(uSkyTint, bleachCol, pow(sunDot, 6.0) * 0.72);
          if (inside) {
            float horizonness = pow(1.0 - NdotV, 0.38);
            vec3  horizonWarm = vec3(1.00, 0.34, 0.05);
            float twilightSky = smoothstep(0.48, -0.14, sunElev)
                              * (1.0 - smoothstep(-0.48, -0.14, sunElev));
            skyCol = mix(skyCol, mix(uSkyTint, horizonWarm, horizonness), twilightSky);
          }

          // Day/night gating uses dayMix so the inside-the-shell case picks
          // up the camera's planetary lambert (uniform sky brightness on the
          // day side) rather than the shell fragment's. The floor is just
          // nightFloor (no 0.10 baseline) so a clear-air planet's sky alpha
          // actually drops to 0 at night — otherwise the horizon retains a
          // blue band even at midnight because pathFactor amplifies it.
          //
          // smoothstep on dayMix saturates sunFactor to 1.0 well before
          // noon (specifically once the sun is more than ~9° above the
          // local horizon). Without this saturation the alpha stayed
          // proportional to lambert across the entire day, so any time
          // *other* than solar noon left the sky at 0.6-0.9 alpha and the
          // gas-shell planets (Venus/Jupiter/Saturn/Neptune) bled through.
          float nightFloor = clamp((uDensity - 0.5) * 2.0, 0.0, 1.0);
          float daySat     = smoothstep(0.0, 0.25, dayMix);
          float sunFactor  = inside
            ? max(mix(nightFloor, 1.00, daySat), skyCover * 0.95)
            : mix(nightFloor, 1.00, daySat);

          float skyAlpha;
          float cloudAlpha;
          if (inside) {
            // Air-mass amplification (horizon looking denser than zenith) is
            // a SUNLIGHT scattering effect, so it has to fade with dayMix.
            // Without this modulation, the night horizon stays "blue/opaque"
            // because pathFactor=5 keeps alpha above the discard threshold
            // even when sunFactor is ~0 — that's the razor-sharp blue band
            // visible at twilight.
            float fullPath   = 1.0 / max(NdotV, 0.20);
            float pathLift   = max(camLamb, skyCover * 0.72);
            float pathFactor = mix(1.0, fullPath, pathLift);
            skyAlpha   = clamp(uDensity * 3.0 * sunFactor * pathFactor, 0.0, 1.0);
            cloudAlpha = cloud * sunFactor;
          } else {
            // From orbit: a thin blue halo that hugs the planet's SURFACE —
            // NOT a glassy dome the width of the (deliberately fat) shell.
            // The shell geometry sits ~10% above the surface so it can clear
            // the tallest mountains and still wrap the camera in surface view;
            // we must NOT let the halo's apparent thickness follow it. Instead
            // shade by the line-of-sight impact parameter b — the perpendicular
            // distance from the body center to the view ray through this
            // fragment:
            //   b < R       → the ray hits the solid planet: clear sky over
            //                 the disc (halo = 0; surface/clouds show through).
            //   R ≤ b ≤ Rs  → the ray grazes only atmosphere: limb glow,
            //                 brightest right at the surface (b≈R) and fading
            //                 to nothing by the shell top (b≈Rs).
            // Rs is this fragment's distance from center (sphere ⇒ constant);
            // R is recovered as Rs / gasThickness so it tracks group scaling.
            // Clouds stay visible across the whole disc (real geometry).
            vec3  OC   = vBodyCenter - cameraPosition;
            vec3  rayD = normalize(vWorldPos - cameraPosition);
            float tca  = dot(OC, rayD);
            float b    = sqrt(max(0.0, dot(OC, OC) - tca * tca));
            float R    = shellRad / max(1.0001, uShellScale);
            float band = clamp((b - R) / max(1e-4, shellRad - R), 0.0, 1.0);
            float overAir = step(R, b);            // 0 over the disc, 1 past the limb
            float halo = overAir * pow(1.0 - band, 2.0);
            float nightFade = mix(0.12, 1.0, shellLambert);
            skyAlpha   = uDensity * halo * 1.8 * nightFade;
            cloudAlpha = cloud * uDensity * 1.6;
          }

          col   = mix(skyCol, uColor, cloud);
          alpha = max(skyAlpha, cloudAlpha);

          // Sunset/sunrise horizon glow: keeps the sun-facing horizon bright
          // and warm during twilight while the rest of the sky fades. Without
          // this the whole sky drops out together and the transition reads
          // as a snap. horizonness peaks at the horizon (NdotV→0), sunSide
          // weights toward the sun direction, twilightWeight peaks at the
          // terminator. Mix col toward duskTint with the same weighting so
          // the alpha-boosted horizon also LOOKS orange.
          if (inside) {
            float horizonness = pow(1.0 - NdotV, 0.6);
            float sunSide     = pow(max(0.0, sunDot), 1.5);
            float sunsetBand  = horizonness * sunSide * twilightWeight;
            alpha = max(alpha, sunsetBand * 0.90);
            col   = mix(col, duskTint, sunsetBand * 0.88);
            float domeAlpha = skyCover * mix(0.82, 0.48, pow(NdotV, 0.58));
            alpha = max(alpha, domeAlpha);
            float nightBlend = (1.0 - skyCover) * pow(NdotV, 0.32);
            col   = mix(col, vec3(0.04, 0.05, 0.12), nightBlend * 0.62);
          }

        } else {
          // ---- Full gas (gas giants) ----
          // Whirlpools first: rotate the sampling direction around each
          // vortex's axis with a Gaussian-decaying rotation amount. The same
          // warped direction then drives both the band LUT lookup and the
          // procedural banding pattern, so the entire color field appears to
          // spiral into each vortex — bands wrap, fbm noise twists, all in
          // one coherent flow.
          vec3 warped = vLocalNormal;
          for (int i = 0; i < GAS_MAX_FEATURES; i++) {
            if (i >= uFeatureCount) break;
            float fr = uFeatureRadii[i];
            if (fr <= 1e-4) continue;
            vec3  fc = uFeatureCenters[i];
            // Inside-vortex check uses the ORIGINAL direction so the vortex
            // stays anchored to a real-world location even as warped drifts
            // from earlier vortices in the loop.
            float cd = clamp(dot(vLocalNormal, fc), -1.0, 1.0);
            float ang = acos(cd);
            if (ang > fr) continue;
            float t = ang / fr;
            float falloff = exp(-3.0 * t * t);   // strongest at center
            float rot = uFeatureStrengths[i] * falloff;
            // Rodrigues' rotation around axis fc by angle rot.
            float cs = cos(rot);
            float sn = sin(rot);
            warped = warped * cs
                   + cross(fc, warped) * sn
                   + fc * dot(fc, warped) * (1.0 - cs);
          }
          // Animated convection: a slowly-scrolling turbulent domain warp so
          // the bands churn and curl over time (the same flowing-noise trick
          // the plasma star uses), instead of sitting as static stripes. The
          // warp is kept small so the latitudinal banding still reads clearly.
          float gt = uTime * (uWindSpeed + 0.02) * 1.5;
          vec3  flowQ = vec3(
            fbm(warped * 1.8 + vec3(0.0, gt * 0.5, 0.0)),
            fbm(warped * 1.8 + vec3(3.1, 1.7, gt * 0.4)),
            fbm(warped * 1.8 + vec3(gt * 0.6, 9.2, 5.7))
          );
          warped = normalize(warped + 0.13 * (flowQ - 0.5));
          float n     = fbm(warped * 3.5 + vec3(0.0, 0.0, gt * 0.25));
          float lat   = warped.y * 0.5 + 0.5;
          float latW  = clamp(lat + (n - 0.5) * 0.04, 0.0, 1.0);
          vec3  bandCol = texture2D(uBandTex, vec2(latW, 0.5)).rgb;
          vec3  baseCol = mix(uColor, bandCol, uUseBands);
          float bands = 0.5 + 0.5 * sin(warped.y * 6.0 + n * 2.5);
          col = mix(baseCol * 0.82, baseCol * 1.06, bands);
          // Dense at center, fading right to zero at the rim so the silhouette
          // feathers out — the body looks like it "stems from" the center
          // instead of being clipped to a hard circle.
          float core = smoothstep(0.0, 0.40, NdotV);
          alpha = uDensity * core;
        }

        // Day/night color dimming. dayMix flips between camera- and
        // shell-driven so the surface view doesn't darken near the horizon
        // and the orbit view keeps its terminator. skyCover keeps the
        // surface sky from going pitch-black while the sun is still up.
        float light = inside
          ? mix(0.30, 1.10, max(camLamb, skyCover * 0.82))
          : mix(0.30, 1.10, dayMix);
        col *= light;

        // Sun disc — added after sky dimming so twilight doesn't fade it early.
        // Stays until the whole disc is below the horizon (center + radius).
        if (inside && uMode < 0.5) {
          vec3  viewDir2 = normalize(-vViewDir);
          float sunDot2  = max(0.0, dot(normalize(uSunDir), viewDir2));
          float sunDisc  = smoothstep(0.99988, 0.99998, sunDot2);
          float SUN_DISC_R = 0.032;
          float sunAbove = smoothstep(-SUN_DISC_R - 0.018, -SUN_DISC_R, sunElev);
          float sunWarm    = smoothstep(0.28, 0.0, camLamb);
          vec3  sunCol     = mix(vec3(1.00, 0.96, 0.82), vec3(1.00, 0.90, 0.68), sunWarm);
          float sunVis     = sunDisc * (1.0 - cloud) * sunAbove;
          col   += sunCol * sunVis;
          alpha  = max(alpha, sunDisc * sunAbove);
        }

        float a = clamp(alpha, 0.0, 1.0);
        if (uOpaqueSky > 0.5) {
          // Opaque-queue path: the shell renders with depthWrite so far
          // planets fail the depth test, AND alphaToCoverage is enabled on
          // the material so partial alpha dithers across MSAA samples
          // instead of snapping to a binary "full opaque / discard" edge.
          // Effect: covered samples occlude background (sky is real), un-
          // covered samples leak through (stars/planets visible). As alpha
          // smoothly drops through twilight, more samples become uncovered,
          // giving a true gradient sunset rather than an instant toggle.
          // Discard at 0.02 is just a perf gate — anything below that is
          // invisible anyway.
          if (a < 0.02) discard;
        }
        gl_FragColor = vec4(col, a);
      }
    `;

    // Placeholder LUT for atmospheres / unpainted full-gas bodies. A 1x1 white
    // pixel keeps the sampler valid; uUseBands gates whether the shader actually
    // mixes it in. Per-body LUTs from ensureGasPaint replace this on full-gas
    // planets.
    const DEFAULT_BAND_TEX = (() => {
      const tex = new THREE.DataTexture(
        new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat
      );
      tex.magFilter = THREE.LinearFilter;
      tex.minFilter = THREE.LinearFilter;
      tex.needsUpdate = true;
      return tex;
    })();

    // Cap on simultaneous whirlpools per gas planet. Must match
    // GAS_MAX_FEATURES in the gas shader; bumping requires editing both.
    const GAS_MAX_FEATURES = 8;

    // Named atmospheric compositions for the Bands brush + randomizer. Each
    // biome is tagged with the archetypes it belongs to so the Composition
    // dropdown can filter to the focused planet's flavour:
    //   gas_giant — brown → beige gradient (Jupiter / Saturn family)
    //   ice_giant — dark blue → white-ice gradient (Uranus / Neptune family)
    // Ordering inside each palette runs darkest → lightest so the dropdown
    // reads as a ramp.
    const GAS_BIOMES = [
      // ---- Gas giant: brown → beige ----
      { id: 'dark_layer',      name: 'Dark Layer',      color: 0x4a3528, archs: ['gas_giant'] },
      { id: 'storm_belt',      name: 'Storm Belt',      color: 0x5e2f1d, archs: ['gas_giant'] },
      { id: 'lower_cloud',     name: 'Lower Cloud',     color: 0x8a5a3a, archs: ['gas_giant'] },
      { id: 'great_spot',      name: 'Great Spot',      color: 0xb5462c, archs: ['gas_giant'] },
      { id: 'ammonia_sulfide', name: 'NH4SH Cloud',     color: 0xc16a4f, archs: ['gas_giant'] },
      { id: 'sulfur',          name: 'Sulfur Layer',    color: 0xd4912d, archs: ['gas_giant'] },
      { id: 'mid_cloud',       name: 'Mid Cloud',       color: 0xc6a378, archs: ['gas_giant'] },
      { id: 'upper_haze',      name: 'Upper Haze',      color: 0xe8d5b0, archs: ['gas_giant'] },
      { id: 'ammonia',         name: 'Ammonia Belt',    color: 0xefe5b8, archs: ['gas_giant'] },
      { id: 'helium_sheath',   name: 'Helium Sheath',   color: 0xf5f0e8, archs: ['gas_giant', 'ice_giant'] },
      // ---- Ice giant: dark blue → white ice ----
      { id: 'hydrogen_deep',   name: 'Hydrogen Deep',   color: 0x1f3b6e, archs: ['ice_giant'] },
      { id: 'methane_sea',     name: 'Methane Sea',     color: 0x3a6cb4, archs: ['ice_giant'] },
      { id: 'methane',         name: 'Methane',         color: 0x5e8fc2, archs: ['ice_giant'] },
      { id: 'phosphine',       name: 'Phosphine',       color: 0x6c91c8, archs: ['ice_giant'] },
      { id: 'aurora',          name: 'Aurora Glow',     color: 0x6cdcc1, archs: ['ice_giant'] },
      { id: 'methane_ice',     name: 'Methane Ice',     color: 0x71c6cf, archs: ['ice_giant'] },
      { id: 'polar_cap',       name: 'Polar Cap',       color: 0xc4cfde, archs: ['ice_giant'] },
      { id: 'frost_veil',      name: 'Frost Veil',      color: 0xd8e8f0, archs: ['ice_giant'] },
      { id: 'ice_crystal',     name: 'Ice Crystal',     color: 0xeaf4fb, archs: ['ice_giant'] },
      { id: 'white_ice',       name: 'White Ice',       color: 0xfafdff, archs: ['ice_giant'] },
    ];

    function gasBiomesForArchetype(arch) {
      const key = arch || 'gas_giant';
      const list = GAS_BIOMES.filter(b => b.archs.includes(key));
      return list.length ? list : GAS_BIOMES.filter(b => b.archs.includes('gas_giant'));
    }

    function gasBiomeById(id) {
      return GAS_BIOMES.find(b => b.id === id) || null;
    }

    function makeGasMaterial() {
      return new THREE.ShaderMaterial({
        vertexShader: GAS_VERT,
        fragmentShader: GAS_FRAG,
        uniforms: {
          uColor:    { value: new THREE.Color(0xffffff) },
          uSkyTint:  { value: new THREE.Color(0x87ceeb) }, // overwritten per-body in applyMatterToBody
          uSunDir:   { value: new THREE.Vector3(1, 0, 0) }, // overwritten per-frame by updateSunLightForFocus
          uDensity:  { value: 0.18 },
          uMode:     { value: 0.0 },
          uCoverage: { value: 0.35 },
          uOpaqueSky:{ value: 0.0 },
          uShellScale:{ value: 1.10 }, // refreshed by applyGasShell from body.gasThickness
          uTime:     { value: 0.0 },
          uWindSpeed:{ value: 0.05 },
          uWindMode: { value: 0.0 }, // 0 = uniform zonal, 1 = multi-band Hadley/Ferrel/Polar
          uBandTex:  { value: DEFAULT_BAND_TEX },
          uUseBands: { value: 0.0 },
          // Whirlpool arrays are sized to GAS_MAX_FEATURES (must match the
          // shader's #define). Slots beyond uFeatureCount are ignored at draw
          // time, but the arrays still need full allocation so Three.js can
          // bind contiguous storage to the uniform.
          uFeatureCount:     { value: 0 },
          uFeatureCenters:   { value: Array.from({ length: GAS_MAX_FEATURES }, () => new THREE.Vector3(0, 1, 0)) },
          uFeatureRadii:     { value: new Float32Array(GAS_MAX_FEATURES) },
          uFeatureStrengths: { value: new Float32Array(GAS_MAX_FEATURES) },
        },
        transparent: true,
        depthWrite: false,
        side: THREE.FrontSide,
      });
    }

    // ====== 5b. Plasma shader (star surfaces) ======
    // The fourth matter type, after solid / liquid / gas. A self-luminous
    // animated photosphere — an "ocean of lava" churning over a sphere. Used by
    // the Sun and by the `star` archetype. The look is entirely procedural and
    // emissive (no sun-direction lighting — a star lights itself):
    //   - domain-warped FBM gives slow swirling convection currents
    //   - a faster granulation layer makes the surface bubble
    //   - a time-shifting threshold lifts bright cells to white-hot and pulses
    //     them, so hot zones drift and breathe instead of sitting still
    //   - dark filament lanes (sunspot-ish) appear in the cold troughs
    //   - a fresnel limb term adds a corona-bright rim
    // Noise is sampled on the local unit direction, so the pattern is stable
    // regardless of the sphere's world radius (Sun vs. a small star planet).
    const PLASMA_VERT = /* glsl */ `
      varying vec3 vLocalDir;
      varying vec3 vWorldNormal;
      varying vec3 vViewDir;
      varying vec3 vWorldPos;
      varying vec3 vCenter;
      void main() {
        vLocalDir = normalize(position);
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        vCenter = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        vWorldNormal = normalize(mat3(modelMatrix) * normal);
        vViewDir = normalize(cameraPosition - wp.xyz);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `;
    const PLASMA_FRAG = /* glsl */ `
      precision highp float;
      varying vec3 vLocalDir;
      varying vec3 vWorldNormal;
      varying vec3 vViewDir;
      varying vec3 vWorldPos;
      varying vec3 vCenter;
      uniform float uTime;
      uniform float uScale;     // base convection-cell frequency
      uniform float uSpeed;     // overall flow-rate multiplier
      uniform float uBright;    // overall emissive multiplier
      uniform float uFlares;    // strength of the random lava-burst flares
      uniform float uWhiten;    // 0 = off; >0 = blow out to white as camera recedes
      uniform float uWhitenNear;// distance at which whitening starts
      uniform float uWhitenFar; // distance at which whitening saturates
      uniform vec3  uColorDeep; // coldest troughs / sunspot lanes (deep orange)
      uniform vec3  uColorLow;  // orange granulation
      uniform vec3  uColorMid;  // bright yellow photosphere
      uniform vec3  uColorHot;  // white-hot faculae

      #define NFLARES 6

      // Scalar hash for flare seeding.
      float hash1(float n) { return fract(sin(n) * 43758.5453123); }

      // Value-noise FBM (same construction as the gas shader).
      float hash3(vec3 p) {
        p = fract(p * 0.3183099 + 0.1);
        p *= 17.0;
        return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
      }
      float vnoise(vec3 x) {
        vec3 p = floor(x);
        vec3 f = fract(x);
        f = f * f * (3.0 - 2.0 * f);
        float n000 = hash3(p + vec3(0,0,0));
        float n100 = hash3(p + vec3(1,0,0));
        float n010 = hash3(p + vec3(0,1,0));
        float n110 = hash3(p + vec3(1,1,0));
        float n001 = hash3(p + vec3(0,0,1));
        float n101 = hash3(p + vec3(1,0,1));
        float n011 = hash3(p + vec3(0,1,1));
        float n111 = hash3(p + vec3(1,1,1));
        return mix(
          mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
          mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
          f.z);
      }
      float fbm(vec3 x) {
        float v = 0.0;
        float a = 0.5;
        for (int i = 0; i < 5; i++) {
          v += a * vnoise(x);
          x *= 2.07;
          a *= 0.5;
        }
        return v;
      }

      // Domain-warped convection: warp the sample point by a slowly-scrolling
      // noise vector field so cells stretch and curl into each other (the
      // "flowing lava" feel), then add a faster, finer bubbling layer.
      float plasmaField(vec3 p, float t) {
        vec3 q = vec3(
          fbm(p + vec3(0.0, 0.0, t * 0.06)),
          fbm(p + vec3(5.2, 1.3, t * 0.05)),
          fbm(p + vec3(1.7, 9.2, t * 0.07))
        );
        vec3 warped = p + 2.0 * q;
        float flow = fbm(warped + vec3(t * 0.04, 0.0, 0.0));
        float bubble = fbm(p * 2.6 + vec3(-t * 0.16, t * 0.13, t * 0.11));
        return flow * 0.68 + bubble * 0.32;
      }

      // Random lava flares: bubbles that swell at a random spot, then burst
      // into an expanding shock ring and fade. Each of NFLARES slots runs on
      // its own period and re-rolls a fresh location every cycle, so flares
      // pop here and there across the surface rather than in a fixed pattern.
      float flares(vec3 dir, float t) {
        float total = 0.0;
        for (int i = 0; i < NFLARES; i++) {
          float fi = float(i);
          float period = 3.5 + hash1(fi * 1.31) * 4.0;
          float tt   = t / period + hash1(fi * 2.17);
          float cyc  = floor(tt);
          float life = fract(tt);
          // Fresh random center (uniform on the sphere) for this cycle.
          float h1 = hash1(fi * 3.7 + cyc * 7.13);
          float h2 = hash1(fi * 5.3 + cyc * 3.91);
          float z  = h1 * 2.0 - 1.0;
          float aa = h2 * 6.2831853;
          float rr = sqrt(max(0.0, 1.0 - z * z));
          vec3  fdir = vec3(rr * cos(aa), z, rr * sin(aa));
          float ang  = acos(clamp(dot(dir, fdir), -1.0, 1.0));
          // Envelope: swell in, then burst (~0.5) and fade out.
          float swell  = smoothstep(0.0, 0.40, life);
          float fade   = 1.0 - smoothstep(0.62, 1.0, life);
          float pop    = smoothstep(0.50, 0.66, life);
          float bright = swell * fade;
          float sigma  = mix(0.05, 0.10, swell) + pop * 0.06;
          float core   = exp(-(ang * ang) / (2.0 * sigma * sigma)) * bright;
          // Expanding shock ring during the burst.
          float ringR  = pop * 0.20;
          float ring   = exp(-pow((ang - ringR) / 0.035, 2.0)) * pop * fade;
          total += core + ring * 0.7;
        }
        return total;
      }

      void main() {
        vec3  dir = normalize(vLocalDir);
        float t   = uTime * uSpeed;
        float f   = plasmaField(dir * uScale, t);

        // Bright cells drift and breathe: a per-location pulse phase keyed to
        // the field value, so hot patches throb out of phase across the disc.
        float pulse   = 0.5 + 0.5 * sin(t * 0.6 + f * 6.2831);
        float hotZone = smoothstep(0.52, 0.86, f + pulse * 0.14);

        // Color ramp: deep orange troughs → orange → yellow → white-hot.
        vec3 col = mix(uColorDeep, uColorLow, smoothstep(0.12, 0.42, f));
        col = mix(col, uColorMid, smoothstep(0.42, 0.68, f));
        col = mix(col, uColorHot, hotZone);

        // Dark convection lanes / sunspots in the coldest troughs.
        float lane = smoothstep(0.14, 0.0, f);
        col = mix(col, uColorDeep * 0.35, lane * 0.7);

        // Random lava bursts: blow the hit spots out to white-hot.
        float fl = flares(dir, t) * uFlares;
        col = mix(col, uColorHot, clamp(fl, 0.0, 1.0));
        col += uColorHot * fl * 0.4;

        // Emissive lift. A faint fresnel keeps the limb warm without making the
        // surface read like a shiny glass bubble (the corona supplies the glow).
        col *= uBright;
        float NdotV = clamp(abs(dot(normalize(vWorldNormal), normalize(vViewDir))), 0.0, 1.0);
        float rim = pow(1.0 - NdotV, 3.2);
        col += uColorHot * rim * 0.25;

        // Slow global flicker so the whole star feels alive and unstable.
        col *= 0.94 + 0.06 * sin(t * 0.9);

        // Distance whitening: from far away a star bleaches toward white-hot
        // (atmospheric/eye response — detail washes out, the disc reads white).
        // Up close the orange convection structure stays visible.
        if (uWhiten > 0.0) {
          float camDist = distance(cameraPosition, vCenter);
          float w = uWhiten * smoothstep(uWhitenNear, uWhitenFar, camDist);
          col = mix(col, vec3(1.0, 0.98, 0.94) * max(1.0, uBright), w * 0.75);
        }

        gl_FragColor = vec4(col, 1.0);
      }
    `;

    function makePlasmaMaterial() {
      return new THREE.ShaderMaterial({
        vertexShader: PLASMA_VERT,
        fragmentShader: PLASMA_FRAG,
        uniforms: {
          uTime:      { value: 0.0 },
          uScale:     { value: 3.6 },
          uSpeed:     { value: 1.0 },
          uBright:    { value: 1.28 },
          uFlares:    { value: 0.9 },
          uWhiten:    { value: 0.0 },
          uWhitenNear:{ value: 100.0 },
          uWhitenFar: { value: 600.0 },
          uColorDeep: { value: new THREE.Color(0x5a0e00) }, // deep orange
          uColorLow:  { value: new THREE.Color(0xc73a00) }, // orange
          uColorMid:  { value: new THREE.Color(0xff9b1e) }, // yellow
          uColorHot:  { value: new THREE.Color(0xfff4d0) }, // white-hot
        },
        side: THREE.FrontSide,
        // Opaque, self-lit surface — depth writes so it occludes correctly and
        // tone mapping is left off (default) so bright cells can bloom past 1.
        transparent: false,
        depthWrite: true,
        fog: false,
      });
    }

    // Soft corona / atmosphere dome: an additive back-faced shell. Instead of a
    // fresnel rim (which reads as a hard "bubble" outline) the alpha is driven
    // by the view ray's impact parameter b — its perpendicular distance from
    // the star's center. Brightest just outside the photosphere (b≈Rsun) and
    // fading smoothly to nothing by the shell's outer radius (b≈Rc), so it
    // looks like a diffuse glow dome rather than a glassy sphere. Used for the
    // Sun. (b<Rsun lands over the disc, where the opaque star occludes it.)
    const CORONA_FRAG = /* glsl */ `
      precision highp float;
      varying vec3 vWorldPos;
      uniform float uTime;
      uniform vec3  uColor;
      uniform vec3  uCenter;
      uniform float uRsun;
      uniform float uRc;
      void main() {
        vec3  OC   = uCenter - cameraPosition;
        vec3  rayD = normalize(vWorldPos - cameraPosition);
        float tca  = dot(OC, rayD);
        float b    = sqrt(max(0.0, dot(OC, OC) - tca * tca));
        float halo = clamp((uRc - b) / max(1e-3, uRc - uRsun), 0.0, 1.0);
        halo = pow(halo, 2.4);
        // Restless, uneven glow: a per-direction phase makes the halo writhe and
        // pulse around its edge rather than breathing as one steady ring. Layered
        // sines of different rates keep it irregular (never a clean loop).
        vec3  nd = normalize(vWorldPos - uCenter);
        float ph = nd.x * 2.3 + nd.y * 1.7 + nd.z * 1.9;
        float flicker = 0.55
                      + 0.30 * sin(uTime * 1.8 + ph * 3.0)
                      + 0.18 * sin(uTime * 3.3 + ph * 5.7)
                      + 0.12 * sin(uTime * 0.7 - ph * 2.1);
        flicker = clamp(flicker, 0.1, 1.4);
        gl_FragColor = vec4(uColor, halo * 0.85 * flicker);
      }
    `;
    function makeCoronaMaterial(colorHex, rSun, rC) {
      return new THREE.ShaderMaterial({
        vertexShader: PLASMA_VERT, // reuses vWorldPos varying
        fragmentShader: CORONA_FRAG,
        uniforms: {
          uTime:   { value: 0.0 },
          uColor:  { value: new THREE.Color(colorHex) },
          uCenter: { value: new THREE.Vector3(0, 0, 0) },
          uRsun:   { value: rSun },
          uRc:     { value: rC },
        },
        side: THREE.BackSide,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        fog: false,
      });
    }

    // Light the Sun with the plasma shader (its MeshBasicMaterial placeholder is
    // replaced here, after the factory exists). Larger-scale + slower than the
    // default so it reads as a vast photosphere; colors are pushed toward
    // yellow-white (less red) and brightness up, since the Sun is a hot star.
    sunMesh.material.dispose();
    sunMesh.material = makePlasmaMaterial();
    {
      const su = sunMesh.material.uniforms;
      su.uScale.value = 3.0;
      su.uSpeed.value = 0.8;
      su.uBright.value = 1.55;
      su.uColorDeep.value.setHex(0xa83a08); // bright deep orange (no dark red)
      su.uColorLow.value.setHex(0xff8a2a);  // orange
      su.uColorMid.value.setHex(0xffd27a);  // warm yellow
      su.uColorHot.value.setHex(0xffffff);  // pure white
      // Bleach toward white as the camera pulls away to system view.
      su.uWhiten.value = 1.0;
      su.uWhitenNear.value = SUN_RADIUS * 4.0;
      su.uWhitenFar.value  = SUN_RADIUS * 30.0;
    }

    // Restless red-orange glow dome around the Sun.
    const CORONA_OUTER = SUN_RADIUS * 1.6;
    const coronaMesh = new THREE.Mesh(
      new THREE.SphereGeometry(CORONA_OUTER, 64, 32),
      makeCoronaMaterial(0xff4d12, SUN_RADIUS, CORONA_OUTER)
    );
    coronaMesh.position.copy(sunMesh.position);
    scene.add(coronaMesh);

    // Uniform sets ticked every frame by the animate loop (always advancing —
    // a star never freezes, even when the sim is paused).
    const plasmaTickUniforms = [sunMesh.material.uniforms, coronaMesh.material.uniforms];

    // Latitudinal band paint state for full-gas planets. Stored per body and
    // sampled by the gas shader via uBandTex. The LUT runs south(0) → north
    // (GAS_BAND_COUNT-1); the shader does linear filtering so bands blend
    // smoothly without visible LUT-cell edges.
    const GAS_BAND_COUNT = 16;

    function ensureGasPaint(body) {
      if (body.gasPaint) return body.gasPaint;
      const bandsRGB = new Float32Array(GAS_BAND_COUNT * 3);
      const data     = new Uint8Array(GAS_BAND_COUNT * 4);
      // Seed each band from uColor with a low-frequency brightness wobble so the
      // unpainted default already reads as banded (rather than flat) and matches
      // the archetype tint.
      const base = body.gasMesh.material.uniforms.uColor.value;
      for (let i = 0; i < GAS_BAND_COUNT; i++) {
        const t = (i + 0.5) / GAS_BAND_COUNT;
        const v = 0.85 + 0.18 * Math.sin(t * Math.PI * 6);
        bandsRGB[i * 3]     = Math.min(1, base.r * v);
        bandsRGB[i * 3 + 1] = Math.min(1, base.g * v);
        bandsRGB[i * 3 + 2] = Math.min(1, base.b * v);
      }
      const tex = new THREE.DataTexture(data, GAS_BAND_COUNT, 1, THREE.RGBAFormat);
      tex.magFilter = THREE.LinearFilter;
      tex.minFilter = THREE.LinearFilter;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      // Per-band biome id, used by the right-side composition panel and
      // updated by paint / randomize. Seeded to the first biome of whatever
      // archetype is being applied right now; randomizeGasBands replaces this
      // wholesale at the end of regenerateBody.
      const defaultBiome = (gasBiomesForArchetype(currentArchetype)[0] || GAS_BIOMES[0]).id;
      const bandBiomes = new Array(GAS_BAND_COUNT).fill(defaultBiome);
      body.gasPaint = { bandsRGB, data, tex, bandBiomes, features: [] };
      commitGasPaint(body.gasPaint);
      return body.gasPaint;
    }

    function commitGasPaint(gp) {
      for (let i = 0; i < GAS_BAND_COUNT; i++) {
        const r = gp.bandsRGB[i * 3];
        const g = gp.bandsRGB[i * 3 + 1];
        const b = gp.bandsRGB[i * 3 + 2];
        gp.data[i * 4]     = r <= 0 ? 0 : r >= 1 ? 255 : Math.round(r * 255);
        gp.data[i * 4 + 1] = g <= 0 ? 0 : g >= 1 ? 255 : Math.round(g * 255);
        gp.data[i * 4 + 2] = b <= 0 ? 0 : b >= 1 ? 255 : Math.round(b * 255);
        gp.data[i * 4 + 3] = 255;
      }
      gp.tex.needsUpdate = true;
    }

    // Paint a strip of the band LUT at the click's latitude. Falloff mirrors
    // the terrain brush — (1 - (d/r)²)² where d is latitude distance from the
    // hit — so the brush feels symmetrical even though it edits a 1D LUT
    // instead of vertex data.
    function applyGasPaintBrush(body, centerLocal, dt) {
      const gp = ensureGasPaint(body);
      const len = Math.hypot(centerLocal.x, centerLocal.y, centerLocal.z) || 1;
      const ny = centerLocal.y / len;
      const centerLat = ny * 0.5 + 0.5;
      // Angular brush radius (radians) → latitude axis fraction (axis spans π).
      const latRadius = Math.max(1e-3, brushRadius / Math.PI);
      // brushStrength is tuned for height units/sec; scale down so paint
      // converges in ~half a second of dragging at default strength.
      const lerpRate = Math.min(1, brushStrength * 0.5 * dt);
      let changed = false;
      for (let i = 0; i < GAS_BAND_COUNT; i++) {
        const lat = (i + 0.5) / GAS_BAND_COUNT;
        const d = Math.abs(lat - centerLat);
        if (d > latRadius) continue;
        const t = d / latRadius;
        const f = 1 - t * t;
        const k = lerpRate * f * f;
        if (k <= 0) continue;
        const inv = 1 - k;
        gp.bandsRGB[i * 3]     = gp.bandsRGB[i * 3]     * inv + gasPaintColor.r * k;
        gp.bandsRGB[i * 3 + 1] = gp.bandsRGB[i * 3 + 1] * inv + gasPaintColor.g * k;
        gp.bandsRGB[i * 3 + 2] = gp.bandsRGB[i * 3 + 2] * inv + gasPaintColor.b * k;
        // Sharp biome reassignment for any band the brush touches — the
        // composition panel should respond on the first frame of paint, not
        // wait for the color lerp to converge.
        if (selectedGasBiomeId) gp.bandBiomes[i] = selectedGasBiomeId;
        changed = true;
      }
      if (changed) commitGasPaint(gp);
    }

    // Roll the band LUT from a deterministic seed: split latitudes into a
    // few zones (3–6) and fill each with a randomly chosen biome's color,
    // jittered per-band so the same biome reads as a textured stripe rather
    // than a flat fill. Called from regenerateBody for fresh gas planets and
    // from the Randomize button for explicit re-rolls.
    function randomizeGasBands(body, seedStr) {
      const gp = ensureGasPaint(body);
      // body.archetype isn't set until registerPlanet runs, which is AFTER
      // regenerateBody. currentArchetype is the right fallback during a
      // fresh-planet bootstrap path.
      const arch = body.archetype || currentArchetype || 'gas_giant';
      const palette = gasBiomesForArchetype(arch);
      const rng = makeRNG(hashSeed(String(seedStr || body.name || 'gas') + ':gas'));
      const zoneCount = 3 + Math.floor(rng() * 4); // 3..6 zones
      const edges = [0];
      for (let z = 1; z < zoneCount; z++) edges.push(rng());
      edges.push(1);
      edges.sort((a, b) => a - b);
      const zoneBiomes = [];
      for (let z = 0; z < zoneCount; z++) {
        zoneBiomes.push(palette[Math.floor(rng() * palette.length)]);
      }
      const tmpCol = new THREE.Color();
      for (let i = 0; i < GAS_BAND_COUNT; i++) {
        const lat = (i + 0.5) / GAS_BAND_COUNT;
        let zi = 0;
        for (let z = 0; z < zoneCount; z++) {
          if (lat >= edges[z] && lat < edges[z + 1]) { zi = z; break; }
        }
        const biome = zoneBiomes[zi];
        tmpCol.setHex(biome.color);
        // Per-band brightness wobble inside the zone keeps adjacent bands of
        // the same biome visually distinct, so a thick zone still shows
        // texture instead of looking like one painted band.
        const v = 0.85 + 0.22 * rng();
        gp.bandsRGB[i * 3]     = Math.min(1, tmpCol.r * v);
        gp.bandsRGB[i * 3 + 1] = Math.min(1, tmpCol.g * v);
        gp.bandsRGB[i * 3 + 2] = Math.min(1, tmpCol.b * v);
        gp.bandBiomes[i] = biome.id;
      }
      commitGasPaint(gp);
    }

    // Maximum cumulative rotation a single whirlpool can apply at its
    // center. ~2π lets the user fully wind the bands around once; beyond
    // that the result reads as visual noise.
    const GAS_VORTEX_MAX_STRENGTH = Math.PI * 2;
    // Per-second growth while held — at default ~3 sec to fully wind up.
    const GAS_VORTEX_GROWTH_RATE  = (Math.PI * 2) / 3;

    // Drop a new whirlpool at the pointer hit direction. Returns the vortex
    // object so the caller can keep growing its strength while held. The
    // vortex itself stores no color — it only rotates the band-sampling
    // direction, so colors "wrap" rather than being overpainted.
    function addGasVortex(body, centerLocal) {
      const gp = ensureGasPaint(body);
      const cx = centerLocal.x, cy = centerLocal.y, cz = centerLocal.z;
      const inv = 1 / (Math.hypot(cx, cy, cz) || 1);
      const vortex = {
        dx: cx * inv, dy: cy * inv, dz: cz * inv,
        radius: brushRadius,
        strength: 0.0,
      };
      gp.features.push(vortex);
      while (gp.features.length > GAS_MAX_FEATURES) gp.features.shift();
      updateGasFeatureUniforms(body);
      return vortex;
    }

    // Advance an existing whirlpool's strength. Called per frame while the
    // user holds the click — strength saturates at GAS_VORTEX_MAX_STRENGTH so
    // bands fully wrap and then stop tightening (instead of becoming chaos).
    function growGasVortex(body, vortex, dt) {
      if (!vortex) return;
      const next = vortex.strength + GAS_VORTEX_GROWTH_RATE * dt;
      vortex.strength = next > GAS_VORTEX_MAX_STRENGTH ? GAS_VORTEX_MAX_STRENGTH : next;
      updateGasFeatureUniforms(body);
    }

    function clearGasFeatures(body) {
      if (!body.gasPaint) return;
      body.gasPaint.features.length = 0;
      updateGasFeatureUniforms(body);
    }

    // Push body.gasPaint.features into the gas mesh's uniform arrays. The
    // shader only iterates up to uFeatureCount, so we don't need to zero
    // trailing slots — but we still update them so previous-frame data can't
    // leak in if uFeatureCount creeps back up later.
    function updateGasFeatureUniforms(body) {
      if (!body.gasMesh) return;
      const gp = body.gasPaint;
      const u = body.gasMesh.material.uniforms;
      const feats = (gp && gp.features) || [];
      const n = Math.min(GAS_MAX_FEATURES, feats.length);
      u.uFeatureCount.value = n;
      for (let i = 0; i < GAS_MAX_FEATURES; i++) {
        const f = feats[i];
        const centerVec = u.uFeatureCenters.value[i];
        if (f) {
          centerVec.set(f.dx, f.dy, f.dz);
          u.uFeatureRadii.value[i] = f.radius;
          u.uFeatureStrengths.value[i] = f.strength;
        } else {
          centerVec.set(0, 1, 0);
          u.uFeatureRadii.value[i] = 0;
          u.uFeatureStrengths.value[i] = 0;
        }
      }
    }

    // ====== 6. Ring shader ======
    // Procedural Saturn-like ring banding. The geometry is a flat annulus in the
    // body's local XZ plane; the fragment shader uses the local radius to drive
    // band brightness, two Cassini-like gaps, and an inner/outer soft edge.
    // Planet shadow is cast onto the ring by projecting the fragment relative to
    // the body center along the sun direction (world-space, refreshed per-frame).
    const RING_VERT = /* glsl */ `
      varying vec3 vLocalPos;
      varying vec3 vWorldPos;
      varying vec3 vWorldNormal;
      void main() {
        vLocalPos = position;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        vWorldNormal = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `;
    const RING_FRAG = /* glsl */ `
      precision highp float;
      varying vec3 vLocalPos;
      varying vec3 vWorldPos;
      varying vec3 vWorldNormal;
      uniform float uInner;
      uniform float uOuter;
      uniform float uIntensity;
      uniform vec3  uColorA;
      uniform vec3  uColorB;
      uniform vec3  uSunDir;
      uniform vec3  uBodyCenter;
      uniform float uBodyRadius;
      uniform float uGasRadius;
      uniform float uGasOpacity;

      float hash11(float n) { return fract(sin(n * 127.1) * 43758.5453); }
      float noise1(float x) {
        float i = floor(x);
        float f = fract(x);
        float u = f * f * (3.0 - 2.0 * f);
        return mix(hash11(i), hash11(i + 1.0), u);
      }
      float fbm1(float x) {
        float v = 0.0;
        float a = 0.5;
        for (int i = 0; i < 4; i++) {
          v += a * noise1(x);
          x *= 2.0;
          a *= 0.5;
        }
        return v;
      }

      void main() {
        float r = length(vLocalPos);
        float t = (r - uInner) / max(1e-4, uOuter - uInner);
        if (t < 0.0 || t > 1.0) discard;

        // Radial banding — fbm gives organic variation; the sin term adds finer
        // ridges so close-up shots still read as many distinct rings.
        float bands = fbm1(t * 18.0);
        bands = mix(bands, 0.5 + 0.5 * sin(t * 120.0), 0.15);

        // Two darker gaps mimicking Cassini/Encke-style divisions.
        float gapMask = 1.0;
        gapMask *= 1.0 - (smoothstep(0.40, 0.42, t) - smoothstep(0.44, 0.46, t));
        gapMask *= 1.0 - (smoothstep(0.72, 0.74, t) - smoothstep(0.76, 0.78, t));

        vec3 col = mix(uColorA, uColorB, clamp(bands, 0.0, 1.0));

        // Soft inner & outer edge so the ring fades into space, not a hard line.
        float edge = smoothstep(0.0, 0.04, t) * (1.0 - smoothstep(0.94, 1.0, t));

        // Light both faces of the ring — abs() so the lit side flips correctly
        // as the camera moves to the other side of the equatorial plane.
        float light = max(0.25, abs(dot(normalize(vWorldNormal), normalize(uSunDir))));

        // Planet-cast shadow: a fragment behind the body (along the sun line)
        // and within ~bodyRadius of the body axis is occluded. smoothstep gives
        // a soft umbra edge instead of a hard cutout.
        vec3 rel = vWorldPos - uBodyCenter;
        vec3 sd = normalize(uSunDir);
        float along = dot(rel, sd);
        float shadow = 1.0;
        if (along < 0.0) {
          vec3 perp = rel - along * sd;
          float d = length(perp);
          shadow = smoothstep(uBodyRadius * 0.95, uBodyRadius * 1.10, d);
        }

        float alpha = uIntensity * (0.28 + 0.72 * bands) * gapMask * edge;

        // Gas occlusion: depth buffer can't help us here because the gas shell
        // uses depthWrite:false (so it can blend with the body). Without this
        // check, the back half of the ring shows straight through a thick
        // atmosphere or a gas-giant body. We ray-march the camera→fragment ray
        // against the planet's gas sphere and attenuate alpha by how much gas
        // sits in front of the fragment.
        if (uGasOpacity > 0.0 && uGasRadius > 0.0) {
          vec3 toFrag = vWorldPos - cameraPosition;
          float distToFrag = length(toFrag);
          vec3 rayDir = toFrag / max(distToFrag, 1e-4);
          vec3 toBody = uBodyCenter - cameraPosition;
          float tBody = dot(toBody, rayDir);
          // Only occlude when the gas sphere sits between camera and fragment.
          if (tBody > 0.0 && tBody < distToFrag) {
            float perp2 = dot(toBody, toBody) - tBody * tBody;
            float gasR2 = uGasRadius * uGasRadius;
            if (perp2 < gasR2) {
              // Center of the disc → ray goes through the full diameter →
              // strongest occlusion. Near the limb → ray clips a thin slice →
              // weakest occlusion. Squaring softens the falloff so the gas
              // silhouette doesn't terminate with a hard ring on the limb.
              float depthFactor = sqrt(max(0.0, 1.0 - perp2 / gasR2));
              alpha *= 1.0 - clamp(depthFactor * uGasOpacity, 0.0, 1.0);
            }
          }
        }

        gl_FragColor = vec4(col * light * mix(0.30, 1.0, shadow), clamp(alpha, 0.0, 1.0));
      }
    `;

    // Inner/outer factors are multiples of body.baseRadius — rings auto-fit any
    // planet size because both the geometry and the shader's uInner/uOuter are
    // derived from baseRadius. Body group scale then carries the ring to its
    // final world size.
    const RING_INNER_FACTOR = 1.40;
    const RING_OUTER_FACTOR = 2.30;

    function makeRingMaterial() {
      return new THREE.ShaderMaterial({
        vertexShader: RING_VERT,
        fragmentShader: RING_FRAG,
        uniforms: {
          uInner:      { value: 1.0 },
          uOuter:      { value: 2.0 },
          uIntensity:  { value: 0.65 },
          uColorA:     { value: new THREE.Color(0x8a6b3a) }, // dusty brown
          uColorB:     { value: new THREE.Color(0xe8d2a0) }, // pale ice
          uSunDir:     { value: new THREE.Vector3(1, 0, 0) }, // refreshed per-frame
          uBodyCenter: { value: new THREE.Vector3() },
          uBodyRadius: { value: 1.0 },
          // Gas occluder — refreshed per-frame so atmo/ring slider changes take
          // effect immediately. uGasOpacity=0 short-circuits the check, so
          // bodies without gas pay no shader cost beyond a uniform fetch.
          uGasRadius:  { value: 0.0 },
          uGasOpacity: { value: 0.0 },
        },
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
    }

    // ====== 7. Body creation ======
    // createBody is the factory used by everything (planets, moons). The returned
    // object's shape is documented in ARCHITECTURE.md → "Data model → Body".
    function createBody({ kind, name, baseRadius, detail, palette, hasOcean, initialHeight = -0.5 }) {
      const geo = new THREE.IcosahedronGeometry(baseRadius, detail);
      const posAttr = geo.attributes.position;
      const N = posAttr.count;
      const unitDirs = new Float32Array(N * 3);
      const heights  = new Float32Array(N);
      const biomes   = new Uint8Array(N); // 0 = auto, 1 = forest, 2 = desert, 3 = city, 4 = tundra
      for (let i = 0; i < N; i++) {

        const x = posAttr.array[3 * i];
        const y = posAttr.array[3 * i + 1];
        const z = posAttr.array[3 * i + 2];
        const inv = 1 / Math.hypot(x, y, z);
        unitDirs[3 * i]     = x * inv;
        unitDirs[3 * i + 1] = y * inv;
        unitDirs[3 * i + 2] = z * inv;
        heights[i] = initialHeight;
      }
      const colorArr = new Float32Array(N * 3);
      geo.setAttribute('color', new THREE.BufferAttribute(colorArr, 3));

      // Per-vertex self-glow (0..1), written by colorBodyVertex. Used so ice caps
      // read as luminous crystal even at the poles, where the sun grazes and pure
      // diffuse shading would otherwise crush any color to grey. Injected into the
      // standard material as an extra emissive term (see onBeforeCompile below).
      const glowArr = new Float32Array(N);
      geo.setAttribute('aGlow', new THREE.BufferAttribute(glowArr, 1));

      const mat = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.92,
        metalness: 0.0,
        flatShading: false,
      });
      // Add `aGlow * ICE_GLOW_COLOR` to the emissive output. Keeps the night side
      // of ordinary terrain black (aGlow = 0 there) while letting ice self-light.
      mat.onBeforeCompile = (shader) => {
        shader.uniforms.uGlowColor = { value: ICE_GLOW_COLOR };
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nattribute float aGlow;\nvarying float vGlow;')
          .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vGlow = aGlow;');
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\nuniform vec3 uGlowColor;\nvarying float vGlow;')
          .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance += uGlowColor * vGlow;');
      };
      mat.customProgramCacheKey = () => 'bodyGlow';
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;

      const group = new THREE.Group();
      group.add(mesh);

      // Liquid layer (ocean) — always created so toggling an archetype that adds
      // an ocean later actually shows water instead of bare deep-color terrain.
      // Vertex-colored (not a flat material color) so a water ocean can carry a
      // latitude gradient: sea ice at the cold poles, steam/evaporation at the hot
      // equator. `aGlow` keeps polar sea ice luminous (same trick as land ice);
      // `aEvap` discards fully boiled-off fragments so the dried seabed shows.
      const oceanGeo = new THREE.SphereGeometry(baseRadius, 160, 96);
      const oceanVerts = oceanGeo.attributes.position.count;
      oceanGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(oceanVerts * 3).fill(1), 3));
      oceanGeo.setAttribute('aGlow', new THREE.BufferAttribute(new Float32Array(oceanVerts), 1));
      oceanGeo.setAttribute('aEvap', new THREE.BufferAttribute(new Float32Array(oceanVerts), 1));
      // Per-vertex signed seabed height for the foam line (~0 at the coast,
      // negative offshore), baked by bakeOceanShore on regen / when stepping on.
      oceanGeo.setAttribute('aShore', new THREE.BufferAttribute(new Float32Array(oceanVerts), 1));
      const oceanMat = new THREE.MeshStandardMaterial({
        color: 0xffffff,            // real tint comes from per-vertex colors below
        vertexColors: true,
        roughness: 0.30,
        metalness: 0.05,
        transparent: true,
        opacity: 1.0,               // real alpha is driven per-fragment in the shader below
        side: THREE.DoubleSide,     // walker can dive under: inner faces must render too
      });
      oceanMat.onBeforeCompile = (shader) => {
        shader.uniforms.uGlowColor = { value: ICE_GLOW_COLOR };
        // View-angle transparency: water is nearly clear when you look straight
        // down into it (so the seabed terrain below sea level shows through near
        // shore) and turns opaque at grazing angles. uClearA / uOpaqueA bracket
        // the alpha. CRUCIAL: this see-through only applies up close — a camera-
        // distance fade (uBodyR below) forces the ocean back to fully opaque from
        // orbit, so the planet looks exactly as it did before from space.
        shader.uniforms.uClearA  = { value: 0.42 };
        shader.uniforms.uOpaqueA = { value: 0.92 };
        shader.uniforms.uBodyR   = { value: baseRadius };
        // uSurface gates ALL water effects (waves + see-through) to surface-walk
        // mode only. From space it's 0, so the ocean is the plain opaque sphere it
        // always was. enterSurfaceMode flips it to 1.
        shader.uniforms.uSurface = { value: 0 };
        // STEP 1 — wave HEIGHT: uWaveTime advances on the gas clock (freezes on
        // pause). Waves are real radial (up/down) vertex displacement from a sum of
        // travelling sines (oceanWave). uWaveAmp scales the swell height; the mesh
        // is 160×96 so only wavelengths > ~1 world unit survive (long ocean swells,
        // not ripples). Foam is intentionally REMOVED here — added in a later step.
        shader.uniforms.uWaveTime = { value: 0 };
        shader.uniforms.uWaveAmp  = { value: baseRadius * 0.0016 };
        oceanMat.userData.shader = shader;   // keep a handle so the loop can poke uWaveTime
        shader.vertexShader = shader.vertexShader
          // oceanWave: travelling swells sampled in LOCAL position space (world
          // units). Frequencies kept low so the wavelength clears the mesh Nyquist
          // limit and the swell actually displaces geometry instead of aliasing.
          .replace('#include <common>', '#include <common>\nattribute float aGlow;\nattribute float aEvap;\nattribute float aShore;\nvarying float vGlow;\nvarying float vEvap;\nvarying float vShore;\nvarying vec3 vLocalPos;\nvarying vec3 vWNormal;\nvarying vec3 vWPos;\nuniform float uWaveTime;\nuniform float uWaveAmp;\nuniform float uSurface;\nfloat oceanWave(vec3 p){\n  float t = uWaveTime;\n  float h = 0.0;\n  h += sin(p.x * 1.3 + p.z * 0.7 + t * 1.1) * 0.60;\n  h += sin(p.z * 1.8 - p.x * 0.5 + t * 1.4) * 0.40;\n  h += sin((p.x + p.z) * 2.7 + t * 1.9) * 0.25;\n  return h;\n}')
          // Perturb the shading normal from the wave slope (finite differences along
          // two surface tangents) so the swells catch light. Keep the STABLE
          // geometric normal (_gnrm) for the transparency calc — if the wave normal
          // drove transparency it would shimmer and look like the coast reshaping.
          .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n  vec3 _wp = position;\n  float _wh = oceanWave(_wp) * uSurface;\n  vec3 _gnrm = normalize(objectNormal);\n  vec3 _wup = abs(_gnrm.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);\n  vec3 _t1 = normalize(cross(_gnrm, _wup));\n  vec3 _t2 = cross(_gnrm, _t1);\n  float _e = 0.25;\n  float _gx = (oceanWave(_wp + _t1 * _e) * uSurface - _wh) / _e;\n  float _gy = (oceanWave(_wp + _t2 * _e) * uSurface - _wh) / _e;\n  objectNormal = normalize(_gnrm - (_t1 * _gx + _t2 * _gy) * uWaveAmp * 6.0);')
          // Displace the vertex radially by the wave height (this is the up/down).
          .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vGlow = aGlow;\n  vEvap = aEvap;\n  vShore = aShore;\n  vLocalPos = position;\n  transformed += normalize(position) * (_wh * uWaveAmp);\n  vec4 _owp = modelMatrix * vec4(transformed, 1.0);\n  vWPos = _owp.xyz;\n  vWNormal = normalize(mat3(modelMatrix) * _gnrm);');
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\nuniform vec3 uGlowColor;\nuniform float uClearA;\nuniform float uOpaqueA;\nuniform float uBodyR;\nuniform float uSurface;\nvarying float vGlow;\nvarying float vEvap;\nvarying float vShore;\nvarying vec3 vLocalPos;\nvarying vec3 vWNormal;\nvarying vec3 vWPos;')
          .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\n  if (vEvap > 0.5) discard;')   // ocean boiled away here
          .replace('#include <color_fragment>', '#include <color_fragment>\n  float _facing = abs(dot(normalize(vWNormal), normalize(cameraPosition - vWPos)));\n  float _clearA = mix(uOpaqueA, uClearA, _facing);\n  float _prox = uSurface * (1.0 - smoothstep(uBodyR * 0.6, uBodyR * 1.6, distance(cameraPosition, vWPos)));\n  diffuseColor.a = mix(uOpaqueA, _clearA, _prox);')
          .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance += uGlowColor * vGlow;');
      };
      oceanMat.customProgramCacheKey = () => 'oceanClimate';
      const oceanMesh = new THREE.Mesh(oceanGeo, oceanMat);
      oceanMesh.receiveShadow = true;
      oceanMesh.visible = !!hasOcean;
      group.add(oceanMesh);

      // Gas layer — translucent shell driven by a custom shader so atmospheres
      // look like sparse clouds and gas giants get a feathered silhouette.
      // depthWrite:false (set on the material) avoids z-fighting with the
      // solid/liquid meshes when the shell sits just outside them.
      const gasMesh = new THREE.Mesh(
        new THREE.SphereGeometry(baseRadius, 64, 48),
        makeGasMaterial()
      );
      gasMesh.visible = false;
      gasMesh.renderOrder = 1; // render after the solid mesh so transparency blends right
      group.add(gasMesh);

      // Plasma layer — an emissive, animated photosphere for stars. Replaces
      // the solid surface entirely (matter.plasma hides body.mesh), so it sits
      // at the surface radius. Opaque + self-lit, so it neither casts nor
      // receives shadows. Hidden until an archetype turns plasma on.
      const plasmaMesh = new THREE.Mesh(
        new THREE.SphereGeometry(baseRadius, 96, 64),
        makePlasmaMaterial()
      );
      plasmaMesh.visible = false;
      plasmaMesh.castShadow = false;
      plasmaMesh.receiveShadow = false;
      group.add(plasmaMesh);

      // Ring annulus, only meaningful on planets. RingGeometry is built in the
      // XY plane; rotating −π/2 around X lays it flat in the body's equatorial
      // (XZ) plane. Rings have rotational symmetry about Y so the planet's
      // daily spin (group.rotation.y) doesn't visually drag them along.
      const ringInner = baseRadius * RING_INNER_FACTOR;
      const ringOuter = baseRadius * RING_OUTER_FACTOR;
      const ringMesh = new THREE.Mesh(
        new THREE.RingGeometry(ringInner, ringOuter, 192, 4),
        makeRingMaterial()
      );
      ringMesh.rotation.x = -Math.PI / 2;
      ringMesh.material.uniforms.uInner.value = ringInner;
      ringMesh.material.uniforms.uOuter.value = ringOuter;
      ringMesh.material.uniforms.uBodyRadius.value = baseRadius;
      ringMesh.visible = false;
      ringMesh.renderOrder = 2;
      group.add(ringMesh);

      const body = {
        kind, name, baseRadius, detail,
        palette: palette || (kind === 'planet' ? PLANET_PALETTE : MOON_PALETTE),
        group, mesh, geo, posAttr, N, unitDirs, heights, biomes, colorArr, glowArr,
        oceanMesh, gasMesh, plasmaMesh, ringMesh,
        // Matter state. Moons keep matter.gas/plasma false; planets inherit from
        // ARCHETYPE_MATTER on regenerate. plasma is the fourth type (stars).
        matter: { solid: true, liquid: !!hasOcean, gas: false, plasma: false },
        gasMode: 'none',
        gasThickness: 1.10,
        gasDensity: 0.18,
        gasCoverage: 0.35,
        // Atmospheric band paint state (full-gas only). Lazily allocated by
        // ensureGasPaint when the body's matter becomes gas:'full'.
        gasPaint: null,
        rings: { enabled: false, intensity: 0.65 },
      };

      for (let i = 0; i < N; i++) {
        writeBodyVertex(body, i);
        colorBodyVertex(body, i);
      }
      commitBodyChanges(body);
      return body;
    }

    function writeBodyVertex(body, i) {
      const r = body.baseRadius * (1 + body.heights[i] * BODY_HEIGHT_SCALE);
      body.posAttr.array[3 * i]     = body.unitDirs[3 * i]     * r;
      body.posAttr.array[3 * i + 1] = body.unitDirs[3 * i + 1] * r;
      body.posAttr.array[3 * i + 2] = body.unitDirs[3 * i + 2] * r;
    }

    // Surface temperature (°C) at vertex i: the body's climate gives a pole→
    // equator gradient (cos(lat)^1.6, latitude = asin(unitDir.y)), then elevation
    // cools it via the lapse rate so peaks run colder than lowlands at the same
    // latitude. Assumes body.climate is set (callers gate on it).
    function vertexTempC(body, i) {
      const clim = body.climate;
      const uy = body.unitDirs[3 * i + 1];
      const cosLat = Math.sqrt(Math.max(0, 1 - uy * uy));   // 1 at equator → 0 at pole
      const warmth = Math.pow(cosLat, 1.6);
      const tK = clim.poleK + (clim.equatorK - clim.poleK) * warmth;
      return (tK - KELVIN_ZERO_C) - Math.max(0, body.heights[i]) * CLIMATE_LAPSE_C;
    }

    // Pick the land biome zone for a temperature. Zones are ordered warmest-first
    // with a `minTempC` floor; the first whose floor we clear wins (coldest is the
    // catch-all). Used by both colorBodyVertex and the composition rollup so the
    // surface and the panel always name the same biome.
    function pickLandZone(zones, tempC) {
      for (const z of zones) if (tempC >= z.minTempC) return z;
      return zones[zones.length - 1];
    }

    function colorBodyVertex(body, i) {
      const h = body.heights[i];
      const b = body.biomes[i];
      const p = body.palette;
      let c;
      if (body.glowArr) body.glowArr[i] = 0;  // cleared each repaint; ice sets it below

      if (b === BIOME.FOREST) {
        c = new THREE.Color(COL.forest);
        const mix = smoothstep(GRASS_TOP, ROCK_TOP, h);
        c.lerp(new THREE.Color(COL.grassDark), mix * 0.3);
      } else if (b === BIOME.DESERT) {
        c = new THREE.Color(COL.desert);
        const mix = smoothstep(SEA_LEVEL, SAND_TOP, h);
        c.lerp(new THREE.Color(COL.sand), mix * 0.2);
      } else if (b === BIOME.TUNDRA) {
        c = new THREE.Color(COL.snow);
        c.lerp(new THREE.Color(COL.shore), 0.1);
      } else if (b === 5) { // Obsidian
        c = new THREE.Color(0x1a1a1a);
      } else if (b === 6) { // Magma Flow
        c = new THREE.Color(0xff4500);
        if ((i * 7) % 10 > 5) c.lerp(new THREE.Color(0xff8c00), 0.5);
      } else if (b === 7) { // Circuitry
        c = new THREE.Color(0x00f2ff);
        if ((i * 13) % 10 > 3) c = new THREE.Color(0x0a0a0a);
      } else if (b === 8) { // Plating
        c = new THREE.Color(0x444444);
        if ((i * 3) % 10 > 7) c = new THREE.Color(0x666666);
      } else if (b === 11) { // Coral Reef
        c = new THREE.Color(0xff7f50);
        if ((i * 3) % 10 > 5) c = new THREE.Color(0xff69b4);
      } else if (b === 12) { // Kelp Forest
        c = new THREE.Color(0x2e8b57);
      } else if (b === 13) { // Abyssal Trench
        c = new THREE.Color(0x000033);
      } else if (b === 14) { // Sulfur Vent
        c = new THREE.Color(0xffff00);
      } else if (b === 15) { // Oasis
        c = new THREE.Color(0x228b22);
      } else if (b === 16) { // Ancient Ruins
        c = new THREE.Color(0x808080);
        if ((i * 11) % 10 > 7) c = new THREE.Color(0x00f2ff); // glowing ruins
      } else if (b === 17) { // Red Sand
        c = new THREE.Color(0x8b0000);
      } else if (b === 18) { // Glacier
        c = new THREE.Color(0xe0ffff);
      } else if (b === 19) { // Cryo-Volcano
        c = new THREE.Color(0xadd8e6);
        if ((i * 5) % 10 > 8) c = new THREE.Color(0xffffff);
      } else if (b === 21) { // Exotic Bloom
        c = new THREE.Color(0xff00ff);
      } else if (b === 24) { // Data Hub
        c = new THREE.Color(0x00f2ff);
        textShadow: '0 0 10px #00f2ff';
      } else if (b === 26) { // Rust
        c = new THREE.Color(0x8b4513);
      } else if (b === 27) { // Gold
        c = new THREE.Color(0xffd700);
      } else if (b === 29) { // Neural
        c = new THREE.Color(0xff69b4);
        if ((i * 2) % 10 > 8) c = new THREE.Color(0xffffff);
      } else if (b === 32) { // Lightning
        c = new THREE.Color(0xffffff);
        if ((i * 17) % 10 > 2) c = new THREE.Color(0x4b0082);
      } else if (b === BIOME.MARE) { // Dark basalt plains
        c = new THREE.Color(0x2a2a30);
        if ((i * 7) % 10 > 8) c = new THREE.Color(0x3a3a42);
      } else if (b === BIOME.REGOLITH) { // Bright lunar dust
        c = new THREE.Color(0xc4b8a0);
        if ((i * 3) % 10 > 6) c = new THREE.Color(0xd6cdb6);
      } else if (b === BIOME.FROST) { // Polar ice patches
        c = new THREE.Color(0xd8e8f0);
        if ((i * 5) % 10 > 7) c = new THREE.Color(0xffffff);
      } else if (body.kind === 'planet') {
        // Does this archetype's land vary with latitude? Only once climate is
        // known (post-bootstrap) and the world has a real equator-to-pole spread.
        const zoned = body.climate && body.climate.spread > 0.5;
        const zones = zoned ? CLIMATE_LAND_ZONES[body.archetype] : null;
        if (h < SEA_LEVEL) {
          // Sea floor. Normally hidden under the water sphere (deep→shore blue),
          // but on a water world hot enough to boil its sea off, the basin dries
          // out — the submerged terrain bakes to a pale cracked salt flat as its
          // temperature climbs from boiling toward full evaporation.
          if (h < -0.4) c = new THREE.Color(p.deep);
          else {
            const t = (h + 0.4) / (SEA_LEVEL + 0.4);
            c = new THREE.Color(p.deep).lerp(new THREE.Color(p.shore), t);
          }
          if (zoned && body.oceanIsWater) {
            const dry = smoothstep(SEA_BOIL_C, SEA_VAPOR_C, vertexTempC(body, i));
            if (dry > 0) c.lerp(new THREE.Color(SEABED_COLOR), dry);
          }
        } else if (zones) {
          // Latitude-zoned land: pick the biome by this vertex's temperature,
          // then layer the usual elevation cues on top (sandy shore, rocky
          // relief, snow-capped peaks) so the terrain still reads in 3D.
          const z = pickLandZone(zones, vertexTempC(body, i));
          if (h >= ROCK_TOP) {
            const t = smoothstep(ROCK_TOP, ROCK_TOP + SNOW_FADE, h);
            c = new THREE.Color(p.rock).lerp(new THREE.Color(p.snow), t);
          } else if (z.beach && h < SAND_TOP) {
            const t = smoothstep(SEA_LEVEL, SAND_TOP, h);
            c = new THREE.Color(p.sand).lerp(new THREE.Color(z.color), t);
          } else {
            c = new THREE.Color(z.color);
            if (z.relief && h >= GRASS_TOP) {
              const t = smoothstep(GRASS_TOP, ROCK_TOP, h);
              c.lerp(new THREE.Color(p.rock), t * 0.6);
            }
            // Ice (and any zone with `glow`) self-emits so it stays bright at the
            // poles where the sun grazes — written into the aGlow attribute.
            if (z.glow && body.glowArr) body.glowArr[i] = z.glow;
          }
        } else if (h < SAND_TOP) c = new THREE.Color(p.sand);
        else if (h < GRASS_TOP) {
          const t = smoothstep(SAND_TOP, SAND_TOP + 0.15, h);
          c = new THREE.Color(p.sand).lerp(new THREE.Color(p.grass), t);
        } else if (h < ROCK_TOP) {
          const t = smoothstep(GRASS_TOP, GRASS_TOP + 0.4, h);
          c = new THREE.Color(p.grass).lerp(new THREE.Color(p.rock), t);
        } else {
          const t = smoothstep(ROCK_TOP, ROCK_TOP + SNOW_FADE, h);
          c = new THREE.Color(p.rock).lerp(new THREE.Color(p.snow), t);
        }
      } else {
        // Moon logic stays same
        if (h < -0.6) c = new THREE.Color(p.crater);
        else if (h < 0) {
          const t = (h + 0.6) / 0.6;
          c = new THREE.Color(p.crater).lerp(new THREE.Color(p.dust), t);
        } else if (h < GRASS_TOP) {
          const t = smoothstep(0, GRASS_TOP, h);
          c = new THREE.Color(p.dust).lerp(new THREE.Color(p.rock), t);
        } else {
          const t = smoothstep(ROCK_TOP, ROCK_TOP + SNOW_FADE, h);
          c = new THREE.Color(p.rock).lerp(new THREE.Color(p.highlight), t);
        }
      }
      body.colorArr[3 * i]     = c.r;
      body.colorArr[3 * i + 1] = c.g;
      body.colorArr[3 * i + 2] = c.b;
    }

    // MUST be called after any batch of writeBodyVertex / colorBodyVertex
    // mutations; otherwise the GPU keeps rendering stale positions/colors and
    // lighting normals go out of sync.
    function commitBodyChanges(body) {
      body.posAttr.needsUpdate = true;
      body.geo.attributes.color.needsUpdate = true;
      if (body.geo.attributes.aGlow) body.geo.attributes.aGlow.needsUpdate = true;
      body.geo.computeVertexNormals();
    }

    // Reads brushRadius / brushStrength / brushRaise from the module-scope state
    // declared further below — those values exist at call time (animate loop).
    function applyBrushToBody(body, centerLocal, dt) {
      // Full-gas planets don't have an editable solid surface, so the brush
      // either drag-paints the band LUT (gasband) or grows the active
      // whirlpool's strength (gaswhirl). Either way, vertex heights/biomes
      // aren't touched.
      if (body.matter && body.matter.gas === 'full') {
        if (currentTool === 'gasband') applyGasPaintBrush(body, centerLocal, dt);
        else if (currentTool === 'gaswhirl' && activeVortex) growGasVortex(body, activeVortex, dt);
        return;
      }
      const cx = centerLocal.x, cy = centerLocal.y, cz = centerLocal.z;
      const invLen = 1 / Math.hypot(cx, cy, cz);
      const ux = cx * invLen, uy = cy * invLen, uz = cz * invLen;

      const cosCut = Math.cos(brushRadius);
      const dir = brushRaise ? 1 : -1;
      const delta = dir * brushStrength * dt;

      let touchedAny = false;
      for (let i = 0; i < body.N; i++) {
        const dx = body.unitDirs[3 * i];
        const dy = body.unitDirs[3 * i + 1];
        const dz = body.unitDirs[3 * i + 2];
        const dot = dx * ux + dy * uy + dz * uz;
        if (dot <= cosCut) continue;

        if (currentTool === 'land') {
          const ang = Math.acos(Math.min(1, dot));
          const t = ang / brushRadius;
          const f = 1 - t * t;
          const falloff = f * f;
          const next = body.heights[i] + delta * falloff;
          body.heights[i] = next < MIN_LAND_HEIGHT ? MIN_LAND_HEIGHT
                          : next > MAX_LAND_HEIGHT ? MAX_LAND_HEIGHT
                          : next;
          writeBodyVertex(body, i);
        } else {
          // Biome painting
          body.biomes[i] = selectedBiome;
        }
        
        colorBodyVertex(body, i);
        touchedAny = true;
      }
      if (touchedAny) commitBodyChanges(body);
    }

    // ====== 8. Terrain generation ======
    // Seeded sum-of-random-plane-waves on the sphere. Each "octave" is a random unit
    // direction with its own frequency/phase; cos(dir · point) summed over many
    // octaves produces continent-like patterns without a full simplex impl.
    const TERRAIN_OCTAVES = 24;

    function hashSeed(str) {
      let h = 2166136261 >>> 0;
      for (let i = 0; i < str.length; i++) {
        h = Math.imul(h ^ str.charCodeAt(i), 16777619);
      }
      return h >>> 0;
    }

    function makeRNG(seed) {
      let s = (seed | 0) || 1;
      return function () {
        s = (s + 0x6D2B79F5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    // Builds a sum-of-sines noise basis on the unit sphere: each entry has a
    // random direction, a frequency that climbs with octave index, and a 1/f-ish
    // amplitude so higher octaves contribute less. Deterministic given `seedNum`.
    function buildTerrainBasis(seedNum, count) {
      const rng = makeRNG(seedNum);
      const basis = [];
      let ampSum = 0;
      for (let k = 0; k < count; k++) {
        const a = rng() * Math.PI * 2;
        const z = rng() * 2 - 1;
        const r = Math.sqrt(Math.max(0, 1 - z * z));
        const freq = 0.6 + k * 0.35 + rng() * 0.25;
        const amp = 1 / (0.5 + freq * 0.8);
        ampSum += amp;
        basis.push({
          dx: r * Math.cos(a),
          dy: r * Math.sin(a),
          dz: z,
          freq,
          amp,
          phase: rng() * Math.PI * 2,
        });
      }
      for (const b of basis) b.amp /= ampSum;
      return basis;
    }

    function sampleTerrainNoise(basis, ux, uy, uz) {
      let sum = 0;
      for (let i = 0; i < basis.length; i++) {
        const b = basis[i];
        sum += Math.cos((b.dx * ux + b.dy * uy + b.dz * uz) * b.freq * Math.PI + b.phase) * b.amp;
      }
      return sum;
    }

    // ====== 9. Archetypes ======
    // amplitude: peak height in height-units. seaCoverage (0..1): fraction of surface
    // biased below sea level (by picking that percentile of samples as the new zero).
    const ARCHETYPES = {
      terrestrial: { name: 'Terrestrial', palette: PLANET_PALETTE, hasOcean: true, amp: 2.0, sea: 0.55 },
      ocean: { name: 'Ocean World', palette: { deep: 0x001a33, shore: 0x004d99, sand: 0x0066cc, grass: 0x0080ff, rock: 0x3399ff, snow: 0x66b2ff }, hasOcean: true, amp: 1.5, sea: 0.9 },
      gas_giant: { name: 'Gas Giant', palette: { deep: 0x331a00, shore: 0x663300, sand: 0x996633, grass: 0xcc9966, rock: 0xffcc99, snow: 0xffffff }, hasOcean: false, amp: 0.8, sea: 0.0 },
      ice_giant: { name: 'Ice Giant', palette: { deep: 0x003366, shore: 0x006699, sand: 0x3399ff, grass: 0x66b2ff, rock: 0x99ccff, snow: 0xffffff }, hasOcean: false, amp: 1.2, sea: 0.0 },
      desert: { name: 'Martian Planet', palette: { deep: 0x4a2412, shore: 0x7d3a1f, sand: 0xcf7d4d, grass: 0xb96138, rock: 0x8a4424, snow: 0xe2b48f }, hasOcean: false, amp: 2.5, sea: 0.0 },
      lava: { name: 'Lava Planet', palette: { deep: 0x330000, shore: 0x660000, sand: 0xff3300, grass: 0xff6600, rock: 0x331a00, snow: 0x663300 }, hasOcean: true, oceanCol: 0xff4500, amp: 3.0, sea: 0.4 },
      ice_planet: { name: 'Ice Planet', palette: { deep: 0x003366, shore: 0x006699, sand: 0x99ccff, grass: 0xccf2ff, rock: 0x6699cc, snow: 0xffffff }, hasOcean: false, amp: 1.8, sea: 0.0 },
      jungle: { name: 'Jungle Planet', palette: { deep: 0x002200, shore: 0x004400, sand: 0x1a3300, grass: 0x006400, rock: 0x2d5a27, snow: 0x4d994d }, hasOcean: true, oceanCol: 0x1a3300, amp: 2.5, sea: 0.4 },
      swamp: { name: 'Swamp Planet', palette: { deep: 0x1a1a00, shore: 0x333300, sand: 0x4d4d00, grass: 0x2d5a27, rock: 0x1a3300, snow: 0x4d994d }, hasOcean: true, oceanCol: 0x2d5a27, amp: 1.5, sea: 0.7 },
      toxic: { name: 'Toxic Planet', palette: { deep: 0x1a0033, shore: 0x330066, sand: 0xadff2f, grass: 0x32cd32, rock: 0x4b0082, snow: 0x7fff00 }, hasOcean: true, oceanCol: 0xadff2f, amp: 2.2, sea: 0.6 },
      venusian: { name: 'Venusian Planet', palette: { deep: 0x4a3520, shore: 0x7a5a2e, sand: 0xc9a25b, grass: 0xd2b074, rock: 0x8f6d3a, snow: 0xf2e2b5 }, hasOcean: false, amp: 1.5, sea: 0.0 },
      metal: { name: 'Metal-Rich', palette: { deep: 0x1a1a1a, shore: 0x333333, sand: 0x4d4d4d, grass: 0x666666, rock: 0x1a1a1a, snow: 0xffd700 }, hasOcean: false, amp: 3.5, sea: 0.0 },
      carbon: { name: 'Carbon Planet', palette: { deep: 0x050505, shore: 0x101010, sand: 0x1a1a1a, grass: 0x252525, rock: 0x0a0a0a, snow: 0x333333 }, hasOcean: false, amp: 2.2, sea: 0.0 },
      moon_like: { name: 'Moon-Like Rocky Planet', palette: { deep: 0x322e29, shore: 0x4a4238, sand: 0x6f6357, grass: 0x8a8174, rock: 0xa49a8b, snow: 0xe2dccf }, hasOcean: false, amp: 1.8, sea: 0.0 },
      storm: { name: 'Storm Planet', palette: { deep: 0x1a1a33, shore: 0x333366, sand: 0x4d4d99, grass: 0x6666cc, rock: 0x1a1a4d, snow: 0x9999ff }, hasOcean: true, oceanCol: 0x1a1a33, amp: 3.5, sea: 0.5 },
      living: { name: 'Living Planet', palette: { deep: 0x33001a, shore: 0x660033, sand: 0x99004d, grass: 0xcc0066, rock: 0x33001a, snow: 0xff0080 }, hasOcean: true, oceanCol: 0x4d0026, amp: 1.8, sea: 0.3 },
      rogue: { name: 'Rogue Planet', palette: { deep: 0x020205, shore: 0x050510, sand: 0x0a0a1a, grass: 0x101025, rock: 0x020208, snow: 0x1a1a33 }, hasOcean: false, amp: 2.0, sea: 0.0 },
      star: { name: 'Star', palette: { deep: 0x3a0a00, shore: 0x7a1500, sand: 0xff6a00, grass: 0xffaa00, rock: 0xffd24d, snow: 0xfff4d0 }, hasOcean: false, amp: 1.0, sea: 0.0 },
    };

    // Each archetype declares its matter composition. `gas` is one of:
    //   false        — no gas at all (bare rock world)
    //   'atmosphere' — thin shell wrapping the solid/liquid surface
    //   'full'       — body IS the gas (no solid, no liquid; e.g. gas giants)
    // gasThickness is multiplied with baseRadius (1.0 = surface; 1.20 = +20%).
    // gasDensity is the shell's base opacity (0..1).
    const ARCHETYPE_MATTER = {
      terrestrial: { solid: true,  liquid: true,  gas: 'atmosphere', gasCol: 0xffffff, skyTint: 0x87ceeb, gasThickness: 1.10, gasDensity: 0.45, gasCoverage: 0.35, windSpeed: 0.03 },
      ocean:       { solid: true,  liquid: true,  gas: 'atmosphere', gasCol: 0xcce7ff, skyTint: 0x9ad0e6, gasThickness: 1.10, gasDensity: 0.50, gasCoverage: 0.40, windSpeed: 0.04 },
      gas_giant:   { solid: false, liquid: false, gas: 'full',       gasCol: 0xc89060, gasThickness: 1.00, gasDensity: 0.95, gasCoverage: 0.50, windSpeed: 0.12 },
      ice_giant:   { solid: false, liquid: false, gas: 'full',       gasCol: 0x88bbee, gasThickness: 1.00, gasDensity: 0.92, gasCoverage: 0.50, windSpeed: 0.08 },
      desert:      { solid: true,  liquid: false, gas: 'atmosphere', gasCol: 0xe8c4a0, skyTint: 0xd2a07a, gasThickness: 1.10, gasDensity: 0.42, gasCoverage: 0.20, windSpeed: 0.04 },
      lava:        { solid: true,  liquid: true,  gas: 'atmosphere', gasCol: 0xff8844, skyTint: 0xc4441a, gasThickness: 1.08, gasDensity: 0.55, gasCoverage: 0.40, windSpeed: 0.10 },
      ice_planet:  { solid: true,  liquid: false, gas: 'atmosphere', gasCol: 0xccddee, skyTint: 0xb8d8ec, gasThickness: 1.05, gasDensity: 0.30, gasCoverage: 0.25, windSpeed: 0.02 },
      jungle:      { solid: true,  liquid: true,  gas: 'atmosphere', gasCol: 0xe8f5e0, skyTint: 0xb6dba0, gasThickness: 1.12, gasDensity: 0.55, gasCoverage: 0.65, windSpeed: 0.04 },
      swamp:       { solid: true,  liquid: true,  gas: 'atmosphere', gasCol: 0xc5d4a8, skyTint: 0x96a878, gasThickness: 1.10, gasDensity: 0.60, gasCoverage: 0.55, windSpeed: 0.02 },
      toxic:       { solid: true,  liquid: true,  gas: 'atmosphere', gasCol: 0xadff2f, skyTint: 0x70c020, gasThickness: 1.15, gasDensity: 0.70, gasCoverage: 0.70, windSpeed: 0.06 },
      venusian:    { solid: true,  liquid: false, gas: 'atmosphere', gasCol: 0xe6c870, skyTint: 0xe6c870, gasThickness: 1.16, gasDensity: 1.00, gasCoverage: 1.00, windSpeed: 0.01 },
      metal:       { solid: true,  liquid: false, gas: false },
      carbon:      { solid: true,  liquid: false, gas: 'atmosphere', gasCol: 0x555555, skyTint: 0x303030, gasThickness: 1.06, gasDensity: 0.45, gasCoverage: 0.40, windSpeed: 0.03 },
      moon_like:   { solid: true,  liquid: false, gas: false },
      storm:       { solid: true,  liquid: true,  gas: 'atmosphere', gasCol: 0xaaaaff, skyTint: 0x6878a0, gasThickness: 1.18, gasDensity: 0.80, gasCoverage: 0.85, windSpeed: 0.18 },
      living:      { solid: true,  liquid: true,  gas: 'atmosphere', gasCol: 0xff99cc, skyTint: 0xe682b5, gasThickness: 1.08, gasDensity: 0.50, gasCoverage: 0.45, windSpeed: 0.05 },
      rogue:       { solid: true,  liquid: false, gas: false },
      // Plasma matter: a star. No solid/liquid/gas — the body IS the photosphere.
      star:        { solid: false, liquid: false, gas: false, plasma: true, plasmaCols: { deep: 0x5a0e00, low: 0xc73a00, mid: 0xff9b1e, hot: 0xfff4d0 } },
    };

    let currentArchetype = 'terrestrial';

    // Apply an archetype's matter spec to a body: toggles solid/liquid/gas
    // meshes and tunes the gas shell. Pulled out of regenerateBody so the UI
    // (atmosphere sliders) can re-apply gas changes without re-running terrain.
    function applyMatterToBody(body, matterCfg, oceanCol) {
      body.matter = {
        solid:  !!matterCfg.solid,
        liquid: !!matterCfg.liquid,
        gas:    matterCfg.gas || false,
        plasma: !!matterCfg.plasma,
      };
      body.mesh.visible = !!matterCfg.solid;

      if (body.oceanMesh) {
        // The tint now lives in the ocean's vertex colors (so it can carry a
        // sea-ice / evaporation gradient); the material stays neutral white.
        // A colored liquid (lava/acid — any archetype with an explicit oceanCol)
        // isn't water and never freezes or boils away.
        body.oceanBaseColor = oceanCol || COL.water;
        body.oceanIsWater   = !oceanCol;
        body.oceanMesh.material.color.setHex(0xffffff);
        body.oceanMesh.visible = !!matterCfg.liquid;
        colorOceanByClimate(body);
      }

      if (body.gasMesh) {
        if (matterCfg.gas) {
          body.gasMode = matterCfg.gas;
          // Take the archetype defaults on first apply; UI overrides persist
          // because applyGasShell reads body.gasThickness/Density/Coverage directly.
          body.gasThickness = matterCfg.gasThickness ?? 1.10;
          body.gasDensity   = matterCfg.gasDensity   ?? 0.20;
          body.gasCoverage  = matterCfg.gasCoverage  ?? 0.35;
          // Wind/coverage realism options (default off — opt-in via UI).
          // coveragePhase is a stable per-body offset so multiple planets
          // with the same drift rate don't oscillate in lockstep.
          if (body.windMode == null)        body.windMode = !!matterCfg.windMode;
          if (body.coverageVariance == null) body.coverageVariance = matterCfg.coverageVariance ?? 0;
          if (body.coveragePhase == null)    body.coveragePhase = Math.random() * Math.PI * 2;
          const u = body.gasMesh.material.uniforms;
          u.uColor.value.setHex(matterCfg.gasCol || 0xffffff);
          u.uSkyTint.value.setHex(matterCfg.skyTint ?? matterCfg.gasCol ?? 0x87ceeb);
          u.uMode.value = matterCfg.gas === 'full' ? 1.0 : 0.0;
          u.uWindSpeed.value = matterCfg.windSpeed ?? 0.05;
          u.uWindMode.value  = body.windMode ? 1.0 : 0.0;
          if (matterCfg.gas === 'full') {
            const gp = ensureGasPaint(body);
            u.uBandTex.value = gp.tex;
            u.uUseBands.value = 1.0;
            // Re-upload any previously stamped features so they survive
            // archetype toggling (gas → terrestrial → gas keeps the spots).
            updateGasFeatureUniforms(body);
          } else {
            u.uBandTex.value = DEFAULT_BAND_TEX;
            u.uUseBands.value = 0.0;
            u.uFeatureCount.value = 0;
          }
          applyGasShell(body);
          body.gasMesh.visible = true;
        } else {
          body.gasMode = 'none';
          body.gasMesh.visible = false;
          const u = body.gasMesh.material.uniforms;
          u.uBandTex.value = DEFAULT_BAND_TEX;
          u.uUseBands.value = 0.0;
          u.uFeatureCount.value = 0;
        }
      }

      // Plasma photosphere (stars). Self-lit and opaque, so when on it replaces
      // the (hidden) solid surface; the per-frame loop drives its uTime.
      if (body.plasmaMesh) {
        if (matterCfg.plasma) {
          const pc = matterCfg.plasmaCols || {};
          const pu = body.plasmaMesh.material.uniforms;
          if (pc.deep != null) pu.uColorDeep.value.setHex(pc.deep);
          if (pc.low  != null) pu.uColorLow.value.setHex(pc.low);
          if (pc.mid  != null) pu.uColorMid.value.setHex(pc.mid);
          if (pc.hot  != null) pu.uColorHot.value.setHex(pc.hot);
          body.plasmaMesh.visible = true;
        } else {
          body.plasmaMesh.visible = false;
        }
      }
    }

    // ====== 10. Gas/rings appliers + regen ======
    // Push gas mesh state from the body's fields. Separate so UI sliders can
    // mutate body fields and call this without going through the archetype path.
    function applyGasShell(body) {
      if (!body.gasMesh) return;
      body.gasMesh.scale.setScalar(body.gasThickness || 1.0);
      const u = body.gasMesh.material.uniforms;
      u.uDensity.value  = Math.max(0, Math.min(1, body.gasDensity  ?? 0.2));
      u.uCoverage.value = Math.max(0, Math.min(1, body.gasCoverage ?? 0.35));
      // The orbit-halo limb math needs the shell-to-surface radius ratio so it
      // can recover the surface radius from the (scaled) shell radius.
      u.uShellScale.value = body.gasThickness || 1.0;
    }

    // Push ring state from body.rings into the ringMesh. Visibility + intensity
    // are the only knobs; geometry is fixed at create time because RING_*_FACTOR
    // are baked into the buffer.
    function applyRingsToBody(body) {
      if (!body.ringMesh) return;
      const r = body.rings || (body.rings = { enabled: false, intensity: 0.65 });
      body.ringMesh.visible = !!r.enabled;
      body.ringMesh.material.uniforms.uIntensity.value =
        Math.max(0, Math.min(1, r.intensity ?? 0.65));
    }

    // Reseed terrain on a body. Samples the noise basis per vertex, then biases
    // heights so `seaCoverage` fraction of vertices sit below 0 (the sea level)
    // — without that percentile bias, coverage would drift unpredictably with seed.
    function regenerateBody(body, seedStr, amplitude, seaCoverage) {
      const arch = ARCHETYPES[currentArchetype] || ARCHETYPES.terrestrial;
      // Only planets adopt the archetype's palette + matter — moons keep their
      // fixed grayscale palette and stay solid-only (the global `currentArchetype`
      // belongs to whichever planet the UI is editing).
      if (body.kind === 'planet') {
        body.palette = arch.palette;
        const matterCfg = ARCHETYPE_MATTER[currentArchetype] || ARCHETYPE_MATTER.terrestrial;
        applyMatterToBody(body, matterCfg, arch.oceanCol);
      }

      // Refresh climate first so the per-vertex frost in colorBodyVertex is
      // current (archetype/atmosphere may have just changed). Skipped during the
      // bootstrap paint — see climateReady.
      if (climateReady) computeClimate(body);

      const basis = buildTerrainBasis(hashSeed(seedStr), TERRAIN_OCTAVES);
      const samples = new Float32Array(body.N);
      for (let i = 0; i < body.N; i++) {
        samples[i] = sampleTerrainNoise(basis, body.unitDirs[3 * i], body.unitDirs[3 * i + 1], body.unitDirs[3 * i + 2]);
      }
      const sorted = Float32Array.from(samples).sort();
      const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * seaCoverage)));
      const bias = sorted[idx];
      // Deepen submerged terrain on ocean worlds (see OCEAN_DEPTH_BOOST). The
      // zero-crossing is unchanged, so sea coverage and the coastline stay put.
      const oceanBoost = (body.matter && body.matter.liquid) ? OCEAN_DEPTH_BOOST : 1.0;
      for (let i = 0; i < body.N; i++) {
        let h = (samples[i] - bias) * amplitude;
        if (h < 0) h *= oceanBoost;
        body.heights[i] = h < MIN_LAND_HEIGHT ? MIN_LAND_HEIGHT
                        : h > MAX_LAND_HEIGHT ? MAX_LAND_HEIGHT
                        : h;
        // Reset biomes on regen
        body.biomes[i] = BIOME.AUTO;
        writeBodyVertex(body, i);
        colorBodyVertex(body, i);
      }
      commitBodyChanges(body);
      colorOceanByClimate(body);  // sea ice / evaporation track the fresh climate
      bakeOceanShore(body);       // shoreline foam follows the fresh coastline
      // Full-gas planets don't render the solid surface, but Generate World
      // should still feel like "make this body fresh" — so re-roll the band
      // composition from the same seed. Whirlpools survive (they're a separate
      // edit layer, like a user's hand-paint on top).
      if (body.kind === 'planet' && body.matter && body.matter.gas === 'full') {
        randomizeGasBands(body, seedStr);
      }
    }

    // Repaint every vertex without touching terrain. Used when something the
    // coloring depends on changed but heights didn't — e.g. climate shifting
    // (planet moved, atmosphere thickened) which grows or shrinks the polar ice.
    function recolorBody(body) {
      for (let i = 0; i < body.N; i++) colorBodyVertex(body, i);
      colorOceanByClimate(body);  // keep sea ice / dry-basin in step with the land repaint
      commitBodyChanges(body);
    }

    // Paint the ocean sphere from the body's climate. A plain-water ocean carries
    // a latitude gradient (poles freeze to sea ice, equator boils to steam and
    // then evaporates); colored liquids or a climate-less body just take a flat
    // surface color. Mirrors vertexTempC's cos(lat)^1.6 falloff, but the ocean is
    // flat at sea level so there's no elevation lapse term. Cheap and only run on
    // climate changes / regen, so per-call THREE.Color allocation is fine.
    function colorOceanByClimate(body) {
      const om = body.oceanMesh;
      if (!om || !body.matter || !body.matter.liquid) return;
      const geo = om.geometry;
      const pos = geo.attributes.position;
      const colA = geo.attributes.color, glowA = geo.attributes.aGlow, evapA = geo.attributes.aEvap;
      const n = pos.count;
      const base = new THREE.Color(body.oceanBaseColor || COL.water);
      const clim = body.climate;
      const zoned = body.oceanIsWater && clim && clim.spread > 0.5;
      if (!zoned) {
        // Flat liquid: lava/acid seas, or any ocean before the climate is known.
        for (let i = 0; i < n; i++) {
          colA.setXYZ(i, base.r, base.g, base.b);
          glowA.setX(i, 0); evapA.setX(i, 0);
        }
      } else {
        const ice = new THREE.Color(SEA_ICE_COLOR);
        const steam = new THREE.Color(SEA_STEAM_COLOR);
        for (let i = 0; i < n; i++) {
          const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
          const inv = 1 / Math.hypot(x, y, z);
          const ux = x * inv, uy = y * inv, uz = z * inv;     // unit direction (uy = sin latitude)
          const warmth = Math.pow(Math.sqrt(Math.max(0, 1 - uy * uy)), 1.6);
          const tC = (clim.poleK + (clim.equatorK - clim.poleK) * warmth) - KELVIN_ZERO_C;
          let glow = 0, evap = 0, c;
          if (tC >= SEA_VAPOR_C) {            // boiled away — fragment discarded
            c = steam; evap = 1;
          } else if (tC >= SEA_BOIL_C) {      // steaming/evaporating: water → murky steam
            c = base.clone().lerp(steam, smoothstep(SEA_BOIL_C, SEA_VAPOR_C, tC));
          } else {
            // Freeze line wobble: cheap directional noise (~[-1,1]) nudges the
            // local freeze temperature so the ice edge breaks into floes/leads
            // instead of tracing a clean latitude circle over the pole.
            const wob = 0.6 * Math.sin(ux * 7 + uy * 3) * Math.cos(uz * 5 - uy * 4)
                      + 0.3 * Math.sin(uz * 11 + ux * 6) * Math.cos(uy * 9 + ux * 2)
                      + 0.15 * Math.sin(ux * 17 - uz * 14);
            const tIce = tC + wob * SEA_ICE_NOISE_C;
            if (tIce <= SEA_ICE_C) {            // fully frozen sea ice
              c = ice; glow = SEA_ICE_GLOW;
            } else if (tIce < SEA_THAW_C) {     // skinning over: open water → sea ice
              const t = (SEA_THAW_C - tIce) / (SEA_THAW_C - SEA_ICE_C);
              c = base.clone().lerp(ice, t); glow = SEA_ICE_GLOW * t;
            } else {
              c = base;                         // open liquid water
            }
          }
          colA.setXYZ(i, c.r, c.g, c.b);
          glowA.setX(i, glow); evapA.setX(i, evap);
        }
      }
      colA.needsUpdate = true; glowA.needsUpdate = true; evapA.needsUpdate = true;
    }

    // Bake the ocean's per-vertex signed seabed height (aShore: ~0 at the coast,
    // negative offshore) whose zero contour is the coastline the foam line hugs.
    // A planet's land mesh carries ~160k verts, so a nearest-neighbour lookup per
    // ocean vertex is far too costly; instead average the seabed heights into a
    // coarse equirect grid in one O(N) pass, then read it under each ocean vertex.
    // Cheap enough to re-run on regen and when stepping onto a body.
    function bakeOceanShore(body) {
      const om = body.oceanMesh;
      if (!om || !body.matter || !body.matter.liquid) return;
      const geo = om.geometry;
      let shoreAttr = geo.getAttribute('aShore');
      if (!shoreAttr) {
        shoreAttr = new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count), 1);
        geo.setAttribute('aShore', shoreAttr);
      }
      // Grid sized to land density (~4 verts per cell) so the seabed map stays
      // filled without holes. GW = 2*GH for an equirect (lon × lat) map. We store
      // the AVERAGE seabed height per cell so the coastline (the height ≈ 0
      // contour) sits where land actually meets sea — that contour is what the
      // foam line hugs.
      const GH = Math.min(160, Math.max(8, Math.round(Math.sqrt(body.N / 8))));
      const GW = GH * 2;
      const sum = new Float32Array(GW * GH);
      const cnt = new Float32Array(GW * GH);
      const dirs = body.unitDirs, hs = body.heights, N = body.N;
      const TAU = Math.PI * 2;
      for (let i = 0; i < N; i++) {
        const uy = Math.max(-1, Math.min(1, dirs[3 * i + 1]));
        let row = ((Math.asin(uy) / Math.PI) + 0.5) * GH | 0;
        let col = ((Math.atan2(dirs[3 * i + 2], dirs[3 * i]) / TAU) + 0.5) * GW | 0;
        if (row < 0) row = 0; else if (row >= GH) row = GH - 1;
        if (col < 0) col = 0; else if (col >= GW) col = GW - 1;
        const idx = row * GW + col;
        sum[idx] += hs[i]; cnt[idx] += 1;
      }
      const EMPTY = 1e9;
      const grid = new Float32Array(GW * GH);
      for (let k = 0; k < grid.length; k++) grid[k] = cnt[k] > 0 ? sum[k] / cnt[k] : EMPTY;
      // Fill isolated empty cells from the average of filled neighbours (one pass,
      // wrapping in longitude) so a sparse body doesn't get gaps in the foam line.
      for (let r = 0; r < GH; r++) {
        for (let c = 0; c < GW; c++) {
          const idx = r * GW + c;
          if (grid[idx] !== EMPTY) continue;
          let acc = 0, num = 0;
          for (let dr = -1; dr <= 1; dr++) {
            const rr = r + dr; if (rr < 0 || rr >= GH) continue;
            for (let dc = -1; dc <= 1; dc++) {
              const v = grid[rr * GW + ((c + dc + GW) % GW)];
              if (v !== EMPTY) { acc += v; num++; }
            }
          }
          if (num > 0) grid[idx] = acc / num;
        }
      }
      const pos = geo.attributes.position;
      const out = shoreAttr.array;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        const inv = 1 / Math.hypot(x, y, z);
        const uy = Math.max(-1, Math.min(1, y * inv));
        let row = ((Math.asin(uy) / Math.PI) + 0.5) * GH | 0;
        let col = ((Math.atan2(z * inv, x * inv) / TAU) + 0.5) * GW | 0;
        if (row < 0) row = 0; else if (row >= GH) row = GH - 1;
        if (col < 0) col = 0; else if (col >= GW) col = GW - 1;
        let H = grid[row * GW + col];
        if (H === EMPTY) H = MIN_LAND_HEIGHT;       // unknown cell → deep, no foam
        out[i] = H;                                 // signed seabed height: ~0 at the coast
      }
      shoreAttr.needsUpdate = true;

      // Also expose the seabed-height grid as an equirect texture the local water
      // patch samples per-fragment for depth-based transparency (clear shallows →
      // opaque deep) and shoreline crash foam. Encoded into 8-bit over [SB_MIN,
      // SB_MAX] (decoded in the patch shader). The terrain itself is only ~0.5-unit
      // resolution, so this coarse grid loses nothing the geometry didn't already.
      const SB_MIN = -6, SB_SPAN = 9;
      if (!body.seabedTex || body.seabedTex.image.width !== GW || body.seabedTex.image.height !== GH) {
        if (body.seabedTex) body.seabedTex.dispose();
        body.seabedTex = new THREE.DataTexture(new Uint8Array(GW * GH * 4), GW, GH, THREE.RGBAFormat);
        body.seabedTex.wrapS = THREE.RepeatWrapping;      // longitude wraps around
        body.seabedTex.wrapT = THREE.ClampToEdgeWrapping;
        body.seabedTex.minFilter = THREE.LinearFilter;
        body.seabedTex.magFilter = THREE.LinearFilter;
      }
      const td = body.seabedTex.image.data;
      for (let k = 0; k < grid.length; k++) {
        const H = grid[k] === EMPTY ? MIN_LAND_HEIGHT : grid[k];
        let n = (H - SB_MIN) / SB_SPAN;
        n = n < 0 ? 0 : n > 1 ? 1 : n;
        const b = (n * 255) | 0;
        td[4 * k] = b; td[4 * k + 1] = b; td[4 * k + 2] = b; td[4 * k + 3] = 255;
      }
      body.seabedTex.needsUpdate = true;
    }

    // Recompute a body's climate and, if it's a solid planet, repaint so its
    // ice caps track the new climate. Called from the distance / atmosphere
    // slider handlers (which don't otherwise re-run terrain).
    function refreshClimateColoring(body) {
      if (!body) return;
      computeClimate(body);
      if (body.kind === 'planet' && body.matter && body.matter.solid) recolorBody(body);
    }

    // ====== 11. Planets (orbiting the sun) ======
    // planets[] holds each planet body + its orbit. Orbit angle ticks in the
    // animate loop. The first entry is also exposed as `planet` for back-compat
    // with code that was written when there was only one.
    const planets = [];
    // The conventional "home"/default body (Earth in Sol; planets[0] elsewhere).
    // Re-pointed by each bootstrap*System(), so it must be a reassignable `let`
    // — when a system is torn down and rebuilt the old body is disposed.
    let planet = null;

    // Per-planet spin rate (rad/s). Declared here — not next to
    // updatePlanetRotation — so registerPlanet() can reference it at init time
    // when the first planets are wired up.
    // Day length is the time for one full rotation. 360s = 6 minutes — slow
    // enough to clearly watch the terminator sweep across the surface during
    // a single play session, but not so slow it feels frozen in orbit view.
    const DEFAULT_SPIN = (Math.PI * 2) / 360;

    function updatePlanetOrbitPosition(p) {
      const o = p.orbit;
      const x = Math.cos(o.angle) * o.distance;
      const z0 = Math.sin(o.angle) * o.distance;
      const inc = o.inclination || 0;
      const ci = Math.cos(inc), si = Math.sin(inc);
      p.body.group.position.set(x, -z0 * si, z0 * ci);
    }

    function updatePlanetOrbits(dt) {
      for (const p of planets) {
        p.orbit.angle += p.orbit.speed * dt;
        updatePlanetOrbitPosition(p);
      }
    }

    function registerPlanet(body, archetype, seedStr, orbit) {
      body.archetype = archetype;
      body.currentSeed = seedStr;
      if (body.rotationSpeed == null) body.rotationSpeed = DEFAULT_SPIN;
      const entry = { body, orbit: { ...orbit } };
      planets.push(entry);
      updatePlanetOrbitPosition(entry);
      refreshOrbitLine(entry);
      return entry;
    }

    // ====== 12. Orbit ellipse trajectories ======
    // A thin LineLoop traces each planet's path around the sun. We keep them
    // all in one group so a single visible flag toggles every line at once.
    // Moons orbit their parent planet (not the sun) and the parent itself is
    // moving, so a static line wouldn't track them — those are skipped.
    const ORBIT_LINE_SEGMENTS = 192;
    const orbitLinesGroup = new THREE.Group();
    scene.add(orbitLinesGroup);

    function buildOrbitLineGeometry(distance, inclination) {
      const pts = new Float32Array(ORBIT_LINE_SEGMENTS * 3);
      const ci = Math.cos(inclination || 0);
      const si = Math.sin(inclination || 0);
      for (let i = 0; i < ORBIT_LINE_SEGMENTS; i++) {
        const t = (i / ORBIT_LINE_SEGMENTS) * Math.PI * 2;
        const x  = Math.cos(t) * distance;
        const z0 = Math.sin(t) * distance;
        pts[3 * i]     = x;
        pts[3 * i + 1] = -z0 * si;
        pts[3 * i + 2] = z0 * ci;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pts, 3));
      return geo;
    }

    function refreshOrbitLine(entry) {
      const { distance, inclination } = entry.orbit;
      if (!entry.orbitLine) {
        const geo = buildOrbitLineGeometry(distance, inclination);
        const mat = new THREE.LineBasicMaterial({
          color: 0x00f2ff,
          transparent: true,
          opacity: 0.32,
          depthWrite: false,
        });
        entry.orbitLine = new THREE.LineLoop(geo, mat);
        orbitLinesGroup.add(entry.orbitLine);
      } else {
        entry.orbitLine.geometry.dispose();
        entry.orbitLine.geometry = buildOrbitLineGeometry(distance, inclination);
      }
    }

    function disposeOrbitLine(entry) {
      if (!entry.orbitLine) return;
      orbitLinesGroup.remove(entry.orbitLine);
      entry.orbitLine.geometry.dispose();
      entry.orbitLine.material.dispose();
      entry.orbitLine = null;
    }

    // Satellite (moon / probe) paths around their parent planet — the group is
    // repositioned each frame to follow the host as it orbits the sun.
    const satelliteOrbitLinesGroup = new THREE.Group();
    scene.add(satelliteOrbitLinesGroup);
    let showSatelliteOrbits = true;

    const ORBIT_DEG = Math.PI / 180;
    // Legacy preset ids (solar spec / saved data) → plane parameters.
    const LEGACY_ORBIT_PATHS = {
      equatorial_west_east: { inclination: 0, node: 0, speedSign: 1 },
      equatorial_east_west: { inclination: 0, node: 0, speedSign: -1 },
      polar_north_south:    { inclination: Math.PI / 2, node: 0, speedSign: 1 },
      polar_south_north:    { inclination: Math.PI / 2, node: 0, speedSign: -1 },
      inclined:             { inclination: 0.42, node: 0.55, speedSign: 1 },
    };

    function applySatelliteOrbitPlane(sat, inclination, node, speedSign) {
      sat.inclination = inclination;
      sat.node = node;
      sat.speedSign = speedSign < 0 ? -1 : 1;
      refreshSatelliteOrbitLine(sat);
    }

    function applySatelliteOrbitOpts(sat, opts, planeDefaults) {
      if (opts.orbitPath && LEGACY_ORBIT_PATHS[opts.orbitPath]) {
        const p = LEGACY_ORBIT_PATHS[opts.orbitPath];
        applySatelliteOrbitPlane(sat, p.inclination, p.node, p.speedSign);
        return;
      }
      applySatelliteOrbitPlane(
        sat,
        opts.inclination ?? planeDefaults.inclination,
        opts.node ?? planeDefaults.node,
        opts.speedSign ?? 1,
      );
    }

    function buildSatelliteOrbitLineGeometry(distance, inclination, node) {
      const pts = new Float32Array(ORBIT_LINE_SEGMENTS * 3);
      const ci = Math.cos(inclination || 0);
      const si = Math.sin(inclination || 0);
      const cn = Math.cos(node || 0);
      const sn = Math.sin(node || 0);
      for (let i = 0; i < ORBIT_LINE_SEGMENTS; i++) {
        const t = (i / ORBIT_LINE_SEGMENTS) * Math.PI * 2;
        const x0 = Math.cos(t) * distance;
        const z0 = Math.sin(t) * distance;
        const y1 = -z0 * si;
        const z1 = z0 * ci;
        pts[3 * i]     = x0 * cn - z1 * sn;
        pts[3 * i + 1] = y1;
        pts[3 * i + 2] = x0 * sn + z1 * cn;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pts, 3));
      return geo;
    }

    function refreshSatelliteOrbitLine(sat) {
      const { distance, inclination, node } = sat;
      if (!sat.orbitLine) {
        const geo = buildSatelliteOrbitLineGeometry(distance, inclination, node);
        const mat = new THREE.LineBasicMaterial({
          color: sat.body ? 0xaaccff : 0xffaa44,
          transparent: true,
          opacity: 0.28,
          depthWrite: false,
        });
        sat.orbitLine = new THREE.LineLoop(geo, mat);
        satelliteOrbitLinesGroup.add(sat.orbitLine);
      } else {
        sat.orbitLine.geometry.dispose();
        sat.orbitLine.geometry = buildSatelliteOrbitLineGeometry(distance, inclination, node);
      }
      syncSatelliteOrbitLinePosition(sat);
      sat.orbitLine.visible = showSatelliteOrbits;
    }

    function syncSatelliteOrbitLinePosition(sat) {
      if (!sat.orbitLine || !sat.parent) return;
      const pp = sat.parent.group.position;
      sat.orbitLine.position.set(pp.x, pp.y, pp.z);
    }

    function disposeSatelliteOrbitLine(sat) {
      if (!sat.orbitLine) return;
      satelliteOrbitLinesGroup.remove(sat.orbitLine);
      sat.orbitLine.geometry.dispose();
      sat.orbitLine.material.dispose();
      sat.orbitLine = null;
    }

    function setSatelliteOrbitLinesVisible(visible) {
      showSatelliteOrbits = visible;
      for (const m of moons) if (m.orbitLine) m.orbitLine.visible = visible;
      for (const p of probes) if (p.orbitLine) p.orbitLine.visible = visible;
    }

    // ====== 13. Solar system bootstrap ======
    // Sizes/distances/speeds are visually scaled — not astronomically accurate.
    // Order is preserved (inner planets close + fast, gas giants huge + slow)
    // and the speeds roughly follow Kepler's third law (ω ∝ 1/a^1.5) so the
    // outer planets crawl while the inner ones whip around. Speed 0.009 → a
    // 12-minute Earth year; outer planets stretch to >1 hour per orbit.
    const SOLAR_SYSTEM_SPEC = [
      { name: 'Mercury', archetype: 'moon_like',   size: 0.15, distance:  120, speed: 0.0175,  inclination:  0.06, angle: 0.20, seed: 'mercury', moons: [] },
      { name: 'Venus',   archetype: 'venusian',    size: 0.24, distance:  190, speed: 0.0125,  inclination: -0.05, angle: 1.10, seed: 'venus',   moons: [] },
      { name: 'Earth',   archetype: 'terrestrial', size: 0.27, distance:  270, speed: 0.0090,  inclination:  0.03, angle: 2.10, seed: 'earth',
        moons: [ { name: 'Moon', size: 0.30, distance: 10, seed: 'luna' } ],
        probes: [
          { name: 'ISS', size: 0.14, distance: 5, speed: 0.015, seed: 'iss', inclination: 0, node: 0, speedSign: 1 },
          { name: 'Tiangong', size: 0.13, distance: 6, speed: 0.012, seed: 'tiangong', inclination: Math.PI / 2, node: 0, speedSign: 1 },
        ] },
      { name: 'Mars',    archetype: 'desert',      size: 0.19, distance:  360, speed: 0.0065,  inclination: -0.08, angle: 3.20, seed: 'mars',    moons: [] },
      { name: 'Jupiter', archetype: 'gas_giant',   size: 0.72, distance:  520, speed: 0.0035,  inclination:  0.02, angle: 4.30, seed: 'jupiter',
        moons: [
          { name: 'Io',       size: 0.30, distance: 22, seed: 'io' },
          { name: 'Europa',   size: 0.28, distance: 28, seed: 'europa' },
          { name: 'Ganymede', size: 0.42, distance: 34, seed: 'ganymede' },
          { name: 'Callisto', size: 0.38, distance: 42, seed: 'callisto' },
        ] },
      { name: 'Saturn',  archetype: 'gas_giant',   size: 0.63, distance:  720, speed: 0.0025,  inclination: -0.04, angle: 5.10, seed: 'saturn',
        rings: { enabled: true, intensity: 0.80 },
        moons: [ { name: 'Titan', size: 0.45, distance: 24, seed: 'titan' } ] },
      { name: 'Uranus',  archetype: 'ice_giant',   size: 0.45, distance:  920, speed: 0.00175, inclination:  0.08, angle: 0.60, seed: 'uranus',  moons: [] },
      { name: 'Neptune', archetype: 'ice_giant',   size: 0.43, distance: 1120, speed: 0.00125, inclination: -0.06, angle: 5.80, seed: 'neptune', moons: [] },
    ];

    function spawnSolarPlanet(spec) {
      const arch = ARCHETYPES[spec.archetype];
      const body = createBody({
        kind: 'planet',
        name: spec.name,
        baseRadius: BASE_RADIUS,
        detail: ICO_DETAIL,
        hasOcean: arch.hasOcean,
      });
      bodies.push(body);
      scene.add(body.group);
      body.group.scale.setScalar(spec.size);
      // regenerateBody reads currentArchetype off the module scope; flip it
      // briefly so the correct palette/matter is applied without disturbing UI.
      const prev = currentArchetype;
      currentArchetype = spec.archetype;
      regenerateBody(body, spec.seed, arch.amp, arch.sea);
      currentArchetype = prev;
      body.currentAmp = arch.amp;
      body.currentSea = arch.sea;
      registerPlanet(body, spec.archetype, spec.seed, {
        angle: spec.angle,
        distance: spec.distance,
        speed: spec.speed,
        inclination: spec.inclination,
      });
      if (spec.rings) {
        body.rings.enabled   = spec.rings.enabled ?? true;
        body.rings.intensity = spec.rings.intensity ?? 0.65;
        applyRingsToBody(body);
      }
      return body;
    }

    // NOTE: Sol's planets are no longer spawned eagerly here. Spawning + moon
    // seeding now live in bootstrapSolSystem() (section 34), called once at the
    // end of init and again whenever the user returns to Sol from the galaxy
    // map. They had to merge into one function called late, because moon/probe
    // seeding depends on consts (moons[], probes[], cities[], climate) declared
    // further down — see the load/unload block near the animate loop.

    // ====== 14. Brush ======
    let brushRadius   = 0.25; // radians of arc on the unit sphere
    let brushStrength = 1.5;  // height units per second of holding
    let brushRaise    = true; // false = lower
    let paintMode     = true; // when true, right-drag paints; when false, right-drag pans
    let paused        = false;
    let currentTool   = 'none'; // 'land' | 'biome' | 'city' | 'gasband' | 'gaswhirl' | 'none'

    function isBrushTool(tool = currentTool) {
      return tool === 'land' || tool === 'biome' || tool === 'gasband' || tool === 'gaswhirl';
    }
    let selectedBiome = BIOME.AUTO;
    // Selected biome (drives gasPaintColor + bandBiomes tagging on stroke).
    let selectedGasBiomeId = null;
    // Selected color for the atmospheric-band brush on full-gas planets.
    const gasPaintColor = new THREE.Color('#cc9966');
    // Active sub-mode for gas paint: 'gasband' = drag-paint latitude bands;
    // 'gaswhirl' = press-and-hold to grow a whirlpool that wraps surrounding
    // bands around the click center (no overpaint — just direction warp).
    let gasPaintMode  = 'gasband';
    // The whirlpool created on the current drag stroke; grown each frame in
    // applyBrushToBody while the user holds the right button.
    let activeVortex  = null;

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let isPainting = false;
    let activeBrushBody = null;  // body the current drag stroke is editing
    let lastHitLocal = null;     // hit point in activeBrushBody's mesh-local space

    // Brush cursor — a thin ring oriented to the surface tangent plane.
    const brushRingGeo = new THREE.RingGeometry(0.95, 1.0, 64);
    const brushRingMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      depthTest: false,
    });
    const brushRing = new THREE.Mesh(brushRingGeo, brushRingMat);
    brushRing.renderOrder = 999;
    brushRing.visible = false;
    scene.add(brushRing);

    function updateBrushRing(hitWorld, hitNormalWorld, radiusWorld) {
      brushRing.position.copy(hitWorld);
      brushRing.lookAt(hitWorld.clone().add(hitNormalWorld));
      brushRing.position.addScaledVector(hitNormalWorld, 0.02);
      brushRing.scale.setScalar(radiusWorld);
      brushRing.visible = true;
    }

    // arcLen ≈ angularRadius * R, where R is the radial distance at the hit.
    function brushArcWorldRadius(hitRadius) {
      return brushRadius * hitRadius;
    }

    // ====== 15. Pointer handling ======
    function setPointerFromEvent(e) {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    }

    // Raycast against every body; return { hit, body } for the closest one.
    // On full-gas planets the solid mesh is hidden, so we fall back to the
    // gas shell — it's the only surface the user can actually click on, and
    // its outward normal is a fine proxy for the body's direction.
    function raycastBodies() {
      raycaster.setFromCamera(pointer, camera);
      const meshes = [];
      const meshToBody = new Map();
      for (const b of bodies) {
        let target = null;
        if (b.mesh.visible) target = b.mesh;
        else if (b.matter && b.matter.gas === 'full' && b.gasMesh && b.gasMesh.visible) target = b.gasMesh;
        else if (b.matter && b.matter.plasma && b.plasmaMesh && b.plasmaMesh.visible) target = b.plasmaMesh;
        if (!target) continue;
        meshes.push(target);
        meshToBody.set(target, b);
      }
      const hits = raycaster.intersectObjects(meshes, false);
      if (hits.length === 0) return null;
      const hit = hits[0];
      const body = meshToBody.get(hit.object) || null;
      if (!body) return null;
      return { hit, body };
    }

    function worldToBodyLocal(body, worldPoint) {
      return body.mesh.worldToLocal(worldPoint.clone());
    }

    renderer.domElement.addEventListener('pointerdown', (e) => {
      if (e.button !== 2) return;
      if (!paintMode) return;
      if (viewMode !== 'orbit') return; // brush is meaningless mid-pick / on surface
      e.preventDefault();
      setPointerFromEvent(e);
      const hb = raycastBodies();
      if (!hb) return;

      if (currentTool === 'city') {
        const name = cityNameInput.value || 'New City';
        const localPos = worldToBodyLocal(hb.body, hb.hit.point);
        addCity(hb.body, name, localPos);
      } else if (!isBrushTool()) {
        return;
      } else if (currentTool === 'gaswhirl'
                 && hb.body.matter && hb.body.matter.gas === 'full') {
        // Drop a fresh whirlpool at strength 0 and capture the pointer.
        // applyBrushToBody will grow its strength each frame the user holds.
        const localPos = worldToBodyLocal(hb.body, hb.hit.point);
        activeVortex = addGasVortex(hb.body, localPos);
        isPainting = true;
        activeBrushBody = hb.body;
        lastHitLocal = localPos;
        renderer.domElement.setPointerCapture(e.pointerId);
      } else {
        isPainting = true;
        activeBrushBody = hb.body;
        lastHitLocal = worldToBodyLocal(hb.body, hb.hit.point);
        renderer.domElement.setPointerCapture(e.pointerId);
      }
    });

    renderer.domElement.addEventListener('pointermove', (e) => {
      setPointerFromEvent(e);
      // Brush ring only on Sculpt / Environment (and gas sub-modes).
      if (!paintMode || !isBrushTool() || viewMode !== 'orbit') {
        brushRing.visible = false;
        return;
      }
      const hb = raycastBodies();
      if (!hb) {
        brushRing.visible = false;
        if (isPainting) lastHitLocal = null;
        return;
      }
      const nWorld = hb.hit.face.normal.clone()
        .transformDirection(hb.body.mesh.matrixWorld)
        .normalize();
      // Scale the ring by the body's local hit radius times its world scale so the
      // visible ring matches the brush footprint on bodies of any size.
      const worldScale = hb.body.group.scale.x;
      const localHitRadius = worldToBodyLocal(hb.body, hb.hit.point).length();
      updateBrushRing(hb.hit.point, nWorld, brushArcWorldRadius(localHitRadius) * worldScale);
      if (isPainting) {
        // Only continue painting on the body we started on, so dragging off doesn't
        // jump the brush to a different body.
        if (hb.body === activeBrushBody) lastHitLocal = worldToBodyLocal(hb.body, hb.hit.point);
        else lastHitLocal = null;
      }
    });

    function endPaint(e) {
      if (!isPainting) return;
      isPainting = false;
      lastHitLocal = null;
      activeBrushBody = null;
      activeVortex = null;
      try { renderer.domElement.releasePointerCapture(e.pointerId); } catch (_) {}
      updateInfoPanel();
    }
    renderer.domElement.addEventListener('pointerup', endPaint);
    renderer.domElement.addEventListener('pointercancel', endPaint);

    // Suppress the browser context menu over the canvas while paint mode is on.
    renderer.domElement.addEventListener('contextmenu', (e) => {
      if (paintMode) e.preventDefault();
    });

    // ====== 16. Moons (each is a full editable body) ======
    // Moons are built once at MOON_BASE_RADIUS = 1 and resized via group.scale,
    // so the slider can change apparent size without rebuilding geometry.
    const MOON_BASE_RADIUS = 1;
    const MOON_DETAIL = 4;            // ~1280 verts; smaller bodies don't need planet-level density
    const MAX_MOONS = 4;              // per parent planet
    const MOON_REF_DISTANCE = 22;
    // Each moon now owns its own orbital speed; this is the default for new moons.
    const DEFAULT_MOON_SPEED = (40 / 3000) * Math.PI * 2;
    let moonSeedCounter = 0;          // ensures each new moon gets a distinct seed
    const moons = [];
    // Slot tracking is per-parent so each planet has its own 0..MAX_MOONS slots.
    const moonSlotsByParent = new Map();

    // Maps a slot index to a unique orbit plane (inclination + ascending node)
    // and starting phase, so concurrent moons of the same planet don't overlap
    // visually. Slots alternate sign so moons fan above + below the ecliptic.
    function moonOrbitPlane(slot) {
      return {
        inclination: (slot % 2 === 0 ? 1 : -1) * (0.08 + 0.18 * slot),
        node: slot * 1.1,
        phase: (slot / MAX_MOONS) * Math.PI * 2,
      };
    }

    function allocateMoonSlot(parent) {
      let used = moonSlotsByParent.get(parent);
      if (!used) { used = new Set(); moonSlotsByParent.set(parent, used); }
      for (let i = 0; i < MAX_MOONS; i++) {
        if (!used.has(i)) { used.add(i); return i; }
      }
      return -1;
    }

    function freeMoonSlot(parent, slot) {
      const used = moonSlotsByParent.get(parent);
      if (used) used.delete(slot);
    }

    function satelliteWorldOffset(sat) {
      const x0 = Math.cos(sat.angle) * sat.distance;
      const z0 = Math.sin(sat.angle) * sat.distance;
      const ci = Math.cos(sat.inclination), si = Math.sin(sat.inclination);
      const y1 = -z0 * si;
      const z1 = z0 * ci;
      const cn = Math.cos(sat.node), sn = Math.sin(sat.node);
      return {
        x: x0 * cn - z1 * sn,
        y: y1,
        z: x0 * sn + z1 * cn,
      };
    }

    function updateMoonPosition(m) {
      const off = satelliteWorldOffset(m);
      const pp = m.parent ? m.parent.group.position : { x: 0, y: 0, z: 0 };
      m.body.group.position.set(off.x + pp.x, off.y + pp.y, off.z + pp.z);
      syncSatelliteOrbitLinePosition(m);
    }

    function addMoon(parent, size, distance, opts = {}) {
      const host = parent || planet;
      const ownCount = moons.reduce((n, m) => n + (m.parent === host ? 1 : 0), 0);
      if (ownCount >= MAX_MOONS) return null;
      const slot = allocateMoonSlot(host);
      if (slot < 0) return null;
      const plane = moonOrbitPlane(slot);
      const seed = opts.seed || ('moon-' + (++moonSeedCounter));
      const name = opts.name || `${host.name} · Moon ${ownCount + 1}`;
      const body = createBody({
        kind: 'moon',
        name,
        baseRadius: MOON_BASE_RADIUS,
        detail: MOON_DETAIL,
        hasOcean: false,
      });
      body.group.scale.setScalar(size);
      regenerateBody(body, seed, 1.6, 0.0); // moons start fully above "sea" — no ocean
      scene.add(body.group);
      bodies.push(body);
      const moon = {
        body,
        parent: host,
        seed,
        angle: plane.phase,
        inclination: plane.inclination,
        node: plane.node,
        speedSign: 1,
        size,
        distance,
        speed: DEFAULT_MOON_SPEED,
        slot,
      };
      applySatelliteOrbitOpts(moon, opts, plane);
      moons.push(moon);
      refreshSatelliteOrbitLine(moon);
      updateMoonPosition(moon);
      return moon;
    }

    function removeMoonAt(index) {
      const moon = moons[index];
      if (!moon) return;
      if (focusedBody === moon.body) setFocus(moon.parent || planet);
      scene.remove(moon.body.group);
      const bi = bodies.indexOf(moon.body);
      if (bi >= 0) bodies.splice(bi, 1);
      moon.body.geo.dispose();
      moon.body.mesh.material.dispose();
      freeMoonSlot(moon.parent, moon.slot);
      disposeSatelliteOrbitLine(moon);
      moons.splice(index, 1);
      updateInfoPanel();
    }

    function setMoonSize(index, size) {
      const m = moons[index];
      if (!m) return;
      m.size = size;
      m.body.group.scale.setScalar(size);
    }

    function setMoonDistance(index, distance) {
      const m = moons[index];
      if (!m) return;
      m.distance = distance;
      refreshSatelliteOrbitLine(m);
      updateMoonPosition(m);
    }

    function updateMoons(dt) {
      for (const m of moons) {
        const speed = m.speed ?? DEFAULT_MOON_SPEED;
        const sign = m.speedSign ?? 1;
        const omega = sign * speed * Math.pow(MOON_REF_DISTANCE / m.distance, 1.5);
        m.angle += omega * dt;
        updateMoonPosition(m);
      }
    }

    // ====== 17. Probes (artificial satellites) ======
    // Unlike moons, probes are not editable bodies — they're a loaded 3D mesh
    // (.glb) orbiting a parent planet. They reuse the moon orbit math but skip
    // the createBody pipeline entirely (no terrain, biome, archetype, etc.).
    const MAX_PROBES = 4;
    const PROBE_REF_DISTANCE = 22;
    const DEFAULT_PROBE_SPEED = (60 / 3000) * Math.PI * 2; // a touch faster than moons
    const PROBE_BASE_SIZE = 1.0; // target on-screen length at size === 1
    let probeSeedCounter = 0;
    const probes = [];
    const probeSlotsByParent = new Map();

    // Cached parsed GLB. Each addSatellite clones it so multiple probes share
    // geometry/material instances and we only pay the network/parse cost once.
    let satelliteTemplate = null;
    let satelliteTemplateLoading = null;

    function loadSatelliteTemplate() {
      if (satelliteTemplate) return Promise.resolve(satelliteTemplate);
      if (satelliteTemplateLoading) return satelliteTemplateLoading;
      const loader = new GLTFLoader();
      satelliteTemplateLoading = new Promise((resolve, reject) => {
        loader.load(
          '3d_objects/satellite.glb',
          (gltf) => {
            const root = gltf.scene;
            // Center the model on its bounding-box center so orbit pivot is sane.
            const bbox = new THREE.Box3().setFromObject(root);
            const center = bbox.getCenter(new THREE.Vector3());
            root.position.sub(center);
            // Normalize so the model's longest axis is PROBE_BASE_SIZE units.
            const size = bbox.getSize(new THREE.Vector3());
            const longest = Math.max(size.x, size.y, size.z) || 1;
            const norm = PROBE_BASE_SIZE / longest;
            root.scale.multiplyScalar(norm);
            satelliteTemplate = root;
            resolve(root);
          },
          undefined,
          (err) => {
            console.error('[probe] failed to load satellite.glb', err);
            reject(err);
          }
        );
      });
      return satelliteTemplateLoading;
    }

    function probeOrbitPlane(slot) {
      // Offset the inclination/node from moons so a planet with both doesn't
      // end up with co-planar orbits.
      return {
        inclination: (slot % 2 === 0 ? 1 : -1) * (0.22 + 0.14 * slot),
        node: slot * 0.85 + 0.4,
        phase: (slot / MAX_PROBES) * Math.PI * 2 + Math.PI / 5,
      };
    }

    function allocateProbeSlot(parent) {
      let used = probeSlotsByParent.get(parent);
      if (!used) { used = new Set(); probeSlotsByParent.set(parent, used); }
      for (let i = 0; i < MAX_PROBES; i++) {
        if (!used.has(i)) { used.add(i); return i; }
      }
      return -1;
    }

    function freeProbeSlot(parent, slot) {
      const used = probeSlotsByParent.get(parent);
      if (used) used.delete(slot);
    }

    const _probeLookTarget = new THREE.Vector3();

    function orientProbeToPlanet(p) {
      if (!p.parent || !p.mesh) return;
      p.parent.group.getWorldPosition(_probeLookTarget);
      p.mesh.lookAt(_probeLookTarget);
    }

    function updateProbePosition(p) {
      const off = satelliteWorldOffset(p);
      const pp = p.parent ? p.parent.group.position : { x: 0, y: 0, z: 0 };
      p.mesh.position.set(off.x + pp.x, off.y + pp.y, off.z + pp.z);
      syncSatelliteOrbitLinePosition(p);
      orientProbeToPlanet(p);
    }

    function addSatellite(parent, size, distance, opts = {}) {
      const host = parent || planet;
      if (!host) return null;
      const ownCount = probes.reduce((n, p) => n + (p.parent === host ? 1 : 0), 0);
      if (ownCount >= MAX_PROBES) return null;
      const slot = allocateProbeSlot(host);
      if (slot < 0) return null;
      const plane = probeOrbitPlane(slot);
      const name = opts.name || `${host.name} · Probe ${ownCount + 1}`;
      // A placeholder mesh holds the slot until the GLB resolves — that way
      // sliders and orbit math work the instant the user clicks Deploy.
      const group = new THREE.Group();
      group.name = name;
      group.scale.setScalar(size);
      scene.add(group);

      const probe = {
        mesh: group,
        parent: host,
        name,
        seed: opts.seed || ('probe-' + (++probeSeedCounter)),
        angle: plane.phase,
        inclination: plane.inclination,
        node: plane.node,
        speedSign: 1,
        size,
        distance,
        speed: opts.speed ?? DEFAULT_PROBE_SPEED,
        slot,
      };
      applySatelliteOrbitOpts(probe, opts, plane);
      probes.push(probe);
      refreshSatelliteOrbitLine(probe);
      updateProbePosition(probe);

      loadSatelliteTemplate().then((template) => {
        // Probe may have been removed before the GLB resolved — bail then.
        if (!probes.includes(probe)) return;
        const clone = template.clone(true);
        group.add(clone);
      }).catch(() => {
        // Fallback marker so the user still sees something if the GLB fails.
        if (!probes.includes(probe)) return;
        const fallback = new THREE.Mesh(
          new THREE.BoxGeometry(0.6, 0.6, 0.6),
          new THREE.MeshStandardMaterial({ color: 0xcccccc, metalness: 0.5, roughness: 0.4 })
        );
        group.add(fallback);
      });

      return probe;
    }

    function removeSatelliteAt(index) {
      const probe = probes[index];
      if (!probe) return;
      // Drop focus to the host planet before tearing down the mesh so the
      // camera tracker doesn't chase a removed object.
      if (focusedProbe === probe) {
        if (probe.parent) setFocus(probe.parent); else setSystemFocus();
      }
      scene.remove(probe.mesh);
      probe.mesh.traverse((obj) => {
        if (obj.isMesh) {
          if (obj.geometry) obj.geometry.dispose();
          if (obj.material) {
            const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
            mats.forEach(m => m.dispose());
          }
        }
      });
      freeProbeSlot(probe.parent, probe.slot);
      disposeSatelliteOrbitLine(probe);
      probes.splice(index, 1);
    }

    function setSatelliteSize(index, size) {
      const p = probes[index];
      if (!p) return;
      p.size = size;
      p.mesh.scale.setScalar(size);
    }

    function setSatelliteDistance(index, distance) {
      const p = probes[index];
      if (!p) return;
      p.distance = distance;
      refreshSatelliteOrbitLine(p);
      updateProbePosition(p);
    }

    function updateSatellites(dt) {
      for (const p of probes) {
        const sign = p.speedSign ?? 1;
        const omega = sign * p.speed * Math.pow(PROBE_REF_DISTANCE / p.distance, 1.5);
        p.angle += omega * dt;
        updateProbePosition(p);
      }
    }

    // ====== 18. Cities ======
    // Cities are pinned to a body by a unit-direction `localPos`. Each settlement
    // is a cloned `lunar_base.glb` parented to body.group (Y-up sits on the
    // surface along localPos). Day/night dimming is applied in updateCityMarkers().
    const CITY_BASE_SIZE = 0.5;   // longest axis at scale 1 (readable on r≈12 bodies)
    const CITY_SURFACE_LIFT = 0.08;
    const cities = [];
    const _cityUp = new THREE.Vector3(0, 1, 0);

    let cityTemplate = null;
    let cityTemplateLoading = null;

    function loadCityTemplate() {
      if (cityTemplate) return Promise.resolve(cityTemplate);
      if (cityTemplateLoading) return cityTemplateLoading;
      const loader = new GLTFLoader();
      cityTemplateLoading = new Promise((resolve, reject) => {
        loader.load(
          'lunar_base.glb',
          (gltf) => {
            const root = gltf.scene;
            const bbox = new THREE.Box3().setFromObject(root);
            const size = bbox.getSize(new THREE.Vector3());
            const longest = Math.max(size.x, size.y, size.z) || 1;
            root.scale.multiplyScalar(CITY_BASE_SIZE / longest);
            // Re-seat so the model's bottom rests on y=0 (local "ground").
            const grounded = new THREE.Box3().setFromObject(root);
            const center = grounded.getCenter(new THREE.Vector3());
            root.position.x -= center.x;
            root.position.z -= center.z;
            root.position.y -= grounded.min.y;
            cityTemplate = root;
            resolve(root);
          },
          undefined,
          (err) => {
            console.error('[city] failed to load lunar_base.glb', err);
            reject(err);
          }
        );
      });
      return cityTemplateLoading;
    }

    function disposeCityMesh(mesh) {
      mesh.traverse((obj) => {
        if (obj.isMesh) {
          if (obj.geometry) obj.geometry.dispose();
          if (obj.material) {
            const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
            mats.forEach(m => m.dispose());
          }
        }
      });
    }

    function setCityMeshOpacity(mesh, opacity) {
      mesh.traverse((obj) => {
        if (!obj.isMesh || !obj.material) return;
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        mats.forEach((m) => {
          m.transparent = true;
          m.opacity = opacity;
        });
      });
    }

    function orientCityMesh(city) {
      const n = city.localPos;
      if (n.lengthSq() < 1e-8) return;
      city.mesh.quaternion.setFromUnitVectors(_cityUp, n);
    }

    function createCityMarker() {
      const group = new THREE.Group();
      const geo = new THREE.BoxGeometry(0.12, 0.12, 0.12);
      const mat = new THREE.MeshBasicMaterial({ color: COL.cityLights });
      group.add(new THREE.Mesh(geo, mat));
      return group;
    }

    function mountCityModel(group) {
      while (group.children.length) group.remove(group.children[0]);
      const clone = cityTemplate.clone(true);
      group.add(clone);
    }

    function addCity(body, name, localPos) {
      const city = {
        body,
        name,
        localPos: localPos.clone().normalize(),
        mesh: createCityMarker(),
      };
      body.group.add(city.mesh);
      cities.push(city);
      updateCityMarkers();
      renderCityList();

      loadCityTemplate().then(() => {
        if (!cities.includes(city)) return;
        mountCityModel(city.mesh);
        updateCityMarkers();
      }).catch(() => {
        if (!cities.includes(city)) return;
        // Placeholder cube from createCityMarker() already visible.
      });
    }

    function updateCityMarkers() {
      const sunWorld = new THREE.Vector3();
      sunMesh.getWorldPosition(sunWorld);
      const planetCenter = new THREE.Vector3();
      const cityWorld = new THREE.Vector3();
      cities.forEach(city => {
        const body = city.body;
        const r = body.baseRadius + CITY_SURFACE_LIFT;
        city.mesh.position.copy(city.localPos).multiplyScalar(r);
        orientCityMesh(city);

        // Day/night relative to *this* planet's sun direction (matters now that
        // planets orbit — direction from planet center to sun varies).
        city.mesh.getWorldPosition(cityWorld);
        body.group.getWorldPosition(planetCenter);
        const toSun = sunWorld.clone().sub(planetCenter).normalize();
        const surfaceNormal = cityWorld.clone().sub(planetCenter).normalize();
        const dot = surfaceNormal.dot(toSun);
        setCityMeshOpacity(city.mesh, dot < 0.1 ? 1.0 : 0.35);
      });
    }

    function renderCityList() {
      const list = document.getElementById('cityList');
      list.innerHTML = cities.map((c, i) => {
        const focusedCls = focusedCity === c ? ' focused' : '';
        return `
        <div class="city-row" data-index="${i}">
          <span>${c.name} (${c.body.name})</span>
          <button class="city-focus focus-btn small-btn${focusedCls}" type="button">Focus</button>
          <button class="city-remove" type="button" aria-label="Remove city">×</button>
        </div>`;
      }).join('');
      list.querySelectorAll('.city-row').forEach((row) => {
        const index = parseInt(row.dataset.index, 10);
        row.querySelector('.city-focus').onclick = () => {
          const c = cities[index];
          if (c) setCityFocus(c);
        };
        row.querySelector('.city-remove').onclick = () => removeCityAt(index);
      });
    }

    function removeCityAt(index) {
      const city = cities[index];
      if (!city) return;
      if (focusedCity === city) {
        focusedCity = null;
        focusNameEl.textContent = focusedBody ? focusedBody.name : '';
      }
      city.body.group.remove(city.mesh);
      disposeCityMesh(city.mesh);
      cities.splice(index, 1);
      renderCityList();
    }
    // Kept for backwards-compat with any inline onclick already in the DOM.
    window.removeCity = removeCityAt;

    loadCityTemplate();

    // ====== 19. Starfield ======
    const starCount = 2000;
    const starPositions = new Float32Array(starCount * 3);
    // Stars sit at a large radius so they read as a backdrop even when the
    // system-view camera is pulled out hundreds of units to frame all planets.
    for (let i = 0; i < starCount; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const r = 2200;
      starPositions[i * 3]     = r * Math.sin(phi) * Math.cos(theta);
      starPositions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      starPositions[i * 3 + 2] = r * Math.cos(phi);
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
    const starMat = new THREE.PointsMaterial({
      color: 0xffffff,
      size: 1.6,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      fog: false,
    });
    const stars = new THREE.Points(starGeo, starMat);
    scene.add(stars);

    // ====== 19a. Galactic band (procedural Milky Way) ======
    // An inward-facing sphere recentred on the camera every frame (a skybox, so
    // it surrounds the eye at any zoom) painted by a shader that builds the
    // Milky Way from noise: a tilted bright band, clumpy star clouds, dark dust
    // lanes hugging the mid-plane, fine grain, and a faintly warm galactic core.
    // ADDITIVE over scene.background so it only *adds* light (lanes read as gaps
    // in the glow). uBrightness is driven per-frame off the starfield's daylight
    // fade, so the band blazes on the night side / in space and washes out
    // behind a planet's daytime atmosphere — see the render loop.
    const milkyMat = new THREE.ShaderMaterial({
      uniforms: { uBrightness: { value: 1.0 } },
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      // Opaque (not `transparent`) on purpose: three.js draws transparent
      // objects in a later pass, which let this additively paint OVER planet
      // night sides. As an opaque draw with renderOrder -1 it lands first, and
      // depthWrite:false lets the planets paint over it — so it stays a backdrop.
      transparent: false,
      depthWrite: false,
      depthTest: false,
      fog: false,
      vertexShader: /* glsl */`
        varying vec3 vDir;
        void main() {
          // The mesh is only translated (to the camera), never rotated, so the
          // local vertex position doubles as a world-space view direction.
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        precision highp float;
        varying vec3 vDir;
        uniform float uBrightness;

        // --- Ashima 3D simplex noise (public domain) ---
        vec4 permute(vec4 x){ return mod(((x*34.0)+1.0)*x, 289.0); }
        vec4 taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }
        float snoise(vec3 v){
          const vec2 C = vec2(1.0/6.0, 1.0/3.0);
          const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
          vec3 i  = floor(v + dot(v, C.yyy));
          vec3 x0 = v - i + dot(i, C.xxx);
          vec3 g = step(x0.yzx, x0.xyz);
          vec3 l = 1.0 - g;
          vec3 i1 = min(g.xyz, l.zxy);
          vec3 i2 = max(g.xyz, l.zxy);
          vec3 x1 = x0 - i1 + C.xxx;
          vec3 x2 = x0 - i2 + C.yyy;
          vec3 x3 = x0 - D.yyy;
          i = mod(i, 289.0);
          vec4 p = permute(permute(permute(
                     i.z + vec4(0.0, i1.z, i2.z, 1.0))
                   + i.y + vec4(0.0, i1.y, i2.y, 1.0))
                   + i.x + vec4(0.0, i1.x, i2.x, 1.0));
          float n_ = 1.0/7.0;
          vec3 ns = n_ * D.wyz - D.xzx;
          vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
          vec4 x_ = floor(j * ns.z);
          vec4 y_ = floor(j - 7.0 * x_);
          vec4 x = x_ * ns.x + ns.yyyy;
          vec4 y = y_ * ns.x + ns.yyyy;
          vec4 h = 1.0 - abs(x) - abs(y);
          vec4 b0 = vec4(x.xy, y.xy);
          vec4 b1 = vec4(x.zw, y.zw);
          vec4 s0 = floor(b0)*2.0 + 1.0;
          vec4 s1 = floor(b1)*2.0 + 1.0;
          vec4 sh = -step(h, vec4(0.0));
          vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy;
          vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;
          vec3 p0 = vec3(a0.xy, h.x);
          vec3 p1 = vec3(a0.zw, h.y);
          vec3 p2 = vec3(a1.xy, h.z);
          vec3 p3 = vec3(a1.zw, h.w);
          vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
          p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
          vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
          m = m * m;
          return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
        }
        float fbm(vec3 p){
          float s = 0.0, a = 0.5;
          for (int i = 0; i < 5; i++){ s += a * snoise(p); p *= 2.0; a *= 0.5; }
          return s; // ~[-1, 1]
        }

        void main(){
          vec3 dir = normalize(vDir);

          // Galactic plane: a tilted normal so the band crosses the sky diagonally.
          vec3 N = normalize(vec3(0.32, 0.90, -0.28));
          float d = dot(dir, N);                       // signed distance from plane

          // Core band: a soft Gaussian stripe about the mid-plane.
          float band = exp(-(d*d) / (2.0 * 0.16 * 0.16));

          // Large-scale clumping so the band has structure, not a flat smear.
          float clump = 0.55 + 0.55 * fbm(dir * 2.2);
          band *= clamp(clump, 0.0, 1.3);

          // Bright star-cloud knots, concentrated tight to the mid-plane.
          float knots = fbm(dir * 4.5 + 7.3);
          band += smoothstep(0.45, 0.95, knots) * exp(-(d*d) / (2.0 * 0.10 * 0.10)) * 0.6;

          // Dust lanes: dark filaments carved out of the densest part of the band.
          float dust     = fbm(dir * 3.0 + 19.0);
          float laneMask = smoothstep(0.10, 0.45, dust);
          float nearMid  = exp(-(d*d) / (2.0 * 0.09 * 0.09));
          band *= 1.0 - 0.75 * laneMask * nearMid;

          // Fine grain so the glow has texture at small scales.
          band *= 0.85 + 0.25 * fbm(dir * 22.0);
          band  = max(band, 0.0);

          // Galactic centre: a faintly warmer, brighter region toward one heading.
          vec3  C        = normalize(vec3(0.85, 0.10, 0.52));
          float toCenter = smoothstep(0.55, 1.0, dot(dir, C));

          // Subtle, low-saturation palette (blue-white edges → faint warm core).
          vec3 coolCol = vec3(0.62, 0.70, 0.92);
          vec3 warmCol = vec3(0.95, 0.86, 0.70);
          vec3 col     = mix(coolCol, warmCol, toCenter * 0.8);

          float intensity = 0.34;          // overall restraint — keep it understated
          vec3 outc = col * band * intensity * (1.0 + 0.8 * toCenter) * uBrightness;
          gl_FragColor = vec4(outc, 1.0);  // additive: only adds light to the sky
        }
      `,
    });
    const milkyway = new THREE.Mesh(new THREE.SphereGeometry(100, 64, 32), milkyMat);
    milkyway.renderOrder = -1;       // paint first, behind stars / planets / sun
    milkyway.frustumCulled = false;  // always recentred on the camera each frame
    scene.add(milkyway);

    // ====== 19b. Eruptions (lava bursts off bodies) ======
    // A burst of glowing molten DROPLETS ejected from a surface point: each
    // particle launches outward along the local normal (with a spread cone),
    // arcs back under a fake gravity, shrinks, and cools white-hot → deep red.
    // Implemented as one THREE.Points per eruption with a custom shader, so the
    // CPU only bumps a `uTime` uniform — the ballistic motion runs on the GPU.
    // The Points object is parented to the body's group, so it rides the body's
    // spin and orbit. A short, bright vent flash sprite sells the initial blast.
    const eruptions = [];
    const MAX_ERUPTIONS = 14;
    const ERUPT_PARTICLES = 26;
    let eruptionTimer = 0.6;

    // Radial flame gradient for the vent flash: white core → orange → clear.
    const flameTex = (() => {
      const s = 64;
      const cv = document.createElement('canvas');
      cv.width = cv.height = s;
      const ctx = cv.getContext('2d');
      const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
      g.addColorStop(0.0, 'rgba(255,255,255,1.0)');
      g.addColorStop(0.25, 'rgba(255,225,140,0.95)');
      g.addColorStop(0.55, 'rgba(255,120,30,0.55)');
      g.addColorStop(1.0, 'rgba(200,40,0,0.0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, s, s);
      return new THREE.CanvasTexture(cv);
    })();

    // Ballistic particle shader. position = launch point; aVel = initial
    // velocity (body-local units/s); the vertex integrates p = p0 + v t − ½g t²
    // along the local up so droplets arc. Point size attenuates with depth and
    // shrinks with age; the frag draws a soft round droplet, hot→cool by life.
    const ERUPT_VERT = /* glsl */ `
      attribute vec3  aVel;
      attribute float aSize;
      uniform float uTime;
      uniform float uLife;
      uniform vec3  uUp;
      uniform float uGravity;
      uniform float uSizePx;
      varying float vLife;
      void main() {
        float t = uTime;
        vec3 p = position + aVel * t - uUp * (0.5 * uGravity * t * t);
        vLife = clamp(t / uLife, 0.0, 1.0);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        float sz = uSizePx * aSize * (1.0 - vLife * 0.65);
        gl_PointSize = clamp(sz * (1.0 / max(0.001, -mv.z)), 1.0, 180.0);
        gl_Position = projectionMatrix * mv;
      }
    `;
    const ERUPT_FRAG = /* glsl */ `
      precision highp float;
      uniform vec3 uHot;
      uniform vec3 uCool;
      varying float vLife;
      void main() {
        vec2 d = gl_PointCoord - vec2(0.5);
        float r = length(d);
        if (r > 0.5) discard;
        float soft = smoothstep(0.5, 0.1, r);   // bright core, soft edge
        vec3  col = mix(uHot, uCool, vLife);     // cool as it falls
        float alpha = soft * (1.0 - vLife * vLife);
        gl_FragColor = vec4(col, alpha);
      }
    `;

    function spawnEruption(body) {
      if (eruptions.length >= MAX_ERUPTIONS) return;
      const R = body.baseRadius;
      // Random surface point + local frame (up = normal, t1/t2 = tangents).
      const z = Math.random() * 2 - 1;
      const aa = Math.random() * Math.PI * 2;
      const rr = Math.sqrt(Math.max(0, 1 - z * z));
      const up = new THREE.Vector3(rr * Math.cos(aa), z, rr * Math.sin(aa));
      const ref = Math.abs(up.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
      const t1 = new THREE.Vector3().crossVectors(ref, up).normalize();
      const t2 = new THREE.Vector3().crossVectors(up, t1).normalize();
      const base = up.clone().multiplyScalar(R * 1.005);

      const life = 1.0 + Math.random() * 0.7;
      const N = ERUPT_PARTICLES;
      const pos  = new Float32Array(N * 3);
      const vel  = new Float32Array(N * 3);
      const size = new Float32Array(N);
      // Launch speed sized so droplets rise ~0.4–1.0 R before gravity wins.
      const speed = R * (1.6 + Math.random() * 1.2);
      for (let i = 0; i < N; i++) {
        // Tight upward cone: mostly along `up`, with a little lateral spread.
        const spread = 0.18 + Math.random() * 0.32;
        const sa = Math.random() * Math.PI * 2;
        const dir = up.clone()
          .addScaledVector(t1, Math.cos(sa) * spread)
          .addScaledVector(t2, Math.sin(sa) * spread)
          .normalize();
        const sp = speed * (0.45 + Math.random() * 0.75);
        // Tiny jitter around the vent so they don't all start at one point.
        const j = R * 0.02;
        pos[i * 3]     = base.x + (Math.random() - 0.5) * j;
        pos[i * 3 + 1] = base.y + (Math.random() - 0.5) * j;
        pos[i * 3 + 2] = base.z + (Math.random() - 0.5) * j;
        vel[i * 3]     = dir.x * sp;
        vel[i * 3 + 1] = dir.y * sp;
        vel[i * 3 + 2] = dir.z * sp;
        size[i] = 0.5 + Math.random() * 1.3;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('aVel', new THREE.BufferAttribute(vel, 3));
      geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
      // Droplet pixel size must track the body's *world* size (group.scale can
      // shrink/grow a body) and the drawing-buffer resolution (devicePixelRatio
      // makes gl_PointSize physical pixels). Motion stays in LOCAL units so the
      // arc scales naturally with the body inside its group.
      const worldR = R * (body.group.scale.x || 1);
      const dpr = renderer.getPixelRatio();
      const mat = new THREE.ShaderMaterial({
        vertexShader: ERUPT_VERT,
        fragmentShader: ERUPT_FRAG,
        uniforms: {
          uTime:    { value: 0 },
          uLife:    { value: life },
          uUp:      { value: up.clone() },
          uGravity: { value: R * 4.5 },
          uSizePx:  { value: worldR * 130.0 * dpr },
          uHot:     { value: new THREE.Color(0xfff0c0) },
          uCool:    { value: new THREE.Color(0xb81800) },
        },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        fog: false,
      });
      const points = new THREE.Points(geo, mat);
      points.frustumCulled = false; // particles travel outside the geo bounds
      points.renderOrder = 3;
      body.group.add(points);

      // Bright vent flash at the blast point.
      const flash = new THREE.Sprite(new THREE.SpriteMaterial({
        map: flameTex, color: 0xffffff, transparent: true,
        depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
      }));
      flash.position.copy(base);
      flash.scale.setScalar(R * 0.4);
      flash.renderOrder = 3;
      body.group.add(flash);

      eruptions.push({ body, points, mat, flash, age: 0, life });
    }

    function updateEruptions(dt) {
      // Throttled random spawning. Only the Sun erupts (solar prominences);
      // planets and moons do not.
      eruptionTimer -= dt;
      if (eruptionTimer <= 0) {
        eruptionTimer = 0.35 + Math.random() * 1.1;
        // Solar prominences only — the Sun erupts, planets/moons do not. The
        // Sun isn't in `bodies` (it's a standalone mesh), so wrap it in a
        // pseudo-body that satisfies spawnEruption (needs baseRadius + group).
        const sunBody = { baseRadius: SUN_RADIUS, group: sunMesh, matter: { plasma: true } };
        spawnEruption(sunBody);
      }
      for (let i = eruptions.length - 1; i >= 0; i--) {
        const e = eruptions[i];
        e.age += dt;
        if (e.age >= e.life) {
          e.body.group.remove(e.points);
          e.body.group.remove(e.flash);
          e.points.geometry.dispose();
          e.mat.dispose();
          e.flash.material.dispose();
          eruptions.splice(i, 1);
          continue;
        }
        e.mat.uniforms.uTime.value = e.age;
        // Flash: blooms hard in the first ~120ms, then snaps out.
        const ft = e.age / 0.18;
        if (ft < 1) {
          const R = e.body.baseRadius;
          e.flash.scale.setScalar(R * (0.3 + ft * 0.7));
          e.flash.material.opacity = 1 - ft;
          e.flash.visible = true;
        } else {
          e.flash.visible = false;
        }
      }
    }

    // ====== 20. Planet rotation ======
    // Each planet carries its own spin rate (rad/s) so the System tab's Spin
    // slider can tune them independently. registerPlanet() seeds new bodies
    // with DEFAULT_SPIN (declared earlier, alongside the planets[] array, so
    // it's available when the first planets register at module init time).
    function updatePlanetRotation(dt) {
      for (const p of planets) {
        const w = p.body.rotationSpeed ?? DEFAULT_SPIN;
        p.body.group.rotation.y += w * dt;
      }
    }

    // ====== 21. Sun light for focus ======
    // PointLight sits at the sun's origin, so its lighting direction is
    // already correct per-body (each fragment computes its own light vector).
    // The atmosphere shader still uses a uniform vec3 uSunDir, so we refresh
    // each body's gas material with its own (body → sun) direction.
    const _sunWorldTmp = new THREE.Vector3();
    const _bodyPosTmp  = new THREE.Vector3();
    const _toSunTmp    = new THREE.Vector3();
    function updateSunLightForFocus() {
      sunMesh.getWorldPosition(_sunWorldTmp);
      for (const b of bodies) {
        const needsGas  = !!(b.gasMesh  && b.gasMesh.material.uniforms.uSunDir);
        const needsRing = !!(b.ringMesh && b.ringMesh.visible);
        if (!needsGas && !needsRing) continue;
        b.group.getWorldPosition(_bodyPosTmp);
        _toSunTmp.subVectors(_sunWorldTmp, _bodyPosTmp);
        if (_toSunTmp.lengthSq() < 1e-8) _toSunTmp.set(1, 0, 0);
        else _toSunTmp.normalize();
        if (needsGas) {
          b.gasMesh.material.uniforms.uSunDir.value.copy(_toSunTmp);
        }
        if (needsRing) {
          const u = b.ringMesh.material.uniforms;
          u.uSunDir.value.copy(_toSunTmp);
          u.uBodyCenter.value.copy(_bodyPosTmp);
          // World radius includes the body group's scale so the planet shadow
          // on the ring tracks visually no matter the planet size.
          const worldScale = b.group.scale.x;
          u.uBodyRadius.value = b.baseRadius * worldScale;
          // Gas occluder: where the line of sight to a ring fragment passes
          // through the gas sphere, the shader fades alpha so a thick
          // atmosphere (or gas-giant body) hides the back half of the ring.
          // For 'full' gas the body IS the gas — opacity tracks density.
          // For 'atmosphere' shells, both density and coverage matter (sparse
          // clouds don't block much regardless of how dense each clump is).
          if (b.matter && b.matter.gas) {
            const thick = b.gasThickness ?? 1.0;
            u.uGasRadius.value = b.baseRadius * thick * worldScale;
            const density  = b.gasDensity  ?? 0.5;
            const coverage = b.gasCoverage ?? 0.5;
            u.uGasOpacity.value = b.matter.gas === 'full'
              ? density
              : density * coverage;
          } else {
            u.uGasRadius.value  = 0.0;
            u.uGasOpacity.value = 0.0;
          }
        }
      }
    }

    function updateMoonLight() {
      // Moonlight is only calculated for the current "focus" context: either the
      // planet we're walking on, or the body (planet/moon) the camera is focused on.
      const targetBody = (viewMode === 'surface' ? surfaceState.body : (focusedProbe ? null : focusedBody));
      if (!targetBody) {
        moonLight.intensity = 0;
        return;
      }

      let primarySat = null;
      let maxImpact = 0;

      if (targetBody.kind === 'planet') {
        // Find the moon with the most "impact" (apparent size) on this planet.
        for (const m of moons) {
          if (m.parent === targetBody) {
            const size = m.body.baseRadius * m.body.group.scale.x;
            // impact is proportional to solid angle (size^2 / distance^2)
            const impact = (size * size) / (m.distance * m.distance);
            if (impact > maxImpact) {
              maxImpact = impact;
              primarySat = m.body;
            }
          }
        }
      } else if (targetBody.kind === 'moon') {
        // If we're on a moon, the host planet is our "primary" light source (planetlight).
        const m = moons.find(mn => mn.body === targetBody);
        if (m && m.parent) {
          primarySat = m.parent;
          maxImpact = 1.0; // host planet is always the dominant night light
        }
      }

      if (!primarySat) {
        moonLight.intensity = 0;
        return;
      }

      // Direction from target to satellite.
      primarySat.group.getWorldPosition(_sunWorldTmp);
      targetBody.group.getWorldPosition(_bodyPosTmp);
      _toSunTmp.subVectors(_sunWorldTmp, _bodyPosTmp);
      
      if (_toSunTmp.lengthSq() < 1e-8) {
        moonLight.intensity = 0;
        return;
      }
      _toSunTmp.normalize();
      
      // DirectionalLight: position is the direction vector relative to the target.
      // We set target at the body center, and position at (body center + direction).
      moonLight.target.position.copy(_bodyPosTmp);
      moonLight.position.copy(_bodyPosTmp).add(_toSunTmp);
      
      // Subtle cool blue moonlight.
      moonLight.intensity = 0.18;
    }

    // ====== 22. Focus ======
    // Camera target each frame is either the focused body's center, or — if a city
    // is selected — that city marker's world position (still parented to its body,
    // so rotation/orbit naturally carries the target along).
    // Starts null: planets aren't spawned yet at eval time (see bootstrapSolSystem).
    // The init tail calls setSystemFocus() anyway, which leaves focusedBody null.
    let focusedBody = null;
    let focusedCity = null;
    // Probes are not editable bodies, so they get their own focus slot rather
    // than riding on focusedBody (which everywhere assumes a planet/moon with a
    // .kind, .group, baseRadius, matter, …). When a probe is focused we keep
    // focusedBody pointing at its host planet so the left panel stays anchored
    // to that planet's Sats tab; focusedProbe distinguishes the two.
    let focusedProbe = null;

    // Switch the focused body. Side effects: clears focusedCity, recenters
    // OrbitControls on the new body's world position at a sensible dolly
    // distance, and re-renders the info panel, biome tools, and left panel.
    function setFocus(body) {
      focusedBody = body;
      focusedCity = null;
      focusedProbe = null;
      focusNameEl.textContent = body.name;
      const newTarget = new THREE.Vector3();
      body.group.getWorldPosition(newTarget);
      const effRadius = body.baseRadius * body.group.scale.x;
      const desiredDist = Math.max(effRadius * 3.2, effRadius + 4);
      let dir = camera.position.clone().sub(controls.target);
      if (dir.lengthSq() < 1e-6) dir.set(0, 0.3, 1);
      dir.normalize();
      camera.position.copy(newTarget).addScaledVector(dir, desiredDist);
      controls.target.copy(newTarget);
      renderFocusBadges();
      updateBiomeTools();
      updateInfoPanel();
      if (typeof applyFocusToLeftPanel === 'function') applyFocusToLeftPanel();
    }

    function setCityFocus(city) {
      focusedBody = city.body;
      focusedCity = city;
      focusedProbe = null;
      focusNameEl.textContent = `${city.name} · ${city.body.name}`;
      const newTarget = new THREE.Vector3();
      city.mesh.getWorldPosition(newTarget);
      // Closer framing than a whole-body focus — settlement is a point, not a sphere.
      const effRadius = city.body.baseRadius * city.body.group.scale.x;
      const desiredDist = Math.max(effRadius * 1.2, effRadius + 2);
      // Look at the city from "above" the local surface: prefer the surface normal
      // direction so the city sits centered with the body curving away.
      const normal = newTarget.clone().sub(city.body.group.getWorldPosition(new THREE.Vector3())).normalize();
      if (normal.lengthSq() < 1e-6) normal.set(0, 1, 0);
      camera.position.copy(newTarget).addScaledVector(normal, desiredDist);
      controls.target.copy(newTarget);
      renderFocusBadges();
      renderCityList();
      updateBiomeTools();
      updateInfoPanel();
      if (typeof applyFocusToLeftPanel === 'function') applyFocusToLeftPanel();
    }

    // Focus on a probe. Mirrors setFocus but targets the probe's mesh group and
    // keeps focusedBody on the host planet so the Sats tab stays in context.
    function setProbeFocus(probe) {
      focusedProbe = probe;
      focusedCity = null;
      focusedBody = probe.parent;
      focusNameEl.textContent = probe.name;
      const newTarget = new THREE.Vector3();
      probe.mesh.getWorldPosition(newTarget);
      // The mesh group is scaled by probe.size, so frame relative to that.
      const desiredDist = Math.max(probe.size * 6, probe.size + 4);
      let dir = camera.position.clone().sub(controls.target);
      if (dir.lengthSq() < 1e-6) dir.set(0, 0.3, 1);
      dir.normalize();
      camera.position.copy(newTarget).addScaledVector(dir, desiredDist);
      controls.target.copy(newTarget);
      renderFocusBadges();
      updateBiomeTools();
      updateInfoPanel();
      if (typeof applyFocusToLeftPanel === 'function') applyFocusToLeftPanel();
    }

    // Per-frame: snap controls.target onto the focused body's current world
    // position so the camera stays glued to it as planets orbit and moons swing
    // around their parent. The camera position trails along by the same delta,
    // so the user's chosen viewing angle is preserved.
    function updateFocusTracking() {
      const newTarget = new THREE.Vector3();
      if (focusedProbe) focusedProbe.mesh.getWorldPosition(newTarget);
      else if (!focusedBody) return;
      else if (focusedCity) focusedCity.mesh.getWorldPosition(newTarget);
      else focusedBody.group.getWorldPosition(newTarget);
      const delta = newTarget.clone().sub(controls.target);
      if (delta.lengthSq() > 1e-12) {
        controls.target.copy(newTarget);
        // Keep camera offset relative to target so user-controlled orbit/zoom is preserved.
        camera.position.add(delta);
      }
    }

    // ====== 22b. Temperature / climate model ======
    // A body's surface temperature is driven by three things the user changes:
    // how far it orbits the star, what archetype it is, and the atmosphere it
    // wears. Incident starlight falls off as 1/d², and an *airless* body
    // re-radiates as a blackbody (T ∝ flux^¼), so its equilibrium temperature
    // scales as d^-0.5. We anchor that bare-rock curve at Earth's orbit (≈ −18°C,
    // Earth's temperature *without* its greenhouse).
    //
    // An atmosphere then does two things, both scaled by how thick/dense it
    // actually is (so the Atmosphere sliders change the climate live):
    //   1. Greenhouse warming — traps heat, lifting the mean temperature. How
    //      potent depends on the archetype's gas (Venus's CO₂ runs away; a thin
    //      terrestrial mix warms gently).
    //   2. Heat redistribution — winds and oceans carry warmth from equator to
    //      pole, *shrinking* the latitude spread. An airless world (the Moon,
    //      Mercury) keeps its full, brutal equator-to-pole gap; a thick envelope
    //      nearly erases it.
    // So Earth (atmosphere) and its Moon (none) at the same orbital distance end
    // up with very different means *and* very different ranges — which is the
    // whole point. temperatureAtLatitude() is the per-vertex hook future biome
    // painting calls to decide snow caps vs. tropics.
    const TEMP_REF_DISTANCE   = 270;    // Earth's orbital distance, scene units
    const TEMP_REF_KELVIN     = 255;    // airless equilibrium there (~ −18°C)
    // KELVIN_ZERO_C lives in section 1 (the frost coloring needs it early).
    const HEAT_REDISTRIBUTION = 0.82;   // fraction of the spread a full atmosphere erases

    // Per-archetype climate shaping (temperatures in kelvin):
    //   base       — fixed offset always applied (albedo, intrinsic warmth). A
    //                reflective ice world is negative; most worlds are 0.
    //   greenhouse — extra warming a *full-strength* atmosphere of this type adds.
    //                Multiplied by the body's live atmosphere factor (0 = none).
    //   airSpread  — equator-to-pole span the body would have with NO atmosphere.
    //                Atmosphere shrinks it toward zero.
    //   override   — fixed mean temp for bodies whose heat isn't the star's:
    //                stars (photosphere), lava worlds (molten), rogues (sunless).
    const ARCHETYPE_CLIMATE = {
      terrestrial: { base:   0, greenhouse:  60, airSpread: 120 },
      ocean:       { base:   4, greenhouse:  55, airSpread:  90 },
      gas_giant:   { base:  20, greenhouse:  40, airSpread:  60 },
      ice_giant:   { base:  -5, greenhouse:  30, airSpread:  55 },
      desert:      { base:   8, greenhouse:  20, airSpread: 130 },
      lava:        { override: 1100, airSpread: 60 },
      ice_planet:  { base: -30, greenhouse:  20, airSpread: 120 },
      jungle:      { base:   0, greenhouse:  50, airSpread:  60 },
      swamp:       { base:   0, greenhouse:  45, airSpread:  70 },
      toxic:       { base:   5, greenhouse:  90, airSpread:  90 },
      venusian:    { base:   0, greenhouse: 430, airSpread:  60 },
      metal:       { base:   0, greenhouse:   0, airSpread: 150 },
      carbon:      { base:  10, greenhouse:  30, airSpread: 110 },
      moon_like:   { base:   0, greenhouse:   0, airSpread: 150 },
      storm:       { base:   5, greenhouse:  40, airSpread:  90 },
      living:      { base:   5, greenhouse:  35, airSpread:  75 },
      rogue:       { override:   35, airSpread:  10 },  // 35 K ≈ −238°C, no star
      star:        { override: 5800, airSpread:   0 },
    };
    const DEFAULT_CLIMATE = { base: 0, greenhouse: 0, airSpread: 130 };

    // Effective distance from the star for any body. Planets read their own
    // orbit; moons inherit their parent planet's orbital distance (a moon's
    // small local orbit barely changes how much starlight reaches it).
    function sunDistanceOf(body) {
      const p = planets.find(pl => pl.body === body);
      if (p) return p.orbit.distance;
      const m = moons.find(mn => mn.body === body);
      if (m) {
        const pp = planets.find(pl => pl.body === m.parent);
        if (pp) return pp.orbit.distance;
      }
      return TEMP_REF_DISTANCE;
    }

    // How much atmosphere a body actually wears, 0 (airless) → 1 (thick & dense).
    // Reads the body's *live* gas state so the Atmosphere sliders move the
    // climate. A full-gas giant is all atmosphere (1); a thin shell is graded by
    // its density plus the extra reach of its thickness above the surface.
    function atmosphereFactor(body) {
      const m = body.matter;
      if (!m || !m.gas) return 0;
      if (m.gas === 'full') return 1;
      const density   = Math.max(0, Math.min(1, body.gasDensity ?? 0.3));
      const thickness = Math.max(0, (body.gasThickness ?? 1.1) - 1.0);  // 0 .. ~0.2
      return Math.max(0, Math.min(1, density * 0.8 + thickness * 2.0));
    }

    // Compute (and cache on body.climate) a body's climate. One source of truth
    // shared by the info panel and future biome code. Recompute after anything
    // that moves the body, changes its archetype, or edits its atmosphere
    // (orbit-distance slider, regen, atmosphere sliders).
    function computeClimate(body) {
      const arch = body.archetype || (body.kind === 'moon' ? 'moon_like' : 'terrestrial');
      const cfg = ARCHETYPE_CLIMATE[arch] || DEFAULT_CLIMATE;
      const dist = Math.max(1, sunDistanceOf(body));
      const equilibrium = TEMP_REF_KELVIN * Math.sqrt(TEMP_REF_DISTANCE / dist);
      const atmo = atmosphereFactor(body);
      const meanK = cfg.override != null
        ? cfg.override
        : equilibrium + (cfg.base || 0) + (cfg.greenhouse || 0) * atmo;
      // Atmosphere carries heat poleward, collapsing the equator-to-pole span.
      const spread = (cfg.airSpread || 0) * (1 - HEAT_REDISTRIBUTION * atmo);
      // The mean sits between equator and pole, area-weighted toward the larger,
      // warmer equatorial belt: equator a little above the mean, poles well below.
      const climate = {
        distance: dist,
        equilibriumK: equilibrium,
        atmosphere: atmo,
        meanK,
        equatorK: meanK + spread * 0.35,
        poleK:    meanK - spread * 0.65,
        spread,
      };
      body.climate = climate;
      return climate;
    }

    // Temperature (kelvin) at a latitude in radians (0 = equator, ±π/2 = pole).
    // cos(lat) is 1 at the equator and 0 at the poles; raising it to a power
    // keeps the tropics broad and warm while the cold collapses toward the caps
    // — the curve future biome painting reads to drop snow/ice onto the poles.
    function temperatureAtLatitude(body, latRad) {
      const c = body.climate || computeClimate(body);
      const warmth = Math.max(0, Math.cos(latRad)) ** 1.6;  // 1 equator → 0 pole
      return c.poleK + (c.equatorK - c.poleK) * warmth;
    }

    function fmtTemp(k) {
      const c = k - KELVIN_ZERO_C;
      if (Math.abs(c) >= 1000) return (c / 1000).toFixed(1) + 'k°C';
      return Math.round(c) + '°C';
    }

    // Map a temperature to a HUD color: frozen blue → temperate green → amber →
    // scorching red → white-hot. Drives the climate swatch so the panel reads at
    // a glance. Stops are in °C.
    const TEMP_COLOR_STOPS = [
      [-150, [120, 170, 255]],
      [ -30, [ 90, 200, 230]],
      [  12, [ 80, 210, 120]],
      [  45, [240, 200,  70]],
      [ 150, [240,  90,  50]],
      [ 600, [255, 240, 220]],
    ];
    function tempColor(k) {
      const c = k - KELVIN_ZERO_C;
      const s = TEMP_COLOR_STOPS;
      if (c <= s[0][0]) return `rgb(${s[0][1].join(',')})`;
      if (c >= s[s.length - 1][0]) return `rgb(${s[s.length - 1][1].join(',')})`;
      for (let i = 0; i < s.length - 1; i++) {
        const [t0, c0] = s[i], [t1, c1] = s[i + 1];
        if (c >= t0 && c <= t1) {
          const f = (c - t0) / (t1 - t0);
          const r = Math.round(c0[0] + (c1[0] - c0[0]) * f);
          const g = Math.round(c0[1] + (c1[1] - c0[1]) * f);
          const b = Math.round(c0[2] + (c1[2] - c0[2]) * f);
          return `rgb(${r},${g},${b})`;
        }
      }
      return `rgb(${s[0][1].join(',')})`;
    }

    // ====== 22c. Surface gravity model ======
    // A toy gravity model in the same not-to-scale spirit as the climate model.
    // Surface gravity scales as g = (4/3)·πG·ρ·R — i.e. density × radius. We
    // don't track mass, so we read the body's *rendered* radius and pair it with
    // a per-archetype relative density, then anchor a reference Earth-size
    // terrestrial world at 1 g. The radius term is softened (^0.6) so small
    // moons stay playfully floaty without collapsing to near-zero, and giants
    // don't blow far past a few g. Drives both the telemetry readout and the
    // surface-walk feel (jump arc height + walk pace).
    const GRAVITY_REF_RADIUS = BASE_RADIUS * 0.27;  // Earth's rendered radius (spec size 0.27)
    const ARCHETYPE_DENSITY = {
      terrestrial: 1.00, ocean: 0.95, desert: 0.95, lava: 1.10, ice_planet: 0.55,
      ice_giant: 0.30, gas_giant: 0.22, jungle: 0.95, swamp: 0.90, toxic: 1.00,
      venusian: 0.95, metal: 2.00, carbon: 1.30, moon_like: 0.85, storm: 0.55,
      living: 0.90, rogue: 0.90,
    };
    // Relative surface gravity (Earth = 1 g) for any planet or moon.
    function surfaceGravityG(body) {
      const arch = body.archetype || (body.kind === 'moon' ? 'moon_like' : 'terrestrial');
      const density = ARCHETYPE_DENSITY[arch] ?? 1.0;
      const worldRadius = body.baseRadius * (body.group ? body.group.scale.x : 1);
      const g = density * Math.pow(worldRadius / GRAVITY_REF_RADIUS, 0.6);
      return Math.max(0.05, Math.min(3.5, g));
    }

    // ====== 23. Info panel ======
    let planetCurrentSeed = 'planet';

    // Category metadata: label + swatch color (matches the in-world palette). Covers
    // both "auto" (height-band) and biome-painted categories for planets and moons.
    const COMP_DISPLAY = {
      water:     { label: 'Water',       color: '#3FA1DC' },
      sand:      { label: 'Sand',        color: '#EDDFB8' },
      grass:     { label: 'Grass',       color: '#4FAE4F' },
      rock:      { label: 'Rock',        color: '#7d6a5a' },
      snow:      { label: 'Snow',        color: '#f0f4f8' },
      forest:    { label: 'Forest',      color: '#1a4d1a' },
      desert:    { label: 'Desert',      color: '#d2b48c' },
      city:      { label: 'Settlements', color: '#808080' },
      // Climate land biomes (terrestrial latitude zones). Colors mirror
      // CLIMATE_LAND_ZONES so the swatch matches the painted surface.
      ice:       { label: 'Ice',         color: '#daf2ff' },
      tundra:    { label: 'Tundra',      color: '#8f9e76' },
      jungle:    { label: 'Jungle',      color: '#15702a' },
      // Sea-state categories (water oceans only): a frozen-over sea and a basin
      // the heat has boiled dry. Colors mirror SEA_ICE_COLOR / SEABED_COLOR.
      seaice:    { label: 'Sea Ice',     color: '#cfe6f0' },
      seabed:    { label: 'Dry Seabed',  color: '#cabfa3' },
      crater:    { label: 'Crater',      color: '#322e29' },
      dust:      { label: 'Dust',        color: '#6f6357' },
      highlight: { label: 'Highlights',  color: '#e2dccf' },
      mare:      { label: 'Mare',        color: '#2a2a30' },
      regolith:  { label: 'Regolith',    color: '#c4b8a0' },
      frost:     { label: 'Frost',       color: '#d8e8f0' },
    };
    const PLANET_COMP_ORDER = ['water', 'seaice', 'ice', 'tundra', 'grass', 'jungle', 'forest', 'sand', 'desert', 'seabed', 'rock', 'snow', 'city'];
    const MOON_COMP_ORDER   = ['crater', 'dust', 'rock', 'highlight', 'mare', 'regolith', 'frost', 'city'];

    // Per-archetype labels for the auto-painted height bands. Without these, a
    // desert planet reports "Grass" for its mid-elevation band even though that
    // band is colored desert-tan — confusing because no green is visible.
    const BAND_KEY_TO_PALETTE = { water: 'deep', sand: 'sand', grass: 'grass', rock: 'rock', snow: 'snow' };
    const ARCHETYPE_BAND_LABELS = {
      terrestrial: { water: 'Ocean',      sand: 'Coast',      grass: 'Grass',      rock: 'Rock',       snow: 'Snow' },
      ocean:       { water: 'Abyss',      sand: 'Deep',       grass: 'Sea',        rock: 'Shoal',      snow: 'Foam' },
      gas_giant:   { water: 'Deep Band',  sand: 'Lower Cloud',grass: 'Mid Cloud',  rock: 'Storm Belt', snow: 'High Cloud' },
      ice_giant:   { water: 'Deep Ice',   sand: 'Ice Shelf',  grass: 'Ice Plain',  rock: 'Ridge',      snow: 'Frost Crown' },
      desert:      { water: 'Basin',      sand: 'Dunes',      grass: 'Flats',      rock: 'Mesa',       snow: 'Salt Peak' },
      lava:        { water: 'Magma',      sand: 'Cinder',     grass: 'Lava Plain', rock: 'Basalt',     snow: 'Ash' },
      ice_planet:  { water: 'Subglacial', sand: 'Snowfield',  grass: 'Pack Ice',   rock: 'Glacier',    snow: 'Ice Peak' },
      jungle:      { water: 'River',      sand: 'Bank',       grass: 'Jungle',     rock: 'Highland',   snow: 'Canopy' },
      swamp:       { water: 'Bog',        sand: 'Marsh',      grass: 'Mossland',   rock: 'Ridge',      snow: 'Mist' },
      toxic:       { water: 'Acid Sea',   sand: 'Sludge',     grass: 'Bloom',      rock: 'Spire',      snow: 'Vapor' },
      venusian:    { water: 'Lava Plain', sand: 'Ochre Flat', grass: 'Cream Crust',rock: 'Basalt',     snow: 'Highland' },
      metal:       { water: 'Slag Pit',   sand: 'Plate',      grass: 'Sheet',      rock: 'Ridge',      snow: 'Vein' },
      carbon:      { water: 'Tar',        sand: 'Ash Flat',   grass: 'Soot Plain', rock: 'Diamond',    snow: 'Carbon Peak' },
      moon_like:   { water: 'Crater Floor',sand: 'Dust Plain', grass: 'Regolith',   rock: 'Highland',   snow: 'Frost Cap' },
      storm:       { water: 'Squall Sea', sand: 'Foam',       grass: 'Plain',      rock: 'Ridge',      snow: 'Cyclone' },
      living:      { water: 'Blood Sea',  sand: 'Vein',       grass: 'Flesh',      rock: 'Bone',       snow: 'Organ' },
      rogue:       { water: 'Void',       sand: 'Dust',       grass: 'Plain',      rock: 'Ridge',      snow: 'Peak' },
    };

    function hexFromNumber(n) {
      return '#' + (n >>> 0).toString(16).padStart(6, '0');
    }

    // Build the (label, swatch-color) pair for a planet band, using the planet's
    // actual palette so the swatch matches what's drawn on the surface.
    function bandMeta(body, key) {
      const arch = body.archetype || 'terrestrial';
      const labels = ARCHETYPE_BAND_LABELS[arch] || ARCHETYPE_BAND_LABELS.terrestrial;
      const label = labels[key] || COMP_DISPLAY[key].label;
      let color;
      if (key === 'water' && body.oceanMesh && body.oceanMesh.visible) {
        // Ocean tint now lives in vertex colors (material.color is neutral white),
        // so use the stored base color for the swatch.
        color = hexFromNumber(body.oceanBaseColor || COL.water);
      } else {
        const palKey = BAND_KEY_TO_PALETTE[key];
        color = body.palette && body.palette[palKey] != null
          ? hexFromNumber(body.palette[palKey])
          : COMP_DISPLAY[key].color;
      }
      return { label, color };
    }

    // Returns { peak, N, counts } where counts maps a band/biome key to the
    // number of vertices in that bucket. Drives the composition rollup in the
    // info panel; planet keys differ from moon keys (see PLANET_COMP_ORDER /
    // MOON_COMP_ORDER).
    function computeBodyStats(body) {
      let peak = -Infinity;
      const counts = {};
      const hasBiomes = body.biomes != null;
      // Mirror colorBodyVertex: on climate-zoned worlds the auto land band is
      // named by latitude (ice/tundra/grass/jungle) rather than elevation, so the
      // composition rollup matches what's actually painted on the surface.
      const climateZoned = body.kind === 'planet' && body.climate && body.climate.spread > 0.5;
      const zones = climateZoned ? CLIMATE_LAND_ZONES[body.archetype] : null;
      // Water seas report their frozen / boiled-dry state so the rollup matches
      // what the ocean sphere shows (see colorOceanByClimate).
      const seaWater = climateZoned && body.matter && body.matter.liquid && body.oceanIsWater;
      for (let i = 0; i < body.N; i++) {
        const h = body.heights[i];
        if (h > peak) peak = h;
        const b = hasBiomes ? body.biomes[i] : 0;
        let key;
        if (b === 1) key = 'forest';
        else if (b === 2) key = 'desert';
        else if (b === 3) key = 'city';
        else if (b === 4) key = 'tundra';
        else if (b === BIOME.MARE) key = 'mare';
        else if (b === BIOME.REGOLITH) key = 'regolith';
        else if (b === BIOME.FROST) key = 'frost';
        else if (body.kind === 'planet') {
          if (h < SEA_LEVEL) {
            if (seaWater) {
              const tC = vertexTempC(body, i);
              key = tC >= SEA_VAPOR_C ? 'seabed' : (tC <= SEA_ICE_C ? 'seaice' : 'water');
            } else key = 'water';
          }
          else if (h >= ROCK_TOP) key = 'snow';
          else if (zones) {
            const z = pickLandZone(zones, vertexTempC(body, i));
            // Warm zones show a sandy shore at the waterline (matches coloring).
            key = (z.beach && h < SAND_TOP) ? 'sand' : z.key;
          }
          else if (h < SAND_TOP) key = 'sand';
          else if (h < GRASS_TOP) key = 'grass';
          else key = 'rock';
        } else {
          if (h < 0) key = 'crater';
          else if (h < GRASS_TOP) key = 'dust';
          else if (h < ROCK_TOP) key = 'rock';
          else key = 'highlight';
        }
        counts[key] = (counts[key] || 0) + 1;
      }
      return { peak: peak === -Infinity ? 0 : peak, N: body.N, counts };
    }

    function fmtPct(n, total) {
      if (!total) return '0%';
      const p = (n / total) * 100;
      return (p >= 10 ? p.toFixed(0) : p.toFixed(1)) + '%';
    }

    function fmtSeconds(s) {
      if (!isFinite(s)) return '∞';
      if (s < 60) return s.toFixed(1) + 's';
      const m = Math.floor(s / 60);
      const r = Math.round(s - m * 60);
      return `${m}m ${r}s`;
    }

    function peakWorldHeight(body, peak) {
      return body.baseRadius * Math.max(0, peak) * BODY_HEIGHT_SCALE * body.group.scale.x;
    }

    const infoEls = {
      name:         document.getElementById('infoBodyName'),
      subtitle:     document.getElementById('infoSubtitle'),
      composition:  document.getElementById('infoComposition'),
      climateSection: document.getElementById('infoClimateSection'),
      tempMean:     document.getElementById('infoTempMean'),
      tempRangeRow: document.getElementById('infoTempRangeRow'),
      tempRange:    document.getElementById('infoTempRange'),
      tempBar:      document.getElementById('infoTempBar'),
      gravity:      document.getElementById('infoGravity'),
      peak:         document.getElementById('infoPeak'),
      verts:        document.getElementById('infoVerts'),
      moonsRow:     document.getElementById('infoMoonsRow'),
      moons:        document.getElementById('infoMoons'),
      timeSection:  document.getElementById('infoTimeSection'),
      dayPeriod:    document.getElementById('infoDayPeriod'),
      dayTime:      document.getElementById('infoDayTime'),
      orbitSection: document.getElementById('infoOrbitSection'),
      orbitDist:    document.getElementById('infoOrbitDist'),
      orbitOmega:   document.getElementById('infoOrbitOmega'),
      orbitPeriod:  document.getElementById('infoOrbitPeriod'),
      moonSize:     document.getElementById('infoMoonSize'),
    };

    // Composition rollup for full-gas planets: tally bandBiomes weighted by
    // each band's actual surface area on the sphere (sin(latitude) — bands
    // near the equator cover more surface than bands near the poles).
    // Returns rows sorted by surface fraction descending so the dominant
    // biome leads the panel.
    function computeGasComposition(body) {
      const gp = body.gasPaint;
      if (!gp || !gp.bandBiomes) return [];
      const tallies = new Map();
      let total = 0;
      for (let i = 0; i < GAS_BAND_COUNT; i++) {
        const w = Math.sin(((i + 0.5) / GAS_BAND_COUNT) * Math.PI);
        total += w;
        const id = gp.bandBiomes[i];
        tallies.set(id, (tallies.get(id) || 0) + w);
      }
      const rows = [];
      for (const [id, w] of tallies) {
        const biome = gasBiomeById(id);
        if (!biome) continue;
        rows.push({ id, name: biome.name, color: biome.color, frac: total > 0 ? w / total : 0 });
      }
      rows.sort((a, b) => b.frac - a.frac);
      return rows;
    }

    // Fill the Climate section from a fresh climate computation. Stars and gas
    // giants get a mean reading; the equator/poles row is hidden when a body has
    // no meaningful latitude spread (e.g. a star). The bar tints from pole color
    // (left) to equator color (right) for an at-a-glance hot/cold read.
    function renderClimateSection(body) {
      if (!infoEls.climateSection) return;
      const c = computeClimate(body);
      infoEls.climateSection.style.display = '';
      infoEls.tempMean.textContent = fmtTemp(c.meanK);
      infoEls.tempMean.style.color = tempColor(c.meanK);
      if (c.spread > 1) {
        infoEls.tempRangeRow.style.display = '';
        infoEls.tempRange.textContent = `${fmtTemp(c.equatorK)} / ${fmtTemp(c.poleK)}`;
        infoEls.tempBar.style.background =
          `linear-gradient(90deg, ${tempColor(c.poleK)}, ${tempColor(c.meanK)}, ${tempColor(c.equatorK)})`;
        infoEls.tempBar.style.display = '';
      } else {
        infoEls.tempRangeRow.style.display = 'none';
        infoEls.tempBar.style.background = tempColor(c.meanK);
        infoEls.tempBar.style.display = '';
      }
    }

    function updateInfoPanel() {
      if (!infoEls.name) return; // info panel removed from HTML — nothing to update
      if (focusedProbe) {
        // Probes are artificial satellites, not surveyable bodies — show their
        // identity and orbit rather than composition/terrain stats.
        infoEls.name.textContent = focusedProbe.name;
        infoEls.subtitle.textContent = `Probe · seed "${focusedProbe.seed}"`;
        infoEls.composition.innerHTML =
          `<div class="info-row"><span>Artificial satellite</span></div>` +
          `<div class="info-row"><span>Orbiting</span><span>${focusedProbe.parent?.name || '—'}</span></div>` +
          `<div class="info-row"><span>Orbit dist</span><span>${focusedProbe.distance.toFixed(1)} u</span></div>`;
        if (infoEls.gravity) infoEls.gravity.textContent = '—';
        infoEls.peak.textContent = '—';
        infoEls.verts.textContent = '—';
        infoEls.moonsRow.style.display = 'none';
        if (infoEls.climateSection) infoEls.climateSection.style.display = 'none';
        infoEls.timeSection.style.display = 'none';
        infoEls.orbitSection.style.display = 'none';
        return;
      }
      if (!focusedBody) {
        // System view — no specific body in focus.
        infoEls.name.textContent = `${systemName} System`;
        infoEls.subtitle.textContent = `${planets.length} planet${planets.length === 1 ? '' : 's'} · ${moons.length} satellite${moons.length === 1 ? '' : 's'}`;
        infoEls.composition.innerHTML = '<div class="info-row"><span>System overview</span></div>';
        if (infoEls.gravity) infoEls.gravity.textContent = '—';
        infoEls.peak.textContent = '—';
        infoEls.verts.textContent = '—';
        infoEls.moonsRow.style.display = '';
        infoEls.moons.textContent = moons.length;
        if (infoEls.climateSection) infoEls.climateSection.style.display = 'none';
        infoEls.timeSection.style.display = 'none';
        infoEls.orbitSection.style.display = 'none';
        return;
      }
      const body = focusedBody;
      infoEls.name.textContent = body.name;
      const isPlasma = !!(body.matter && body.matter.plasma);
      const seed = body.kind === 'planet'
        ? (body.currentSeed || planetCurrentSeed)
        : (moons.find(m => m.body === body)?.seed || '');
      const kindLabel = isPlasma ? 'Star' : (body.kind === 'planet' ? 'Planet' : 'Moon');
      infoEls.subtitle.textContent = kindLabel + (seed ? ` · seed "${seed}"` : '');

      // Full-gas planets and stars don't have per-vertex biomes; their
      // composition is reported from their own model (gas band LUT / fixed
      // plasma layers). Peak/verts also swap — neither has a terrain peak.
      const isGasFull = !!(body.matter && body.matter.gas === 'full');
      let rows = [];
      let stats = null;
      if (isPlasma) {
        // Fixed photosphere layers, colored from the body's plasma uniforms.
        const pu = body.plasmaMesh && body.plasmaMesh.material.uniforms;
        const hx = c => '#' + c.getHexString();
        const layers = pu ? [
          { name: 'Photosphere',    color: hx(pu.uColorMid.value),  frac: 0.62 },
          { name: 'Granulation',    color: hx(pu.uColorLow.value),  frac: 0.24 },
          { name: 'Bright Faculae', color: hx(pu.uColorHot.value),  frac: 0.09 },
          { name: 'Cool Lanes',     color: hx(pu.uColorDeep.value), frac: 0.05 },
        ] : [];
        rows = layers.map(c =>
          `<div class="comp-row">` +
          `<span class="comp-swatch" style="background:${c.color}"></span>` +
          `<span>${c.name}</span>` +
          `<span class="comp-pct">${(c.frac * 100).toFixed(0)}%</span>` +
          `</div>`
        );
      } else if (isGasFull) {
        const comp = computeGasComposition(body);
        rows = comp.map(c =>
          `<div class="comp-row">` +
          `<span class="comp-swatch" style="background:${hexFromNumber(c.color)}"></span>` +
          `<span>${c.name}</span>` +
          `<span class="comp-pct">${(c.frac * 100).toFixed(0)}%</span>` +
          `</div>`
        );
      } else {
        stats = computeBodyStats(body);
        const order = body.kind === 'planet' ? PLANET_COMP_ORDER : MOON_COMP_ORDER;
        for (const key of order) {
          const count = stats.counts[key] || 0;
          if (count === 0) continue;
          const meta = body.kind === 'planet' && key in BAND_KEY_TO_PALETTE
            ? bandMeta(body, key)
            : COMP_DISPLAY[key];
          rows.push(
            `<div class="comp-row">` +
            `<span class="comp-swatch" style="background:${meta.color}"></span>` +
            `<span>${meta.label}</span>` +
            `<span class="comp-pct">${fmtPct(count, stats.N)}</span>` +
            `</div>`
          );
        }
      }
      infoEls.composition.innerHTML = rows.join('') || '<div class="info-row"><span>—</span></div>';

      if (isGasFull || isPlasma) {
        infoEls.peak.textContent = '—';
        infoEls.verts.textContent = body.N.toLocaleString();
      } else {
        const worldPeak = peakWorldHeight(body, stats.peak);
        const pctOfRadius = stats.peak * BODY_HEIGHT_SCALE * 100;
        infoEls.peak.textContent = `${worldPeak.toFixed(2)} u (${pctOfRadius.toFixed(1)}%)`;
        infoEls.verts.textContent = stats.N.toLocaleString();
      }

      // Surface gravity — meaningful for any planet or moon (stars handled by
      // the probe/plasma readouts elsewhere). Suffix a quick qualitative read.
      if (infoEls.gravity) {
        if (isPlasma) {
          infoEls.gravity.textContent = '—';
        } else {
          const g = surfaceGravityG(body);
          const note = g < 0.5 ? 'low' : (g <= 1.2 ? 'Earth-like' : 'high');
          infoEls.gravity.textContent = `${g.toFixed(2)} g (${note})`;
        }
      }

      renderClimateSection(body);

      const isPlanet = body.kind === 'planet';
      infoEls.moonsRow.style.display = isPlanet ? '' : 'none';
      if (isPlanet) infoEls.moons.textContent = moons.length;
      infoEls.timeSection.style.display = isPlanet ? '' : 'none';
      infoEls.orbitSection.style.display = isPlanet ? 'none' : '';

      updateLiveInfo();
    }

    function updateLiveInfo() {
      if (!infoEls.dayPeriod) return; // info panel removed from HTML
      if (focusedProbe) return; // probe panel has no live day/orbit readouts
      if (!focusedBody) return;
      const body = focusedBody;
      if (body.kind === 'planet') {
        const w = body.rotationSpeed ?? DEFAULT_SPIN;
        const period = w > 1e-6 ? (Math.PI * 2 / w) : Infinity;
        infoEls.dayPeriod.textContent = fmtSeconds(period);
        const twoPi = Math.PI * 2;
        const phase = ((body.group.rotation.y % twoPi) + twoPi) % twoPi / twoPi;
        const hh = Math.floor(phase * 24);
        const mm = Math.floor((phase * 24 - hh) * 60);
        infoEls.dayTime.textContent = `${hh.toString().padStart(2, '0')}:${mm.toString().padStart(2, '0')}`;
      } else {
        const m = moons.find(mn => mn.body === body);
        if (!m) return;
        const speed = m.speed ?? DEFAULT_MOON_SPEED;
        const omega = speed * Math.pow(MOON_REF_DISTANCE / m.distance, 1.5);
        const period = omega > 1e-6 ? (Math.PI * 2 / omega) : Infinity;
        infoEls.orbitDist.textContent = m.distance.toFixed(1) + ' u';
        infoEls.orbitOmega.textContent = omega.toFixed(3) + ' rad/s';
        infoEls.orbitPeriod.textContent = fmtSeconds(period);
        infoEls.moonSize.textContent = (m.size * 2 * body.baseRadius).toFixed(2) + ' u';
      }
    }

    // ====== 24. Random names ======
    // Hand-curated cosmic word bank (mythology + astronomy + Greek letters).
    let systemName = 'Sol';

    const COSMIC_WORDS = {
      greek: ['Alpha','Beta','Gamma','Delta','Epsilon','Zeta','Eta','Theta','Iota','Kappa','Lambda','Mu','Nu','Xi','Omicron','Pi','Rho','Sigma','Tau','Upsilon','Phi','Chi','Psi','Omega'],
      mythos: ['Aether','Apollo','Athena','Cronus','Helios','Hyperion','Selene','Eos','Hekate','Nyx','Erebus','Hades','Poseidon','Ares','Hermes','Triton','Nereus','Thalassa','Gaia','Hestia','Hephaestus','Aurora','Bellona','Ceres','Diana','Faunus','Flora','Freya','Loki','Thor','Odin','Frigg','Tyr','Heimdall','Vali','Vidar','Ymir','Skadi','Bragi','Idun','Mimir','Forseti','Sif'],
      stars: ['Kepler','Hubble','Cassini','Galileo','Webb','Voyager','Pioneer','Sirius','Vega','Rigel','Altair','Procyon','Polaris','Antares','Arcturus','Deneb','Spica','Aldebaran','Capella','Lyra','Cygnus','Orion','Hydra','Draco','Phoenix','Pegasus','Andromeda','Carina','Nebula','Quasar','Pulsar','Cosmos','Nova','Halo','Eon','Helix','Tycho','Brahe'],
      moonish: ['Phobos','Deimos','Charon','Hydra','Nix','Kerberos','Styx','Triton','Nereid','Proteus','Naiad','Despina','Galatea','Larissa','Bianca','Cressida','Desdemona','Juliet','Portia','Rosalind','Belinda','Puck','Miranda','Ariel','Umbriel','Titania','Oberon','Calypso','Telesto','Tethys','Dione','Rhea','Iapetus','Phoebe','Hyperion','Mimas','Enceladus','Pan','Atlas','Prometheus','Pandora','Janus','Epimetheus','Helene','Polydeuces','Methone','Anthe','Pallene','Tarvos','Erriapus','Jarnsaxa','Bebhionn','Skathi','Albiorix','Paaliaq','Siarnaq','Suttungr','Thrymr','Mundilfari','Kari','Fenrir','Aegaeon'],
      designators: ['Prime','Major','Minor','II','III','IV','V','VI','VII','IX','XII','XV','XX'],
    };

    function _pick(arr) { return arr[(Math.random() * arr.length) | 0]; }

    function generateCosmic(kind) {
      const r = Math.random();
      if (kind === 'moon') {
        if (r < 0.6) return _pick(COSMIC_WORDS.moonish);
        if (r < 0.85) return _pick(COSMIC_WORDS.mythos);
        return _pick(COSMIC_WORDS.greek) + ' ' + _pick(COSMIC_WORDS.moonish);
      }
      if (kind === 'system') {
        if (r < 0.4) return _pick(COSMIC_WORDS.stars);
        if (r < 0.7) return _pick(COSMIC_WORDS.greek) + ' ' + _pick(COSMIC_WORDS.stars);
        if (r < 0.9) return _pick(COSMIC_WORDS.mythos) + "'s Reach";
        return _pick(COSMIC_WORDS.stars) + '-' + (100 + ((Math.random() * 900) | 0));
      }
      // planet
      if (r < 0.3) return _pick(COSMIC_WORDS.mythos);
      if (r < 0.55) return _pick(COSMIC_WORDS.stars) + ' ' + _pick(COSMIC_WORDS.designators);
      if (r < 0.75) return _pick(COSMIC_WORDS.greek) + ' ' + _pick(COSMIC_WORDS.mythos);
      if (r < 0.9) return _pick(COSMIC_WORDS.stars) + '-' + (10 + ((Math.random() * 990) | 0));
      return _pick(COSMIC_WORDS.mythos) + ' ' + _pick(COSMIC_WORDS.designators);
    }

    function generateName(kind) {
      return generateCosmic(kind);
    }

    // ====== 25. UI (tabs + sliders) ======
    const tabBtns = document.querySelectorAll('.tab-btn');
    const tabContents = document.querySelectorAll('.tab-content');

    // Resolve currentTool from the active tab plus focus-driven overrides.
    // Centralized so focus changes (which can flip Envir between biome painting
    // and gas-band painting) and tab clicks share a single source of truth.
    function refreshActiveTool() {
      const active = Array.from(tabBtns).find(b => b.classList.contains('active'));
      const tab = active ? active.dataset.tab : '';
      const gasFull = !!(focusedBody && focusedBody.kind === 'planet'
        && focusedBody.matter && focusedBody.matter.gas === 'full');
      if (tab === 'sculpt') currentTool = 'land';
      else if (tab === 'environment') currentTool = gasFull ? gasPaintMode : 'biome';
      else if (tab === 'colonies') currentTool = 'city';
      else if (tab === 'satellites') currentTool = 'none';
      else currentTool = 'none';
      if (!isBrushTool()) {
        brushRing.visible = false;
        if (isPainting) {
          isPainting = false;
          lastHitLocal = null;
          activeBrushBody = null;
          activeVortex = null;
        }
      }
    }

    tabBtns.forEach(btn => {
      btn.onclick = () => {
        tabBtns.forEach(b => b.classList.remove('active'));
        tabContents.forEach(c => c.classList.remove('active'));
        btn.classList.add('active');
        const tab = btn.dataset.tab;
        document.getElementById(`tab-${tab}`).classList.add('active');
        refreshActiveTool();
      };
    });

    const brushRadiusInput   = document.getElementById('brushRadius');
    const brushRadiusVal     = document.getElementById('brushRadiusVal');
    const brushRadiusInputB  = document.getElementById('brushRadiusB');
    const brushRadiusValB    = document.getElementById('brushRadiusValB');
    
    const brushStrengthInput = document.getElementById('brushStrength');
    const brushStrengthVal   = document.getElementById('brushStrengthVal');
    
    const sculptRaiseBtn     = document.getElementById('sculptRaise');
    const sculptLowerBtn     = document.getElementById('sculptLower');
    
    const pauseRotInput      = document.getElementById('pauseRot');
    const moonsListEl        = document.getElementById('moonsList');
    const addMoonBtn         = document.getElementById('addMoon');
    const probesListEl       = document.getElementById('probesList');
    const addProbeBtn        = document.getElementById('addProbe');
    const seedInput          = document.getElementById('seedInput');
    const genAmpInput        = document.getElementById('genAmp');
    const genAmpVal          = document.getElementById('genAmpVal');
    const genSeaInput        = document.getElementById('genSea');
    const genSeaVal          = document.getElementById('genSeaVal');
    const regenBtn           = document.getElementById('regenBtn');
    const randomSeedBtn      = document.getElementById('randomSeedBtn');
    const focusPlanetBtn     = document.getElementById('focusPlanet');
    const focusNameEl        = document.getElementById('focusName');

    const satellitesContext  = document.getElementById('satellitesContext');
    const archetypeSelect    = document.getElementById('archetypeSelect');

    archetypeSelect.onchange = () => {
      currentArchetype = archetypeSelect.value;
      const arch = ARCHETYPES[currentArchetype];
      if (arch) {
        genAmpInput.value = arch.amp * 10;
        genSeaInput.value = arch.sea * 100;
        syncGenLabels();
        regenBtn.click();
        updateBiomeTools();
      }
    };

    // Rebuild the Environment tab's biome <select> for the focused body. Moons
    // and planets have different palettes; archetype also restricts the menu
    // (e.g. desert planets get desert + tundra only). Call after any focus change.
    function updateBiomeTools() {
      const select = document.getElementById('biomeSelect');
      const hint = document.getElementById('biomeHint');
      select.innerHTML = '<option value="0">Natural State</option>';

      // Moons get a deliberately tiny biome palette — focus drives the choice.
      if (focusedBody && focusedBody.kind === 'moon') {
        MOON_BIOME_OPTIONS.forEach(opt => {
          const el = document.createElement('option');
          el.value = opt.v;
          el.textContent = opt.n;
          select.appendChild(el);
        });
        if (hint) hint.textContent = `Lunar palette · painting on ${focusedBody.name}`;
        select.value = 0;
        selectedBiome = 0;
        return;
      }

      const options = {
        terrestrial: [
          {v: 1, n: 'Forest'}, {v: 2, n: 'Desert'}, {v: 4, n: 'Tundra'}
        ],
        ocean: [
          {v: 11, n: 'Coral Reef'}, {v: 12, n: 'Kelp Forest'}, {v: 13, n: 'Abyssal Trench'}
        ],
        lava: [
          {v: 5, n: 'Obsidian'}, {v: 6, n: 'Magma Flow'}, {v: 14, n: 'Sulfur Vent'}
        ],
        desert: [
          {v: 15, n: 'Oasis'}, {v: 16, n: 'Ancient Ruins'}, {v: 17, n: 'Red Sand'}
        ],
        ice_planet: [
          {v: 18, n: 'Glacier'}, {v: 19, n: 'Cryo-Volcano'}, {v: 20, n: 'Blue Ice'}
        ],
        jungle: [
          {v: 21, n: 'Exotic Bloom'}, {v: 22, n: 'River Path'}, {v: 23, n: 'Dense Canopy'}
        ],
        moon_like: [
          {v: BIOME.MARE, n: 'Mare'}, {v: BIOME.REGOLITH, n: 'Regolith'}, {v: BIOME.FROST, n: 'Frost'}
        ],
        toxic: [
          {v: 9, n: 'Acid Sludge'}, {v: 10, n: 'Mutation Bloom'}, {v: 25, n: 'Gas Vent'}
        ],
        metal: [
          {v: 26, n: 'Rust Belt'}, {v: 27, n: 'Gold Vein'}, {v: 28, n: 'Chrome Flat'}
        ],
        living: [
          {v: 29, n: 'Neural Path'}, {v: 30, n: 'Pulsing Organ'}, {v: 31, n: 'Tendon'}
        ],
        storm: [
          {v: 32, n: 'Lightning Scar'}, {v: 33, n: 'Cyclone Eye'}, {v: 34, n: 'Vortex'}
        ],
        venusian: [
          {v: 35, n: 'Sulfur Cloud'}, {v: 36, n: 'Volcanic Plain'}, {v: 37, n: 'Greenhouse Haze'}
        ]
      };

      // Read archetype from the focused planet, not the global UI state — the
      // user expects the biome list to reflect the body they're painting on
      // (e.g. focusing a desert planet should hide Forest/Tundra entirely).
      const archKey = (focusedBody && focusedBody.kind === 'planet')
        ? (focusedBody.archetype || 'terrestrial')
        : currentArchetype;
      // No fallback to terrestrial: archetypes without a dedicated biome list
      // get only Natural State, which is more honest than showing wrong biomes.
      const archOptions = options[archKey] || [];
      archOptions.forEach(opt => {
        const el = document.createElement('option');
        el.value = opt.v;
        el.textContent = opt.n;
        select.appendChild(el);
      });

      if (hint) {
        const archName = (ARCHETYPES[archKey] && ARCHETYPES[archKey].name) || 'Surface';
        const bodyName = focusedBody && focusedBody.kind === 'planet' ? focusedBody.name : 'planet';
        hint.textContent = archOptions.length
          ? `${archName} palette · painting on ${bodyName}`
          : `${archName} · no surface biomes available`;
      }

      select.value = 0;
      selectedBiome = 0;
    }
    const cityNameInput      = document.getElementById('cityNameInput');

    randomSeedBtn.onclick = () => {
      const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
      let newSeed = '';
      for(let i=0; i<8; i++) newSeed += chars.charAt(Math.floor(Math.random() * chars.length));
      seedInput.value = newSeed;
      // Automatically trigger regen for better UX
      regenBtn.click();
    };

    function syncBrushRadius(val) {
      brushRadius = sliderToBrushRadius(val);
      brushRadiusInput.value = val;
      brushRadiusInputB.value = val;
      brushRadiusVal.textContent = brushRadius.toFixed(2);
      brushRadiusValB.textContent = brushRadius.toFixed(2);
    }

    brushRadiusInput.oninput = () => syncBrushRadius(parseInt(brushRadiusInput.value, 10));
    brushRadiusInputB.oninput = () => syncBrushRadius(parseInt(brushRadiusInputB.value, 10));

    brushStrengthInput.oninput = () => {
      brushStrength = sliderToBrushStrength(parseInt(brushStrengthInput.value, 10));
      brushStrengthVal.textContent = brushStrength.toFixed(1);
    };

    sculptRaiseBtn.onclick = () => {
      brushRaise = true;
      sculptRaiseBtn.classList.add('active');
      sculptLowerBtn.classList.remove('active');
    };
    sculptLowerBtn.onclick = () => {
      brushRaise = false;
      sculptRaiseBtn.classList.remove('active');
      sculptLowerBtn.classList.add('active');
    };

    pauseRotInput.onchange = () => { paused = pauseRotInput.checked; };

    const showOrbitsInput = document.getElementById('showOrbits');
    orbitLinesGroup.visible = showOrbitsInput.checked;
    showOrbitsInput.onchange = () => {
      orbitLinesGroup.visible = showOrbitsInput.checked;
    };
    biomeSelect.onchange = () => {
      selectedBiome = parseInt(biomeSelect.value, 10);
    };

    // Composition dropdown: drives gasPaintColor for the Bands brush and the
    // biome tag written into bandBiomes during a stroke. The options are
    // filtered to the focused planet's archetype palette by
    // refreshGasBiomeOptions, called from applyFocusToLeftPanel.
    const gasBiomeSelectEl = document.getElementById('gasBiomeSelect');
    function applyGasBiome() {
      if (!gasBiomeSelectEl) return;
      const biome = gasBiomeById(gasBiomeSelectEl.value) || GAS_BIOMES[0];
      gasPaintColor.setHex(biome.color);
      selectedGasBiomeId = biome.id;
    }
    function refreshGasBiomeOptions(arch) {
      if (!gasBiomeSelectEl) return;
      const palette = gasBiomesForArchetype(arch);
      const prev = gasBiomeSelectEl.value;
      gasBiomeSelectEl.innerHTML = '';
      palette.forEach((biome) => {
        const opt = document.createElement('option');
        opt.value = biome.id;
        opt.textContent = biome.name;
        gasBiomeSelectEl.appendChild(opt);
      });
      // Preserve the previous selection if the new palette still contains it
      // (switching between two gas giants shouldn't reset the dropdown).
      if (palette.some(b => b.id === prev)) gasBiomeSelectEl.value = prev;
      applyGasBiome();
    }
    if (gasBiomeSelectEl) {
      gasBiomeSelectEl.onchange = applyGasBiome;
      // Seed with gas_giant palette so gasPaintColor / selectedGasBiomeId have
      // sensible defaults before any focus change has fired.
      refreshGasBiomeOptions('gas_giant');
    }

    // Bands vs. Whirlpool mode toggle. Bands = drag-paint band LUT;
    // Whirlpool = press-and-hold to wrap surrounding bands into a vortex.
    // refreshActiveTool resolves the actual tool name from this state + the
    // focused body. The Composition (biome) row only applies to Bands, so we
    // hide it in Whirlpool mode.
    const gasModeBandsBtn = document.getElementById('gasModeBands');
    const gasModeStampBtn = document.getElementById('gasModeStamp');
    const gasBiomeRowEl   = document.getElementById('gasBiomeRow');
    function setGasPaintMode(mode) {
      gasPaintMode = mode;
      if (gasModeBandsBtn) gasModeBandsBtn.classList.toggle('active', mode === 'gasband');
      if (gasModeStampBtn) gasModeStampBtn.classList.toggle('active', mode === 'gaswhirl');
      if (gasBiomeRowEl)   gasBiomeRowEl.style.display = mode === 'gasband' ? '' : 'none';
      refreshActiveTool();
    }
    if (gasModeBandsBtn) gasModeBandsBtn.onclick = () => setGasPaintMode('gasband');
    if (gasModeStampBtn) gasModeStampBtn.onclick = () => setGasPaintMode('gaswhirl');

    // Randomize: clear whirlpools + re-roll the band LUT with a fresh salt.
    // Different result every click; the user can keep rerolling until a
    // composition they like comes up.
    const gasRandomizeBtn = document.getElementById('gasRandomize');
    if (gasRandomizeBtn) gasRandomizeBtn.onclick = () => {
      if (!focusedBody || !focusedBody.matter || focusedBody.matter.gas !== 'full') return;
      clearGasFeatures(focusedBody);
      const salt = Math.random().toString(36).slice(2, 8);
      randomizeGasBands(focusedBody, (focusedBody.currentSeed || focusedBody.name || 'gas') + ':' + salt);
      updateInfoPanel();
    };

    // ====== 26. Atmosphere sliders ======
    const atmoThickInput      = document.getElementById('atmoThick');
    const atmoThickValEl      = document.getElementById('atmoThickVal');
    const atmoDensityInput    = document.getElementById('atmoDensity');
    const atmoDensityValEl    = document.getElementById('atmoDensityVal');
    const atmoCoverageInput   = document.getElementById('atmoCoverage');
    const atmoCoverageValEl   = document.getElementById('atmoCoverageVal');
    const atmoComplexWindsInput = document.getElementById('atmoComplexWinds');
    const atmoCloudDriftInput   = document.getElementById('atmoCloudDrift');
    const atmoCloudDriftValEl   = document.getElementById('atmoCloudDriftVal');
    const atmoHintEl          = document.getElementById('atmoHint');

    // Whoever is in focus when the slider moves is the body that gets edited.
    // No focus, or focus on a body without gas, means the change is a no-op.
    function applyAtmoSliderToFocus() {
      const b = focusedBody;
      if (!b || !b.gasMesh || !b.matter || !b.matter.gas) return;
      b.gasThickness = parseInt(atmoThickInput.value, 10) / 100;       // 1.00..1.40
      b.gasDensity   = parseInt(atmoDensityInput.value, 10) / 100;     // 0.00..1.00
      b.gasCoverage  = parseInt(atmoCoverageInput.value, 10) / 100;    // 0.00..1.00
      applyGasShell(b);
      atmoThickValEl.textContent    = b.gasThickness.toFixed(2);
      atmoDensityValEl.textContent  = b.gasDensity.toFixed(2);
      atmoCoverageValEl.textContent = b.gasCoverage.toFixed(2);
      // A denser/thicker atmosphere warms the surface and evens out the poles —
      // reflect that in the climate readout as the sliders move.
      renderClimateSection(b);
    }
    atmoThickInput.oninput    = applyAtmoSliderToFocus;
    atmoDensityInput.oninput  = applyAtmoSliderToFocus;
    atmoCoverageInput.oninput = applyAtmoSliderToFocus;
    // Size/density change the greenhouse warming and pole-to-equator evening, so
    // repaint the ice on release. (Coverage is cloud cover only — no climate
    // effect — but recoloring on its release too is harmless and keeps it simple.)
    atmoThickInput.onchange   = () => { refreshClimateColoring(focusedBody); updateInfoPanel(); };
    atmoDensityInput.onchange = () => { refreshClimateColoring(focusedBody); updateInfoPanel(); };

    // Per-body realism toggles for the cloud layer.
    //   atmoComplexWinds → flips the shader's uWindMode, swapping uniform
    //     zonal drift for latitude-banded flow (Hadley/Ferrel/Polar).
    //   atmoCloudDrift   → body.coverageVariance (0..1). The animation
    //     loop modulates uCoverage around the slider's base value at this
    //     amplitude, so total cloud cover slowly waxes and wanes.
    atmoComplexWindsInput.onchange = () => {
      const b = focusedBody;
      if (!b || !b.gasMesh || !b.matter || !b.matter.gas) return;
      b.windMode = !!atmoComplexWindsInput.checked;
      b.gasMesh.material.uniforms.uWindMode.value = b.windMode ? 1.0 : 0.0;
    };
    atmoCloudDriftInput.oninput = () => {
      const b = focusedBody;
      const v = parseInt(atmoCloudDriftInput.value, 10) / 100; // 0..1
      atmoCloudDriftValEl.textContent = v.toFixed(2);
      if (!b || !b.gasMesh || !b.matter || !b.matter.gas) return;
      b.coverageVariance = v;
      // If drift just turned off, snap the uniform back to the base value
      // so the cloud field stops mid-cycle instead of freezing wherever
      // it happened to be in its sine wave.
      if (v === 0) b.gasMesh.material.uniforms.uCoverage.value = b.gasCoverage ?? 0.35;
    };

    // ====== 27. Ring controls ======
    const ringsEnabledInput   = document.getElementById('ringsEnabled');
    const ringsIntensityInput = document.getElementById('ringsIntensity');
    const ringsIntensityValEl = document.getElementById('ringsIntensityVal');
    const ringsHintEl         = document.getElementById('ringsHint');

    function applyRingsSliderToFocus() {
      const b = focusedBody;
      if (!b || !b.ringMesh || b.kind !== 'planet') return;
      b.rings.enabled   = !!ringsEnabledInput.checked;
      b.rings.intensity = parseInt(ringsIntensityInput.value, 10) / 100;
      ringsIntensityValEl.textContent = b.rings.intensity.toFixed(2);
      applyRingsToBody(b);
      // Toggling enable flips whether the intensity row is greyed; re-sync.
      syncRingsToFocus();
    }
    ringsEnabledInput.onchange   = applyRingsSliderToFocus;
    ringsIntensityInput.oninput  = applyRingsSliderToFocus;

    regenBtn.onclick = () => {
      // Regenerate operates on the focused body (planet or moon). The archetype
      // global only changes palette for planets — moons keep MOON_PALETTE.
      const target = focusedBody && (focusedBody.kind === 'planet' || focusedBody.kind === 'moon')
        ? focusedBody : planet;
      const seed = seedInput.value || 'planet';
      const amp = sliderToAmplitude(parseInt(genAmpInput.value, 10));
      const sea = sliderToSeaCoverage(parseInt(genSeaInput.value, 10));
      regenerateBody(target, seed, amp, sea);
      target.currentSeed = seed;
      target.currentAmp = amp;
      target.currentSea = sea;
      if (target.kind === 'planet') target.archetype = currentArchetype;
      if (target === planet) planetCurrentSeed = seed;
      const moonEntry = moons.find(m => m.body === target);
      if (moonEntry) moonEntry.seed = seed;
      // Matter may have changed (e.g. desert→terrestrial gained an ocean and
      // atmosphere; or terrestrial→gas_giant dropped the solid surface) —
      // re-sync the atmo sliders and the panel layout so the Sculpt tab and
      // biome / band-color rows match the new state.
      if (typeof syncAtmoSlidersToFocus === 'function') syncAtmoSlidersToFocus();
      if (typeof applyFocusToLeftPanel === 'function') applyFocusToLeftPanel();
      updateInfoPanel();
    };

    // Initialize values
    syncBrushRadius(parseInt(brushRadiusInput.value, 10));
    brushStrength = sliderToBrushStrength(parseInt(brushStrengthInput.value, 10));
    brushStrengthVal.textContent = brushStrength.toFixed(1);

    function sliderToBrushRadius(v) { return v / 100; }
    function sliderToBrushStrength(v) { return v / 10; }
    function sliderToAmplitude(v) { return v / 10; }
    function sliderToSeaCoverage(v) { return v / 100; }

    function syncGenLabels() {
      genAmpVal.textContent = sliderToAmplitude(parseInt(genAmpInput.value, 10)).toFixed(1);
      genSeaVal.textContent = genSeaInput.value + '%';
    }
    genAmpInput.oninput = syncGenLabels;
    genSeaInput.oninput = syncGenLabels;
    syncGenLabels();

    // ====== 28. Context-aware left panel ======
    // Each tab points at the focused entity; sliders, regen, deploy buttons all
    // operate on the focused body. When focus changes we (1) refresh the slider
    // values from the focused entity's state and (2) disable sections that can't
    // act on the current focus (e.g. archetype select when a moon is focused).

    const classifyContextEl  = document.getElementById('classifyContext');
    const systemContextEl    = document.getElementById('systemContext');
    const archetypeHeaderEl  = document.getElementById('archetypeHeader');
    const classifyArchSection = archetypeSelect.closest('label');
    const classifyGenLabels  = [genAmpInput.closest('label'), genSeaInput.closest('label')];
    const rosterHintEl       = document.getElementById('rosterHint');
    const rosterSectionEl    = document.getElementById('rosterSection');
    const planetListEl       = document.getElementById('planetList');
    const deployPlanetBtn    = document.getElementById('deployPlanetBtn');
    const bodyOrbitSectionEl = document.getElementById('bodyOrbitSection');
    const bodyOrbitHeaderEl  = document.getElementById('bodyOrbitHeader');
    const bodyDistInput      = document.getElementById('bodyDistInput');
    const bodyDistVal        = document.getElementById('bodyDistVal');
    const bodySpeedRow       = document.getElementById('bodySpeedRow');
    const bodySpeedInput     = document.getElementById('bodySpeedInput');
    const bodySpeedVal       = document.getElementById('bodySpeedVal');
    const bodySpinRow        = document.getElementById('bodySpinRow');
    const bodySpinInput      = document.getElementById('bodySpinInput');
    const bodySpinVal        = document.getElementById('bodySpinVal');
    const bodyMoonSpeedRow   = document.getElementById('bodyMoonSpeedRow');
    const bodyMoonSpeedInput = document.getElementById('bodyMoonSpeedInput');
    const bodyMoonSpeedVal   = document.getElementById('bodyMoonSpeedVal');
    const bodySizeInput      = document.getElementById('bodySizeInput');
    const bodySizeVal        = document.getElementById('bodySizeVal');
    const satelliteOrbitPlaneSection = document.getElementById('satelliteOrbitPlaneSection');
    const bodyInclInput      = document.getElementById('bodyInclInput');
    const bodyInclVal        = document.getElementById('bodyInclVal');
    const bodyNodeInput      = document.getElementById('bodyNodeInput');
    const bodyNodeVal        = document.getElementById('bodyNodeVal');
    const bodyRetrogradeInput= document.getElementById('bodyRetrogradeInput');
    const showSatelliteOrbitsInput = document.getElementById('showSatelliteOrbits');
    const showSatelliteOrbitsRow   = document.getElementById('showSatelliteOrbitsRow');
    const satellitesSectionEl= document.getElementById('satellitesSection');
    const atmoSectionEl      = document.getElementById('atmoSection');
    const ringsSectionEl     = document.getElementById('ringsSection');

    // Range mapping. Different ranges for planets vs moons so the slider feels
    // sensible at either scale.
    const PLANET_DIST = { sliderMin: 120, sliderMax: 900, scale: 1 };
    const MOON_DIST   = { sliderMin: 5,   sliderMax: 60,  scale: 1 };
    const PLANET_SIZE = { sliderMin: 3,   sliderMax: 30,  div: 10 };  // scale 0.3..3.0
    const MOON_SIZE   = { sliderMin: 2,   sliderMax: 40,  div: 10 };  // scale 0.2..4.0
    const PLANET_SPEED= { sliderMin: 1,   sliderMax: 40,  div: 100 }; // 0.01..0.40 rad/s
    // Spin slider 0..100 maps linearly: w = (v / 3000) * 2π → 0..~0.21 rad/s.
    const PLANET_SPIN = { sliderMin: 0,   sliderMax: 100, div: 3000 };
    const spinSliderToRad = v => (v / PLANET_SPIN.div) * Math.PI * 2;
    const spinRadToSlider = w => Math.round((w / (Math.PI * 2)) * PLANET_SPIN.div);
    // Moon-speed slider uses the same mapping that used to drive the global
    // moon-speed knob, only now per-moon.
    const MOON_SPEED_DIV = 3000;
    const moonSliderToSpeed = v => (v / MOON_SPEED_DIV) * Math.PI * 2;
    const moonSpeedToSlider = s => Math.round((s / (Math.PI * 2)) * MOON_SPEED_DIV);

    function setRange(input, min, max) {
      input.min = String(min); input.max = String(max);
    }

    function normDeg(rad) {
      return ((rad * 180 / Math.PI) % 360 + 360) % 360;
    }

    function getFocusedSatellite() {
      if (focusedProbe) return focusedProbe;
      if (focusedBody?.kind === 'moon') {
        return moons.find(mn => mn.body === focusedBody) || null;
      }
      return null;
    }

    function syncSatelliteOrbitPlaneUI(sat) {
      if (!sat || !bodyInclInput) return;
      bodyInclInput.value = String(Math.round(Math.abs(sat.inclination) / ORBIT_DEG));
      bodyInclVal.textContent = `${bodyInclInput.value}°`;
      bodyNodeInput.value = String(Math.round(normDeg(sat.node)));
      bodyNodeVal.textContent = `${bodyNodeInput.value}°`;
      if (bodyRetrogradeInput) bodyRetrogradeInput.checked = (sat.speedSign ?? 1) < 0;
    }

    function applyFocusedSatelliteOrbitPlane() {
      const sat = getFocusedSatellite();
      if (!sat || !bodyInclInput) return;
      applySatelliteOrbitPlane(
        sat,
        parseInt(bodyInclInput.value, 10) * ORBIT_DEG,
        parseInt(bodyNodeInput.value, 10) * ORBIT_DEG,
        bodyRetrogradeInput?.checked ? -1 : 1,
      );
      if (sat.body) updateMoonPosition(sat);
      else updateProbePosition(sat);
    }

    // Show/hide tabs and sections in the left panel for the current focus.
    // Driven by each tab button's `data-focus` attribute in index.html: a tab
    // is visible only if its data-focus list includes the current kind
    // ('planet' | 'moon' | 'system'). The big function below this one is the
    // heart of context-aware UI — every focus change runs it.
    function applyFocusToLeftPanel() {
      const isProbe  = !!focusedProbe;
      const isPlanet = !isProbe && focusedBody && focusedBody.kind === 'planet';
      const isMoon   = !isProbe && focusedBody && focusedBody.kind === 'moon';
      const isSystem = !focusedBody && !focusedCity && !focusedProbe;
      // Full-gas planets have no solid surface, so the Sculpt tab and the
      // biome dropdown both disappear; the Envir tab swaps to atmospheric
      // band painting.
      const isGasFull = !!(isPlanet && focusedBody.matter && focusedBody.matter.gas === 'full');
      // Cities anchor their controls to the host body — re-use the planet/moon
      // layout for the body they belong to.
      const focusKind = isProbe  ? 'probe'
                      : isPlanet ? 'planet'
                      : isMoon   ? 'moon'
                      : focusedCity ? (focusedCity.body.kind === 'moon' ? 'moon' : 'planet')
                      : 'system';

      // --- Tab visibility (driven by data-focus on each tab button) ---
      // Each tab button declares which focus kinds it's relevant to. Hidden
      // tabs are stripped from layout entirely so the menu feels purpose-built
      // for the focused element instead of a static 5-tab grid with dimmed
      // sections. Belt-and-braces: class + inline style + disabled, because a
      // single CSS rule can be defeated by browser cache or theme overrides.
      let firstVisibleTab = null;
      let activeStillVisible = false;
      tabBtns.forEach(btn => {
        const allowed = (btn.dataset.focus || '').split(/\s+/);
        let visible = allowed.includes(focusKind);
        // Sculpt makes no sense on full-gas planets — there's no solid surface
        // to displace. The Envir tab survives because it owns atmosphere + rings
        // and the band-paint controls.
        if (visible && isGasFull && btn.dataset.tab === 'sculpt') visible = false;
        btn.classList.toggle('is-hidden', !visible);
        btn.style.display = visible ? '' : 'none';
        btn.disabled = !visible;
        // Also hide the matching tab-content so an old `.active` from a
        // previous focus can't keep panels showing through.
        const content = document.getElementById(`tab-${btn.dataset.tab}`);
        if (content && !visible) content.classList.remove('active');
        if (visible) {
          if (!firstVisibleTab) firstVisibleTab = btn;
          if (btn.classList.contains('active')) activeStillVisible = true;
        }
      });
      // Envir tab: swap biome row for the gas-paint section on full-gas planets.
      const biomeRowEl = document.getElementById('biomeRow');
      const gasPaintSectionEl = document.getElementById('gasPaintSection');
      if (biomeRowEl)        biomeRowEl.style.display        = isGasFull ? 'none' : '';
      if (gasPaintSectionEl) gasPaintSectionEl.style.display = isGasFull ? '' : 'none';
      // The Composition dropdown is filtered to the focused planet's flavour
      // (gas giant = brown→beige; ice giant = blue→white).
      if (isGasFull && typeof refreshGasBiomeOptions === 'function') {
        refreshGasBiomeOptions(focusedBody.archetype || 'gas_giant');
      }
      // If the active tab got hidden by the new focus, switch to System
      // (always visible) or whichever visible tab comes first.
      if (!activeStillVisible && firstVisibleTab) {
        const systemBtn = Array.from(tabBtns).find(b => b.dataset.tab === 'system' && b.style.display !== 'none');
        (systemBtn || firstVisibleTab).click();
      }

      // --- Classify tab (planet only) ---
      if (isPlanet) {
        classifyContextEl.textContent = `Editing: ${focusedBody.name}`;
        archetypeSelect.value = focusedBody.archetype || 'terrestrial';
        currentArchetype = focusedBody.archetype || 'terrestrial';
        seedInput.value = focusedBody.currentSeed || planetCurrentSeed || '';
        genAmpInput.value = Math.round((focusedBody.currentAmp ?? 2.0) * 10);
        genSeaInput.value = Math.round((focusedBody.currentSea ?? 0.55) * 100);
        syncGenLabels();
        classifyArchSection.classList.remove('is-disabled-section');
        classifyGenLabels.forEach(l => l && l.classList.remove('is-disabled-section'));
        regenBtn.disabled = false;
      }

      // --- Satellites tab ---
      if (isPlanet) {
        satellitesContext.textContent = `Editing: ${focusedBody.name}`;
      } else if (isProbe && focusedProbe.parent) {
        satellitesContext.textContent = `Editing: ${focusedProbe.parent.name}`;
      }

      // --- System tab ---
      // Section visibility:
      //   roster        ↔ system focus
      //   bodyOrbit     ↔ planet | moon focus
      //   bodyMoonSpeed ↔ moon focus
      rosterSectionEl.classList.toggle('is-hidden-section', !isSystem);
      bodyOrbitSectionEl.classList.toggle('is-hidden-section', !(isPlanet || isMoon || isProbe));
      if (satelliteOrbitPlaneSection) {
        satelliteOrbitPlaneSection.style.display = (isMoon || isProbe) ? '' : 'none';
      }

      if (isSystem) {
        systemContextEl.textContent = `Editing: ${systemName} System`;
        rosterHintEl.textContent = `${planets.length} planet${planets.length === 1 ? '' : 's'} in system · keep ≥ 1`;
        renderPlanetList();
      } else if (isPlanet) {
        systemContextEl.textContent = `Editing: ${focusedBody.name}`;
        const entry = planets.find(p => p.body === focusedBody);
        bodyOrbitHeaderEl.textContent = 'Orbit (around star)';
        setRange(bodyDistInput, PLANET_DIST.sliderMin, PLANET_DIST.sliderMax);
        setRange(bodySizeInput, PLANET_SIZE.sliderMin, PLANET_SIZE.sliderMax);
        setRange(bodySpeedInput, PLANET_SPEED.sliderMin, PLANET_SPEED.sliderMax);
        setRange(bodySpinInput, PLANET_SPIN.sliderMin, PLANET_SPIN.sliderMax);
        bodySpeedRow.style.display = '';
        bodySpinRow.style.display = '';
        bodyMoonSpeedRow.style.display = 'none';
        if (entry) {
          bodyDistInput.value = Math.round(entry.orbit.distance);
          bodyDistVal.textContent = entry.orbit.distance.toFixed(0);
          bodySpeedInput.value = Math.max(1, Math.round(entry.orbit.speed * 100));
          bodySpeedVal.textContent = entry.orbit.speed.toFixed(2);
        }
        const spin = focusedBody.rotationSpeed ?? DEFAULT_SPIN;
        bodySpinInput.value = spinRadToSlider(spin);
        bodySpinVal.textContent = spin.toFixed(2);
        bodySizeInput.value = Math.round(focusedBody.group.scale.x * PLANET_SIZE.div);
        bodySizeVal.textContent = focusedBody.group.scale.x.toFixed(2);
        bodyOrbitSectionEl.classList.remove('is-disabled-section');
      } else if (isProbe) {
        systemContextEl.textContent = `Editing: ${focusedProbe.name}`;
        bodyOrbitHeaderEl.textContent = `Orbit (around ${focusedProbe.parent?.name || 'parent'})`;
        setRange(bodyDistInput, MOON_DIST.sliderMin, MOON_DIST.sliderMax);
        setRange(bodySizeInput, MOON_SIZE.sliderMin, MOON_SIZE.sliderMax);
        bodySpeedRow.style.display = 'none';
        bodySpinRow.style.display = 'none';
        bodyMoonSpeedRow.style.display = '';
        bodyDistInput.value = Math.round(focusedProbe.distance);
        bodyDistVal.textContent = focusedProbe.distance.toFixed(0);
        bodySizeInput.value = Math.round(focusedProbe.size * MOON_SIZE.div);
        bodySizeVal.textContent = focusedProbe.size.toFixed(2);
        const pSlider = moonSpeedToSlider(focusedProbe.speed ?? DEFAULT_PROBE_SPEED);
        bodyMoonSpeedInput.value = Math.max(1, Math.min(100, pSlider));
        bodyMoonSpeedVal.textContent = String(bodyMoonSpeedInput.value);
        syncSatelliteOrbitPlaneUI(focusedProbe);
        bodyOrbitSectionEl.classList.remove('is-disabled-section');
      } else if (isMoon) {
        systemContextEl.textContent = `Editing: ${focusedBody.name}`;
        const m = moons.find(mn => mn.body === focusedBody);
        bodyOrbitHeaderEl.textContent = `Orbit (around ${m?.parent?.name || 'parent'})`;
        setRange(bodyDistInput, MOON_DIST.sliderMin, MOON_DIST.sliderMax);
        setRange(bodySizeInput, MOON_SIZE.sliderMin, MOON_SIZE.sliderMax);
        bodySpeedRow.style.display = 'none';
        bodySpinRow.style.display = 'none';
        bodyMoonSpeedRow.style.display = '';
        if (m) {
          bodyDistInput.value = Math.round(m.distance);
          bodyDistVal.textContent = m.distance.toFixed(0);
          bodySizeInput.value = Math.round(m.size * MOON_SIZE.div);
          bodySizeVal.textContent = m.size.toFixed(2);
          const slider = moonSpeedToSlider(m.speed ?? DEFAULT_MOON_SPEED);
          bodyMoonSpeedInput.value = Math.max(1, Math.min(100, slider));
          bodyMoonSpeedVal.textContent = String(bodyMoonSpeedInput.value);
          syncSatelliteOrbitPlaneUI(m);
        }
        bodyOrbitSectionEl.classList.remove('is-disabled-section');
      } else {
        // City focus — show host body controls instead of disabling everything.
        systemContextEl.textContent = focusedCity ? `Editing: ${focusedCity.name} (city)` : 'No body focused';
      }

      // --- Environment tab: hide atmo + rings entirely for moons (not just
      //     disabled), since they're conceptually planet-only.
      atmoSectionEl.classList.toggle('is-hidden-section', !isPlanet);
      ringsSectionEl.classList.toggle('is-hidden-section', !isPlanet);
      syncAtmoSlidersToFocus();
      syncRingsToFocus();
      // On full-gas planets the Envir tab paints atmospheric bands instead of
      // biomes, so the hint and the active tool flip accordingly. updateBiomeTools
      // (called elsewhere on focus changes) rewrites this hint for solid bodies.
      if (isGasFull) {
        const hint = document.getElementById('biomeHint');
        if (hint) hint.textContent = `Atmospheric bands · painting on ${focusedBody.name}`;
      }
      refreshActiveTool();
    }
    // Mirror focused body's gas state into the atmo sliders + hint. If the
    // focused body has no gas (or isn't a planet), gray out the controls and
    // explain why so the panel doesn't look broken.
    function syncAtmoSlidersToFocus() {
      const b = focusedBody;
      const hasGas = !!(b && b.matter && b.matter.gas);
      // Coverage controls the cloud-pattern threshold, which only applies to
      // atmosphere mode — gas-giant bodies have no separate cloud layer.
      const coverageApplies = hasGas && b.matter.gas !== 'full';
      const atmoThickRow    = atmoThickInput.closest('label');
      const atmoDensityRow  = atmoDensityInput.closest('label');
      const atmoCoverageRow = atmoCoverageInput.closest('label');
      atmoThickInput.disabled    = !hasGas;
      atmoDensityInput.disabled  = !hasGas;
      atmoCoverageInput.disabled = !coverageApplies;
      // Wind & drift only meaningful on atmosphere-mode bodies — gas-giant
      // mode draws bands directly into the gas color, no separate cloud layer.
      atmoComplexWindsInput.disabled = !coverageApplies;
      atmoCloudDriftInput.disabled   = !coverageApplies;
      const atmoComplexWindsRow = atmoComplexWindsInput.closest('label');
      const atmoCloudDriftRow   = atmoCloudDriftInput.closest('label');
      if (atmoThickRow)    atmoThickRow.classList.toggle('is-disabled-section', !hasGas);
      if (atmoDensityRow)  atmoDensityRow.classList.toggle('is-disabled-section', !hasGas);
      if (atmoCoverageRow) atmoCoverageRow.classList.toggle('is-disabled-section', !coverageApplies);
      if (atmoComplexWindsRow) atmoComplexWindsRow.classList.toggle('is-disabled-section', !coverageApplies);
      if (atmoCloudDriftRow)   atmoCloudDriftRow.classList.toggle('is-disabled-section', !coverageApplies);
      if (hasGas) {
        const t = b.gasThickness ?? 1.10;
        const d = b.gasDensity ?? 0.20;
        const c = b.gasCoverage ?? 0.35;
        const cw = !!b.windMode;
        const cd = b.coverageVariance ?? 0;
        atmoThickInput.value      = Math.round(t * 100);
        atmoDensityInput.value    = Math.round(d * 100);
        atmoCoverageInput.value   = Math.round(c * 100);
        atmoComplexWindsInput.checked = cw;
        atmoCloudDriftInput.value     = Math.round(cd * 100);
        atmoThickValEl.textContent    = t.toFixed(2);
        atmoDensityValEl.textContent  = d.toFixed(2);
        atmoCoverageValEl.textContent = coverageApplies ? c.toFixed(2) : '—';
        atmoCloudDriftValEl.textContent = coverageApplies ? cd.toFixed(2) : '—';
        atmoHintEl.textContent = b.matter.gas === 'full'
          ? `Gaseous body · adjust size and density`
          : `Atmosphere wrapping ${b.name}`;
      } else {
        atmoThickValEl.textContent    = '—';
        atmoDensityValEl.textContent  = '—';
        atmoCoverageValEl.textContent = '—';
        atmoCloudDriftValEl.textContent = '—';
        atmoComplexWindsInput.checked = false;
        atmoHintEl.textContent = (b && b.kind === 'planet')
          ? `${b.name} has no atmosphere`
          : 'No atmosphere on this body';
      }
    }

    // Rings are planet-only. Disable the controls otherwise, and grey the
    // intensity row when rings are toggled off so it reads as "no effect now".
    function syncRingsToFocus() {
      const b = focusedBody;
      const isPlanet = !!(b && b.kind === 'planet' && b.ringMesh);
      const enabledRow   = ringsEnabledInput.closest('label');
      const intensityRow = ringsIntensityInput.closest('label');
      ringsEnabledInput.disabled   = !isPlanet;
      ringsIntensityInput.disabled = !isPlanet || !(b && b.rings && b.rings.enabled);
      if (enabledRow)   enabledRow.classList.toggle('is-disabled-section', !isPlanet);
      if (intensityRow) intensityRow.classList.toggle('is-disabled-section', !isPlanet || !(b && b.rings && b.rings.enabled));
      if (isPlanet) {
        const r = b.rings;
        ringsEnabledInput.checked   = !!r.enabled;
        ringsIntensityInput.value   = Math.round((r.intensity ?? 0.65) * 100);
        ringsIntensityValEl.textContent = (r.intensity ?? 0.65).toFixed(2);
        ringsHintEl.textContent = r.enabled
          ? `Rings encircle ${b.name}`
          : `Toggle to add rings to ${b.name}`;
      } else {
        ringsEnabledInput.checked = false;
        ringsIntensityValEl.textContent = '—';
        ringsHintEl.textContent = (b && b.kind === 'moon')
          ? 'Satellites cannot have rings'
          : 'Focus a planet to add rings';
      }
    }

    // ====== 29. Body orbit slider handlers ======
    bodyDistInput.oninput = () => {
      const v = parseInt(bodyDistInput.value, 10);
      if (focusedProbe) {
        const idx = probes.indexOf(focusedProbe);
        if (idx >= 0) setSatelliteDistance(idx, v);
      } else if (focusedBody?.kind === 'planet') {
        const entry = planets.find(p => p.body === focusedBody);
        if (entry) {
          entry.orbit.distance = v;
          updatePlanetOrbitPosition(entry);
          refreshOrbitLine(entry);
        }
      } else if (focusedBody?.kind === 'moon') {
        const idx = moons.findIndex(mn => mn.body === focusedBody);
        if (idx >= 0) setMoonDistance(idx, v);
      }
      bodyDistVal.textContent = v.toFixed(0);
      // A planet's distance from the star sets its climate — refresh the readout
      // live as the slider drags (cheap; no full panel re-render needed).
      if (focusedBody && !focusedProbe) renderClimateSection(focusedBody);
    };
    // On release, repaint the surface so the ice caps grow/shrink with the new
    // orbital distance. Done on 'change' (not every drag tick) since a full
    // recolor is heavier than the live readout above.
    bodyDistInput.onchange = () => {
      if (focusedBody?.kind === 'planet' && !focusedProbe) {
        refreshClimateColoring(focusedBody);
        updateInfoPanel();  // climate shifted the biomes/sea state — re-roll the composition rollup
      }
    };

    bodySpeedInput.oninput = () => {
      const v = parseInt(bodySpeedInput.value, 10) / PLANET_SPEED.div;
      if (focusedBody?.kind === 'planet' && !focusedProbe) {
        const entry = planets.find(p => p.body === focusedBody);
        if (entry) entry.orbit.speed = v;
        bodySpeedVal.textContent = v.toFixed(2);
      }
    };

    bodySpinInput.oninput = () => {
      if (focusedBody?.kind !== 'planet' || focusedProbe) return;
      const w = spinSliderToRad(parseInt(bodySpinInput.value, 10));
      focusedBody.rotationSpeed = w;
      bodySpinVal.textContent = w.toFixed(2);
      updateLiveInfo();
    };

    bodySizeInput.oninput = () => {
      const raw = parseInt(bodySizeInput.value, 10);
      if (focusedProbe) {
        const scale = raw / MOON_SIZE.div;
        const idx = probes.indexOf(focusedProbe);
        if (idx >= 0) setSatelliteSize(idx, scale);
        bodySizeVal.textContent = scale.toFixed(2);
      } else if (focusedBody?.kind === 'planet') {
        const scale = raw / PLANET_SIZE.div;
        focusedBody.group.scale.setScalar(scale);
        bodySizeVal.textContent = scale.toFixed(2);
      } else if (focusedBody?.kind === 'moon') {
        const scale = raw / MOON_SIZE.div;
        const idx = moons.findIndex(mn => mn.body === focusedBody);
        if (idx >= 0) setMoonSize(idx, scale);
        bodySizeVal.textContent = scale.toFixed(2);
      }
    };

    // Per-moon / per-probe orbital speed around the host planet.
    bodyMoonSpeedInput.oninput = () => {
      const v = parseInt(bodyMoonSpeedInput.value, 10);
      if (focusedProbe) {
        focusedProbe.speed = moonSliderToSpeed(v);
      } else if (focusedBody?.kind === 'moon') {
        const m = moons.find(mn => mn.body === focusedBody);
        if (m) m.speed = moonSliderToSpeed(v);
      } else return;
      bodyMoonSpeedVal.textContent = String(v);
      updateLiveInfo();
    };

    function onSatelliteOrbitPlaneControl() {
      applyFocusedSatelliteOrbitPlane();
      updateLiveInfo();
    }
    if (bodyInclInput) {
      bodyInclInput.oninput = () => {
        bodyInclVal.textContent = `${bodyInclInput.value}°`;
        onSatelliteOrbitPlaneControl();
      };
    }
    if (bodyNodeInput) {
      bodyNodeInput.oninput = () => {
        bodyNodeVal.textContent = `${bodyNodeInput.value}°`;
        onSatelliteOrbitPlaneControl();
      };
    }
    if (bodyRetrogradeInput) {
      bodyRetrogradeInput.onchange = onSatelliteOrbitPlaneControl;
    }

    if (showSatelliteOrbitsInput) {
      showSatelliteOrbitsInput.checked = showSatelliteOrbits;
      showSatelliteOrbitsInput.onchange = () => {
        setSatelliteOrbitLinesVisible(showSatelliteOrbitsInput.checked);
      };
    }

    // ====== 30. Add / Remove planet ======
    const ROMAN = ['I','II','III','IV','V','VI','VII','VIII','IX','X','XI','XII'];
    function nextPlanetName() {
      // Find lowest unused roman so removed slots get reused first.
      const used = new Set(planets.map(p => p.body.name));
      for (let i = 0; i < ROMAN.length; i++) {
        const n = `Planet ${ROMAN[i]}`;
        if (!used.has(n)) return n;
      }
      return `Planet ${planets.length + 1}`;
    }

    function deployNewPlanet() {
      if (planets.length >= 8) return null;
      // Place beyond the outermost existing orbit so it doesn't intersect.
      const maxDist = planets.reduce((m, p) => Math.max(m, p.orbit.distance), 120);
      const dist = maxDist + 160;
      // Pick an archetype that isn't on every planet already, for variety.
      const archKeys = Object.keys(ARCHETYPES);
      const used = planets.map(p => p.body.archetype);
      const arch = archKeys.find(a => !used.includes(a)) || 'terrestrial';
      const archSpec = ARCHETYPES[arch];
      const idx = planets.length;
      const name = nextPlanetName();
      const seed = `planet-${idx + 1}-${Math.floor(Math.random() * 1e4).toString(36)}`;

      const body = createBody({
        kind: 'planet',
        name,
        baseRadius: BASE_RADIUS,
        detail: ICO_DETAIL,
        hasOcean: archSpec.hasOcean,
      });
      bodies.push(body);
      scene.add(body.group);

      const prev = currentArchetype;
      currentArchetype = arch;
      regenerateBody(body, seed, archSpec.amp, archSpec.sea);
      currentArchetype = prev;
      body.currentAmp = archSpec.amp;
      body.currentSea = archSpec.sea;

      registerPlanet(body, arch, seed, {
        angle: Math.random() * Math.PI * 2,
        distance: dist,
        // Outer planets are slower (loose Kepler-ish feel without real physics).
        speed: 0.06 / (1 + idx * 0.35),
        inclination: (Math.random() - 0.5) * 0.3,
      });
      // regenerateBody ran before the planet was registered, so its climate was
      // computed at the default distance. Now that the real orbit is set, refresh
      // climate + ice for the planet's actual (far, cold) distance.
      refreshClimateColoring(body);
      return body;
    }

    // Cascade-delete a planet: also tears down its moons, probes, cities, and
    // the visible orbit line. Refuses to delete the last remaining planet and
    // re-focuses on a neighbor if the deleted planet was focused.
    // opts.force — used by unloadStarSystem() to tear down every planet when
    // swapping systems: skips the keep-≥1 guard and the per-planet refocus
    // (the caller re-focuses once after the new system is built).
    function removePlanetBody(target, opts = {}) {
      if (!target || target.kind !== 'planet') return;
      if (!opts.force && planets.length <= 1) return;
      // Remove moons of this planet first.
      for (let i = moons.length - 1; i >= 0; i--) {
        if (moons[i].parent === target) {
          if (focusedBody === moons[i].body) {
            // moot since focusedBody is the planet, not the moon — but be safe
          }
          scene.remove(moons[i].body.group);
          const bi = bodies.indexOf(moons[i].body);
          if (bi >= 0) bodies.splice(bi, 1);
          moons[i].body.geo.dispose();
          moons[i].body.mesh.material.dispose();
          freeMoonSlot(moons[i].parent, moons[i].slot);
          disposeSatelliteOrbitLine(moons[i]);
          moons.splice(i, 1);
        }
      }
      // Remove probes orbiting this planet.
      for (let i = probes.length - 1; i >= 0; i--) {
        if (probes[i].parent === target) removeSatelliteAt(i);
      }
      // Remove cities on this planet.
      for (let i = cities.length - 1; i >= 0; i--) {
        if (cities[i].body === target) {
          if (focusedCity === cities[i]) focusedCity = null;
          target.group.remove(cities[i].mesh);
          disposeCityMesh(cities[i].mesh);
          cities.splice(i, 1);
        }
      }
      // Remove the planet itself.
      scene.remove(target.group);
      const bi = bodies.indexOf(target);
      if (bi >= 0) bodies.splice(bi, 1);
      const pi = planets.findIndex(p => p.body === target);
      if (pi >= 0) {
        disposeOrbitLine(planets[pi]);
        planets.splice(pi, 1);
      }
      target.geo.dispose();
      target.mesh.material.dispose();
      if (target.oceanMesh) {
        target.oceanMesh.geometry.dispose();
        target.oceanMesh.material.dispose();
      }
      if (target.ringMesh) {
        target.ringMesh.geometry.dispose();
        target.ringMesh.material.dispose();
      }
      // Bounce to system view: the focus may have been pointing at the planet
      // itself, one of its moons, or a city on it — all destroyed above. Skipped
      // during a bulk system swap (the caller re-focuses once at the end).
      if (!opts.force) {
        setSystemFocus();
        renderCityList();
      }
    }

    deployPlanetBtn.onclick = () => {
      const b = deployNewPlanet();
      if (b) {
        renderPlanetList();
        renderNavBodies();
      }
    };

    // Reset Camera: recenter on whatever is currently in focus, not always Earth.
    focusPlanetBtn.onclick = () => {
      if (focusedProbe) setProbeFocus(focusedProbe);
      else if (focusedCity) setCityFocus(focusedCity);
      else if (focusedBody) setFocus(focusedBody);
      else setSystemFocus();
    };

    function renderPlanetList() {
      if (!planetListEl) return;
      if (planets.length === 0) {
        planetListEl.innerHTML = `<div class="empty-state">No planets · deploy one to begin</div>`;
        return;
      }
      const canRemove = planets.length > 1;
      planetListEl.innerHTML = planets.map((p, i) => {
        const arch = ARCHETYPES[p.body.archetype || 'terrestrial']?.name || 'Planet';
        const focusedCls = focusedBody === p.body ? ' is-focused' : '';
        return `
          <div class="planet-row${focusedCls}" data-index="${i}">
            <span class="planet-row-name">${p.body.name}</span>
            <span class="planet-row-arch">${arch}</span>
            <button class="planet-focus" type="button" title="Focus">◎</button>
            <button class="planet-remove" type="button" aria-label="Remove planet" title="Remove" ${canRemove ? '' : 'disabled'}>×</button>
          </div>`;
      }).join('');
      planetListEl.querySelectorAll('.planet-row').forEach(row => {
        const idx = parseInt(row.dataset.index, 10);
        const entry = planets[idx];
        if (!entry) return;
        row.querySelector('.planet-focus').onclick = () => setFocus(entry.body);
        row.querySelector('.planet-remove').onclick = () => removePlanetBody(entry.body);
      });
    }

    function renderMoonsList() {
      renderNavBodies();
      // Only show moons of the focused planet. With multiple planets in the
      // system, mixing them all into one list would be confusing.
      const parent = (focusedBody && focusedBody.kind === 'planet') ? focusedBody : null;
      const own = parent ? moons.filter(m => m.parent === parent) : [];

      if (!parent) {
        moonsListEl.innerHTML = '';
        addMoonBtn.disabled = true;
        return;
      }

      if (own.length === 0) {
        moonsListEl.innerHTML = `<div class="empty-state">No satellites in orbit · deploy one to begin</div>`;
        addMoonBtn.disabled = false;
        return;
      }

      moonsListEl.innerHTML = own.map((m, i) => {
        const sizeSlider = Math.round(m.size * 10);
        const distSlider = Math.round(m.distance);
        const focusedCls = focusedBody === m.body ? ' focused' : '';
        const apparent = (m.size * 2 * m.body.baseRadius).toFixed(2);
        return `
          <div class="moon-card${focusedBody === m.body ? ' is-focused' : ''}" data-local="${i}">
            <div class="moon-card-header">
              <span class="moon-card-title">${m.body.name}</span>
              <div class="moon-card-actions">
                <button class="moon-focus focus-btn small-btn${focusedCls}" type="button">Focus</button>
                <button class="moon-remove small-btn" type="button" aria-label="Remove moon">×</button>
              </div>
            </div>
            <div class="moon-card-body">
              <label>Size <input class="moon-size-input" type="range" min="2" max="40" value="${sizeSlider}"><span class="val moon-size-val">${sizeSlider}</span></label>
              <label>Dist <input class="moon-dist-input" type="range" min="14" max="60" value="${distSlider}"><span class="val moon-dist-val">${distSlider}</span></label>
              <div class="moon-meta">
                <span>Seed · ${m.seed}</span>
                <span>⌀ ${apparent} u</span>
              </div>
            </div>
          </div>
        `;
      }).join('');

      moonsListEl.querySelectorAll('.moon-card').forEach((row) => {
        const localIdx = parseInt(row.dataset.local, 10);
        const moonRef = own[localIdx];
        // Map back to the global moons[] index for the setter helpers.
        const globalIdx = () => moons.indexOf(moonRef);
        const sizeIn = row.querySelector('.moon-size-input');
        const sizeValEl = row.querySelector('.moon-size-val');
        const distIn = row.querySelector('.moon-dist-input');
        const distValEl = row.querySelector('.moon-dist-val');
        const focusBtn = row.querySelector('.moon-focus');
        const rmBtn = row.querySelector('.moon-remove');
        sizeIn.oninput = () => {
          sizeValEl.textContent = sizeIn.value;
          setMoonSize(globalIdx(), parseInt(sizeIn.value, 10) / 10);
        };
        distIn.oninput = () => {
          distValEl.textContent = distIn.value;
          setMoonDistance(globalIdx(), parseInt(distIn.value, 10));
        };
        focusBtn.onclick = () => { if (moonRef) setFocus(moonRef.body); };
        rmBtn.onclick = () => {
          removeMoonAt(globalIdx());
          renderMoonsList();
        };
      });

      addMoonBtn.disabled = own.length >= MAX_MOONS;
    }

    function renderProbesList() {
      const parent = focusedProbe?.parent
        || ((focusedBody && focusedBody.kind === 'planet') ? focusedBody : null);
      const own = parent ? probes.filter(p => p.parent === parent) : [];

      if (!parent) {
        probesListEl.innerHTML = '';
        addProbeBtn.disabled = true;
        return;
      }

      if (own.length === 0) {
        probesListEl.innerHTML = `<div class="empty-state">No probes in orbit · deploy one to begin</div>`;
        addProbeBtn.disabled = false;
        return;
      }

      probesListEl.innerHTML = own.map((p, i) => {
        const sizeSlider = Math.round(p.size * 10);
        const distSlider = Math.round(p.distance);
        const focusedCls = focusedProbe === p ? ' focused' : '';
        return `
          <div class="moon-card${focusedProbe === p ? ' is-focused' : ''}" data-local="${i}">
            <div class="moon-card-header">
              <span class="moon-card-title">${p.name}</span>
              <div class="moon-card-actions">
                <button class="probe-focus focus-btn small-btn${focusedCls}" type="button">Focus</button>
                <button class="probe-remove moon-remove small-btn" type="button" aria-label="Remove probe">×</button>
              </div>
            </div>
            <div class="moon-card-body">
              <label>Size <input class="probe-size-input" type="range" min="2" max="40" value="${sizeSlider}"><span class="val probe-size-val">${sizeSlider}</span></label>
              <label>Dist <input class="probe-dist-input" type="range" min="14" max="60" value="${distSlider}"><span class="val probe-dist-val">${distSlider}</span></label>
              <div class="moon-meta">
                <span>Probe · ${p.seed}</span>
                <span>d ${p.distance.toFixed(0)} u</span>
              </div>
            </div>
          </div>
        `;
      }).join('');

      probesListEl.querySelectorAll('.moon-card').forEach((row) => {
        const localIdx = parseInt(row.dataset.local, 10);
        const probeRef = own[localIdx];
        const globalIdx = () => probes.indexOf(probeRef);
        const sizeIn = row.querySelector('.probe-size-input');
        const sizeValEl = row.querySelector('.probe-size-val');
        const distIn = row.querySelector('.probe-dist-input');
        const distValEl = row.querySelector('.probe-dist-val');
        const focusBtn = row.querySelector('.probe-focus');
        const rmBtn = row.querySelector('.probe-remove');
        sizeIn.oninput = () => {
          sizeValEl.textContent = sizeIn.value;
          setSatelliteSize(globalIdx(), parseInt(sizeIn.value, 10) / 10);
        };
        distIn.oninput = () => {
          distValEl.textContent = distIn.value;
          setSatelliteDistance(globalIdx(), parseInt(distIn.value, 10));
        };
        focusBtn.onclick = () => { if (probeRef) setProbeFocus(probeRef); };
        rmBtn.onclick = () => {
          removeSatelliteAt(globalIdx());
          renderProbesList();
        };
      });

      addProbeBtn.disabled = own.length >= MAX_PROBES;
    }

    function renderFocusBadges() {
      // "Reset Camera" recenters whatever's currently in focus, so no need for
      // a per-target highlight on the button itself.
      renderMoonsList();
      renderProbesList();
    }

    // ====== 31. Hierarchy navigation ======
    // Levels: System (no body focused) → Planet → satellite ring (moons +
    // probes, same level) / City. Arrows: ↑ zoom out, ↓ zoom in to first child,
    // ←/→ cycle siblings (moons and probes share one ring under their planet).
    const navLevelEl = document.getElementById('navFocusLevel');
    const navNameEl  = document.getElementById('navFocusName');
    const navSubEl   = document.getElementById('navFocusSub');
    const navUpBtn   = document.getElementById('navUp');
    const navDownBtn = document.getElementById('navDown');
    const navLeftBtn = document.getElementById('navLeft');
    const navRightBtn= document.getElementById('navRight');
    const navBreadcrumbEl = document.getElementById('navBreadcrumb');
    const navRandomBtn    = document.getElementById('navRandomBtn');

    // navNameEl is contenteditable. While the user has it focused for typing,
    // skip programmatic updates so renders don't clobber their unsaved input.
    function setNavNameText(text) {
      if (document.activeElement === navNameEl) return;
      navNameEl.textContent = text;
    }

    function setSystemFocus() {
      focusedBody = null;
      focusedCity = null;
      focusedProbe = null;
      focusNameEl.textContent = 'System View';
      const maxOrbit = planets.reduce((acc, p) => Math.max(acc, p.orbit.distance), 40);
      const dist = Math.max(220, maxOrbit * 3.0 + 60);
      let dir = camera.position.clone().sub(controls.target);
      if (dir.lengthSq() < 1e-6) dir.set(0, 0.4, 1);
      dir.normalize();
      controls.target.set(0, 0, 0);
      camera.position.copy(controls.target).addScaledVector(dir, dist);
      renderFocusBadges();
      updateInfoPanel();
      applyFocusToLeftPanel();
    }

    // The satellite level of a planet holds both its moons and its probes, in
    // that order. Returned as a uniform list of nav targets so the arrows can
    // cycle through them as one ring and zoom into the first of either kind.
    function satelliteRing(parent) {
      const ring = [];
      for (const m of moons) if (m.parent === parent) ring.push({ kind: 'moon', body: m.body });
      for (const p of probes) if (p.parent === parent) ring.push({ kind: 'probe', probe: p });
      return ring;
    }
    function focusSatellite(target) {
      if (target.kind === 'probe') setProbeFocus(target.probe);
      else setFocus(target.body);
    }

    function navUp() {
      // On the star maps, ▲ climbs the cosmic hierarchy.
      if (viewLevel === 'constellation') { openGalaxyMap(); return; }
      if (viewLevel === 'galaxy') return;                 // already at the top
      // --- system level (the 3D scene) ---
      if (focusedProbe) { setFocus(focusedProbe.parent); return; }
      if (focusedCity) { setFocus(focusedBody); return; }
      if (focusedBody?.kind === 'moon') {
        const m = moons.find(mn => mn.body === focusedBody);
        if (m?.parent) { setFocus(m.parent); return; }
      }
      // Planet → system view; already at system → up into the constellation map.
      if (focusedBody) { setSystemFocus(); return; }
      openConstellationMap();
    }

    function navDown() {
      // On the star maps, ▼ descends: galaxy → home constellation, constellation
      // → into the loaded 3D system.
      if (viewLevel === 'galaxy') { openConstellationMap(); return; }
      if (viewLevel === 'constellation') { closeMap(); return; }
      if (focusedCity || focusedProbe) return; // leaf nodes — nothing below
      if (!focusedBody) {
        if (planets.length) setFocus(planets[0].body);
        return;
      }
      if (focusedBody.kind === 'planet') {
        const ring = satelliteRing(focusedBody);
        if (ring.length) { focusSatellite(ring[0]); return; }
        const myCities = cities.filter(c => c.body === focusedBody);
        if (myCities.length) setCityFocus(myCities[0]);
        return;
      }
      // moon
      const myCities = cities.filter(c => c.body === focusedBody);
      if (myCities.length) setCityFocus(myCities[0]);
    }

    // Cycle the focused entity to its next/previous sibling. Siblings are: other
    // cities on the same body (when a city is focused), other planets at the
    // system level, or the host planet's satellite ring — moons and probes
    // together (when a moon or probe is focused). Wraps both directions.
    function navSibling(dir) {
      if (focusedCity) {
        const sibs = cities.filter(c => c.body === focusedCity.body);
        if (sibs.length < 2) return;
        const idx = sibs.indexOf(focusedCity);
        setCityFocus(sibs[(idx + dir + sibs.length) % sibs.length]);
        return;
      }
      if (focusedProbe) {
        const ring = satelliteRing(focusedProbe.parent);
        if (ring.length < 2) return;
        const idx = ring.findIndex(t => t.kind === 'probe' && t.probe === focusedProbe);
        focusSatellite(ring[(idx + dir + ring.length) % ring.length]);
        return;
      }
      if (!focusedBody) {
        if (planets.length) setFocus(planets[0].body);
        return;
      }
      if (focusedBody.kind === 'planet') {
        const sibs = planets.map(p => p.body);
        if (sibs.length < 2) return;
        const idx = sibs.indexOf(focusedBody);
        setFocus(sibs[(idx + dir + sibs.length) % sibs.length]);
        return;
      }
      // moon — cycle within its parent's satellite ring (moons + probes)
      const m = moons.find(mn => mn.body === focusedBody);
      const ring = satelliteRing(m?.parent);
      if (ring.length < 2) return;
      const idx = ring.findIndex(t => t.kind === 'moon' && t.body === focusedBody);
      focusSatellite(ring[(idx + dir + ring.length) % ring.length]);
    }

    // Refresh the bottom-nav focus card (level, name, sub) and the breadcrumb
    // from the current focus state. Call after any setFocus / setCityFocus /
    // rename. Respects the user's caret if they're mid-edit (via setNavNameText).
    function renderNavBodies() {
      if (!navLevelEl) return;

      // Breadcrumb reflects the level being browsed. currentConstellation()
      // reads the live catalog (section 34), defined by the time this runs.
      if (navBreadcrumbEl) {
        if (viewLevel === 'galaxy') {
          navBreadcrumbEl.textContent = 'Milky Way Galaxy';
        } else if (viewLevel === 'constellation') {
          const con = findConstellation(viewedConstellationId) || currentConstellation();
          navBreadcrumbEl.textContent = `Milky Way · ${con.name}`;
        } else {
          navBreadcrumbEl.textContent = `Milky Way · ${currentConstellation().name} · ${systemName}`;
        }
      }

      // On the star maps the focus card shows the cosmic level rather than a
      // body: rename and sibling cycling don't apply, and Visit is off. ▲/▼ are
      // wired to climb/descend levels (see navUp/navDown).
      if (viewLevel !== 'system') {
        navNameEl.contentEditable = 'false';
        if (viewLevel === 'galaxy') {
          navLevelEl.textContent = 'Galaxy';
          setNavNameText(galaxy.name.toUpperCase());
          navSubEl.textContent = `${galaxy.constellations.length} constellations`;
          navUpBtn.disabled = true;          // top of the hierarchy
          navDownBtn.disabled = false;
        } else {
          const con = findConstellation(viewedConstellationId) || currentConstellation();
          const n = con.starSystems.length;
          navLevelEl.textContent = 'Constellation';
          setNavNameText(con.name.toUpperCase());
          navSubEl.textContent = `${n} system${n === 1 ? '' : 's'}`;
          navUpBtn.disabled = false;
          navDownBtn.disabled = false;
        }
        navLeftBtn.disabled = navRightBtn.disabled = true;
        if (typeof updateVisitButtonState === 'function') updateVisitButtonState();
        return;
      }
      navNameEl.contentEditable = 'true';

      // Focus card content
      if (focusedProbe) {
        navLevelEl.textContent = 'Probe';
        setNavNameText(focusedProbe.name.toUpperCase());
        navSubEl.textContent = focusedProbe.parent ? `Orbiting ${focusedProbe.parent.name}` : '';
      } else if (focusedCity) {
        navLevelEl.textContent = 'Settlement';
        setNavNameText(focusedCity.name.toUpperCase());
        navSubEl.textContent = `On ${focusedCity.body.name}`;
      } else if (focusedBody?.kind === 'planet') {
        const idx = planets.findIndex(p => p.body === focusedBody);
        navLevelEl.textContent = `Planet · N° ${idx + 1}`;
        setNavNameText(focusedBody.name.toUpperCase());
        const arch = ARCHETYPES[focusedBody.archetype || 'terrestrial'];
        const moonCount = moons.filter(m => m.parent === focusedBody).length;
        navSubEl.textContent = `${arch?.name || 'Planet'} · ${moonCount} satellite${moonCount === 1 ? '' : 's'}`;
      } else if (focusedBody?.kind === 'moon') {
        const m = moons.find(mn => mn.body === focusedBody);
        navLevelEl.textContent = 'Satellite';
        setNavNameText(focusedBody.name.toUpperCase());
        navSubEl.textContent = m?.parent ? `Orbiting ${m.parent.name}` : '';
      } else {
        navLevelEl.textContent = 'System';
        setNavNameText(systemName.toUpperCase());
        navSubEl.textContent = `${planets.length} planets · ${moons.length} satellites`;
      }

      // Arrow availability. ▲ is always live now: from a body it zooms out a
      // level, and from the system it opens the constellation map.
      navUpBtn.disabled = false;

      if (focusedCity || focusedProbe) navDownBtn.disabled = true;
      else if (focusedBody?.kind === 'planet') {
        navDownBtn.disabled = satelliteRing(focusedBody).length === 0
          && !cities.some(c => c.body === focusedBody);
      } else if (focusedBody?.kind === 'moon') {
        navDownBtn.disabled = !cities.some(c => c.body === focusedBody);
      } else {
        navDownBtn.disabled = planets.length === 0;
      }

      let sibCount = 0;
      if (focusedCity) sibCount = cities.filter(c => c.body === focusedCity.body).length;
      else if (focusedProbe) sibCount = satelliteRing(focusedProbe.parent).length;
      else if (focusedBody?.kind === 'planet') sibCount = planets.length;
      else if (focusedBody?.kind === 'moon') {
        const m = moons.find(mn => mn.body === focusedBody);
        sibCount = satelliteRing(m?.parent).length;
      }
      navLeftBtn.disabled = navRightBtn.disabled = sibCount < 2;

      // Visit availability mirrors the nav state — refresh whenever the focus
      // changes. Defined later in the file; guard for first-call ordering.
      if (typeof updateVisitButtonState === 'function') updateVisitButtonState();
    }

    if (navUpBtn) {
      navUpBtn.onclick    = navUp;
      navDownBtn.onclick  = navDown;
      navLeftBtn.onclick  = () => navSibling(-1);
      navRightBtn.onclick = () => navSibling(1);
    }

    // ====== 32. Surface walk ======
    // Lets the user stand on a planet/moon as a microscopic person. Three modes:
    //   orbit  — default; OrbitControls drives the camera.
    //   pick   — Visit button armed, awaiting a click on a valid landing spot.
    //   surface— camera is at ground level; left-drag = look, scroll = FOV zoom.
    // Eligibility: body.matter.solid && kind is 'planet' or 'moon'. Bodies with
    // matter.solid === false (gas/ice giants) auto-fail; clicks below sea level
    // fail too (liquid surface).

    const navVisitBtn        = document.getElementById('navVisit');
    const surfaceOverlay     = document.getElementById('surfaceOverlay');
    const surfaceLocationEl  = document.getElementById('surfaceLocationName');
    const surfaceExitBtn     = document.getElementById('surfaceExitBtn');
    const pickToastEl        = document.getElementById('pickToast');

    let viewMode = 'orbit';                // 'orbit' | 'pick' | 'surface'
    let pickTargetBody = null;             // body being targeted in pick mode (focused at activation)
    const surfaceState = {
      body: null,
      localEye: new THREE.Vector3(),       // eye position in body-local (mesh) coords
      localUp:  new THREE.Vector3(0, 1, 0),// surface normal in body-local
      localFwd: new THREE.Vector3(0, 0, 1),// initial forward, tangent to surface
      localRight: new THREE.Vector3(1, 0, 0),
      faceLocal: new THREE.Vector3(0, 0, 1),// direction the avatar faces (movement dir while moving, look heading at idle)
      yaw: 0,
      pitch: 0,
      fov: 60,
      eyeHeight: 0.04,                     // body-local units above surface (eye/head height)
      groundRadius: 0,                     // body-local radius of the standing surface
      moveSpeed: 0,                        // body-local units per second when walking
      // Camera rig: 'third' trails the astronaut, 'first' sits at the eye.
      cameraMode: 'third',
      camDist: 0,                          // third-person trail distance (body-local units)
      charWorldH: 0,                       // avatar's actual rendered world height (camera framing unit)
      // Jump physics, all in body-local radial units along localUp.
      jumpOffset: 0,                       // current height above the ground sphere
      vertVel: 0,                          // vertical velocity (units/sec)
      grounded: true,
      jumpSpeed: 0,                        // launch velocity, sized per body
      gravity: 0,                          // pulls the jump back down, sized per body × surface gravity
      gravityG: 1,                         // body's surface gravity (Earth = 1 g), shown in telemetry
      locoScale: 1,                        // gravity-driven locomotion rate (slows walk + animation in low-g)
      // Astronaut animation state machine: 'idle' | 'walk' | 'run' | 'jump'.
      animName: 'idle',
      stridePhase: 0,                      // drives procedural bob/sway for unrigged models
      // Grass treadmill: how far (in body-local tangent units) the walker has
      // drifted from the patch origin along localRight / localFwd. The grass
      // field wraps blades modulo the patch size against these so the lawn reads
      // as ground-fixed while staying centered on the avatar. Reset on entry.
      grassU: 0,
      grassV: 0,
      // True while the global ocean sphere is hidden for a water-world surface
      // visit (the local water patch takes over). Restored on exit.
      oceanHidden: false,
      // Saved orbit state, restored on exit.
      savedFov: 45,
      savedNear: 0.1,
      savedFar: 7000,
      savedCamPos: new THREE.Vector3(),
      savedTarget: new THREE.Vector3(),
      // Atmosphere shell gets reconfigured when inside: flipped to DoubleSide
      // so the inside faces render, and (for dense atmospheres) promoted to
      // an opaque occluder so other bodies don't bleed through the sky.
      gasMeshAdjusted: null,               // the gasMesh whose material we touched
      savedGas: null,                      // snapshot of material state to restore on exit
      savedSunVisible: null,               // sunMesh + corona visibility before surface visit
      paintsSunDisc: false,                // true if the body's atmosphere shader draws its own sun disc
    };

    function isBodyVisitable(body) {
      if (!body) return false;
      if (body.kind !== 'planet' && body.kind !== 'moon') return false;
      return !!(body.matter && body.matter.solid);
    }

    function updateVisitButtonState() {
      if (!navVisitBtn) return;
      const canVisit = !focusedCity && !focusedProbe && isBodyVisitable(focusedBody);
      navVisitBtn.disabled = !canVisit;
      navVisitBtn.classList.toggle('active', viewMode === 'pick' || viewMode === 'surface');
      if (viewMode === 'surface') {
        navVisitBtn.querySelector('.nav-action-label').textContent = 'ON SURFACE';
      } else if (viewMode === 'pick') {
        navVisitBtn.querySelector('.nav-action-label').textContent = 'PICK A SPOT…';
      } else {
        navVisitBtn.querySelector('.nav-action-label').textContent = 'VISIT SURFACE';
      }
    }

    let pickToastTimer = 0;
    function flashPickToast(msg) {
      if (!pickToastEl) return;
      pickToastEl.textContent = msg;
      pickToastEl.classList.add('show');
      clearTimeout(pickToastTimer);
      pickToastTimer = setTimeout(() => pickToastEl.classList.remove('show'), 1800);
    }

    function enterPickMode() {
      if (viewMode !== 'orbit') return;
      if (!isBodyVisitable(focusedBody)) return;
      viewMode = 'pick';
      pickTargetBody = focusedBody;
      document.body.classList.add('pick-mode');
      // Hide the sculpt ring immediately — it stays painted on the surface
      // until the next pointermove otherwise, which feels stale.
      brushRing.visible = false;
      // Disable orbit drag so the next left-click goes to our pick handler.
      controls.enabled = false;
      updateVisitButtonState();
    }

    function exitPickMode() {
      if (viewMode !== 'pick') return;
      viewMode = 'orbit';
      pickTargetBody = null;
      document.body.classList.remove('pick-mode');
      controls.enabled = true;
      updateVisitButtonState();
    }

    // Build an orthonormal basis at a body-local point. Up is the radial unit
    // vector; forward is an arbitrary tangent (we pick the world-Y projection,
    // falling back to world-X if the up vector is nearly aligned with Y so we
    // never get a degenerate cross product at the poles).
    function buildLocalFrame(localPos, outUp, outFwd, outRight) {
      outUp.copy(localPos).normalize();
      const ref = Math.abs(outUp.y) > 0.95
        ? new THREE.Vector3(1, 0, 0)
        : new THREE.Vector3(0, 1, 0);
      outRight.copy(ref).cross(outUp).normalize();
      outFwd.copy(outUp).cross(outRight).normalize();
    }

    // ── Astronaut character ────────────────────────────────────────────────
    // A GLB drives the surface avatar. It loads once and is re-parented to the
    // scene for each visit (only one surface session is ever active). The model
    // is astronaut.glb. If it carries animation clips matching ASTRO_CLIPS we
    // play them through an AnimationMixer; if it's an UNRIGGED static mesh (no
    // skeleton / no clips — like the current astronaut), we fall back to
    // procedural bob + lean so it still reads as moving. To get true limb
    // animation, supply a rigged+animated GLB whose clips match ASTRO_CLIPS.
    const ASTRO_MODEL_URL = 'astronaut.glb';
    const ASTRO_CLIPS = { idle: 'Idle', walk: 'Walking', run: 'Running', jump: 'Jump' };
    // The model's local forward axis. Flip sign if the avatar faces the camera
    // instead of showing its back. Soldier.glb faces -Z, so we use -1.
    const ASTRO_FACING = -1;
    const ASTRO_TURN_RATE = 10;            // how fast the avatar swivels to face its heading
    const ASTRO_FADE = 0.18;               // animation crossfade seconds
    const ASTRO_HEIGHT_FACTOR = 0.9;       // avatar height as a fraction of eye height (tune the visual size)

    let astronaut = null;                  // { root, inner, mixer, actions, animated, footOffset, nativeHeight }
    let astronautLoading = null;

    function loadAstronaut() {
      if (astronaut) return Promise.resolve(astronaut);
      if (astronautLoading) return astronautLoading;
      const loader = new GLTFLoader();
      astronautLoading = new Promise((resolve, reject) => {
        loader.load(ASTRO_MODEL_URL, (gltf) => {
          const inner = gltf.scene;
          // Re-seat so the model's feet sit at the pivot origin and it's centred
          // on X/Z. These offsets are in native model units; the pivot's scale
          // (set per visit) shrinks the whole thing to human size on the body.
          // updateMatrixWorld FIRST so the bbox includes the rig's nested node
          // scales — otherwise the measured height is wrong and scaling breaks.
          inner.updateMatrixWorld(true);
          const bbox = new THREE.Box3().setFromObject(inner);
          const size = bbox.getSize(new THREE.Vector3());
          const center = bbox.getCenter(new THREE.Vector3());
          const footOffset = new THREE.Vector3(-center.x, -bbox.min.y, -center.z);
          inner.position.copy(footOffset);
          inner.traverse((o) => {
            if (!o.isMesh) return;
            o.castShadow = true;
            o.frustumCulled = false;       // tiny on-screen; culling math gets twitchy at this scale
            // A dim self-glow so the avatar stays readable on the night side,
            // where the Sun PointLight doesn't reach.
            const mats = Array.isArray(o.material) ? o.material : [o.material];
            mats.forEach((m) => {
              // Dim neutral fill so the avatar stays faintly visible on the night
              // side without washing out under daylight.
              if (m && m.emissive) { m.emissive.setHex(0x222428); m.emissiveIntensity = 1.0; }
            });
          });
          const pivot = new THREE.Group();
          pivot.add(inner);
          // Build a mixer only if the model actually ships clips. We fuzzy-match
          // clip names (case-insensitive substring) so most rigged models from
          // Mixamo/Sketchfab/etc. "just work" without manual renaming. Exact
          // ASTRO_CLIPS names are tried first as a hint.
          const actions = {};
          let mixer = null;
          if (gltf.animations && gltf.animations.length) {
            mixer = new THREE.AnimationMixer(inner);
            const anims = gltf.animations;
            const pick = (...keys) => {
              for (const want of keys) {
                const w = want.toLowerCase();
                const c = anims.find(a => a.name && a.name.toLowerCase().includes(w));
                if (c) return c;
              }
              return null;
            };
            const clips = {
              idle: pick(ASTRO_CLIPS.idle, 'idle', 'breath', 'stand', 'rest') || anims[0],
              walk: pick(ASTRO_CLIPS.walk, 'walk'),
              run:  pick(ASTRO_CLIPS.run, 'run', 'sprint', 'jog'),
              jump: pick(ASTRO_CLIPS.jump, 'jump', 'leap'),
            };
            for (const key in clips) {
              if (clips[key]) actions[key] = mixer.clipAction(clips[key]);
            }
          }
          // "Animated" = we have at least a stand or walk clip to drive.
          const animated = !!(actions.idle || actions.walk);
          astronaut = { root: pivot, inner, mixer, actions, animated, current: null, footOffset, nativeHeight: size.y || 1 };
          if (animated) {
            console.info('[surface] astronaut clips:', Object.keys(actions).join(', '));
          } else {
            console.info('[surface] astronaut.glb has no usable clips — using procedural motion');
          }
          resolve(astronaut);
        }, undefined, (err) => {
          console.error('[surface] failed to load astronaut model', ASTRO_MODEL_URL, err);
          reject(err);
        });
      });
      return astronautLoading;
    }

    // Resolve a desired state to whatever clip the model actually has, with
    // graceful fallbacks (run→walk→idle, jump→idle) so partial clip sets work.
    function resolveAstronautAction(name) {
      const A = astronaut.actions;
      if (name === 'run')  return A.run  || A.walk || A.idle || null;
      if (name === 'walk') return A.walk || A.idle || null;
      if (name === 'jump') return A.jump || A.idle || null;
      return A.idle || A.walk || null;
    }

    // Crossfade to the clip for a state (clip-driven models only). For static
    // models we just record the state name so updateAstronaut fakes it.
    function setAstronautAction(name) {
      if (!astronaut) return;
      surfaceState.animName = name;
      if (!astronaut.animated) return;
      const next = resolveAstronautAction(name);
      if (!next || next === astronaut.current) return;

      next.reset();
      next.enabled = true;
      next.setEffectiveWeight(1);
      next.setEffectiveTimeScale(1.0);
      next.play();
      if (astronaut.current) astronaut.current.crossFadeTo(next, ASTRO_FADE, false);
      astronaut.current = next;
    }

    // Mount the (already loaded) avatar into the scene for a fresh visit.
    function attachAstronaut() {
      if (!astronaut) return;
      const body = surfaceState.body;
      if (!body) return;
      const worldScale = body.group.scale.x || 1;
      // Target world height = a fraction of eye height, scaled into world units.
      const targetH = surfaceState.eyeHeight * ASTRO_HEIGHT_FACTOR * worldScale;
      const s = targetH / astronaut.nativeHeight;
      astronaut.root.scale.setScalar(s);
      // Remember the avatar's real rendered height so the camera can frame it in
      // units of "character heights" instead of guessing from eye height.
      surfaceState.charWorldH = targetH;
      astronaut.root.visible = surfaceState.cameraMode === 'third';
      if (!astronaut.root.parent) scene.add(astronaut.root);
      surfaceState.animName = 'idle';
      surfaceState.stridePhase = 0;
      if (astronaut.animated) {
        // Reset to a clean idle so a previous visit's pose doesn't carry over.
        for (const k in astronaut.actions) astronaut.actions[k].stop();
        astronaut.current = null;
        setAstronautAction('idle');
      } else {
        // Static model: clear any leftover procedural pose.
        astronaut.inner.position.copy(astronaut.footOffset);
        astronaut.inner.rotation.set(0, 0, 0);
      }
    }

    function enterSurfaceMode(body, hitPoint) {
      // hitPoint comes in as a world-space Vector3 from the raycast result.
      const localHit = body.mesh.worldToLocal(hitPoint.clone());
      // Snap the eye to the local surface normal at the picked point. This
      // matters more than the picked point's exact radius — the icosphere
      // vertices form the visible "ground", and we want the camera to ride
      // their height field, not float over the click coordinate.
      surfaceState.body = body;
      // On a WATER world the local water patch (attachWaterPatch below) becomes the
      // only water up close — it reaches past the horizon, so the coarse global
      // ocean sphere is hidden while we walk to avoid a second, separately-shaded
      // water layer fighting it. Non-water liquids (lava/acid) have no patch, so
      // their sphere stays visible. Restored on exit. uSurface stays 0 (the sphere
      // is never put into surface see-through/wave mode now that the patch exists).
      surfaceState.oceanHidden = false;
      if (body.oceanMesh && body.matter && body.matter.liquid && body.oceanIsWater) {
        body.oceanMesh.visible = false;
        surfaceState.oceanHidden = true;
      }
      // Shrink the character scale on planets so the world feels larger and
      // traversal takes longer without needing slow-motion animations.
      const sizeMult = (body.kind === 'planet') ? 0.4 : 1.0;
      surfaceState.eyeHeight = Math.max(0.012, body.baseRadius * 0.003 * sizeMult);
      buildLocalFrame(localHit, surfaceState.localUp, surfaceState.localFwd, surfaceState.localRight);
      surfaceState.faceLocal.copy(surfaceState.localFwd);
      // Place the eye at (vertex height + eyeHeight) along the surface normal.
      // The picked point's local radius is the initial ground level; while
      // walking, stepSurfaceWalk resamples the terrain under each step so the
      // eye rises over mountains and dips into valleys.
      surfaceState.groundRadius = localHit.length();
      // Surface gravity for this body (Earth = 1 g). Low gravity gives a
      // low-traction, bounding feel: short, drifting strides paired with the
      // long, high leaps the reduced fall accel below produces. A heavy world
      // gives more purchase — faster, planted strides and a snappy jump. Clamp
      // the pace factor so the extremes stay playable rather than silly.
      const gFactor = surfaceGravityG(body);
      surfaceState.gravityG = gFactor;
      // Locomotion slows in low gravity for a "moonwalk" slow-motion read.
      // Walking speed scales ~√g (the Froude-number relation for a pendulum
      // stride), so the Moon's ~0.2 g lands near 45% pace — a clear slow-mo —
      // while a heavy world strides a touch faster. This SAME factor is fed to
      // the avatar's animation playback (see updateAstronaut) so the legs cycle
      // in slow motion too and the feet don't slide. Clamped so the extremes
      // stay playable.
      const locoScale = Math.min(1.3, Math.max(0.4, Math.sqrt(gFactor)));
      surfaceState.locoScale = locoScale;
      // Walk pace scales with character size. Because the character is smaller
      // on planets, they cover less absolute distance per step, but move at
      // a natural human cadence — then slowed/sped by gravity.
      surfaceState.moveSpeed = surfaceState.eyeHeight * 9.3 * locoScale;
      surfaceState.localEye.copy(surfaceState.localUp).multiplyScalar(surfaceState.groundRadius + surfaceState.eyeHeight);
      surfaceState.yaw = 0;
      surfaceState.pitch = 0;
      surfaceState.fov = 60;

      // Third-person trail distance + jump tuning, all scaled to the avatar's
      // size so jumps and camera framing feel the same on a moon or a giant.
      // Fixed distance (no scroll dolly in third person).
      surfaceState.camDist = surfaceState.eyeHeight * 2.2;
      // Launch velocity is constant across worlds; the per-body gravity below
      // does the work, so a weak-gravity moon yields a much higher, longer leap.
      surfaceState.jumpSpeed = surfaceState.eyeHeight * 9;
      // Fall acceleration scales with the body's gravity. The Earth baseline
      // (gFactor ≈ 1) keeps the ~0.7s, slightly-floaty hang time; the Moon's
      // ~0.2 g makes jumps drift, while a dense world snaps them straight down.
      surfaceState.gravity   = surfaceState.eyeHeight * 26 * gFactor;
      surfaceState.jumpOffset = 0;
      surfaceState.vertVel = 0;
      surfaceState.grounded = true;

      // Kick off (or reuse) the avatar load, then mount it for this visit.
      loadAstronaut().then(() => {
        if (viewMode === 'surface') attachAstronaut();
      }).catch(() => { /* avatar optional — surface view still works without it */ });

      // Reset and mount the grass field (gated to green ground by sampleGrassGround).
      surfaceState.grassU = 0;
      surfaceState.grassV = 0;
      attachGrass(body);
      attachRocks(body);
      // Lay the local high-detail water patch (waves) under the avatar.
      attachWaterPatch(body);

      // Save orbit state for clean restore.
      surfaceState.savedFov = camera.fov;
      surfaceState.savedNear = camera.near;
      surfaceState.savedFar = camera.far;
      surfaceState.savedCamPos.copy(camera.position);
      surfaceState.savedTarget.copy(controls.target);

      // A body with a visible atmosphere shell paints its own warm sun disc in
      // the gas shader (uMode 0), so we hide the system-scale Sun mesh to avoid
      // a double sun. An airless body (Mercury, the Moon, bare-rock worlds)
      // paints nothing — keep the real Sun mesh + corona visible so the star
      // still hangs in its black sky. The planet body occludes it naturally
      // once it's below the horizon, so no manual day/night gating is needed.
      surfaceState.paintsSunDisc = !!(body.gasMesh && body.gasMesh.visible
        && body.gasMesh.material.uniforms.uMode.value < 0.5);
      surfaceState.savedSunVisible = { mesh: sunMesh.visible, corona: coronaMesh.visible };
      sunMesh.visible    = !surfaceState.paintsSunDisc;
      coronaMesh.visible = !surfaceState.paintsSunDisc;

      // Atmosphere from inside — flip the shell to DoubleSide so the inside
      // faces render, and if the atmosphere is dense enough to read as a
      // solid sky, promote it to the opaque queue with depthWrite on so it
      // properly occludes other bodies in the scene. We snapshot the prior
      // material state per visit so re-entering can't compound the change.
      if (body.gasMesh && body.gasMesh.visible) {
        const mat = body.gasMesh.material;
        surfaceState.gasMeshAdjusted = body.gasMesh;
        surfaceState.savedGas = {
          side:            mat.side,
          transparent:     mat.transparent,
          depthWrite:      mat.depthWrite,
          alphaToCoverage: mat.alphaToCoverage,
          opaqueSky:       mat.uniforms.uOpaqueSky.value,
        };
        mat.side = THREE.DoubleSide;

        // Opaque-shell promotion: any atmosphere thick enough to paint a
        // visible sky (Earth 0.45 included) needs depthWrite-backed
        // occlusion or the far gas planets keep bleeding through.
        // alphaToCoverage dithers the shell's smooth alpha across MSAA
        // samples, so the day→night transition fades through partial
        // sample coverage instead of snapping at a discard threshold —
        // sunset/sunrise gradients actually read as gradients. ice_planet
        // (0.30) stays transparent so Mars-like atmospheres still show
        // stars at noon.
        const density = mat.uniforms.uDensity.value;
        if (density > 0.40) {
          mat.transparent     = false;
          mat.depthWrite      = true;
          mat.alphaToCoverage = true;
          mat.uniforms.uOpaqueSky.value = 1.0;
        }
        mat.needsUpdate = true;
      } else {
        surfaceState.gasMeshAdjusted = null;
        surfaceState.savedGas = null;
      }

      camera.fov = surfaceState.fov;
      camera.near = 0.001;
      camera.far = surfaceState.savedFar;
      camera.updateProjectionMatrix();

      controls.enabled = false;
      document.body.classList.remove('pick-mode');
      document.body.classList.add('surface-mode');
      surfaceOverlay.setAttribute('aria-hidden', 'false');
      if (surfaceLocationEl) surfaceLocationEl.textContent = body.name;
      viewMode = 'surface';
      pickTargetBody = null;
      updateVisitButtonState();
      updateSurfaceCamera();

      // Request pointer lock for mouse-look.
      try {
        renderer.domElement.requestPointerLock();
      } catch (err) {
        console.warn('Pointer lock request failed:', err);
      }
    }

    function exitSurfaceMode() {
      if (viewMode !== 'surface') return;

      if (document.pointerLockElement === renderer.domElement) {
        document.exitPointerLock();
      }

      // Restore camera projection + transform.
      camera.fov = surfaceState.savedFov;
      camera.near = surfaceState.savedNear;
      camera.far = surfaceState.savedFar;
      camera.updateProjectionMatrix();
      camera.position.copy(surfaceState.savedCamPos);
      controls.target.copy(surfaceState.savedTarget);
      camera.up.set(0, 1, 0);
      // Restore atmo shell material state (side + opaque-sky promotion).
      if (surfaceState.gasMeshAdjusted && surfaceState.savedGas) {
        const mat = surfaceState.gasMeshAdjusted.material;
        const s = surfaceState.savedGas;
        mat.side            = s.side;
        mat.transparent     = s.transparent;
        mat.depthWrite      = s.depthWrite;
        mat.alphaToCoverage = s.alphaToCoverage;
        mat.uniforms.uOpaqueSky.value = s.opaqueSky;
        mat.needsUpdate = true;
        surfaceState.gasMeshAdjusted = null;
        surfaceState.savedGas = null;
      }
      if (surfaceState.savedSunVisible) {
        sunMesh.visible = surfaceState.savedSunVisible.mesh;
        coronaMesh.visible = surfaceState.savedSunVisible.corona;
        surfaceState.savedSunVisible = null;
      }
      starMat.opacity = SURFACE_STAR_OPACITY;
      scene.fog = null;            // drop any underwater fog
      // Unmount the avatar (it persists in memory for the next visit).
      if (astronaut && astronaut.root.parent) {
        scene.remove(astronaut.root);
        for (const k in astronaut.actions) astronaut.actions[k].stop();
        surfaceState.animName = 'idle';
      }
      detachGrass();
      detachRocks();
      detachWaterPatch();
      // Restore the global ocean sphere we hid for the surface visit (water worlds)
      // and make sure it's back to the plain opaque sphere for the orbit view.
      if (surfaceState.body && surfaceState.body.oceanMesh) {
        const om = surfaceState.body.oceanMesh;
        if (surfaceState.oceanHidden) {
          om.visible = !!(surfaceState.body.matter && surfaceState.body.matter.liquid);
          surfaceState.oceanHidden = false;
        }
        if (om.material.userData.shader) om.material.userData.shader.uniforms.uSurface.value = 0;
      }
      surfaceState.body = null;
      controls.enabled = true;
      document.body.classList.remove('surface-mode');
      surfaceOverlay.setAttribute('aria-hidden', 'true');
      viewMode = 'orbit';
      clearSurfaceKeys();
      updateVisitButtonState();
    }

    // Gate starfield + keep Sun mesh hidden while on a body's surface.
    const _surfBodyCenter = new THREE.Vector3();
    const _surfCamDir     = new THREE.Vector3();
    const SURFACE_STAR_OPACITY = 0.95;
    // Reused single fog instance for the underwater look (a blue exponential fog
    // that collapses visibility to a short radius). scene.fog is otherwise unused.
    const underwaterFog = new THREE.FogExp2(0x10566f, 0.0);
    function updateSurfaceSkyEffects() {
      if (viewMode !== 'surface' || !surfaceState.body) {
        starMat.opacity = SURFACE_STAR_OPACITY;
        scene.fog = null;
        return;
      }
      // Underwater: once the eye drops below sea level on a liquid body, fill the
      // scene with blue fog so you can only see a short distance (just the nearby
      // seabed) and everything reads submerged. Density deepens the further under
      // you go; cleared the moment the eye breaks the surface.
      {
        const b = surfaceState.body;
        const eyeR = surfaceState.groundRadius + surfaceState.eyeHeight + surfaceState.jumpOffset;
        if (b.matter && b.matter.liquid && eyeR < b.baseRadius) {
          const depth = b.baseRadius - eyeR;                 // local units below sea level
          const vis   = Math.max(0.5, b.baseRadius * 0.22);  // clear sight range just under the surface
          underwaterFog.density = (1.6 / vis) * (1.0 + 1.5 * depth / b.baseRadius);
          scene.fog = underwaterFog;
        } else {
          scene.fog = null;
        }
      }
      // Atmosphere worlds: shader paints the sun, so keep the real mesh hidden.
      // Airless worlds: show the real Sun (occluded by the body when it sets).
      sunMesh.visible    = !surfaceState.paintsSunDisc;
      coronaMesh.visible = !surfaceState.paintsSunDisc;
      // Airless worlds have no atmosphere to scatter daylight, so the sky stays
      // black and the stars never wash out — the Sun just hangs among them.
      if (!surfaceState.paintsSunDisc) {
        starMat.opacity = SURFACE_STAR_OPACITY;
        return;
      }
      surfaceState.body.group.getWorldPosition(_surfBodyCenter);
      _surfCamDir.copy(camera.position).sub(_surfBodyCenter).normalize();
      sunMesh.getWorldPosition(_sunWorldTmp);
      _toSunTmp.subVectors(_sunWorldTmp, _surfBodyCenter).normalize();
      const sunElev = _surfCamDir.dot(_toSunTmp);
      if (sunElev >= 0.06) {
        starMat.opacity = 0;
      } else {
        const t = Math.min(1, Math.max(0, (0.06 - sunElev) / 0.44));
        const eased = t * t * (3 - 2 * t);
        starMat.opacity = eased * SURFACE_STAR_OPACITY;
      }
    }

    // Per-frame: rebuild the camera transform from the body's current world
    // matrix. The body spins on its axis and orbits the sun; by transforming
    // the local eye/look vectors through body.mesh.matrixWorld every frame,
    // the camera naturally rides along — sun and stars wheel overhead.
    const _worldEye    = new THREE.Vector3();
    const _worldLook   = new THREE.Vector3();   // normalized world look direction (yaw+pitch)
    const _worldUp     = new THREE.Vector3();   // normalized world surface normal
    const _worldHeading= new THREE.Vector3();   // normalized world heading (yaw only, level)
    const _localLookDir= new THREE.Vector3();
    const _localHeading= new THREE.Vector3();
    const _eyeLocal    = new THREE.Vector3();
    const _footLocal   = new THREE.Vector3();
    const _footWorld   = new THREE.Vector3();
    const _astroZ      = new THREE.Vector3();
    const _astroX      = new THREE.Vector3();
    const _astroMat    = new THREE.Matrix4();
    const _astroQuat   = new THREE.Quaternion();
    const _lookAtTmp   = new THREE.Vector3();
    const _camLocalTmp = new THREE.Vector3();

    function updateSurfaceCamera() {
      const body = surfaceState.body;
      if (!body) return;
      body.mesh.updateMatrixWorld();
      const mw = body.mesh.matrixWorld;

      // Look direction (yaw + pitch) and a level heading (yaw only). Order
      // matters — yaw last so the horizon stays level relative to the surface.
      _localLookDir.copy(surfaceState.localFwd)
        .applyAxisAngle(surfaceState.localRight, surfaceState.pitch)
        .applyAxisAngle(surfaceState.localUp, surfaceState.yaw)
        .normalize();

      // Eye/head sits at ground + eyeHeight, lifted by any active jump.
      const eyeRadius = surfaceState.groundRadius + surfaceState.eyeHeight + surfaceState.jumpOffset;
      _eyeLocal.copy(surfaceState.localUp).multiplyScalar(eyeRadius);

      // Body matrix carries the group scale, so transformed directions come out
      // scaled — normalize them to get unit world vectors. _worldHeading is the
      // avatar's facing (its movement direction), not the camera look.
      _worldEye.copy(_eyeLocal).applyMatrix4(mw);
      _worldUp.copy(surfaceState.localUp).transformDirection(mw).normalize();
      _worldLook.copy(_localLookDir).transformDirection(mw).normalize();
      _worldHeading.copy(surfaceState.faceLocal).transformDirection(mw).normalize();

      camera.up.copy(_worldUp);
      if (surfaceState.cameraMode === 'first') {
        camera.position.copy(_worldEye);
        _lookAtTmp.copy(_worldEye).add(_worldLook);
        camera.lookAt(_lookAtTmp);
      } else {
        // Third person framed in units of the avatar's actual height: aim at its
        // chest (~0.6× height above the feet), then trail behind a few body-
        // heights and lifted, so we look down at it at a gentle angle.
        const ch = surfaceState.charWorldH || (surfaceState.eyeHeight * (body.group.scale.x || 1));
        // Foot point in world (ground + any jump lift).
        _footLocal.copy(surfaceState.localUp)
          .multiplyScalar(surfaceState.groundRadius + surfaceState.jumpOffset);
        _footWorld.copy(_footLocal).applyMatrix4(mw);
        // Aim at the chest.
        _lookAtTmp.copy(_footWorld).addScaledVector(_worldUp, ch * 0.6);
        const dist = ch * 3.2;             // trail distance in character-heights
        const lift = ch * 1.5;             // camera elevation
        camera.position.copy(_lookAtTmp)
          .addScaledVector(_worldLook, -dist)
          .addScaledVector(_worldUp, lift);
        // Never let the look-around drag the camera under the ground: clamp its
        // distance from planet-centre to stay a hair above the standing surface.
        const minR = surfaceState.groundRadius + surfaceState.eyeHeight * 0.4;
        _camLocalTmp.copy(camera.position);
        body.mesh.worldToLocal(_camLocalTmp);
        if (_camLocalTmp.length() < minR) {
          _camLocalTmp.setLength(minR);
          body.mesh.localToWorld(_camLocalTmp);
          camera.position.copy(_camLocalTmp);
        }
        camera.lookAt(_lookAtTmp);
      }
    }

    // Per-frame avatar update: advance its animation, plant its feet on the
    // ground (lifted during a jump), and swivel it to face its heading. Reads
    // the world vectors that updateSurfaceCamera just computed this frame.
    function updateAstronaut(dt) {
      if (!astronaut) return;
      // Play the locomotion clips in slow motion under low gravity so the legs
      // cycle at the same rate the body actually translates (surfaceState.moveSpeed
      // carries the same locoScale) — keeps the feet planted instead of sliding,
      // and sells the floaty moonwalk feel alongside the lofted jump.
      if (astronaut.mixer) {
        astronaut.mixer.timeScale = surfaceState.locoScale;
        astronaut.mixer.update(dt);
      }
      if (!astronaut.root.parent || !surfaceState.body) return;
      const mw = surfaceState.body.mesh.matrixWorld;

      // Static (unrigged) models get faked motion: a stride-driven vertical bob,
      // a forward lean while moving, and a gentle side-to-side sway. Applied to
      // `inner` about the foot origin so the feet stay planted. Stride frequency
      // is slowed by the same gravity locoScale as the rigged clips above.
      if (!astronaut.animated) {
        const a = astronaut.animName;
        const moving = a === 'walk' || a === 'run';
        const freq = (a === 'run' ? 9 : (moving ? 5.5 : 2.2)) * surfaceState.locoScale;
        surfaceState.stridePhase += dt * freq;
        const ph = surfaceState.stridePhase;
        const h = astronaut.nativeHeight;
        const bobAmp  = a === 'run' ? 0.05 : (moving ? 0.03 : 0.006);
        const lean    = a === 'run' ? 0.20 : (moving ? 0.12 : 0);
        const swayAmp = moving ? (a === 'run' ? 0.06 : 0.04) : 0;
        const inner = astronaut.inner;
        inner.position.y = astronaut.footOffset.y + Math.abs(Math.sin(ph)) * bobAmp * h;
        inner.rotation.x = lean;                       // forward tilt about the feet
        inner.rotation.z = Math.sin(ph) * swayAmp;     // weight-shift sway
      }

      const footRadius = surfaceState.groundRadius + surfaceState.jumpOffset;
      _footLocal.copy(surfaceState.localUp).multiplyScalar(footRadius);
      _footWorld.copy(_footLocal).applyMatrix4(mw);
      astronaut.root.position.copy(_footWorld);

      // Orthonormal basis: Z = facing, Y = up, X = up × Z (right-handed).
      _astroZ.copy(_worldHeading).multiplyScalar(ASTRO_FACING);
      _astroX.crossVectors(_worldUp, _astroZ).normalize();
      _astroMat.makeBasis(_astroX, _worldUp, _astroZ);
      _astroQuat.setFromRotationMatrix(_astroMat);
      // Smoothly rotate toward the target so turns read as a swivel, not a snap.
      astronaut.root.quaternion.slerp(_astroQuat, Math.min(1, dt * ASTRO_TURN_RATE));
    }

    // ── Surface grass ──────────────────────────────────────────────────────
    // A single InstancedMesh of stylized blades that exists only while walking.
    // It's parented to the focused body's mesh, so it inherits the planet's spin
    // and orbit exactly like the terrain it grows on. Blades aren't pinned to the
    // ground individually — they tile a square patch of side 2·PR that "treadmills"
    // around the avatar: each blade's tangent coordinate is wrapped modulo the
    // patch against the walker's drift (surfaceState.grassU/V), so the lawn appears
    // fixed to the surface while always staying centered under the camera. Blades
    // scale to zero as they near any patch edge (Chebyshev edge fade), so they grow
    // in / out smoothly instead of popping whole rows in at the wrap seam as you
    // walk. Grass shows ONLY on the *grass* biome (checked against the terrain's own
    // biome/zone logic — not color), so sand, water, rock, snow and desert stay
    // bare: the footing under the avatar gates the whole field on/off, AND a
    // per-cell biome mask (read from the same raycast grid as terrain height) fades
    // individual blades back from coastlines so the lawn never spills onto beach or
    // water. Blades are clustered into dense tufts and follow real terrain height
    // via the grid so they sit on slopes and in dips, not a single sphere.
    const GRASS_COUNT = 18000;
    const GRASS_GN    = 8;        // height + biome grid resolution (GN×GN raycast samples)
    let grassField = null;
    let grassUniforms = null;     // captured from onBeforeCompile (uTime/uWind/uReveal)

    // One tapered blade pointing +Y, base at y=0, tip at y=1. Normals point
    // straight up so the instance orientation lights each blade like the ground
    // patch it stands on (vertical flat normals would crush to black edge-on).
    // A base→tip grey gradient in vertex color fakes ambient occlusion at the
    // roots; the per-instance color and material tint layer green on top.
    function buildGrassBladeGeometry() {
      const segs = 4, halfBase = 0.13;
      const pos = [], col = [], nrm = [], aH = [], idx = [];
      for (let s = 0; s <= segs; s++) {
        const y = s / segs;
        const hw = halfBase * (1 - y * 0.85);  // taper toward (but not fully to) a point
        const z = y * y * 0.18;                // gentle forward droop
        pos.push(-hw, y, z,  hw, y, z);
        const shade = 0.4 + 0.6 * y;           // dark roots → bright tip
        col.push(shade, shade, shade,  shade, shade, shade);
        nrm.push(0, 1, 0,  0, 1, 0);
        aH.push(y, y);
      }
      for (let s = 0; s < segs; s++) {
        const a = s * 2, b = s * 2 + 1, c = s * 2 + 2, d = s * 2 + 3;
        idx.push(a, c, b,  b, c, d);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('color',    new THREE.Float32BufferAttribute(col, 3));
      g.setAttribute('normal',   new THREE.Float32BufferAttribute(nrm, 3));
      g.setAttribute('aH',       new THREE.Float32BufferAttribute(aH, 1));
      g.setIndex(idx);
      return g;
    }

    function buildGrassField() {
      const geo = buildGrassBladeGeometry();
      // Per-instance distance-fade (1 = full blade, 0 = melted into the ground).
      // Drives BOTH height (in the placement matrix) and shading (flatten below).
      const fadeArr = new Float32Array(GRASS_COUNT); fadeArr.fill(1);
      geo.setAttribute('aFade', new THREE.InstancedBufferAttribute(fadeArr, 1).setUsage(THREE.DynamicDrawUsage));
      const mat = new THREE.MeshStandardMaterial({
        vertexColors: true, roughness: 1.0, metalness: 0.0, side: THREE.DoubleSide,
      });
      // Wind sway + grow-in reveal, injected into the standard vertex shader.
      // Sway bends the blade in its own local X/Z (so the instance orientation
      // carries it to the right world direction), weighted by height so roots
      // stay planted; phase varies per blade from its instance translation.
      // aFade additionally flattens the root→tip shading toward the flat ground
      // tint as a blade recedes, so a far blade is visually identical to the bare
      // green ground — the lawn's outer ring melts into the terrain instead of
      // showing a moving edge where blades "grow in" ahead of the walker.
      mat.onBeforeCompile = (sh) => {
        sh.uniforms.uTime   = { value: 0 };
        sh.uniforms.uWind   = { value: 0.18 };
        sh.uniforms.uReveal = { value: 0 };
        grassUniforms = sh.uniforms;
        sh.vertexShader = sh.vertexShader
          .replace('#include <common>',
            '#include <common>\nattribute float aH;\nattribute float aFade;\nuniform float uTime;\nuniform float uWind;\nuniform float uReveal;')
          .replace('#include <color_vertex>',
            '#include <color_vertex>\n  vColor = mix(vec3(1.0), vColor, clamp(aFade, 0.0, 1.0));')
          .replace('#include <begin_vertex>',
            '#include <begin_vertex>\n'
          + '  float _gph = instanceMatrix[3][0] * 11.0 + instanceMatrix[3][2] * 7.0;\n'
          + '  float _gsway = uWind * pow(aH, 1.5) * (sin(uTime * 1.6 + _gph) * 0.7 + sin(uTime * 3.1 + _gph * 1.7) * 0.3);\n'
          + '  transformed.x += _gsway;\n'
          + '  transformed.z += _gsway * 0.35;\n'
          + '  transformed *= uReveal;\n');
      };
      mat.customProgramCacheKey = () => 'grassBlade';

      const mesh = new THREE.InstancedMesh(geo, mat, GRASS_COUNT);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;   // the patch is always at the camera
      mesh.castShadow = false;
      mesh.receiveShadow = false;

      const baseUV    = new Float32Array(GRASS_COUNT * 2);  // normalized [-1,1], scaled by PR at runtime
      const yaw       = new Float32Array(GRASS_COUNT);
      const hScale    = new Float32Array(GRASS_COUNT);
      const leanAmt   = new Float32Array(GRASS_COUNT);      // tilt off vertical (tuft splay)
      const leanTheta = new Float32Array(GRASS_COUNT);      // tilt direction
      const tint      = new THREE.Color();
      // Scatter as tufts: pick a clump centre, then drop a handful of blades in a
      // tight disc around it. Reads as clustered grass instead of lone stems.
      let i = 0;
      while (i < GRASS_COUNT) {
        const cx = Math.random() * 2 - 1, cy = Math.random() * 2 - 1;
        const n  = 9 + (Math.random() * 11 | 0);         // 9..19 blades per tuft (dense clumps)
        const cr = 0.006 + Math.random() * 0.016;        // tight tuft radius (normalized)
        for (let k = 0; k < n && i < GRASS_COUNT; k++, i++) {
          const a  = Math.random() * Math.PI * 2;
          const rr = Math.sqrt(Math.random()) * cr;
          baseUV[2 * i]     = Math.max(-1, Math.min(1, cx + Math.cos(a) * rr));
          baseUV[2 * i + 1] = Math.max(-1, Math.min(1, cy + Math.sin(a) * rr));
          yaw[i]       = Math.random() * Math.PI * 2;
          hScale[i]    = 0.82 + Math.random() * 0.36;
          leanAmt[i]   = Math.random() * 0.28;            // splay tips outward a bit
          leanTheta[i] = Math.random() * Math.PI * 2;
          // Per-blade brightness + slight warm/cool jitter so the lawn isn't a flat
          // wash; the green itself comes from mat.color (sampled from the ground).
          const v = 0.72 + Math.random() * 0.42;
          tint.setRGB(v * (0.88 + Math.random() * 0.22), v, v * (0.82 + Math.random() * 0.22));
          mesh.setColorAt(i, tint);
        }
      }
      mesh.instanceColor.needsUpdate = true;
      grassField = {
        mesh, mat, baseUV, yaw, hScale, leanAmt, leanTheta, fadeArr,
        reveal: 0, targetReveal: 0, sampleTimer: 0, PR: 1, bladeH: 0.02,
        // Height grid: ground radii sampled in a snapshot tangent frame, so blades
        // read terrain height by bilinear lookup instead of one flat sphere.
        grid: new Float32Array(GRASS_GN * GRASS_GN),
        gridGrass: new Float32Array(GRASS_GN * GRASS_GN),  // 1 = grass-biome cell, 0 = bare (sand/water/rock)
        gridHalf: 1, gridValid: false,
        gridU: 0, gridV: 0,
        gridUp: new THREE.Vector3(), gridRight: new THREE.Vector3(), gridFwd: new THREE.Vector3(),
        lastU: NaN, lastV: NaN, placed: false,
      };
    }

    // Attach the (lazily built) grass to a body for a fresh surface visit.
    // PR (patch half-size) and blade height scale to the body's eye height so the
    // lawn reads the same on a moon or a giant.
    function attachGrass(body) {
      if (!grassField) buildGrassField();
      const gf = grassField;
      // Patch half-size reaches PAST the horizon (the eye-height horizon on these
      // bodies is ~26 eye-heights). Grass stays full almost the whole way out and
      // only fades over the outermost ~18% — i.e. at and beyond the skyline, where
      // the planet's own curvature hides the transition. So the visible ground is
      // grass everywhere; the walker never sees a bare ring sprouting grass ahead.
      gf.PR     = surfaceState.eyeHeight * 30;
      gf.bladeH = surfaceState.eyeHeight * 0.34;
      gf.reveal = 0;
      gf.targetReveal = 0;
      gf.sampleTimer = 0;
      gf.gridValid = false;
      gf.placed = false;
      gf.lastU = NaN; gf.lastV = NaN;
      if (grassUniforms) grassUniforms.uReveal.value = 0;
      gf.mesh.visible = false;
      if (gf.mesh.parent) gf.mesh.parent.remove(gf.mesh);
      body.mesh.add(gf.mesh);
    }

    function detachGrass() {
      if (grassField && grassField.mesh.parent) grassField.mesh.parent.remove(grassField.mesh);
    }

    // Console diagnostic: run `grassDiag()` in DevTools while standing on a planet
    // to see whether the lawn is gated off (and why) vs. an actual render problem.
    window.grassDiag = () => {
      const gf = grassField, body = surfaceState.body;
      if (!gf) return 'grass not built yet (enter a surface first)';
      let probe = 'no body';
      if (body) {
        body.mesh.updateMatrixWorld();
        const high = body.baseRadius * (1 + MAX_LAND_HEIGHT * BODY_HEIGHT_SCALE) + 1;
        _grOrigin.copy(surfaceState.localUp).multiplyScalar(high).applyMatrix4(body.mesh.matrixWorld);
        _grDir.copy(surfaceState.localUp).multiplyScalar(-1).transformDirection(body.mesh.matrixWorld).normalize();
        grassRaycaster.set(_grOrigin, _grDir);
        const hit = grassRaycaster.intersectObject(body.mesh, false)[0];
        const f = hit ? hit.face : null;
        probe = f ? {
          biome: body.biomes[f.a],
          heightAvg: ((body.heights[f.a] + body.heights[f.b] + body.heights[f.c]) / 3).toFixed(2),
          zoned: !!(body.climate && body.climate.spread > 0.5 && CLIMATE_LAND_ZONES[body.archetype]),
          isGrass: groundIsGrassFace(body, f),
        } : 'raycast missed';
      }
      return {
        body: body && body.name, archetype: body && body.archetype,
        visible: gf.mesh.visible, reveal: +gf.reveal.toFixed(3), targetReveal: gf.targetReveal,
        placed: gf.placed, gridValid: gf.gridValid, PR: gf.PR, bladeH: gf.bladeH,
        count: GRASS_COUNT, parented: !!gf.mesh.parent, probe,
      };
    };

    // True when terrain face `f` is vegetated green land — replicating
    // colorBodyVertex's land logic so the lawn only grows where the ground reads
    // green. Excludes sand/beach/water (below GRASS_FLOOR), rock/snow (above ROCK_TOP),
    // and the desert/tundra/ice climate zones; INCLUDES the grass + jungle zones,
    // painted forest, and the plain grass band. Moons stay bare. Only terrestrial
    // worlds have a genuine grassland mid-band — every other archetype's mid-band
    // is its own (orange dunes, red lava plain, blue ice plain…), NOT grassland —
    // so grass is gated to terrestrial worlds entirely; every other archetype
    // grows no grass blades, including under painted forest.
    const GRASS_ZONE_KEYS = { grass: 1, jungle: 1 };
    function groundIsGrassFace(body, f) {
      if (body.kind !== 'planet' || body.archetype !== 'terrestrial') return false;
      const bm = body.biomes[f.a];
      if (bm === BIOME.FOREST) return true;                       // painted forest = vegetated
      if (bm !== BIOME.AUTO) return false;                        // other painted biomes: bare
      const h = (body.heights[f.a] + body.heights[f.b] + body.heights[f.c]) / 3;
      if (h < GRASS_FLOOR || h >= ROCK_TOP) return false;         // sandy beach below, rock/snow above
      const zoned = body.climate && body.climate.spread > 0.5 && CLIMATE_LAND_ZONES[body.archetype];
      if (zoned) return !!GRASS_ZONE_KEYS[pickLandZone(CLIMATE_LAND_ZONES[body.archetype], vertexTempC(body, f.a)).key];
      return h < GRASS_TOP;                                        // plain grass band
    }

    // Throttled biome probe: cast down under the avatar, decide whether we're on
    // grass, and tint the blades from the face's actual green.
    const grassRaycaster = new THREE.Raycaster();
    const _grOrigin = new THREE.Vector3();
    const _grDir    = new THREE.Vector3();
    const _grHit    = new THREE.Vector3();
    const _grCol    = new THREE.Color();
    const _grTint   = new THREE.Color();
    const _grGreen  = new THREE.Color(COL.grass);
    function sampleGrassGround() {
      const body = surfaceState.body, gf = grassField;
      if (!body) { gf.targetReveal = 0; return; }
      body.mesh.updateMatrixWorld();
      const mw = body.mesh.matrixWorld;
      const high = body.baseRadius * (1 + MAX_LAND_HEIGHT * BODY_HEIGHT_SCALE) + 1;
      const footR = surfaceState.groundRadius;
      const up = surfaceState.localUp, right = surfaceState.localRight, fwd = surfaceState.localFwd;
      const d = gf.PR * 0.5;
      // Probe a small cross of points (centre + 4 around the avatar) and keep the
      // lawn ON if ANY of them is grass. A single odd bare face under one ray — a
      // height blip above GRASS_TOP, a climate-zone edge, the faceted icosphere —
      // no longer blinks the whole field off and on as you walk. The per-blade
      // biome mask still hides individual blades over genuinely bare spots.
      let onGrass = false, tf = null;
      for (let s = 0; s < 5; s++) {
        const ou = s === 1 ? d : s === 2 ? -d : 0;
        const ov = s === 3 ? d : s === 4 ? -d : 0;
        _grHit.copy(up).multiplyScalar(footR).addScaledVector(right, ou).addScaledVector(fwd, ov).normalize();
        _grOrigin.copy(_grHit).multiplyScalar(high).applyMatrix4(mw);
        _grDir.copy(_grHit).multiplyScalar(-1).transformDirection(mw).normalize();
        grassRaycaster.set(_grOrigin, _grDir);
        const hits = grassRaycaster.intersectObject(body.mesh, false);
        const f = hits.length ? hits[0].face : null;
        if (f && groundIsGrassFace(body, f)) { onGrass = true; if (s === 0 || !tf) tf = f; }
      }
      gf.targetReveal = onGrass ? 1 : 0;
      if (tf) {                                          // tint from a grass face (centre preferred)
        const ca = body.colorArr;
        _grCol.setRGB(
          (ca[3 * tf.a]     + ca[3 * tf.b]     + ca[3 * tf.c])     / 3,
          (ca[3 * tf.a + 1] + ca[3 * tf.b + 1] + ca[3 * tf.c + 1]) / 3,
          (ca[3 * tf.a + 2] + ca[3 * tf.b + 2] + ca[3 * tf.c + 2]) / 3,
        );
        _grTint.copy(_grCol).lerp(_grGreen, 0.3);
        gf.mat.color.copy(_grTint);
      }
    }

    // Re-sample the terrain-height grid in the avatar's current tangent frame,
    // snapshotting that frame so blades can be placed relative to it until the
    // walker drifts far enough to warrant a fresh grid. GN×GN downward raycasts.
    function refreshGrassGrid() {
      const gf = grassField, body = surfaceState.body;
      body.mesh.updateMatrixWorld();
      const mw = body.mesh.matrixWorld;
      const high = body.baseRadius * (1 + MAX_LAND_HEIGHT * BODY_HEIGHT_SCALE) + 1;
      gf.gridUp.copy(surfaceState.localUp);
      gf.gridRight.copy(surfaceState.localRight);
      gf.gridFwd.copy(surfaceState.localFwd);
      gf.gridU = surfaceState.grassU;
      gf.gridV = surfaceState.grassV;
      gf.gridHalf = gf.PR * 1.3;                 // cover the patch + the re-anchor slack
      const footR = surfaceState.groundRadius, GH = gf.gridHalf, GN = GRASS_GN;
      for (let iy = 0; iy < GN; iy++) {
        for (let ix = 0; ix < GN; ix++) {
          const gu = (ix / (GN - 1) * 2 - 1) * GH;
          const gv = (iy / (GN - 1) * 2 - 1) * GH;
          _gP.copy(gf.gridUp).multiplyScalar(footR).addScaledVector(gf.gridRight, gu).addScaledVector(gf.gridFwd, gv);
          _gUp.copy(_gP).normalize();
          _grOrigin.copy(_gUp).multiplyScalar(high).applyMatrix4(mw);
          _grDir.copy(_gUp).multiplyScalar(-1).transformDirection(mw).normalize();
          grassRaycaster.set(_grOrigin, _grDir);
          const hits = grassRaycaster.intersectObject(body.mesh, false);
          let r = footR, isGrass = 0;
          if (hits.length) {
            _grHit.copy(hits[0].point); body.mesh.worldToLocal(_grHit); r = _grHit.length();
            isGrass = groundIsGrassFace(body, hits[0].face) ? 1 : 0;
            if (body.matter && body.matter.liquid) r = Math.max(r, body.baseRadius);
          }
          gf.grid[iy * GN + ix] = r;
          gf.gridGrass[iy * GN + ix] = isGrass;
        }
      }
      gf.gridValid = true;
    }

    // Bilinear ground radius from the snapshot grid at snapshot-tangent (su, sv).
    function grassGroundRadius(gf, su, sv) {
      const GN = GRASS_GN, GH = gf.gridHalf;
      let fx = (su / GH * 0.5 + 0.5) * (GN - 1);
      let fy = (sv / GH * 0.5 + 0.5) * (GN - 1);
      fx = fx < 0 ? 0 : fx > GN - 1 ? GN - 1 : fx;
      fy = fy < 0 ? 0 : fy > GN - 1 ? GN - 1 : fy;
      const x0 = fx | 0, y0 = fy | 0;
      const x1 = x0 < GN - 1 ? x0 + 1 : x0, y1 = y0 < GN - 1 ? y0 + 1 : y0;
      const tx = fx - x0, ty = fy - y0, g = gf.grid;
      const a = g[y0 * GN + x0] + (g[y0 * GN + x1] - g[y0 * GN + x0]) * tx;
      const b = g[y1 * GN + x0] + (g[y1 * GN + x1] - g[y1 * GN + x0]) * tx;
      return a + (b - a) * ty;
    }

    // Bilinear grass-biome coverage (0..1) from the snapshot mask grid; lets blades
    // fade out as the ground beneath them turns to beach / water / rock / snow.
    function grassMask(gf, su, sv) {
      const GN = GRASS_GN, GH = gf.gridHalf;
      let fx = (su / GH * 0.5 + 0.5) * (GN - 1);
      let fy = (sv / GH * 0.5 + 0.5) * (GN - 1);
      fx = fx < 0 ? 0 : fx > GN - 1 ? GN - 1 : fx;
      fy = fy < 0 ? 0 : fy > GN - 1 ? GN - 1 : fy;
      const x0 = fx | 0, y0 = fy | 0;
      const x1 = x0 < GN - 1 ? x0 + 1 : x0, y1 = y0 < GN - 1 ? y0 + 1 : y0;
      const tx = fx - x0, ty = fy - y0, g = gf.gridGrass;
      const a = g[y0 * GN + x0] + (g[y0 * GN + x1] - g[y0 * GN + x0]) * tx;
      const b = g[y1 * GN + x0] + (g[y1 * GN + x1] - g[y1 * GN + x0]) * tx;
      return a + (b - a) * ty;
    }

    const _gP     = new THREE.Vector3();
    const _gUp    = new THREE.Vector3();
    const _gTilt  = new THREE.Vector3();
    const _gMat   = new THREE.Matrix4();
    const _gQuat  = new THREE.Quaternion();
    const _gRot   = new THREE.Quaternion();
    const _gScale = new THREE.Vector3();
    const _gAxisY = new THREE.Vector3(0, 1, 0);

    // Per-frame: refresh the biome probe + height grid as needed, advance wind +
    // reveal, and (only when the patch actually moved) re-place every blade.
    function updateGrass(dt) {
      if (!grassField || viewMode !== 'surface' || !surfaceState.body) return;
      const gf = grassField;

      gf.sampleTimer -= dt;
      if (gf.sampleTimer <= 0) { gf.sampleTimer = 0.3; sampleGrassGround(); }

      gf.reveal += (gf.targetReveal - gf.reveal) * Math.min(1, dt * 4);
      if (grassUniforms) {
        grassUniforms.uReveal.value = gf.reveal;
        grassUniforms.uTime.value  += dt;
      }
      if (gf.reveal <= 0.01) { gf.mesh.visible = false; return; }
      gf.mesh.visible = true;

      const PR = gf.PR;
      // Re-anchor the height grid once the walker drifts ~0.4 of the patch. The grid
      // (gridHalf = PR·1.3) still blankets the near field at that drift, so relaxing
      // the threshold just spreads the GN×GN raycast burst out in time (fewer hitches)
      // without leaving near blades un-sampled.
      let gridRefreshed = false;
      if (!gf.gridValid ||
          Math.abs(surfaceState.grassU - gf.gridU) > PR * 0.4 ||
          Math.abs(surfaceState.grassV - gf.gridV) > PR * 0.4) {
        refreshGrassGrid();
        gridRefreshed = true;
      }

      // Blade matrices only need rebuilding when the lawn shifted relative to the
      // ground (walker moved or grid re-anchored) — wind/grow-in live in the shader.
      const moved = surfaceState.grassU !== gf.lastU || surfaceState.grassV !== gf.lastV;
      if (!moved && !gridRefreshed && gf.placed) return;
      gf.lastU = surfaceState.grassU;
      gf.lastV = surfaceState.grassV;
      gf.placed = true;

      const period = PR * 2, bladeH = gf.bladeH, rootSink = bladeH * 0.12;
      const up = surfaceState.localUp, right = surfaceState.localRight, fwd = surfaceState.localFwd;
      const footR = surfaceState.groundRadius;
      const uOff = surfaceState.grassU, vOff = surfaceState.grassV;
      const driftU = surfaceState.grassU - gf.gridU, driftV = surfaceState.grassV - gf.gridV;
      for (let i = 0; i < GRASS_COUNT; i++) {
        // Treadmill wrap into [-PR, PR) so the blade maps to a fixed ground cell.
        let u = gf.baseUV[2 * i]     * PR - uOff;
        let v = gf.baseUV[2 * i + 1] * PR - vOff;
        u -= period * Math.floor((u + PR) / period);
        v -= period * Math.floor((v + PR) / period);
        // Edge fade (Chebyshev): grass is FULL out to 0.92·PR ≈ 27.6 eye-heights,
        // genuinely PAST the ~26 eye-height horizon, and only fades over the thin
        // outer ring (0.92→1.0) that sits beyond the skyline where the planet's
        // curvature already hides it. (This was 0.82·PR ≈ 24.6 eh — INSIDE the
        // horizon — so grass visibly thinned / popped in right at the skyline.)
        // The aFade attribute also melts that ring's shading into the ground tint.
        const au = u < 0 ? -u : u, av = v < 0 ? -v : v;
        let ef = (1.0 - (au > av ? au : av) / PR) * 12.5;
        ef = ef < 0 ? 0 : ef > 1 ? 1 : ef;
        // Biome mask: pull blades back from beach / sand / water so the lawn never
        // spills onto bare ground. Tightened (full at ≥0.75 coverage, gone ≤0.30) so
        // grass keeps clear of the shoreline; broad bare regions (water, sand, rock)
        // still clear it, while a stray bare face inland barely dents the meadow.
        let mf = (grassMask(gf, driftU + u, driftV + v) - 0.30) * 2.2222;
        mf = mf < 0 ? 0 : mf > 1 ? 1 : mf;
        let fade = ef * mf;
        if (fade <= 0.004) { gf.fadeArr[i] = 0; _gMat.makeScale(0, 0, 0); gf.mesh.setMatrixAt(i, _gMat); continue; }
        fade = fade * fade * (3 - 2 * fade);                          // smoothstep ease
        gf.fadeArr[i] = fade;                                         // height (below) + shading flatten (shader)
        // Tangent offset → surface direction, then lift to the real ground height
        // (blade position in the snapshot frame = drift since snapshot + uv).
        _gP.copy(up).multiplyScalar(footR).addScaledVector(right, u).addScaledVector(fwd, v);
        _gUp.copy(_gP).normalize();
        const r = grassGroundRadius(gf, driftU + u, driftV + v) - rootSink;
        _gP.copy(_gUp).multiplyScalar(r);
        // Splay: tilt the blade off vertical a touch for a tuft look, then spin.
        const lean = gf.leanAmt[i], th = gf.leanTheta[i];
        _gTilt.copy(_gUp)
          .addScaledVector(right, Math.cos(th) * lean)
          .addScaledVector(fwd,   Math.sin(th) * lean)
          .normalize();
        _gQuat.setFromUnitVectors(_gAxisY, _gTilt);
        _gRot.setFromAxisAngle(_gUp, gf.yaw[i]);
        _gQuat.premultiply(_gRot);
        const s = bladeH * gf.hScale[i] * fade;
        _gScale.set(s, s, s);
        _gMat.compose(_gP, _gQuat, _gScale);
        gf.mesh.setMatrixAt(i, _gMat);
      }
      gf.mesh.instanceMatrix.needsUpdate = true;
      gf.mesh.geometry.getAttribute('aFade').needsUpdate = true;
    }

    // ── Surface rocks (Martian / desert worlds) ────────────────────────────
    // A sparse InstancedMesh of low-poly boulders, built and scattered with the
    // same treadmill machinery as the grass above but gated to the DESERT
    // (Martian) archetype, so red rocks litter the flats only on Mars-type
    // worlds. One jittered icosahedron is reused for every instance; per-instance
    // non-uniform scale + tilt + yaw gives each boulder its own silhouette, and
    // the material colour is sampled from the ground (biased rust-red) so the
    // rocks match whatever the surface paints. They follow real terrain height
    // via a raycast grid (reusing grassGroundRadius, same GN/layout) and sink
    // ~1/3 into the ground so they read as embedded. No external assets - same
    // stylized, UV-free approach as the grass.
    const ROCK_COUNT = 280;
    const ROCK_GN    = GRASS_GN;     // reuse grassGroundRadius (identical GN + grid layout)
    let rockField = null;

    // One lumpy low-poly rock: an icosahedron whose every vertex is pushed in/out
    // by a position-hash noise. Duplicate verts at shared corners hash identically
    // (same position in -> same offset out), so the faces stay welded - no cracks.
    // flatShading then renders the irregular hull faceted, like a chipped stone.
    function buildRockGeometry() {
      const geo = new THREE.IcosahedronGeometry(1, 1);
      const pos = geo.getAttribute('position');
      const col = [];
      const rh = (x, y, z) => { const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453; return s - Math.floor(s); };
      const v = new THREE.Vector3();
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i);
        // Two octaves of radial displacement -> chunky, irregular boulder.
        const r = 1
          + (rh(v.x, v.y, v.z) - 0.5) * 0.55
          + (rh(v.y * 2.3, v.z * 2.3, v.x * 2.3) - 0.5) * 0.22;
        v.normalize().multiplyScalar(r);
        v.y *= 0.78;                                     // squash: boulders sit wider than tall
        pos.setXYZ(i, v.x, v.y, v.z);
        const shade = 0.55 + 0.45 * (v.y * 0.5 + 0.5);   // dark base -> lit crown (baked AO)
        col.push(shade, shade, shade);
      }
      geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      geo.computeVertexNormals();
      return geo;
    }

    function buildRockField() {
      const geo = buildRockGeometry();
      const mat = new THREE.MeshStandardMaterial({
        vertexColors: true, roughness: 0.95, metalness: 0.0, flatShading: true,
      });
      const mesh = new THREE.InstancedMesh(geo, mat, ROCK_COUNT);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;          // the patch is always at the camera
      mesh.castShadow = false;
      mesh.receiveShadow = false;

      const baseUV    = new Float32Array(ROCK_COUNT * 2);   // normalized [-1,1], scaled by PR at runtime
      const yaw       = new Float32Array(ROCK_COUNT);
      const tiltAmt   = new Float32Array(ROCK_COUNT);       // tip off vertical (tumbled look)
      const tiltTheta = new Float32Array(ROCK_COUNT);
      const nsx       = new Float32Array(ROCK_COUNT);       // per-axis scale -> varied silhouettes
      const nsy       = new Float32Array(ROCK_COUNT);
      const nsz       = new Float32Array(ROCK_COUNT);
      const size      = new Float32Array(ROCK_COUNT);
      const tint      = new THREE.Color();
      // Scatter as CLUSTERS with bare ground between — rock piles and debris
      // fields of varying character, not an even gravel spread. Each cluster
      // rolls a "tier" that sets its size band and packing; rocks crowd toward
      // the cluster centre. This leaves open Martian flats punctuated by the odd
      // boulder field, which reads far better than a uniform sprinkle.
      let i = 0;
      while (i < ROCK_COUNT) {
        const cx = Math.random() * 2 - 1, cy = Math.random() * 2 - 1;
        const roll = Math.random();
        let n, spread, sizeLo, sizeHi, flatChance;
        if (roll < 0.20) {                 // hero pile: 1–3 big boulders + a little rubble
          n = 1 + (Math.random() * 3 | 0);
          spread = 0.012 + Math.random() * 0.022;
          sizeLo = 1.5; sizeHi = 3.0; flatChance = 0.0;
        } else if (roll < 0.52) {          // debris field: many small angular pebbles / slabs
          n = 10 + (Math.random() * 24 | 0);
          spread = 0.03 + Math.random() * 0.07;
          sizeLo = 0.16; sizeHi = 0.5; flatChance = 0.5;
        } else {                           // mixed rubble: small-to-medium clump
          n = 3 + (Math.random() * 9 | 0);
          spread = 0.018 + Math.random() * 0.05;
          sizeLo = 0.4; sizeHi = 1.2; flatChance = 0.2;
        }
        for (let k = 0; k < n && i < ROCK_COUNT; k++, i++) {
          const a = Math.random() * Math.PI * 2;
          const rr = Math.pow(Math.random(), 0.7) * spread;     // crowd toward the centre
          baseUV[2 * i]     = Math.max(-1, Math.min(1, cx + Math.cos(a) * rr));
          baseUV[2 * i + 1] = Math.max(-1, Math.min(1, cy + Math.sin(a) * rr));
          yaw[i]       = Math.random() * Math.PI * 2;
          tiltAmt[i]   = Math.random() * 0.35;
          tiltTheta[i] = Math.random() * Math.PI * 2;
          // Size: skew within the tier's band; the lead rock of a hero pile is the
          // largest, the rest taper off (st*st) so a cluster has a clear hierarchy.
          const st = Math.random();
          size[i] = sizeLo + (sizeHi - sizeLo) * (k === 0 ? Math.pow(st, 0.45) : st * st);
          if (Math.random() < flatChance) {                     // flat slab: wide + low
            nsx[i] = 1.0 + Math.random() * 0.8;
            nsy[i] = 0.26 + Math.random() * 0.22;
            nsz[i] = 1.0 + Math.random() * 0.8;
          } else {                                              // chunky block
            nsx[i] = 0.7 + Math.random() * 0.7;
            nsy[i] = 0.55 + Math.random() * 0.65;
            nsz[i] = 0.7 + Math.random() * 0.7;
          }
          // Per-rock brightness + warm jitter (multiplies the sampled ground tint).
          const b = 0.68 + Math.random() * 0.46;
          tint.setRGB(b * (0.95 + Math.random() * 0.2), b * (0.88 + Math.random() * 0.12), b * (0.8 + Math.random() * 0.12));
          mesh.setColorAt(i, tint);
        }
      }
      mesh.instanceColor.needsUpdate = true;
      rockField = {
        mesh, mat, baseUV, yaw, tiltAmt, tiltTheta, nsx, nsy, nsz, size,
        reveal: 0, targetReveal: 0, sampleTimer: 0, PR: 1, rockH: 0.02,
        grid: new Float32Array(ROCK_GN * ROCK_GN),         // ground radii in a snapshot tangent frame
        gridRock: new Float32Array(ROCK_GN * ROCK_GN),     // 1 = desert-rock cell, 0 = bare
        gridHalf: 1, gridValid: false, gridU: 0, gridV: 0,
        gridUp: new THREE.Vector3(), gridRight: new THREE.Vector3(), gridFwd: new THREE.Vector3(),
      };
    }

    function attachRocks(body) {
      if (!rockField) buildRockField();
      const rf = rockField;
      rf.PR    = surfaceState.eyeHeight * 30;        // same horizon-reaching patch as grass
      rf.rockH = surfaceState.eyeHeight * 0.5;       // base boulder size (scaled per instance)
      rf.reveal = 0;
      rf.targetReveal = 0;
      rf.sampleTimer = 0;
      rf.gridValid = false;
      rf.mesh.visible = false;
      if (rf.mesh.parent) rf.mesh.parent.remove(rf.mesh);
      body.mesh.add(rf.mesh);
    }

    function detachRocks() {
      if (rockField && rockField.mesh.parent) rockField.mesh.parent.remove(rockField.mesh);
    }

    // True when terrain face `f` is dry Martian rock ground: desert archetype,
    // unpainted, above the basin sand line and below the salt-peak snow line.
    const ROCK_TOP_CAP = ROCK_TOP + 0.6;
    function groundIsRockFace(body, f) {
      if (body.kind !== 'planet' || body.archetype !== 'desert') return false;
      if (body.biomes[f.a] !== BIOME.AUTO) return false;         // painted faces: leave bare
      const h = (body.heights[f.a] + body.heights[f.b] + body.heights[f.c]) / 3;
      return h >= SAND_TOP && h < ROCK_TOP_CAP;                  // flats -> mesa, not basins/peaks
    }

    // Throttled biome probe: is the avatar on Martian rock ground, and what colour?
    const _rkRust = new THREE.Color(0x9c4a2a);
    function sampleRockGround() {
      const body = surfaceState.body, rf = rockField;
      if (!body) { rf.targetReveal = 0; return; }
      body.mesh.updateMatrixWorld();
      const mw = body.mesh.matrixWorld;
      const high = body.baseRadius * (1 + MAX_LAND_HEIGHT * BODY_HEIGHT_SCALE) + 1;
      const footR = surfaceState.groundRadius;
      const up = surfaceState.localUp, right = surfaceState.localRight, fwd = surfaceState.localFwd;
      const d = rf.PR * 0.5;
      let onRock = false, tf = null;
      for (let s = 0; s < 5; s++) {
        const ou = s === 1 ? d : s === 2 ? -d : 0;
        const ov = s === 3 ? d : s === 4 ? -d : 0;
        _grHit.copy(up).multiplyScalar(footR).addScaledVector(right, ou).addScaledVector(fwd, ov).normalize();
        _grOrigin.copy(_grHit).multiplyScalar(high).applyMatrix4(mw);
        _grDir.copy(_grHit).multiplyScalar(-1).transformDirection(mw).normalize();
        grassRaycaster.set(_grOrigin, _grDir);
        const hits = grassRaycaster.intersectObject(body.mesh, false);
        const f = hits.length ? hits[0].face : null;
        if (f && groundIsRockFace(body, f)) { onRock = true; if (s === 0 || !tf) tf = f; }
      }
      rf.targetReveal = onRock ? 1 : 0;
      if (tf) {                                          // tint from the ground, biased rust-red + darker
        const ca = body.colorArr;
        _grCol.setRGB(
          (ca[3 * tf.a]     + ca[3 * tf.b]     + ca[3 * tf.c])     / 3,
          (ca[3 * tf.a + 1] + ca[3 * tf.b + 1] + ca[3 * tf.c + 1]) / 3,
          (ca[3 * tf.a + 2] + ca[3 * tf.b + 2] + ca[3 * tf.c + 2]) / 3,
        );
        _grTint.copy(_grCol).lerp(_rkRust, 0.45).multiplyScalar(0.9);
        rf.mat.color.copy(_grTint);
      }
    }

    // Re-sample the height + rock-mask grid in the avatar's current tangent frame.
    function refreshRockGrid() {
      const rf = rockField, body = surfaceState.body;
      body.mesh.updateMatrixWorld();
      const mw = body.mesh.matrixWorld;
      const high = body.baseRadius * (1 + MAX_LAND_HEIGHT * BODY_HEIGHT_SCALE) + 1;
      rf.gridUp.copy(surfaceState.localUp);
      rf.gridRight.copy(surfaceState.localRight);
      rf.gridFwd.copy(surfaceState.localFwd);
      rf.gridU = surfaceState.grassU;
      rf.gridV = surfaceState.grassV;
      rf.gridHalf = rf.PR * 1.3;
      const footR = surfaceState.groundRadius, GH = rf.gridHalf, GN = ROCK_GN;
      for (let iy = 0; iy < GN; iy++) {
        for (let ix = 0; ix < GN; ix++) {
          const gu = (ix / (GN - 1) * 2 - 1) * GH;
          const gv = (iy / (GN - 1) * 2 - 1) * GH;
          _gP.copy(rf.gridUp).multiplyScalar(footR).addScaledVector(rf.gridRight, gu).addScaledVector(rf.gridFwd, gv);
          _gUp.copy(_gP).normalize();
          _grOrigin.copy(_gUp).multiplyScalar(high).applyMatrix4(mw);
          _grDir.copy(_gUp).multiplyScalar(-1).transformDirection(mw).normalize();
          grassRaycaster.set(_grOrigin, _grDir);
          const hits = grassRaycaster.intersectObject(body.mesh, false);
          let r = footR, isRock = 0;
          if (hits.length) {
            _grHit.copy(hits[0].point); body.mesh.worldToLocal(_grHit); r = _grHit.length();
            isRock = groundIsRockFace(body, hits[0].face) ? 1 : 0;
          }
          rf.grid[iy * GN + ix] = r;
          rf.gridRock[iy * GN + ix] = isRock;
        }
      }
      rf.gridValid = true;
    }

    // Bilinear rock-ground coverage (0..1) from the snapshot mask grid.
    function rockMask(rf, su, sv) {
      const GN = ROCK_GN, GH = rf.gridHalf;
      let fx = (su / GH * 0.5 + 0.5) * (GN - 1);
      let fy = (sv / GH * 0.5 + 0.5) * (GN - 1);
      fx = fx < 0 ? 0 : fx > GN - 1 ? GN - 1 : fx;
      fy = fy < 0 ? 0 : fy > GN - 1 ? GN - 1 : fy;
      const x0 = fx | 0, y0 = fy | 0;
      const x1 = x0 < GN - 1 ? x0 + 1 : x0, y1 = y0 < GN - 1 ? y0 + 1 : y0;
      const tx = fx - x0, ty = fy - y0, g = rf.gridRock;
      const a = g[y0 * GN + x0] + (g[y0 * GN + x1] - g[y0 * GN + x0]) * tx;
      const b = g[y1 * GN + x0] + (g[y1 * GN + x1] - g[y1 * GN + x0]) * tx;
      return a + (b - a) * ty;
    }

    // Per-frame: refresh the probe + grid as needed, then re-place every boulder.
    // (Only ~1000 instances, so we re-place each frame rather than guard on motion;
    // the reveal lerp folds straight into the per-instance scale for a smooth fade.)
    // Rock collision: treat each nearby boulder as a solid disc in the avatar's
    // tangent (treadmill) frame and stop/deflect the proposed step (du,dv) at its
    // edge, so you can't walk through rocks. Short pebbles are stepped over, and
    // once a jump clears a boulder's height you pass over it. Tunables: the colR
    // footprint factor (0.95) and the minColH step-over threshold.
    const _rkOut = [0, 0];
    function resolveRockCollision(du, dv) {
      _rkOut[0] = du; _rkOut[1] = dv;
      const rf = rockField, body = surfaceState.body;
      if (!rf || !rf.mesh.visible || rf.reveal < 0.5 || !body || body.archetype !== 'desert') return _rkOut;
      const PR = rf.PR, period = PR * 2, rockH = rf.rockH;
      const uOff = surfaceState.grassU, vOff = surfaceState.grassV;
      const eh = surfaceState.eyeHeight;
      const minColH = eh * 0.18;          // pebbles shorter than this: just step over
      const bodyR   = eh * 0.20;          // avatar half-width padding
      const near    = eh * 5;             // ignore rocks beyond this tangent range
      const airborne = !surfaceState.grounded;
      let nu = du, nv = dv;
      for (let i = 0; i < ROCK_COUNT; i++) {
        const colH = rockH * rf.size[i] * rf.nsy[i];
        if (colH < minColH) continue;                              // step over pebbles
        if (airborne && surfaceState.jumpOffset > colH) continue;  // jump cleared its top
        let u = rf.baseUV[2 * i]     * PR - uOff;
        let v = rf.baseUV[2 * i + 1] * PR - vOff;
        u -= period * Math.floor((u + PR) / period);
        v -= period * Math.floor((v + PR) / period);
        if (u < -near || u > near || v < -near || v > near) continue;
        const colR = rockH * rf.size[i] * Math.max(rf.nsx[i], rf.nsz[i]) * 0.95 + bodyR;
        const dx = nu - u, dy = nv - v;
        const d2 = dx * dx + dy * dy;
        if (d2 < colR * colR) {                                    // proposed pos inside the rock
          const d = Math.sqrt(d2) || 1e-5;
          const push = colR / d;                                  // shove back out to the edge (slides)
          nu = u + dx * push;
          nv = v + dy * push;
        }
      }
      _rkOut[0] = nu; _rkOut[1] = nv;
      return _rkOut;
    }
    function updateRocks(dt) {
      if (!rockField || viewMode !== 'surface' || !surfaceState.body) return;
      const rf = rockField;

      rf.sampleTimer -= dt;
      if (rf.sampleTimer <= 0) { rf.sampleTimer = 0.4; sampleRockGround(); }

      rf.reveal += (rf.targetReveal - rf.reveal) * Math.min(1, dt * 4);
      if (rf.reveal <= 0.01) { rf.mesh.visible = false; return; }
      rf.mesh.visible = true;

      const PR = rf.PR;
      if (!rf.gridValid ||
          Math.abs(surfaceState.grassU - rf.gridU) > PR * 0.4 ||
          Math.abs(surfaceState.grassV - rf.gridV) > PR * 0.4) {
        refreshRockGrid();
      }

      const period = PR * 2, rockH = rf.rockH, reveal = rf.reveal;
      const up = surfaceState.localUp, right = surfaceState.localRight, fwd = surfaceState.localFwd;
      const footR = surfaceState.groundRadius;
      const uOff = surfaceState.grassU, vOff = surfaceState.grassV;
      const driftU = surfaceState.grassU - rf.gridU, driftV = surfaceState.grassV - rf.gridV;
      for (let i = 0; i < ROCK_COUNT; i++) {
        let u = rf.baseUV[2 * i]     * PR - uOff;
        let v = rf.baseUV[2 * i + 1] * PR - vOff;
        u -= period * Math.floor((u + PR) / period);
        v -= period * Math.floor((v + PR) / period);
        const au = u < 0 ? -u : u, av = v < 0 ? -v : v;
        let ef = (1.0 - (au > av ? au : av) / PR) * 9.0;          // full to ~0.89·PR (past the horizon); thin fade beyond
        ef = ef < 0 ? 0 : ef > 1 ? 1 : ef;
        let mf = (rockMask(rf, driftU + u, driftV + v) - 0.18) * 2.7027;
        mf = mf < 0 ? 0 : mf > 1 ? 1 : mf;
        let fade = ef * mf * reveal;
        if (fade <= 0.004) { _gMat.makeScale(0, 0, 0); rf.mesh.setMatrixAt(i, _gMat); continue; }
        fade = fade * fade * (3 - 2 * fade);                      // smoothstep ease
        _gP.copy(up).multiplyScalar(footR).addScaledVector(right, u).addScaledVector(fwd, v);
        _gUp.copy(_gP).normalize();
        const sz = rockH * rf.size[i];
        const grR = grassGroundRadius(rf, driftU + u, driftV + v);
        const r = grR + sz * rf.nsy[i] * 0.25 * fade;             // sink lower third into the ground
        _gP.copy(_gUp).multiplyScalar(r);
        // Tip off vertical for a tumbled look, then spin about the surface normal.
        const lean = rf.tiltAmt[i], th = rf.tiltTheta[i];
        _gTilt.copy(_gUp)
          .addScaledVector(right, Math.cos(th) * lean)
          .addScaledVector(fwd,   Math.sin(th) * lean)
          .normalize();
        _gQuat.setFromUnitVectors(_gAxisY, _gTilt);
        _gRot.setFromAxisAngle(_gUp, rf.yaw[i]);
        _gQuat.premultiply(_gRot);
        _gScale.set(sz * rf.nsx[i] * fade, sz * rf.nsy[i] * fade, sz * rf.nsz[i] * fade);
        _gMat.compose(_gP, _gQuat, _gScale);
        rf.mesh.setMatrixAt(i, _gMat);
      }
      rf.mesh.instanceMatrix.needsUpdate = true;
    }


    // ── Local water patch (surface-walk only) ──────────────────────────────
    // The shared ocean SPHERE is far too coarse to show waves at the walking
    // avatar's scale — there are only one or two triangles between the eye and the
    // horizon, so sphere-level displacement can only heave slowly. In surface mode
    // we instead lay a dedicated, finely-tessellated water mesh tangent to the sea
    // under the avatar: a flat grid whose verts are projected onto the sea-level
    // sphere (so it hugs the planet's curvature) and displaced by short-wavelength
    // travelling waves in the vertex shader. It re-centres on the avatar each frame
    // while the waves are sampled in ground-fixed coords (the grass treadmill's
    // drift) so the swell reads as world-fixed rather than dragged along. It's only
    // attached while walking a water world, so the orbit/system view never sees it.
    // STEP 1: waves only (real up/down). Crest + shoreline foam come later.
    const WATER_PATCH_N = 144;          // grid resolution (verts per side)
    let waterPatch = null;
    let waterUniforms = null;

    function buildWaterPatch() {
      const N = WATER_PATCH_N;
      // Flat unit grid; after the rotate it lies in the XZ plane with position.xz
      // spanning [-1,1] (the tangent coords the shader scales by the patch radius).
      const geo = new THREE.PlaneGeometry(2, 2, N - 1, N - 1);
      geo.rotateX(-Math.PI / 2);
      const mat = new THREE.MeshStandardMaterial({
        // Opaque so it reads as a clean blue sea — at 0.92 it revealed the deep,
        // dark OCEAN_DEPTH_BOOST seabed beneath and looked blotchy. (See-through
        // shallows can come back later as a depth-aware effect.) The shader still
        // fades alpha at the rim, which needs transparent:true.
        color: 0xffffff, roughness: 0.22, metalness: 0.04,
        transparent: true, opacity: 1.0, side: THREE.DoubleSide,
      });
      mat.polygonOffset = true;          // bias against the global ocean sphere it sits on
      mat.polygonOffsetFactor = -1;
      mat.polygonOffsetUnits = -1;
      mat.onBeforeCompile = (sh) => {
        sh.uniforms.uPUp    = { value: new THREE.Vector3(0, 1, 0) };
        sh.uniforms.uPRight = { value: new THREE.Vector3(1, 0, 0) };
        sh.uniforms.uPFwd   = { value: new THREE.Vector3(0, 0, 1) };
        sh.uniforms.uPR     = { value: 0.4 };           // patch half-size (body-local units)
        sh.uniforms.uBodyR  = { value: 12 };            // sea-level radius (curvature)
        sh.uniforms.uLift   = { value: 0.004 };         // tiny outward bias over the sphere ocean
        sh.uniforms.uDrift  = { value: new THREE.Vector2(0, 0) };  // ground-fixed wave offset
        sh.uniforms.uWaveTime = { value: 0 };
        sh.uniforms.uWaveAmp  = { value: 0.004 };
        // STEP 2 — crest foam: white foam riding the tops of the waves.
        sh.uniforms.uFoamColor = { value: FOAM_COLOR };
        sh.uniforms.uCrestFoam = { value: 0.85 };       // crest foam strength (0 = off)
        // Depth-based look (clearer shallows → deeper blue) + STEP 3 shoreline foam.
        // uSeabedTex is the equirect seabed-height map (built by bakeOceanShore);
        // the shader reads water depth under each fragment from it.
        sh.uniforms.uSeabedTex  = { value: null };
        sh.uniforms.uShallowCol = { value: new THREE.Color(0x9fe0ee) };  // clear shallow tint
        sh.uniforms.uDeepCol    = { value: new THREE.Color(0x2f7fc0) };  // deeper open-water tint
        sh.uniforms.uShallowA   = { value: 0.72 };      // alpha in the shallows (only slightly see-through)
        sh.uniforms.uDeepA      = { value: 0.95 };      // alpha in deep water (near opaque)
        sh.uniforms.uDepthFade  = { value: 0.65 };      // seabed-height units over which it deepens
        sh.uniforms.uShoreFoam  = { value: 0.9 };       // shoreline crash-foam strength
        sh.uniforms.uShoreW     = { value: 0.16 };      // shoreline foam band width (depth units)
        // Stylized self-illumination floor so the water keeps its clear blue even
        // in dim / colour-tinted surface lighting instead of crushing to near-black.
        sh.uniforms.uWaterGlow  = { value: 0.28 };
        waterUniforms = sh.uniforms;
        sh.vertexShader = sh.vertexShader
          .replace('#include <common>',
            '#include <common>\nuniform vec3 uPUp;\nuniform vec3 uPRight;\nuniform vec3 uPFwd;\nuniform float uPR;\nuniform float uBodyR;\nuniform float uLift;\nuniform vec2 uDrift;\nuniform float uWaveTime;\nuniform float uWaveAmp;\nvarying float vEdge;\nvarying float vWaveH;\nvarying vec2 vW;\nvarying vec3 vDir;\n'
          + 'float wv(vec2 p){\n  float t = uWaveTime;\n  float h = 0.0;\n'
          + '  h += sin(dot(p, vec2(1.0, 0.25)) * 60.0 + t * 1.6) * 0.50;\n'
          + '  h += sin(dot(p, vec2(-0.35, 1.0)) * 85.0 - t * 1.9) * 0.32;\n'
          + '  h += sin(dot(p, vec2(0.80, 0.60)) * 130.0 + t * 2.6) * 0.18;\n'
          + '  return h;\n}')
          // Project the grid point onto the sea sphere, bump the normal from the
          // wave slope (finite differences), then displace radially by wave height.
          .replace('#include <beginnormal_vertex>',
            '#include <beginnormal_vertex>\n'
          + '  vec2 _uv = position.xz;\n'
          + '  float _u = _uv.x * uPR;\n  float _v = _uv.y * uPR;\n'
          + '  vec2 _w = vec2(_u, _v) + uDrift;\n'
          + '  float _h = wv(_w);\n'
          + '  vec3 _dir = normalize(uPUp * uBodyR + uPRight * _u + uPFwd * _v);\n'
          + '  float _e = 0.004;\n'
          + '  float _hR = wv(_w + vec2(_e, 0.0));\n  float _hF = wv(_w + vec2(0.0, _e));\n'
          + '  vec3 _grad = (uPRight * (_hR - _h) + uPFwd * (_hF - _h)) / _e;\n'
          + '  objectNormal = normalize(_dir - _grad * uWaveAmp * 1.2);\n')
          .replace('#include <begin_vertex>',
            '#include <begin_vertex>\n'
          + '  transformed = _dir * (uBodyR + uLift + _h * uWaveAmp);\n'
          + '  vEdge = max(abs(_uv.x), abs(_uv.y));\n'
          + '  vWaveH = _h;\n'      // wave height ∈[-1,1] (crest ≈ +1) → crest foam
          + '  vW = _w;\n'          // ground-fixed coords → foam noise rides the wave
          + '  vDir = _dir;\n');    // unit body-local dir → equirect seabed-depth lookup
        // Soft rim fade so the patch edge melts into the global ocean sphere out
        // past the horizon (where curvature already hides the seam anyway).
        sh.fragmentShader = sh.fragmentShader
          .replace('#include <common>', '#include <common>\nvarying float vEdge;\nvarying float vWaveH;\nvarying vec2 vW;\nvarying vec3 vDir;\nuniform float uWaveTime;\nuniform vec3 uFoamColor;\nuniform float uCrestFoam;\nuniform sampler2D uSeabedTex;\nuniform vec3 uShallowCol;\nuniform vec3 uDeepCol;\nuniform float uShallowA;\nuniform float uDeepA;\nuniform float uDepthFade;\nuniform float uShoreFoam;\nuniform float uShoreW;\nuniform float uWaterGlow;\nvec3 _waterEmit = vec3(0.0);\nfloat fHash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }\nfloat fNoise(vec2 x){ vec2 i = floor(x); vec2 f = fract(x); f = f * f * (3.0 - 2.0 * f); return mix(mix(fHash(i), fHash(i + vec2(1.0, 0.0)), f.x), mix(fHash(i + vec2(0.0, 1.0)), fHash(i + vec2(1.0, 1.0)), f.x), f.y); }\nfloat fFbm(vec2 p){ float a = 0.5; float s = 0.0; for(int k = 0; k < 3; k++){ s += a * fNoise(p); p *= 2.03; a *= 0.5; } return s; }')
          // Sea floor depth from the equirect seabed map → clearer, more
          // transparent shallows over a deeper, opaque blue; plus a shoreline
          // crash-foam band that surges in and recedes as the waves wash up.
          .replace('#include <color_fragment>',
            '#include <color_fragment>\n'
          + '  vec3 _d = normalize(vDir);\n'
          + '  vec2 _suv = vec2(atan(_d.z, _d.x) / PI2 + 0.5, asin(clamp(_d.y, -1.0, 1.0)) / PI + 0.5);\n'
          + '  float _H = texture2D(uSeabedTex, _suv).r * 9.0 - 6.0;\n'   // decode seabed height
          + '  float _depth = max(0.0, -_H);\n'                          // water depth (height units)
          + '  float _df = smoothstep(0.0, uDepthFade, _depth);\n'
          + '  diffuseColor.rgb = mix(uShallowCol, uDeepCol, _df);\n'     // clearer shallows → deep blue
          + '  float _alpha = mix(uShallowA, uDeepA, _df);\n'
          + '  _alpha *= 1.0 - smoothstep(0.86, 1.0, vEdge);\n'           // rim fade into the far sea
          // Crest foam (Step 2): white caps on the upper part of each wave crest.
          + '  float _crest = smoothstep(0.45, 0.92, vWaveH);\n'
          + '  float _ctex = fFbm(vW * 240.0 + vec2(uWaveTime * 0.5, -uWaveTime * 0.4));\n'
          + '  float _crestFoam = uCrestFoam * _crest * smoothstep(0.30, 0.75, _ctex);\n'
          // Shoreline crash foam (Step 3): a foam band hugging the waterline whose
          // width pulses with time (waves rushing up the sand, then drawing back),
          // broken into lacy streaks. Strongest right at depth 0, gone past uShoreW.
          + '  float _wash = 0.6 + 0.4 * sin(uWaveTime * 2.2 + (vW.x + vW.y) * 26.0);\n'
          + '  float _band = smoothstep(uShoreW * _wash, 0.0, _depth);\n'
          + '  float _stex = fFbm(vW * 170.0 + vec2(-uWaveTime * 0.35, uWaveTime * 0.5));\n'
          + '  float _shoreFoam = uShoreFoam * _band * smoothstep(0.25, 0.8, _stex);\n'
          + '  float _foam = clamp(max(_crestFoam, _shoreFoam), 0.0, 1.0);\n'
          + '  diffuseColor.rgb = mix(diffuseColor.rgb, uFoamColor, _foam);\n'
          + '  diffuseColor.a = max(_alpha, _foam * 0.9);\n'
          + '  _waterEmit = diffuseColor.rgb;\n')   // feed the self-illumination floor below
          // Stylized glow floor: lift the water toward its own colour so it stays a
          // clear blue (and foam stays white) even where the scene light is dim.
          .replace('#include <emissivemap_fragment>',
            '#include <emissivemap_fragment>\n  totalEmissiveRadiance += _waterEmit * uWaterGlow;\n');
      };
      mat.customProgramCacheKey = () => 'waterPatch';
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;        // always centred on the camera
      mesh.renderOrder = 2;
      mesh.visible = false;
      waterPatch = { mesh, mat };
    }

    // Mount the water patch for a fresh surface visit. Only shows on liquid WATER
    // worlds (lava/acid seas keep the plain sphere); sized to the body's eye height
    // so the swell reads the same on a moon or a giant.
    function attachWaterPatch(body) {
      if (!waterPatch) buildWaterPatch();
      const wp = waterPatch;
      wp.mesh.visible = false;
      if (wp.mesh.parent) wp.mesh.parent.remove(wp.mesh);
      const show = !!(body.matter && body.matter.liquid && body.oceanIsWater);
      if (!show) return;
      // Ensure the seabed-depth texture exists/fresh (depth transparency + shore foam).
      if (!body.seabedTex) bakeOceanShore(body);
      if (waterUniforms) {
        waterUniforms.uPR.value       = surfaceState.eyeHeight * 30;
        waterUniforms.uBodyR.value    = body.baseRadius;
        // uLift MUST be ≥ uWaveAmp so wave TROUGHS never dip below sea level —
        // otherwise the shallow seabed pokes up through the troughs near shore and
        // the water looks blotchy. The whole sea then rides slightly above true sea
        // level (negligible) with troughs ≈ sea level and crests ≈ +2·amp.
        waterUniforms.uWaveAmp.value  = surfaceState.eyeHeight * 0.22;
        waterUniforms.uLift.value     = surfaceState.eyeHeight * 0.27;
        waterUniforms.uWaveTime.value = 0;
        waterUniforms.uDrift.value.set(0, 0);
        waterUniforms.uSeabedTex.value = body.seabedTex || null;
        // Clearer-blue look derived from the body's own water tint: shallows lean
        // bright/pale, open water leans a touch deeper than the base tint.
        const base = new THREE.Color(body.oceanBaseColor || COL.water);
        waterUniforms.uShallowCol.value.copy(base).lerp(new THREE.Color(0xffffff), 0.45);
        waterUniforms.uDeepCol.value.copy(base);   // keep deep water a bright clear blue, not near-black
      }
      body.mesh.add(wp.mesh);
      wp.mesh.visible = true;
    }

    function detachWaterPatch() {
      if (waterPatch && waterPatch.mesh.parent) waterPatch.mesh.parent.remove(waterPatch.mesh);
    }

    // Per-frame: re-centre the patch on the avatar (current tangent frame) and
    // scroll the wave field by the walker's drift so it stays world-fixed. Waves
    // freeze while the sim is paused, matching the sphere ocean's clock.
    function updateWaterPatch(dt) {
      if (!waterPatch || !waterPatch.mesh.visible || viewMode !== 'surface' || !surfaceState.body) return;
      if (!waterUniforms) return;
      waterUniforms.uPUp.value.copy(surfaceState.localUp);
      waterUniforms.uPRight.value.copy(surfaceState.localRight);
      waterUniforms.uPFwd.value.copy(surfaceState.localFwd);
      waterUniforms.uDrift.value.set(surfaceState.grassU, surfaceState.grassV);
      if (!paused) waterUniforms.uWaveTime.value += dt;
    }

    // WASD walking. Movement happens in body-local space along the tangent
    // plane at the current standing point, then the position is renormalized
    // to the standing sphere (groundRadius + eyeHeight). The local frame is
    // parallel-transported across the surface so yaw stays meaningful — the
    // direction the user faces relative to "north" remains consistent step
    // to step.
    const surfaceKeys = { w: false, a: false, s: false, d: false, shift: false };
    const SURFACE_SPRINT_MULT = 2.0;
    const _walkHeading = new THREE.Vector3();
    const _walkStrafe  = new THREE.Vector3();
    const _walkDelta   = new THREE.Vector3();
    const _walkNewUp   = new THREE.Vector3();
    const _walkAxis    = new THREE.Vector3();

    function clearSurfaceKeys() {
      surfaceKeys.w = surfaceKeys.a = surfaceKeys.s = surfaceKeys.d = surfaceKeys.shift = false;
    }

    // Dedicated raycaster for terrain-following so we don't disturb the shared
    // `raycaster`'s state that pick mode relies on.
    const groundRaycaster = new THREE.Raycaster();
    const _groundOrigin   = new THREE.Vector3();
    const _groundDir      = new THREE.Vector3();
    const _groundHitLocal = new THREE.Vector3();

    // Sample the body's actual surface radius beneath a body-local up
    // direction by casting a ray straight down at the terrain. Returns the
    // local radius of the ground (per-vertex displacement included), or null
    // if the ray misses (shouldn't happen aiming at the body's center).
    function sampleGroundRadius(body, localUpDir) {
      body.mesh.updateMatrixWorld();
      // Start above the tallest possible peak so we never begin below ground.
      const high = body.baseRadius * (1 + MAX_LAND_HEIGHT * BODY_HEIGHT_SCALE) + 1;
      _groundOrigin.copy(localUpDir).multiplyScalar(high).applyMatrix4(body.mesh.matrixWorld);
      _groundDir.copy(localUpDir).multiplyScalar(-1).transformDirection(body.mesh.matrixWorld).normalize();
      groundRaycaster.set(_groundOrigin, _groundDir);
      const hits = groundRaycaster.intersectObject(body.mesh, false);
      if (hits.length === 0) return null;
      _groundHitLocal.copy(hits[0].point);
      body.mesh.worldToLocal(_groundHitLocal);
      let ground = _groundHitLocal.length();
      // Ocean bodies USED to clamp the walker to the waterline here. Now the eye
      // follows the real seabed, so wading off a beach actually sinks you below
      // sea level and underwater fog kicks in (see updateSurfaceSkyEffects).
      return ground;
    }

    function stepSurfaceWalk(dt) {
      if (viewMode !== 'surface' || !surfaceState.body) return;

      // Jump physics: integrate vertical motion along the surface normal. Runs
      // every frame (not just on input) so a leap always arcs back to ground.
      if (!surfaceState.grounded) {
        surfaceState.vertVel -= surfaceState.gravity * dt;
        surfaceState.jumpOffset += surfaceState.vertVel * dt;
        if (surfaceState.jumpOffset <= 0) {
          surfaceState.jumpOffset = 0;
          surfaceState.vertVel = 0;
          surfaceState.grounded = true;
        }
      }

      const fwdInput    = (surfaceKeys.w ? 1 : 0) + (surfaceKeys.s ? -1 : 0);
      const strafeInput = (surfaceKeys.d ? 1 : 0) + (surfaceKeys.a ? -1 : 0);
      const moving = fwdInput !== 0 || strafeInput !== 0;

      // Drive the animation state machine: airborne → jump; on the ground →
      // run (sprint) / walk / idle depending on input.
      if (!surfaceState.grounded)      setAstronautAction('jump');
      else if (moving)                 setAstronautAction(surfaceKeys.shift ? 'run' : 'walk');
      else                             setAstronautAction('idle');

      // Heading and strafe in local space: take the basis vectors and rotate
      // them by the current yaw about local up, so "forward" is whichever way
      // the camera currently looks.
      _walkHeading.copy(surfaceState.localFwd)
        .applyAxisAngle(surfaceState.localUp, surfaceState.yaw);
      _walkStrafe.copy(surfaceState.localRight)
        .applyAxisAngle(surfaceState.localUp, surfaceState.yaw);

      // The avatar faces the direction it actually MOVES (not the camera), so the
      // forward walk/run clip matches strafing and diagonal motion instead of
      // looking like it's running forwards sideways. Idle keeps the look heading.
      if (moving) {
        surfaceState.faceLocal.copy(_walkHeading).multiplyScalar(fwdInput)
          .addScaledVector(_walkStrafe, strafeInput).normalize();
      } else {
        surfaceState.faceLocal.copy(_walkHeading);
        return;
      }

      // Wading drag: moving below sea level on an ocean body is slower, so
      // stepping into water feels heavier than striding on land.
      const submerged = surfaceState.body.matter && surfaceState.body.matter.liquid &&
        (surfaceState.groundRadius + surfaceState.eyeHeight) < surfaceState.body.baseRadius;
      const speed = surfaceState.moveSpeed * (surfaceKeys.shift ? SURFACE_SPRINT_MULT : 1) * (submerged ? 0.55 : 1);
      const step  = speed * dt;
      _walkDelta.set(0, 0, 0)
        .addScaledVector(_walkHeading, fwdInput * step)
        .addScaledVector(_walkStrafe,  strafeInput * step);

      // Rock collision: convert the tangent step to (du,dv), let solid boulders
      // block/deflect it, then rebuild the step from the resolved values.
      let _rkDu = _walkDelta.dot(surfaceState.localRight);
      let _rkDv = _walkDelta.dot(surfaceState.localFwd);
      const _rkRes = resolveRockCollision(_rkDu, _rkDv);
      _rkDu = _rkRes[0]; _rkDv = _rkRes[1];
      _walkDelta.copy(surfaceState.localRight).multiplyScalar(_rkDu)
        .addScaledVector(surfaceState.localFwd, _rkDv);
      surfaceState.localEye.add(_walkDelta);

      // Feed the grass treadmill: how far this step drifted along the (pre-
      // transport) tangent basis the field places blades against.
      surfaceState.grassU += _walkDelta.dot(surfaceState.localRight);
      surfaceState.grassV += _walkDelta.dot(surfaceState.localFwd);

      // new up = normalized eye position after the tangent step.
      _walkNewUp.copy(surfaceState.localEye).normalize();

      // Terrain-follow: sample the real ground height under the new spot so we
      // rise over mountains and dip into valleys instead of clipping through
      // them. Smooth toward it so the faceted icosphere doesn't jolt the eye.
      const sampled = sampleGroundRadius(surfaceState.body, _walkNewUp);
      if (sampled != null) surfaceState.groundRadius = sampled;
      const targetRadius = surfaceState.groundRadius + surfaceState.eyeHeight;
      const curRadius = surfaceState.localEye.length();
      const lerp = Math.min(1, dt * 10);
      surfaceState.localEye.copy(_walkNewUp)
        .multiplyScalar(curRadius + (targetRadius - curRadius) * lerp);

      // Parallel-transport the local frame from oldUp → newUp by rotating
      // about their common perpendicular. Tiny moves leave the frame nearly
      // unchanged; large moves rotate it the correct amount so localFwd
      // stays tangent to the sphere instead of drifting off-surface.
      _walkAxis.crossVectors(surfaceState.localUp, _walkNewUp);
      const sinA = _walkAxis.length();
      if (sinA > 1e-6) {
        _walkAxis.divideScalar(sinA);
        const cosA  = surfaceState.localUp.dot(_walkNewUp);
        const angle = Math.atan2(sinA, cosA);
        surfaceState.localFwd.applyAxisAngle(_walkAxis, angle).normalize();
        surfaceState.localRight.applyAxisAngle(_walkAxis, angle).normalize();
      }
      surfaceState.localUp.copy(_walkNewUp);
    }

    // Launch a jump if we're standing on the ground. Mid-air presses are
    // ignored (no double-jump) so the arc stays predictable.
    function tryJump() {
      if (viewMode !== 'surface' || !surfaceState.grounded) return;
      surfaceState.vertVel = surfaceState.jumpSpeed;
      surfaceState.grounded = false;
    }

    // Flip between the trailing third-person rig and the eye-level first-person
    // view. The avatar is hidden in first person so it doesn't fill the screen.
    function toggleSurfaceCamera() {
      if (viewMode !== 'surface') return;
      surfaceState.cameraMode = surfaceState.cameraMode === 'third' ? 'first' : 'third';
      if (astronaut) astronaut.root.visible = surfaceState.cameraMode === 'third';
    }

    // ====== 33. Surface input ======
    let surfaceDragging = false;
    let surfaceDragLastX = 0;
    let surfaceDragLastY = 0;
    const SURFACE_LOOK_SPEED = 0.0035; // radians per pixel
    const SURFACE_PITCH_LIMIT = Math.PI * 0.49;

    renderer.domElement.addEventListener('pointerdown', (e) => {
      if (viewMode === 'pick') {
        if (e.button !== 0) return;
        e.preventDefault();
        setPointerFromEvent(e);
        raycaster.setFromCamera(pointer, camera);
        // Only consider the body that was focused when pick mode started, so
        // the user can't accidentally land on a moon hovering near the planet.
        if (!pickTargetBody || !pickTargetBody.mesh.visible) {
          flashPickToast('Target unavailable');
          exitPickMode();
          return;
        }
        const hits = raycaster.intersectObject(pickTargetBody.mesh, false);
        if (hits.length === 0) {
          flashPickToast('Aim at the body');
          return;
        }
        const hit = hits[0];
        // Reject points below sea level — that's liquid surface. We compare the
        // local hit radius to baseRadius (heights[i] == 0 is sea level, which
        // corresponds to a local radius of baseRadius).
        const localHit = pickTargetBody.mesh.worldToLocal(hit.point.clone());
        if (localHit.length() < pickTargetBody.baseRadius - 0.001) {
          flashPickToast('Liquid surface — pick land');
          return;
        }
        enterSurfaceMode(pickTargetBody, hit.point);
        return;
      }
      if (viewMode === 'surface') {
        // Re-request pointer lock if lost.
        if (document.pointerLockElement !== renderer.domElement) {
          try {
            renderer.domElement.requestPointerLock();
          } catch (err) {}
        }

        // Left OR right drag orbits the camera around the character.
        if (e.button !== 0 && e.button !== 2) return;
        e.preventDefault();
        surfaceDragging = true;
        surfaceDragLastX = e.clientX;
        surfaceDragLastY = e.clientY;
        renderer.domElement.setPointerCapture(e.pointerId);
      }
    });

    // Suppress the browser context menu while on a surface so right-drag can
    // orbit the camera without popping a menu.
    renderer.domElement.addEventListener('contextmenu', (e) => {
      if (viewMode === 'surface') e.preventDefault();
    });

    renderer.domElement.addEventListener('pointermove', (e) => {
      if (viewMode !== 'surface') return;

      let dx = 0, dy = 0;
      if (document.pointerLockElement === renderer.domElement) {
        dx = e.movementX;
        dy = e.movementY;
      } else if (surfaceDragging) {
        dx = e.clientX - surfaceDragLastX;
        dy = e.clientY - surfaceDragLastY;
        surfaceDragLastX = e.clientX;
        surfaceDragLastY = e.clientY;
      } else {
        return;
      }

      surfaceState.yaw   -= dx * SURFACE_LOOK_SPEED;
      surfaceState.pitch += dy * SURFACE_LOOK_SPEED;
      if (surfaceState.pitch >  SURFACE_PITCH_LIMIT) surfaceState.pitch =  SURFACE_PITCH_LIMIT;
      if (surfaceState.pitch < -SURFACE_PITCH_LIMIT) surfaceState.pitch = -SURFACE_PITCH_LIMIT;
    });

    const endSurfaceDrag = (e) => {
      if (!surfaceDragging) return;
      surfaceDragging = false;
      try { renderer.domElement.releasePointerCapture(e.pointerId); } catch (_) {}
    };
    renderer.domElement.addEventListener('pointerup', endSurfaceDrag);
    renderer.domElement.addEventListener('pointercancel', endSurfaceDrag);

    // If the browser releases pointer lock (ESC), also exit surface mode.
    document.addEventListener('pointerlockchange', () => {
      if (document.pointerLockElement !== renderer.domElement && viewMode === 'surface') {
        exitSurfaceMode();
      }
    });

    // Scroll in surface mode: in first person it zooms the FOV. Third person has
    // a fixed framing, so scroll does nothing there. We piggyback on the canvas
    // wheel event so we intercept it before OrbitControls (disabled anyway).
    renderer.domElement.addEventListener('wheel', (e) => {
      if (viewMode !== 'surface') return;
      e.preventDefault();
      if (surfaceState.cameraMode !== 'first') return;   // no zoom in third person
      const step = e.deltaY > 0 ? 1.08 : 1 / 1.08;
      surfaceState.fov = Math.max(20, Math.min(95, surfaceState.fov * step));
      camera.fov = surfaceState.fov;
      camera.updateProjectionMatrix();
    }, { passive: false });

    // ESC cancels pick mode or exits surface mode. Keeps a clean way out
    // when the user gets stuck without reaching the on-screen button.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (viewMode === 'pick') exitPickMode();
        else if (viewMode === 'surface') exitSurfaceMode();
        return;
      }

      // Don't hijack keys while the user is editing a name field.
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;

      const k = e.key.toLowerCase();

      // Toggle orbits (global shortcut)
      if (k === 'o') {
        const next = !showSatelliteOrbits;
        setSatelliteOrbitLinesVisible(next);
        const satInput = document.getElementById('showSatelliteOrbits');
        if (satInput) satInput.checked = next;

        const orbitsInput = document.getElementById('showOrbits');
        if (orbitsInput) {
          orbitsInput.checked = next;
          orbitLinesGroup.visible = next;
        }
        e.preventDefault();
        return;
      }

      // Navigation (orbit/pick modes)
      if (viewMode !== 'surface') {
        if (k === 'arrowup' || k === 'w') { navUp(); e.preventDefault(); }
        else if (k === 'arrowdown' || k === 's') { navDown(); e.preventDefault(); }
        else if (k === 'arrowleft' || k === 'a') { navSibling(-1); e.preventDefault(); }
        else if (k === 'arrowright' || k === 'd') { navSibling(1); e.preventDefault(); }
        return;
      }

      // Movement (surface mode)
      if (k === 'w' || k === 'arrowup')    { surfaceKeys.w = true; e.preventDefault(); }
      else if (k === 's' || k === 'arrowdown')  { surfaceKeys.s = true; e.preventDefault(); }
      else if (k === 'a' || k === 'arrowleft')  { surfaceKeys.a = true; e.preventDefault(); }
      else if (k === 'd' || k === 'arrowright') { surfaceKeys.d = true; e.preventDefault(); }
      else if (k === 'shift') surfaceKeys.shift = true;
      else if (k === ' ' || e.code === 'Space') { tryJump(); e.preventDefault(); }
      else if (k === 'v') { toggleSurfaceCamera(); e.preventDefault(); }
    });
    document.addEventListener('keyup', (e) => {
      const k = e.key.toLowerCase();
      if (k === 'w' || k === 'arrowup')    surfaceKeys.w = false;
      else if (k === 's' || k === 'arrowdown')  surfaceKeys.s = false;
      else if (k === 'a' || k === 'arrowleft')  surfaceKeys.a = false;
      else if (k === 'd' || k === 'arrowright') surfaceKeys.d = false;
      else if (k === 'shift') surfaceKeys.shift = false;
    });
    // If the window loses focus mid-walk, drop all held keys so the camera
    // doesn't keep drifting on its own when the user returns.
    window.addEventListener('blur', clearSurfaceKeys);

    if (navVisitBtn) {
      navVisitBtn.onclick = () => {
        if (viewMode === 'orbit') enterPickMode();
        else if (viewMode === 'pick') exitPickMode();
        else if (viewMode === 'surface') exitSurfaceMode();
      };
    }
    if (surfaceExitBtn) surfaceExitBtn.onclick = exitSurfaceMode;

    addMoonBtn.onclick = () => {
      const parent = (focusedBody && focusedBody.kind === 'planet') ? focusedBody : planet;
      const ownCount = moons.reduce((n, m) => n + (m.parent === parent ? 1 : 0), 0);
      const defaultDistance = 18 + ownCount * 8;
      if (addMoon(parent, 1.2, defaultDistance)) {
        renderMoonsList();
        updateInfoPanel();
      }
    };

    addProbeBtn.onclick = () => {
      const parent = (focusedBody && focusedBody.kind === 'planet') ? focusedBody : planet;
      if (!parent) return;
      const ownCount = probes.reduce((n, p) => n + (p.parent === parent ? 1 : 0), 0);
      const defaultDistance = 16 + ownCount * 6;
      if (addSatellite(parent, 1.0, defaultDistance)) {
        renderProbesList();
      }
    };

    // ====== 34. Renaming ======
    // Inline edit (click the focused name in the nav) + a 🎲 button that
    // pulls from generateName(). Renaming touches a lot of surfaces — moon
    // cards, city list, info panel, nav, biome hint — so setBodyName is the
    // single fan-out point that re-renders all of them.
    function setBodyName(body, newName) {
      if (!body || !newName) return;
      body.name = newName;
      if (focusedBody === body) {
        focusNameEl.textContent = focusedCity ? `${focusedCity.name} · ${body.name}` : body.name;
      }
      renderNavBodies();
      renderMoonsList();
      renderProbesList();
      renderCityList();
      updateInfoPanel();
      updateBiomeTools();
      applyFocusToLeftPanel();
    }

    function setSystemName(newName) {
      if (!newName) return;
      systemName = newName;
      renderNavBodies();
      updateInfoPanel();
    }

    function commitFocusName(newName) {
      const cleaned = newName.replace(/\s+/g, ' ').trim();
      if (!cleaned) { renderNavBodies(); return; }
      if (focusedProbe) {
        focusedProbe.name = cleaned;
        if (focusedProbe.mesh) focusedProbe.mesh.name = cleaned;
        focusNameEl.textContent = cleaned;
        renderNavBodies();
        renderProbesList();
        updateInfoPanel();
      } else if (focusedCity) {
        focusedCity.name = cleaned;
        focusNameEl.textContent = `${cleaned} · ${focusedCity.body.name}`;
        renderNavBodies();
        renderCityList();
      } else if (focusedBody) {
        setBodyName(focusedBody, cleaned);
      } else {
        setSystemName(cleaned);
      }
    }

    navNameEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); navNameEl.blur(); }
      else if (e.key === 'Escape') { e.preventDefault(); renderNavBodies(); navNameEl.blur(); }
    });
    navNameEl.addEventListener('focus', () => {
      // Select-all on focus so typing replaces the current name.
      requestAnimationFrame(() => {
        const range = document.createRange();
        range.selectNodeContents(navNameEl);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      });
    });
    navNameEl.addEventListener('blur', () => {
      commitFocusName(navNameEl.textContent);
    });

    navRandomBtn.addEventListener('click', () => {
      if (focusedProbe) {
        focusedProbe.name = generateName('moon');
        if (focusedProbe.mesh) focusedProbe.mesh.name = focusedProbe.name;
        focusNameEl.textContent = focusedProbe.name;
        renderNavBodies();
        renderProbesList();
        updateInfoPanel();
      } else if (focusedCity) {
        focusedCity.name = generateName('moon');
        focusNameEl.textContent = `${focusedCity.name} · ${focusedCity.body.name}`;
        renderNavBodies();
        renderCityList();
      } else if (focusedBody) {
        const kind = focusedBody.kind === 'moon' ? 'moon' : 'planet';
        setBodyName(focusedBody, generateName(kind));
      } else {
        setSystemName(generateName('system'));
      }
    });

    // ====== 34. Star-system load / unload ======
    // The 3D scene only ever holds one star system at a time. Switching systems
    // (driven by the galaxy/constellation maps, added in later phases) tears the
    // current one down and bootstraps another into the same renderer/scene — the
    // Sun mesh and starfield are shared and never disposed. Sol is the immutable
    // preset, rebuilt from SOLAR_SYSTEM_SPEC every time, so a reload always
    // returns home; procedural systems live only in memory for the session.

    // ---- Catalog ----------------------------------------------------------
    // The galaxy → constellation → star-system tree the maps (Phase 3/4) will
    // render. Session-only and rebuilt fresh on every load: Sol always exists
    // in Helios Sector; the other constellations start empty and fill with
    // user-created systems. mapX/mapY are normalized [0..1] positions for the
    // map overlays; the empties are placed now so the galaxy map has anchors.
    const galaxy = {
      id: 'milky-way',
      name: 'Milky Way Galaxy',
      constellations: [
        { id: 'helios-sector', name: 'Helios Sector', mapX: 0.50, mapY: 0.52, starSystems: [
          { id: 'sol', name: 'Sol', isPreset: true, constellationId: 'helios-sector', mapX: 0.50, mapY: 0.50 },
        ] },
        { id: 'orion',       name: 'Orion',        mapX: 0.30, mapY: 0.34, starSystems: [] },
        { id: 'lyra',        name: 'Lyra',         mapX: 0.70, mapY: 0.30, starSystems: [] },
        { id: 'draco',       name: 'Draco',        mapX: 0.22, mapY: 0.66, starSystems: [] },
        { id: 'cygnus',      name: 'Cygnus',       mapX: 0.78, mapY: 0.62, starSystems: [] },
        { id: 'carina',      name: 'Carina',       mapX: 0.46, mapY: 0.80, starSystems: [] },
      ],
    };
    // Scatter the constellations across the galaxy map with rough spacing so the
    // sectors look randomly placed (like the systems inside them), not on a fixed
    // grid. Session-only — re-rolled each load. mapX/mapY can also be dragged.
    (function scatterConstellations() {
      const placed = [];
      const minD = 0.24;
      galaxy.constellations.forEach(con => {
        let x, y, tries = 0;
        do {
          x = 0.15 + Math.random() * 0.70;
          y = 0.18 + Math.random() * 0.60;
          tries++;
        } while (tries < 50 && placed.some(p => Math.hypot(p.x - x, p.y - y) < minD));
        placed.push({ x, y });
        con.mapX = x;
        con.mapY = y;
      });
    })();

    // id of the system currently built into the 3D scene (set by loadStarSystem).
    let currentSystemId = null;
    let systemSeq = 0; // monotonic counter for unique procedural-system ids
    // Where we are above the 3D scene. Declared here (not in 34b) because the
    // bottom-nav render reads it during the very first boot, before 34b runs.
    let viewLevel = 'system';            // 'system' | 'constellation' | 'galaxy'
    // Which constellation the constellation map is showing (the galaxy map can
    // open any constellation, independent of where the loaded system lives).
    let viewedConstellationId = null;

    function allStarSystems() {
      return galaxy.constellations.flatMap(c => c.starSystems);
    }
    function findStarSystem(id) {
      return allStarSystems().find(s => s.id === id) || null;
    }
    function findConstellation(id) {
      return galaxy.constellations.find(c => c.id === id) || null;
    }

    // ---- Procedural generator --------------------------------------------
    // Build a planetSpecs array (same shape as SOLAR_SYSTEM_SPEC) for a new
    // system: 4–9 planets on Kepler-ish widening orbits, weighted archetypes
    // (commoner rock/desert/gas/ice over exotic), giants get rings + more moons.
    // Star archetype is excluded — the central Sun is the shared mesh at origin.
    function randomArchetypeKey() {
      // Weighted bag: terrestrial-ish and giants are common; exotics are rare.
      const weighted = [
        'terrestrial','terrestrial','desert','desert','moon_like','moon_like',
        'gas_giant','gas_giant','ice_giant','ice_planet','ocean','venusian',
        'lava','jungle','swamp','toxic','metal','carbon','storm','living','rogue',
      ];
      return weighted[(Math.random() * weighted.length) | 0];
    }
    function generateStarSystemSpec(seed) {
      const rand = (a, b) => a + Math.random() * (b - a);
      const planetCount = 4 + ((Math.random() * 6) | 0); // 4..9
      const specs = [];
      let distance = rand(110, 160);
      for (let i = 0; i < planetCount; i++) {
        const arch = randomArchetypeKey();
        const isGiant = arch === 'gas_giant' || arch === 'ice_giant';
        const size = isGiant ? rand(0.45, 0.78) : rand(0.14, 0.30);
        // Inner planets orbit faster; tie speed to distance (∝ 1/dist) like Sol.
        const speed = (0.0175 * (120 / distance)) * rand(0.8, 1.2);
        // Moons: giants 0–4, rocky worlds 0–2 (innermost rarely keeps any).
        const moonMax = isGiant ? 4 : 2;
        const moonCount = Math.max(0, Math.round(rand(-0.4, moonMax)));
        const moons = [];
        for (let m = 0; m < moonCount; m++) {
          moons.push({
            name: generateName('moon'),
            size: rand(0.22, isGiant ? 0.45 : 0.34),
            distance: (isGiant ? 18 : 8) + m * rand(5, 9),
            seed: `${seed}-p${i}-m${m}`,
          });
        }
        const spec = {
          name: `Planet ${ROMAN[i] || i + 1}`,
          archetype: arch,
          size,
          distance: Math.round(distance),
          speed,
          inclination: rand(-0.08, 0.08),
          angle: Math.random() * Math.PI * 2,
          seed: `${seed}-p${i}`,
          moons,
        };
        if (isGiant && Math.random() < 0.45) {
          spec.rings = { enabled: true, intensity: rand(0.5, 0.9) };
        }
        specs.push(spec);
        distance += rand(90, 190);
      }
      return specs;
    }

    // ---- Catalog mutations (session only) --------------------------------
    // Create a new procedural system inside a constellation, generating and
    // caching its planetSpecs immediately so the system is reproducible for the
    // session. Returns the new catalog entry (not yet loaded into the scene).
    function createStarSystem(constellationId) {
      const con = findConstellation(constellationId);
      if (!con) return null;
      const id = `sys-${++systemSeq}-${Math.floor(Math.random() * 1e4).toString(36)}`;
      const seed = `${id}-${Math.floor(Math.random() * 1e6).toString(36)}`;
      const entry = {
        id,
        name: generateName('system'),
        isPreset: false,
        constellationId,
        seed,
        planetSpecs: generateStarSystemSpec(seed),
        // Random position within the constellation's local map bounds.
        mapX: 0.5 + (Math.random() - 0.5) * 0.7,
        mapY: 0.5 + (Math.random() - 0.5) * 0.7,
      };
      con.starSystems.push(entry);
      return entry;
    }

    // Remove a system from the catalog. Sol (preset) is undeletable. Refuses to
    // delete the system currently in the scene — callers exit to a map / load
    // another system first. Returns true on success.
    function deleteStarSystem(id) {
      const sys = findStarSystem(id);
      if (!sys || sys.isPreset) return false;
      if (id === currentSystemId) return false;
      const con = findConstellation(sys.constellationId);
      if (!con) return false;
      const idx = con.starSystems.indexOf(sys);
      if (idx >= 0) con.starSystems.splice(idx, 1);
      return true;
    }

    // Load a system by catalog id (convenience wrapper over loadStarSystem).
    function loadStarSystemById(id) {
      const sys = findStarSystem(id);
      if (!sys) return false;
      loadStarSystem(sys);
      return true;
    }

    // Build a system's bodies from a spec array (same shape as SOLAR_SYSTEM_SPEC:
    // each entry is a planet with optional moons[]/probes[]/rings). spawnSolarPlanet
    // is archetype-agnostic, so it serves both the preset and procedural systems.
    // Returns the spawned planet bodies in spec order. Deliberately defined down
    // here: moon/probe seeding needs moons[]/probes[]/cities[] and the climate
    // model declared above. spawnSolarPlanet/addMoon/addSatellite are hoisted.
    function buildSystemFromSpec(specArray) {
      const spawned = specArray.map(spawnSolarPlanet);
      specArray.forEach((spec, i) => {
        const parent = spawned[i];
        (spec.moons || []).forEach(moonSpec => {
          addMoon(parent, moonSpec.size, moonSpec.distance, {
            name: moonSpec.name,
            seed: moonSpec.seed,
            inclination: moonSpec.inclination,
            node: moonSpec.node,
            speedSign: moonSpec.speedSign,
            orbitPath: moonSpec.orbitPath,
          });
        });
        (spec.probes || []).forEach(probeSpec => {
          addSatellite(parent, probeSpec.size, probeSpec.distance, {
            name: probeSpec.name,
            seed: probeSpec.seed,
            inclination: probeSpec.inclination,
            node: probeSpec.node,
            speedSign: probeSpec.speedSign,
            orbitPath: probeSpec.orbitPath,
            speed: probeSpec.speed,
          });
        });
      });
      return spawned;
    }

    // Build Sol from the immutable preset. Earth is the home/default body.
    function bootstrapSolSystem() {
      systemName = 'Sol';
      const solarBodies = buildSystemFromSpec(SOLAR_SYSTEM_SPEC);
      planet = solarBodies[2]; // Earth — the conventional home/default body
    }

    // Tear down every body in the current system. removePlanetBody already
    // cascade-deletes a planet's moons, probes, cities, and orbit line and
    // disposes geometry/materials; with { force } it skips the keep-≥1 guard and
    // the per-planet refocus. Afterwards bodies/planets/moons/probes/cities are
    // all empty. The shared Sun, starfield, and renderer are left intact.
    function unloadStarSystem() {
      if (viewMode === 'surface') exitSurfaceMode();
      else if (viewMode === 'pick') exitPickMode();
      // Drop focus first so nothing renders against a body we're about to
      // dispose (finalizeSystemLoad's list renders run before setSystemFocus).
      focusedBody = null;
      focusedCity = null;
      focusedProbe = null;
      // Snapshot first: removePlanetBody mutates planets[] as it runs.
      for (const body of planets.map(p => p.body)) {
        removePlanetBody(body, { force: true });
      }
      planet = null;
    }

    // Post-build step shared by every system (Sol or procedural): enable the
    // climate model, repaint solid surfaces for frost, and settle into the
    // system-wide view. setSystemFocus() cascades to the planet/moon/probe/nav
    // panels. Mirrors the original end-of-init tail.
    function finalizeSystemLoad() {
      // The world is now fully built and the climate model (section 22b) exists,
      // so switch frost on and repaint every solid body — polar ice and altitude
      // frost show from the first frame. Gas giants and stars skip the repaint
      // (no visible solid surface) but still get a cached climate for the panel.
      climateReady = true;
      for (const b of bodies) {
        computeClimate(b);
        // Only planets render latitude frost; moons keep their fixed palette.
        if (b.kind === 'planet' && b.matter && b.matter.solid) recolorBody(b);
      }
      renderMoonsList();
      renderProbesList();
      updateBiomeTools();
      // Default to the system-wide view so the user sees the whole system.
      setSystemFocus();
      refreshActiveTool();
      updateInfoPanel();
    }

    // Build a user-created system from the planetSpecs cached on its catalog
    // entry (generated once, at create time, so revisiting in the same session
    // reproduces it exactly). planet (home/default) is the innermost planet.
    function bootstrapProceduralSystem(system) {
      systemName = system.name;
      const spawned = buildSystemFromSpec(system.planetSpecs || []);
      planet = spawned[0] || null;
    }

    // Swap the live system. A null system or one flagged isPreset rebuilds Sol;
    // any other spec is generated procedurally (generator added in a later
    // phase). Hooked up to the map overlays once those exist.
    function loadStarSystem(system) {
      unloadStarSystem();
      if (!system || system.isPreset) bootstrapSolSystem();
      else bootstrapProceduralSystem(system);
      currentSystemId = (system && system.id) || 'sol';
      finalizeSystemLoad();
    }

    // Initial boot: load Sol from the catalog (unload is a no-op on an empty
    // scene) so currentSystemId is set through the same path as every later swap.
    loadStarSystem(findStarSystem('sol'));

    // ====== 34b. Star-map overlays ======
    // The galaxy/constellation levels are 2D HTML overlays (not 3D scenes). The
    // bottom transport panel stays visible and drives them: ▲ climbs (system →
    // constellation → galaxy), ▼ descends. Picking a star runs an "Entering…"
    // fade while loadStarSystem() swaps the scene underneath. viewLevel /
    // viewedConstellationId are declared up in section 34 (the bottom-nav render
    // needs them during the first boot, before this runs).
    const mapOverlay          = document.getElementById('mapOverlay');
    const mapGalaxyArt        = document.getElementById('mapGalaxyArt');
    const mapField            = document.getElementById('mapField');
    const mapTitleEl          = document.getElementById('mapTitle');
    const mapEyebrowEl        = document.getElementById('mapEyebrow');
    const mapNewBtn           = document.getElementById('mapNewBtn');
    const mapHintEl           = document.getElementById('mapHint');
    const systemTransitionTxt = document.getElementById('systemTransitionText');

    // The constellation that holds the currently-loaded system (fallback: the
    // first, Helios Sector — should never be needed once a system is loaded).
    function currentConstellation() {
      const sys = findStarSystem(currentSystemId);
      return (sys && findConstellation(sys.constellationId)) || galaxy.constellations[0];
    }

    // Build the spiral-galaxy art once (lazily, on first galaxy-map open): a
    // spinning wrapper carrying star particles laid along two logarithmic arms,
    // warm (pink/white) near the core fading to cool (violet/blue) at the rim,
    // plus a scattering of faint field stars. Left in the DOM after building.
    function buildGalaxyArt() {
      if (!mapGalaxyArt || mapGalaxyArt.dataset.built) return;
      mapGalaxyArt.dataset.built = '1';
      const spin = document.createElement('div');
      spin.className = 'galaxy-spin';
      const frag = document.createDocumentFragment();
      const ramp = [ // warm-core → cool-rim colour stops, lerped by t
        [255, 236, 240], [255, 188, 214], [226, 130, 214], [150, 110, 240], [110, 150, 255],
      ];
      const lerpColor = (t) => {
        const s = Math.max(0, Math.min(0.999, t)) * (ramp.length - 1);
        const i = s | 0, f = s - i, a = ramp[i], b = ramp[i + 1] || a;
        return `rgb(${Math.round(a[0] + (b[0] - a[0]) * f)},${Math.round(a[1] + (b[1] - a[1]) * f)},${Math.round(a[2] + (b[2] - a[2]) * f)})`;
      };
      const addStar = (x, y, size, color, opacity, glow) => {
        const star = document.createElement('span');
        star.className = 'galaxy-star';
        star.style.left = x + '%';
        star.style.top = y + '%';
        star.style.width = size + 'px';
        star.style.height = size + 'px';
        star.style.background = color;
        star.style.opacity = opacity;
        if (glow) star.style.boxShadow = `0 0 ${(size * 1.7).toFixed(1)}px ${color}`;
        frag.appendChild(star);
      };
      const arms = 2, perArm = 180, turns = 2.6;
      for (let arm = 0; arm < arms; arm++) {
        const base = (arm / arms) * Math.PI * 2;
        for (let i = 0; i < perArm; i++) {
          const t = i / perArm;
          const r = Math.pow(t, 0.6) * 46;                  // % radius, tight near core
          const theta = base + t * turns * Math.PI * 2;
          const spread = 0.7 + t * 6;                       // arms thicken outward
          const x = 50 + Math.cos(theta) * r + (Math.random() - 0.5) * spread;
          const y = 50 + Math.sin(theta) * r + (Math.random() - 0.5) * spread;
          const size = (1 - t) * 2.4 + 0.7 + Math.random() * 1.6;
          addStar(x, y, size, lerpColor(t * 1.05), (0.3 + (1 - t) * 0.55).toFixed(2), true);
        }
      }
      for (let i = 0; i < 130; i++) {                        // faint field stars for density
        const ang = Math.random() * Math.PI * 2;
        const rr = Math.pow(Math.random(), 0.5) * 47;
        addStar(50 + Math.cos(ang) * rr, 50 + Math.sin(ang) * rr,
          0.5 + Math.random() * 1.2, 'rgba(220,222,255,0.85)', (0.12 + Math.random() * 0.4).toFixed(2), false);
      }
      spin.appendChild(frag);
      mapGalaxyArt.appendChild(spin);
    }

    // Make a map point draggable: live-update its model's mapX/mapY so the layout
    // persists for the session, and cancel the navigation click if the press was
    // an actual drag (not a tap). onMove redraws dependent art (e.g. lines).
    function enablePointDrag(pt, model, onMove) {
      let down = false, moved = false, sx = 0, sy = 0;
      pt.addEventListener('pointerdown', (e) => {
        if (e.target.classList.contains('map-point-del')) return;
        down = true; moved = false; sx = e.clientX; sy = e.clientY;
        try { pt.setPointerCapture(e.pointerId); } catch (_) {}
      });
      pt.addEventListener('pointermove', (e) => {
        if (!down) return;
        if (!moved && Math.abs(e.clientX - sx) < 4 && Math.abs(e.clientY - sy) < 4) return;
        moved = true;
        pt.classList.add('dragging');
        const rect = mapField.getBoundingClientRect();
        const nx = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        const ny = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
        model.mapX = nx; model.mapY = ny;
        pt.style.left = (nx * 100) + '%';
        pt.style.top = (ny * 100) + '%';
        if (onMove) onMove();
      });
      const end = (e) => {
        if (!down) return;
        down = false;
        pt.classList.remove('dragging');
        try { pt.releasePointerCapture(e.pointerId); } catch (_) {}
      };
      pt.addEventListener('pointerup', end);
      pt.addEventListener('pointercancel', end);
      // Capture phase: swallow the click so a drag doesn't also navigate/travel.
      pt.addEventListener('click', (e) => {
        if (moved) { e.stopImmediatePropagation(); e.preventDefault(); moved = false; }
      }, true);
    }

    // Faint star-chart links: connect each system to its two nearest neighbours,
    // so the systems read as a constellation figure. Coordinates share the points'
    // 0..100 % space (viewBox 100×100, non-uniform scale). Rebuilt on drag.
    function drawConstellationLines(svg, systems) {
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      const pts = systems.map(s => ({ x: s.mapX * 100, y: s.mapY * 100 }));
      const NS = 'http://www.w3.org/2000/svg';
      const seen = new Set();
      for (let i = 0; i < pts.length; i++) {
        // Rank the other points by distance and link to the closest two.
        const near = [];
        for (let j = 0; j < pts.length; j++) {
          if (j === i) continue;
          near.push({ j, d: (pts[i].x - pts[j].x) ** 2 + (pts[i].y - pts[j].y) ** 2 });
        }
        near.sort((a, b) => a.d - b.d);
        near.slice(0, 2).forEach(({ j }) => {
          const key = i < j ? `${i}-${j}` : `${j}-${i}`;
          if (seen.has(key)) return;
          seen.add(key);
          const ln = document.createElementNS(NS, 'line');
          ln.setAttribute('x1', pts[i].x); ln.setAttribute('y1', pts[i].y);
          ln.setAttribute('x2', pts[j].x); ln.setAttribute('y2', pts[j].y);
          svg.appendChild(ln);
        });
      }
    }

    // Open the map overlay if it isn't already up (shared by both levels).
    function showMapOverlay() {
      document.body.classList.add('map-mode');
      mapOverlay.setAttribute('aria-hidden', 'false');
    }

    // Enter the constellation map for a specific constellation. Defaults to the
    // loaded system's home (the level you reach by pressing ▲ from System view).
    function openConstellationMap(constellationId) {
      viewedConstellationId = constellationId || currentConstellation().id;
      viewLevel = 'constellation';
      mapOverlay.classList.remove('is-galaxy');
      showMapOverlay();
      renderConstellationMap();
      renderNavBodies();
    }

    // Enter the galaxy map: every constellation as a node, over the spiral art.
    function openGalaxyMap() {
      viewLevel = 'galaxy';
      mapOverlay.classList.add('is-galaxy');
      buildGalaxyArt();
      showMapOverlay();
      renderGalaxyMap();
      renderNavBodies();
    }

    function closeMap() {
      viewLevel = 'system';
      mapOverlay.classList.remove('is-galaxy');
      document.body.classList.remove('map-mode');
      mapOverlay.setAttribute('aria-hidden', 'true');
      renderNavBodies();
    }

    // Adapt the chrome to the level: "+ New System" and the star hint belong to
    // the constellation level (galaxy is the top, and systems are created inside
    // a constellation). Up/down navigation lives on the bottom transport panel.
    function syncMapButtons() {
      const atConstellation = viewLevel === 'constellation';
      if (mapNewBtn) mapNewBtn.style.display = atConstellation ? '' : 'none';
      if (mapHintEl) {
        mapHintEl.textContent = atConstellation
          ? 'Click a star to travel · hover to inspect · ✕ to delete'
          : 'Click a constellation to explore its systems';
      }
    }

    // Galaxy map: each constellation is a violet nebula node positioned by its
    // mapX/mapY. The node holding the loaded system is ringed (is-active). Click
    // descends into that constellation's star map.
    function renderGalaxyMap() {
      syncMapButtons();
      mapEyebrowEl.textContent = 'Galaxy';
      mapTitleEl.textContent = galaxy.name;
      mapField.innerHTML = '';
      const homeConId = currentConstellation().id;
      galaxy.constellations.forEach(con => {
        const isActive = con.id === homeConId;
        const n = con.starSystems.length;
        const pt = document.createElement('button');
        pt.type = 'button';
        pt.className = 'map-point is-constellation' + (isActive ? ' is-active' : '');
        pt.style.left = (con.mapX * 100) + '%';
        pt.style.top  = (con.mapY * 100) + '%';
        pt.title = con.name;
        pt.innerHTML = `
          <span class="map-point-dot"></span>
          <span class="map-point-label">${con.name}
            <span class="map-point-sub">${n} system${n === 1 ? '' : 's'}${isActive ? ' · here' : ''}</span>
          </span>`;
        pt.addEventListener('click', () => openConstellationMap(con.id));
        enablePointDrag(pt, con);
        mapField.appendChild(pt);
      });
    }

    // Paint a constellation's star systems as glowing points. Sol is the gold
    // preset point and can't be deleted; the loaded system is ringed.
    function renderConstellationMap() {
      syncMapButtons();
      const con = findConstellation(viewedConstellationId) || currentConstellation();
      mapEyebrowEl.textContent = 'Constellation';
      mapTitleEl.textContent = con.name;
      mapField.innerHTML = '';
      const systems = con.starSystems;
      // Constellation links go in first so they sit behind the dots.
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.id = 'mapLines';
      svg.setAttribute('viewBox', '0 0 100 100');
      svg.setAttribute('preserveAspectRatio', 'none');
      mapField.appendChild(svg);
      systems.forEach(sys => {
        const isCurrent = sys.id === currentSystemId;
        const planetCount = sys.isPreset ? SOLAR_SYSTEM_SPEC.length : (sys.planetSpecs || []).length;
        const pt = document.createElement('button');
        pt.type = 'button';
        pt.className = 'map-point'
          + (isCurrent ? ' is-current' : '')
          + (sys.isPreset ? ' is-preset' : '');
        pt.style.left = (sys.mapX * 100) + '%';
        pt.style.top  = (sys.mapY * 100) + '%';
        pt.title = sys.name;
        pt.innerHTML = `
          <span class="map-point-dot"></span>
          <span class="map-point-label">${sys.name}
            <span class="map-point-sub">${planetCount} planets${isCurrent ? ' · here' : ''}</span>
          </span>
          ${sys.isPreset ? '' : '<span class="map-point-del" title="Delete system">✕</span>'}`;
        pt.addEventListener('click', (e) => {
          if (e.target.classList.contains('map-point-del')) {
            e.stopPropagation();
            if (deleteStarSystem(sys.id)) renderConstellationMap();
            return;
          }
          travelToSystem(sys);
        });
        enablePointDrag(pt, sys, () => drawConstellationLines(svg, systems));
        mapField.appendChild(pt);
      });
      drawConstellationLines(svg, systems);
    }

    // Travel to a system: no-op-but-close if it's already loaded, otherwise run
    // the fade and swap the 3D scene mid-fade.
    function travelToSystem(sys) {
      if (sys.id === currentSystemId) { closeMap(); return; }
      runSystemTransition(sys.name, () => {
        loadStarSystem(sys);
        closeMap();
      });
    }

    // Full-screen "Entering …" fade: fade to black, swap at the peak, fade back.
    let transitionBusy = false;
    function runSystemTransition(name, doSwap) {
      if (transitionBusy) { doSwap(); return; }
      transitionBusy = true;
      systemTransitionTxt.textContent = `Entering ${name}…`;
      document.body.classList.add('transitioning');
      setTimeout(() => {
        doSwap();
        setTimeout(() => {
          document.body.classList.remove('transitioning');
          transitionBusy = false;
        }, 450);
      }, 450);
    }

    if (mapNewBtn) {
      mapNewBtn.onclick = () => {
        // Create into whichever constellation the map is showing. On the galaxy
        // map there's no single target, so fall back to the loaded system's home.
        const conId = (viewLevel === 'constellation')
          ? (viewedConstellationId || currentConstellation().id)
          : currentConstellation().id;
        const created = createStarSystem(conId);
        if (!created) return;
        if (viewLevel === 'galaxy') openConstellationMap(conId);
        else renderConstellationMap();
      };
    }
    // Up/down between levels is driven by the bottom transport panel (navUp /
    // navDown), which stays visible on the maps. Esc is a shortcut for ▼:
    // galaxy → home constellation, constellation → the loaded system.
    addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (viewLevel === 'galaxy') { e.preventDefault(); openConstellationMap(); }
      else if (viewLevel === 'constellation') { e.preventDefault(); closeMap(); }
    });

    // ====== 35. Init + Resize ======
    addEventListener('resize', () => {
      camera.aspect = innerWidth / innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(innerWidth, innerHeight);
    });

    // ====== 36. Animate ======
    const clock = new THREE.Clock();
    // Light updates (clock + orbit values) refresh several times per second; we
    // throttle so we're not writing DOM every single frame.
    let liveInfoAccum = 0;
    // Cloud-drift clock. Advances only when unpaused so wind freezes when the
    // sim is paused, matching how orbital motion behaves.
    let gasTime = 0;
    // Plasma clock. Unlike gasTime this advances every frame, paused or not — a
    // star's surface keeps churning even when the orbital sim is frozen.
    let plasmaTime = 0;
    (function loop() {
      requestAnimationFrame(loop);
      const dt = clock.getDelta();
      // Drive the Sun's photosphere + corona and every star body's plasma.
      plasmaTime += dt;
      for (const u of plasmaTickUniforms) u.uTime.value = plasmaTime;
      for (const b of bodies) {
        if (b.plasmaMesh && b.plasmaMesh.visible) {
          b.plasmaMesh.material.uniforms.uTime.value = plasmaTime;
        }
      }
      if (!paused) {
        updatePlanetOrbits(dt);
        updatePlanetRotation(dt);
        gasTime += dt;
        for (const b of bodies) {
          if (!b.gasMesh) continue;
          const u = b.gasMesh.material.uniforms;
          u.uTime.value = gasTime;
          // Time-varying coverage: when coverageVariance > 0, slowly modulate
          // the cloud-pattern threshold so coverage drifts between sparser
          // and denser overcast. Atmosphere mode only (full-gas has no
          // cloud layer). Slider sets the BASE coverage; this oscillates
          // around it with amplitude scaled by variance.
          if (b.matter && b.matter.gas === 'atmosphere') {
            const variance = b.coverageVariance ?? 0;
            if (variance > 0) {
              const base   = b.gasCoverage ?? 0.35;
              const phase  = b.coveragePhase ?? 0;
              const drift  = Math.sin(gasTime * 0.08 + phase) * 0.35 * variance;
              u.uCoverage.value = Math.max(0, Math.min(1, base + drift));
            } else {
              u.uCoverage.value = b.gasCoverage ?? 0.35;
            }
          }
        }
        // Ocean waves drift on the same clock as clouds (frozen while paused).
        // The uniforms live on the compiled shader, captured in userData.shader.
        for (const b of bodies) {
          if (!b.oceanMesh || !b.oceanMesh.visible) continue;
          const os = b.oceanMesh.material.userData.shader;
          if (os) os.uniforms.uWaveTime.value = gasTime;
        }
      }
      updateMoons(dt);
      updateSatellites(dt);
      updateEruptions(dt);
      updateCityMarkers();
      updateSunLightForFocus();
      updateMoonLight();
      updateFocusTracking();

      controls.update();
      // In surface mode the camera rides the focused body — recompute its
      // transform from the body's current world matrix every frame so spin
      // and orbit naturally wheel the sky overhead. Cheap no-op otherwise.
      if (viewMode === 'surface') {
        stepSurfaceWalk(dt);
        updateSurfaceCamera();
        updateAstronaut(dt);
        updateGrass(dt);
        updateRocks(dt);
        updateWaterPatch(dt);
        updateSurfaceSkyEffects();
      }
      if (isPainting && isBrushTool() && lastHitLocal && activeBrushBody) {
        applyBrushToBody(activeBrushBody, lastHitLocal, dt);
      }
      // Galactic band rides with the camera (skybox) and inherits the
      // starfield's daylight fade so it washes out under a daytime atmosphere
      // and blazes on the night side / in space. SURFACE_STAR_OPACITY is the
      // full-brightness reference, so this is 1.0 everywhere but surface-daytime.
      milkyway.position.copy(camera.position);
      milkyMat.uniforms.uBrightness.value = starMat.opacity / SURFACE_STAR_OPACITY;
      liveInfoAccum += dt;
      if (liveInfoAccum >= 0.1) { liveInfoAccum = 0; updateLiveInfo(); }
      renderer.render(scene, camera);
    })();
