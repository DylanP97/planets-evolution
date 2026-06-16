// Instanced grass on vegetated worlds — treadmill grid that wraps around the
// walker, ground sampling, wind sway. One shared blade geometry renders three
// biome variants (meadow / forest-floor understory / tundra sedge), chosen
// per-blade from the terrain's own climate zone: each blade picks its tint,
// height, width and density from GRASS_ZONE_STYLE, so the lawn changes character
// as you cross from grassland into forest or tundra rather than being one flat
// green everywhere.
import * as THREE from 'three';
import {
  BODY_HEIGHT_SCALE, MAX_LAND_HEIGHT
} from '../../core/constants.js';
// FACE_BIOME + groundBiomeOfFace are the canonical surface-biome classifier;
// they live in framework/body.js so lower layers (interaction/) can share them.
import { CLIMATE_LAND_ZONES, FACE_BIOME, groundBiomeOfFace } from '../../framework/body.js';
import { viewMode } from '../../framework/state.js';
import { surfaceState } from './core.js';
import {
  _gAxisY, _gMat, _gP, _gQuat, _gRot, _gScale, _gTilt, _gUp, _grDir, _grHit, _grOrigin, grassRaycaster
} from './scratch.js';

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
export const GRASS_COUNT = 52000;    // dense enough to keep the lawn solid out to the (now past-horizon) patch edge
export const GRASS_GN    = 18;       // height + biome grid resolution (GN×GN raycast samples) — finer so small painted patches + biome edges register
export let grassField = null;
export let grassUniforms = null;     // captured from onBeforeCompile (uTime/uWind/uReveal)

// Per-zone grass look, indexed by the code grassZoneOfFace returns
// (1 meadow · 2 tundra sedge · 3 forest/jungle understory; 0 = bare, unused).
// One shared blade geometry serves all three — the differences are purely
// per-instance: `color` is the blade base (multiplied by each blade's brightness
// jitter), `hMul`/`wMul` stretch the blade taller-shorter / broader-finer, and
// `dens` is the fraction of blades kept so tundra reads as sparse hardy sedge
// while forest floor packs in lush and tall. Tints sit near each climate zone's
// painted ground colour (constants COL / CLIMATE_LAND_ZONES) so blades cohere
// with the terrain they grow on.
const GRASS_ZONE_STYLE = [
  null,
  { color: new THREE.Color(0x6fc34a), hMul: 1.25, wMul: 1.05, dens: 1.00 }, // meadow grass — bright, taller than the flat ground so it reads
  { color: new THREE.Color(0x9e8a4a), hMul: 0.72, wMul: 0.85, dens: 0.88 }, // tundra sedge — short & brownish, but dense enough to read as grass
  { color: new THREE.Color(0x2f8a39), hMul: 1.55, wMul: 1.35, dens: 1.00 }, // forest/jungle understory — tall, broad, lush
];
const _grBlade = new THREE.Color();  // scratch for per-blade instanceColor writes

// One tapered blade pointing +Y, base at y=0, tip at y=1. Normals point
// straight up so the instance orientation lights each blade like the ground
// patch it stands on (vertical flat normals would crush to black edge-on).
// A base→tip grey gradient in vertex color fakes ambient occlusion at the
// roots; the per-instance color and material tint layer green on top.
export function buildGrassBladeGeometry() {
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

export function buildGrassField() {
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
  const jitter    = new Float32Array(GRASS_COUNT * 3);  // per-blade brightness/warmth — multiplied by the zone tint each placement
  const rnd       = new Float32Array(GRASS_COUNT);      // stable per-blade [0,1) — gates sparse zones (tundra)
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
      // wash; the zone green is multiplied on top each placement (updateGrass).
      const v = 0.72 + Math.random() * 0.42;
      jitter[3 * i]     = v * (0.88 + Math.random() * 0.22);
      jitter[3 * i + 1] = v;
      jitter[3 * i + 2] = v * (0.82 + Math.random() * 0.22);
      rnd[i] = Math.random();
      tint.setRGB(jitter[3 * i], jitter[3 * i + 1], jitter[3 * i + 2]);
      mesh.setColorAt(i, tint);
    }
  }
  mesh.instanceColor.needsUpdate = true;
  mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);  // recoloured per zone as the walker crosses biomes
  grassField = {
    mesh, mat, baseUV, yaw, hScale, leanAmt, leanTheta, jitter, rnd, fadeArr,
    reveal: 0, targetReveal: 0, sampleTimer: 0, PR: 1, bladeH: 0.02,
    // Height grid: ground radii sampled in a snapshot tangent frame, so blades
    // read terrain height by bilinear lookup instead of one flat sphere.
    grid: new Float32Array(GRASS_GN * GRASS_GN),
    gridGrass: new Float32Array(GRASS_GN * GRASS_GN),  // 1 = grass-biome cell, 0 = bare (sand/water/rock)
    gridZone: new Float32Array(GRASS_GN * GRASS_GN),   // grass-variant code per cell (1 meadow / 2 tundra / 3 forest)
    gridHalf: 1, gridValid: false,
    gridU: 0, gridV: 0,
    gridUp: new THREE.Vector3(), gridRight: new THREE.Vector3(), gridFwd: new THREE.Vector3(),
    lastU: NaN, lastV: NaN, placed: false,
  };
}

