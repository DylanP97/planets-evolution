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
      const oceanGeo = new THREE.SphereGeometry(baseRadius, 96, 64);
      const oceanVerts = oceanGeo.attributes.position.count;
      oceanGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(oceanVerts * 3).fill(1), 3));
      oceanGeo.setAttribute('aGlow', new THREE.BufferAttribute(new Float32Array(oceanVerts), 1));
      oceanGeo.setAttribute('aEvap', new THREE.BufferAttribute(new Float32Array(oceanVerts), 1));
      const oceanMat = new THREE.MeshStandardMaterial({
        color: 0xffffff,            // real tint comes from per-vertex colors below
        vertexColors: true,
        roughness: 0.30,
        metalness: 0.05,
        transparent: true,
        opacity: 0.92,
      });
      oceanMat.onBeforeCompile = (shader) => {
        shader.uniforms.uGlowColor = { value: ICE_GLOW_COLOR };
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nattribute float aGlow;\nattribute float aEvap;\nvarying float vGlow;\nvarying float vEvap;')
          .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vGlow = aGlow;\n  vEvap = aEvap;');
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\nuniform vec3 uGlowColor;\nvarying float vGlow;\nvarying float vEvap;')
          .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\n  if (vEvap > 0.5) discard;')   // ocean boiled away here
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
      for (let i = 0; i < body.N; i++) {
        const h = (samples[i] - bias) * amplitude;
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
      if (showSatelliteOrbitsRow) {
        showSatelliteOrbitsRow.style.display = (isPlanet || isMoon || isProbe) ? '' : 'none';
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
      yaw: 0,
      pitch: 0,
      fov: 60,
      eyeHeight: 0.04,                     // body-local units above surface
      groundRadius: 0,                     // body-local radius of the standing surface
      moveSpeed: 0,                        // body-local units per second when walking
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

    function enterSurfaceMode(body, hitPoint) {
      // hitPoint comes in as a world-space Vector3 from the raycast result.
      const localHit = body.mesh.worldToLocal(hitPoint.clone());
      // Snap the eye to the local surface normal at the picked point. This
      // matters more than the picked point's exact radius — the icosphere
      // vertices form the visible "ground", and we want the camera to ride
      // their height field, not float over the click coordinate.
      surfaceState.body = body;
      surfaceState.eyeHeight = Math.max(0.012, body.baseRadius * 0.003);
      buildLocalFrame(localHit, surfaceState.localUp, surfaceState.localFwd, surfaceState.localRight);
      // Place the eye at (vertex height + eyeHeight) along the surface normal.
      // The picked point's local radius is the initial ground level; while
      // walking, stepSurfaceWalk resamples the terrain under each step so the
      // eye rises over mountains and dips into valleys.
      surfaceState.groundRadius = localHit.length();
      // Walk pace scales with body size so small moons don't feel like a
      // marathon and giants don't fly past. Tuned so a full circumnav of an
      // Earth-sized body at sprint takes a couple of minutes.
      surfaceState.moveSpeed = body.baseRadius * 0.12;
      surfaceState.localEye.copy(surfaceState.localUp).multiplyScalar(surfaceState.groundRadius + surfaceState.eyeHeight);
      surfaceState.yaw = 0;
      surfaceState.pitch = 0;
      surfaceState.fov = 60;

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
    }

    function exitSurfaceMode() {
      if (viewMode !== 'surface') return;
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
    function updateSurfaceSkyEffects() {
      if (viewMode !== 'surface' || !surfaceState.body) {
        starMat.opacity = SURFACE_STAR_OPACITY;
        return;
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
    const _worldLook   = new THREE.Vector3();
    const _worldUp     = new THREE.Vector3();
    const _localLookDir= new THREE.Vector3();
    function updateSurfaceCamera() {
      const body = surfaceState.body;
      if (!body) return;
      body.mesh.updateMatrixWorld();

      // Local look direction: start from forward, rotate by pitch about right,
      // then by yaw about up. Order matters — yaw last so the horizon stays
      // level relative to the surface (not the camera).
      _localLookDir.copy(surfaceState.localFwd)
        .applyAxisAngle(surfaceState.localRight, surfaceState.pitch)
        .applyAxisAngle(surfaceState.localUp, surfaceState.yaw)
        .normalize();

      _worldEye.copy(surfaceState.localEye).applyMatrix4(body.mesh.matrixWorld);
      _worldUp.copy(surfaceState.localUp).transformDirection(body.mesh.matrixWorld);
      _worldLook.copy(_localLookDir).transformDirection(body.mesh.matrixWorld)
        .add(_worldEye);

      camera.position.copy(_worldEye);
      camera.up.copy(_worldUp);
      camera.lookAt(_worldLook);
    }

    // WASD walking. Movement happens in body-local space along the tangent
    // plane at the current standing point, then the position is renormalized
    // to the standing sphere (groundRadius + eyeHeight). The local frame is
    // parallel-transported across the surface so yaw stays meaningful — the
    // direction the user faces relative to "north" remains consistent step
    // to step.
    const surfaceKeys = { w: false, a: false, s: false, d: false, shift: false };
    const SURFACE_SPRINT_MULT = 3.0;
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
      // On bodies with oceans, never descend below sea level — walk on the
      // waterline instead of sinking to the seabed.
      if (body.matter && body.matter.liquid) ground = Math.max(ground, body.baseRadius);
      return ground;
    }

    function stepSurfaceWalk(dt) {
      if (viewMode !== 'surface' || !surfaceState.body) return;
      const fwdInput    = (surfaceKeys.w ? 1 : 0) + (surfaceKeys.s ? -1 : 0);
      const strafeInput = (surfaceKeys.d ? 1 : 0) + (surfaceKeys.a ? -1 : 0);
      if (fwdInput === 0 && strafeInput === 0) return;

      // Heading and strafe in local space: take the basis vectors and rotate
      // them by the current yaw about local up, so "forward" is whichever way
      // the user is currently facing.
      _walkHeading.copy(surfaceState.localFwd)
        .applyAxisAngle(surfaceState.localUp, surfaceState.yaw);
      _walkStrafe.copy(surfaceState.localRight)
        .applyAxisAngle(surfaceState.localUp, surfaceState.yaw);

      const speed = surfaceState.moveSpeed * (surfaceKeys.shift ? SURFACE_SPRINT_MULT : 1);
      const step  = speed * dt;
      _walkDelta.set(0, 0, 0)
        .addScaledVector(_walkHeading, fwdInput * step)
        .addScaledVector(_walkStrafe,  strafeInput * step);

      surfaceState.localEye.add(_walkDelta);

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

    // ====== 33. Surface input ======
    let surfaceDragging = false;
    let surfaceDragLastX = 0;
    let surfaceDragLastY = 0;
    const SURFACE_LOOK_SPEED = 0.0035; // radians per pixel
    const SURFACE_PITCH_LIMIT = Math.PI * 0.49;

    renderer.domElement.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (viewMode === 'pick') {
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
        e.preventDefault();
        surfaceDragging = true;
        surfaceDragLastX = e.clientX;
        surfaceDragLastY = e.clientY;
        renderer.domElement.setPointerCapture(e.pointerId);
      }
    });

    renderer.domElement.addEventListener('pointermove', (e) => {
      if (!surfaceDragging || viewMode !== 'surface') return;
      const dx = e.clientX - surfaceDragLastX;
      const dy = e.clientY - surfaceDragLastY;
      surfaceDragLastX = e.clientX;
      surfaceDragLastY = e.clientY;
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

    // Scroll = FOV zoom in surface mode. We piggyback on the canvas wheel
    // event with capture so we can intercept it before OrbitControls (which
    // is disabled anyway, but the listener still exists).
    renderer.domElement.addEventListener('wheel', (e) => {
      if (viewMode !== 'surface') return;
      e.preventDefault();
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

    // Temporary console harness for Phase 2 (no map UI yet). Drive system swaps
    // from devtools to verify the engine end-to-end, e.g.:
    //   galaxyDebug.list()                       → every system + which is loaded
    //   galaxyDebug.create('orion')              → make a random system in Orion
    //   galaxyDebug.load('<id from list>')        → swap the 3D scene to it
    //   galaxyDebug.load('sol')                  → return home
    //   galaxyDebug.remove('<id>')               → delete a (non-current) system
    // Removed once the map overlays drive these (Phase 3/4).
    window.galaxyDebug = {
      galaxy,
      list() {
        return allStarSystems().map(s => ({
          id: s.id,
          name: s.name,
          constellation: s.constellationId,
          planets: s.isPreset ? SOLAR_SYSTEM_SPEC.length : (s.planetSpecs || []).length,
          current: s.id === currentSystemId,
        }));
      },
      create: (constellationId = 'orion') => createStarSystem(constellationId),
      load: (id) => loadStarSystemById(id),
      remove: (id) => deleteStarSystem(id),
      current: () => currentSystemId,
    };

    // ====== 34b. Star-map overlays ======
    // The galaxy/constellation levels are 2D HTML overlays (not 3D scenes). The
    // bottom transport panel stays visible and drives them: ▲ climbs (system →
    // constellation → galaxy), ▼ descends. Picking a star runs an "Entering…"
    // fade while loadStarSystem() swaps the scene underneath. viewLevel /
    // viewedConstellationId are declared up in section 34 (the bottom-nav render
    // needs them during the first boot, before this runs).
    const mapOverlay          = document.getElementById('mapOverlay');
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
      con.starSystems.forEach(sys => {
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
        mapField.appendChild(pt);
      });
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
      }
      updateMoons(dt);
      updateSatellites(dt);
      updateEruptions(dt);
      updateCityMarkers();
      updateSunLightForFocus();
      updateFocusTracking();
      controls.update();
      // In surface mode the camera rides the focused body — recompute its
      // transform from the body's current world matrix every frame so spin
      // and orbit naturally wheel the sky overhead. Cheap no-op otherwise.
      if (viewMode === 'surface') {
        stepSurfaceWalk(dt);
        updateSurfaceCamera();
        updateSurfaceSkyEffects();
      }
      if (isPainting && isBrushTool() && lastHitLocal && activeBrushBody) {
        applyBrushToBody(activeBrushBody, lastHitLocal, dt);
      }
      liveInfoAccum += dt;
      if (liveInfoAccum >= 0.1) { liveInfoAccum = 0; updateLiveInfo(); }
      renderer.render(scene, camera);
    })();