// Attach the (lazily built) grass to a body for a fresh surface visit.
// PR (patch half-size) and blade height scale to the body's eye height so the
// lawn reads the same on a moon or a giant.
export function attachGrass(body) {
  if (!grassField) buildGrassField();
  const gf = grassField;
  // Patch half-size MUST reach past the visible horizon, or you watch grass fade
  // in ahead of you (the old fixed eye-height multiple fell short on planets,
  // where the character is shrunk 0.4× so the horizon sits much farther out in
  // eye-heights). The geometric horizon on a sphere from eye height h is
  // √(2·R·h); we draw 1.35× that so the whole fade band lands BELOW the skyline,
  // where the planet's own curvature occludes it — the walker never sees the
  // wrap/fade. Clamped to the old radius as a floor for tiny bodies.
  const _horizon = Math.sqrt(2 * body.baseRadius * surfaceState.eyeHeight);
  gf.PR     = Math.max(surfaceState.eyeHeight * 30, _horizon * 1.8);
  gf.bladeH = surfaceState.eyeHeight * 0.8;      // taller so the lawn reads clearly from the trailing camera
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

export function detachGrass() {
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
      faceBiome: groundBiomeOfFace(body, f), // FACE_BIOME code (1 grass·2 forest·3 jungle·4 tundra·5 ice·6 coast·7 desert)
      zoneCode: grassZoneOfFace(body, f),   // 0 bare · 1 meadow · 2 tundra · 3 forest
    } : 'raycast missed';
  }
  return {
    VERSION: 'grass-biomes-v5',
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
// FACE_BIOME + groundBiomeOfFace (the canonical surface-biome classifier) now
// live in framework/body.js and are imported above — this module just maps
// their codes to a grass-variant style below.

// Grass-variant code (GRASS_ZONE_STYLE index) for terrain face `f`: 0 bare,
// 1 meadow, 2 tundra sedge, 3 forest/jungle understory. Grass grows on grass,
// forest, jungle and tundra ground; coast, ice, desert and bare rock grow none.
export function grassZoneOfFace(body, f) {
  switch (groundBiomeOfFace(body, f)) {
    case FACE_BIOME.GRASS:  return 1;
    case FACE_BIOME.TUNDRA: return 2;
    case FACE_BIOME.FOREST: return 3;
    case FACE_BIOME.JUNGLE: return 3;
    default:                return 0;
  }
}

// True when face `f` grows any grass at all (gates the field on/off + the fade
// mask). Thin wrapper over grassZoneOfFace; props.js imports this.
export function groundIsGrassFace(body, f) { return grassZoneOfFace(body, f) !== 0; }

// Throttled on/off gate for the whole lawn. We keep the field REVEALED whenever
// any grass exists in the patch around the walker — read from the biome grid,
// not just the face under the avatar's feet. (The old foot-probe blinked the
// ENTIRE lawn off the instant a single bare face slid under the avatar — a rocky
// rise, a dip toward the shore, an icosphere seam — even while grass surrounded
// you, which read as "grass regions with no grass". The per-cell mask + per-blade
// zone in updateGrass still hide/keep each individual blade over its own ground,
// so this gate only decides "is there a lawn here at all", and the grid already
// knows that for the whole field.) Falls back to a downward ray under the avatar
// for the first frame, before the grid has been built.
export function sampleGrassGround() {
  const body = surfaceState.body, gf = grassField;
  if (!body) { gf.targetReveal = 0; return; }
  if (gf.gridValid) {
    const g = gf.gridGrass;
    let any = false;
    for (let k = 0; k < g.length; k++) if (g[k] > 0) { any = true; break; }
    gf.targetReveal = any ? 1 : 0;
    return;
  }
  body.mesh.updateMatrixWorld();
  const mw = body.mesh.matrixWorld;
  const high = body.baseRadius * (1 + MAX_LAND_HEIGHT * BODY_HEIGHT_SCALE) + 1;
  const footR = surfaceState.groundRadius;
  const up = surfaceState.localUp;
  _grHit.copy(up).multiplyScalar(footR).normalize();
  _grOrigin.copy(_grHit).multiplyScalar(high).applyMatrix4(mw);
  _grDir.copy(_grHit).multiplyScalar(-1).transformDirection(mw).normalize();
  grassRaycaster.set(_grOrigin, _grDir);
  const hits = grassRaycaster.intersectObject(body.mesh, false);
  const f = hits.length ? hits[0].face : null;
  gf.targetReveal = (f && groundIsGrassFace(body, f)) ? 1 : 0;
}

// Re-sample the terrain-height grid in the avatar's current tangent frame,
// snapshotting that frame so blades can be placed relative to it until the
// walker drifts far enough to warrant a fresh grid. GN×GN downward raycasts.
export function refreshGrassGrid() {
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
      let r = footR, zone = 0;
      if (hits.length) {
        _grHit.copy(hits[0].point); body.mesh.worldToLocal(_grHit); r = _grHit.length();
        zone = grassZoneOfFace(body, hits[0].face);   // 0 bare / 1 meadow / 2 tundra / 3 forest
        if (body.matter && body.matter.liquid) r = Math.max(r, body.baseRadius);
      }
      gf.grid[iy * GN + ix] = r;
      gf.gridGrass[iy * GN + ix] = zone ? 1 : 0;
      gf.gridZone[iy * GN + ix] = zone;
    }
  }
  gf.gridValid = true;
}

// Bilinear ground radius from the snapshot grid at snapshot-tangent (su, sv).
export function grassGroundRadius(gf, su, sv) {
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
export function grassMask(gf, su, sv) {
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

// Nearest-cell grass-variant code (1 meadow / 2 tundra / 3 forest) from the
// snapshot zone grid. Categorical, so it snaps to the closest sample rather than
// blending — a blade is wholly one kind of grass, and the variant flips cell-to-
// cell at biome edges (the coverage mask above still feathers the lawn out where
// it meets bare ground, so the seam never looks hard).
export function grassZone(gf, su, sv) {
  const GN = GRASS_GN, GH = gf.gridHalf;
  let fx = Math.round((su / GH * 0.5 + 0.5) * (GN - 1));
  let fy = Math.round((sv / GH * 0.5 + 0.5) * (GN - 1));
  fx = fx < 0 ? 0 : fx > GN - 1 ? GN - 1 : fx;
  fy = fy < 0 ? 0 : fy > GN - 1 ? GN - 1 : fy;
  return gf.gridZone[fy * GN + fx];
}

// Per-frame: refresh the biome probe + height grid as needed, advance wind +
// reveal, and (only when the patch actually moved) re-place every blade.
export function updateGrass(dt) {
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
    let mf = (grassMask(gf, driftU + u, driftV + v) - 0.15) * 1.8;
    mf = mf < 0 ? 0 : mf > 1 ? 1 : mf;
    // Which kind of grass stands on this cell, and its look. Sparse zones
    // (tundra) thin themselves out via a stable per-blade keep test, so the same
    // blades stay dropped frame to frame instead of flickering.
    const st = GRASS_ZONE_STYLE[grassZone(gf, driftU + u, driftV + v)] || GRASS_ZONE_STYLE[1];
    let fade = ef * mf;
    if (gf.rnd[i] >= st.dens) fade = 0;                          // density cull (sparse sedge)
    if (fade <= 0.004) { gf.fadeArr[i] = 0; _gMat.makeScale(0, 0, 0); gf.mesh.setMatrixAt(i, _gMat); continue; }
    fade = fade * fade * (3 - 2 * fade);                          // smoothstep ease
    gf.fadeArr[i] = fade;                                         // height (below) + shading flatten (shader)
    // Per-blade zone tint = stored brightness jitter × the zone's base colour.
    _grBlade.setRGB(gf.jitter[3 * i] * st.color.r, gf.jitter[3 * i + 1] * st.color.g, gf.jitter[3 * i + 2] * st.color.b);
    gf.mesh.setColorAt(i, _grBlade);
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
    const s  = bladeH * gf.hScale[i] * fade;
    const sy = s * st.hMul, sxz = s * st.wMul;                    // taller-shorter / broader-finer per zone
    _gScale.set(sxz, sy, sxz);
    _gMat.compose(_gP, _gQuat, _gScale);
    gf.mesh.setMatrixAt(i, _gMat);
  }
  gf.mesh.instanceMatrix.needsUpdate = true;
  gf.mesh.instanceColor.needsUpdate = true;
  gf.mesh.geometry.getAttribute('aFade').needsUpdate = true;
}

