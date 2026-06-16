// Footprint decals on soft-soil worlds (venusian/desert/moon_like).
//
// A standalone near-field layer, fully decoupled from the disabled ground patch
// (see ground.js → ENABLE_GROUND_PATCH). It is a flat, tessellated plane parented
// to body.mesh that rides the same grassU/grassV treadmill the other surface
// fields use. The plane is curved onto the sphere and lifted to the real terrain
// height (sampled by a small GP raycast grid, exactly like the ground patch did)
// so the prints sit flush on the ground at every distance.
//
// The key difference from the ground patch — and the reason this doesn't bring
// back the "dark square that tracks the avatar" bug — is the ALPHA: the layer is
// completely transparent everywhere except the boot-shaped fragments, so there is
// no full-plane overlay to shade differently from the terrain. Each boot print is
// an oriented SDF (rounded sole + heel + tread bars) evaluated in the FRAGMENT
// shader: it tints the soil darker in the tread, throws a pale rim of displaced
// regolith, and bends the shading normal into a soft depression. Prints live in
// ground-fixed treadmill coords so they stay put as the avatar walks away, and
// they settle (fade) over ~FOOT_LIFE seconds. Ring buffer: oldest slot reused.
import * as THREE from 'three';
import {
  BODY_HEIGHT_SCALE, CLIMATE_LAPSE_C, KELVIN_ZERO_C, MAX_LAND_HEIGHT, ROCK_TOP, SAND_TOP
} from '../../core/constants.js';
import { smoothstep } from '../../core/utils.js';
import { CLIMATE_LAND_ZONES, pickLandZone } from '../../framework/body.js';
import { viewMode } from '../../framework/state.js';
import { surfaceState } from './core.js';
import { _gP, _gUp, _grDir, _grHit, _grOrigin, grassRaycaster } from './scratch.js';

export const FOOT_N    = 48;               // live print slots (vec4 uniform array)
export const FOOT_LIFE = 70;               // seconds before a print fully settles away
const FP_PATCH_N = 64;                     // plane grid resolution (verts per side)
const FP_GN      = 12;                      // height/colour sample grid (FP_GN² raycasts on re-anchor)

// Planet archetypes that are soft the whole way down, with strength per band:
// `low` applies below SAND_TOP (venusian slab flats barely dust over; the
// regolith and dark soil above take a full print).
export const FOOTPRINT_GROUND = {
  venusian:  { strength: 1.0,  low: 0.4 },
  desert:    { strength: 0.75, low: 0.75 },
  moon_like: { strength: 0.9,  low: 0.9 },
};

// Strengths for the biome-gated soft ground found on other worlds.
const MOON_FOOT_STR = 0.9;    // any moon — regolith / mare / frost all take prints
const SAND_FOOT_STR = 0.85;   // sandy beach / coast on Earth-likes
const SNOW_FOOT_STR = 0.8;    // snow caps + the ice biome

// True when a body has soft ground *somewhere* the avatar might stand, so the
// layer is worth attaching. Moons are soft everywhere; Earth-likes take prints
// only on sand/ice (gated per-step in footprintStrengthHere).
function bodyCanPrint(body) {
  return body.kind === 'moon'
    || !!FOOTPRINT_GROUND[body.archetype]
    || body.archetype === 'terrestrial';
}

export let footLayer = null;
let footLayerUniforms = null;

function buildFootLayer() {
  // ONE cell array, shared by the shader uniform AND refreshFootGrid — so the
  // raycast samples we write actually reach the GPU. Radius in .x, sampled
  // terrain colour (used to tint the prints) in .yzw.
  const cell = new Float32Array(4 * FP_GN * FP_GN);
  const foot = new Float32Array(4 * FOOT_N);   // per print vec4(u, v, yaw, fade); fade==0 = empty
  const geo = new THREE.PlaneGeometry(2, 2, FP_PATCH_N - 1, FP_PATCH_N - 1);
  geo.rotateX(-Math.PI / 2);        // lie flat in XZ; position.xz ∈ [-1,1] are the tangent coords
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.96, metalness: 0.0,
    transparent: true, opacity: 1.0, side: THREE.DoubleSide,
  });
  mat.polygonOffset = true;         // bias in front of the coarse mesh it overlays
  mat.polygonOffsetFactor = -1;
  mat.polygonOffsetUnits = -1;
  mat.depthWrite = false;           // translucent decal — must not occlude grass/props behind it
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uPUp       = { value: new THREE.Vector3(0, 1, 0) };
    sh.uniforms.uPRight    = { value: new THREE.Vector3(1, 0, 0) };
    sh.uniforms.uPFwd      = { value: new THREE.Vector3(0, 0, 1) };
    sh.uniforms.uPR        = { value: 0.4 };                       // patch half-size (body-local units)
    sh.uniforms.uRef       = { value: 12 };                        // reference radius for tangent curvature
    sh.uniforms.uGridHalf  = { value: 0.5 };                       // half-extent the cell grid covers
    sh.uniforms.uGridDrift = { value: new THREE.Vector2(0, 0) };   // current-frame → snapshot-frame offset
    sh.uniforms.uDrift     = { value: new THREE.Vector2(0, 0) };   // ground-fixed footprint coords offset
    sh.uniforms.uEps       = { value: 0.01 };                      // finite-difference step for base normals
    sh.uniforms.uReveal    = { value: 0 };                         // fade-in on attach
    sh.uniforms.uCell      = { value: cell };
    sh.uniforms.uFoot      = { value: foot };                      // footprint decals
    sh.uniforms.uFootLen   = { value: 0.05 };                      // boot length, body-local units
    footLayerUniforms = sh.uniforms;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>',
        '#include <common>\n'
      + 'uniform vec3 uPUp;\nuniform vec3 uPRight;\nuniform vec3 uPFwd;\n'
      + 'uniform float uPR;\nuniform float uRef;\nuniform float uGridHalf;\n'
      + 'uniform vec2 uGridDrift;\nuniform vec2 uDrift;\nuniform float uEps;\n'
      + 'uniform vec4 uCell[' + (FP_GN * FP_GN) + '];\n'
      + 'varying float vEdge;\nvarying vec3 vGCol;\n'
      // #ifndef-guarded: three.js can invoke onBeforeCompile more than once over
      // an already-patched string (program variants), so bare varying declarations
      // here would land twice → "redefinition" compile errors.
      + '#ifndef FPL_VARYINGS\n#define FPL_VARYINGS\nvarying vec2 vWd;\nvarying vec3 vTanR;\nvarying vec3 vTanF;\n#endif\n'
      + 'vec4 cellAt(vec2 w){ const float GN = ' + FP_GN + '.0; float fx = (w.x / uGridHalf * 0.5 + 0.5) * (GN - 1.0); float fy = (w.y / uGridHalf * 0.5 + 0.5) * (GN - 1.0); fx = clamp(fx, 0.0, GN - 1.0); fy = clamp(fy, 0.0, GN - 1.0); float x0 = floor(fx); float y0 = floor(fy); float x1 = min(x0 + 1.0, GN - 1.0); float y1 = min(y0 + 1.0, GN - 1.0); float tx = fx - x0; float ty = fy - y0; vec4 a = mix(uCell[int(y0 * GN + x0)], uCell[int(y0 * GN + x1)], tx); vec4 b = mix(uCell[int(y1 * GN + x0)], uCell[int(y1 * GN + x1)], tx); return mix(a, b, ty); }')
      .replace('#include <beginnormal_vertex>',
        '#include <beginnormal_vertex>\n'
      + '  vec2 _puv = position.xz;\n'
      + '  float _pu = _puv.x * uPR;\n  float _pv = _puv.y * uPR;\n'
      + '  vec2 _wc = vec2(_pu, _pv) + uGridDrift;\n'
      + '  vec4 _cell = cellAt(_wc);\n'
      + '  vGCol = _cell.yzw;\n'
      + '  float _ph = _cell.x;\n'                                  // sit on the real terrain height
      + '  vec3 _pdir = normalize(uPUp * uRef + uPRight * _pu + uPFwd * _pv);\n'
      + '  float _e = uEps;\n'
      + '  float _hx = cellAt(_wc + vec2(_e, 0.0)).x;\n'
      + '  float _hy = cellAt(_wc + vec2(0.0, _e)).x;\n'
      + '  float _sx = (_hx - _ph) / _e;\n  float _sy = (_hy - _ph) / _e;\n'
      + '  objectNormal = normalize(_pdir - (uPRight * _sx + uPFwd * _sy));\n'
      + '  vEdge = max(abs(_puv.x), abs(_puv.y));')
      .replace('#include <begin_vertex>',
        '#include <begin_vertex>\n  transformed = _pdir * _ph;\n'
      + '  vWd = vec2(_pu, _pv) + uDrift;\n'                        // ground-fixed coords for the decal lookup
      + '  vTanR = normalize(normalMatrix * uPRight);\n'
      + '  vTanF = normalize(normalMatrix * uPFwd);\n');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>',
        '#include <common>\nvarying float vEdge;\nvarying vec3 vGCol;\nuniform float uReveal;\n'
      + '#ifndef FPL_VARYINGS\n#define FPL_VARYINGS\nvarying vec2 vWd;\nvarying vec3 vTanR;\nvarying vec3 vTanF;\n#endif\n'
      + 'uniform vec4 uFoot[' + FOOT_N + '];\nuniform float uFootLen;\n'
      // Footprint accumulators, filled in color_fragment (which runs before
      // normal_fragment_begin) and consumed there for the depression normal.
      + 'float _fpDark = 0.0;\nfloat _fpRim = 0.0;\nvec2 _fpGrad = vec2(0.0);\n'
      // Boot-print SDF in print-local coords (units of boot length, +y = direction
      // of travel): a rounded-box sole up front and a round heel behind.
      + 'float fpBox(vec2 p, vec2 b, float r){ vec2 d = abs(p) - b + r; return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r; }\n'
      + 'float fpSD(vec2 q){ return min(fpBox(q - vec2(0.0, 0.16), vec2(0.17, 0.30), 0.13), length(q - vec2(0.0, -0.33)) - 0.15); }\n')
      .replace('#include <color_fragment>',
        '#include <color_fragment>\n'
      // Footprint decals: per print, rotate into its frame, evaluate the boot
      // SDF, darken the tread, lighten the displaced-soil rim, and build the
      // depression gradient for the normal bend below. Cheap bounding-circle
      // early-outs keep the loop ~free for fragments away from any print.
      + '  for (int i = 0; i < ' + FOOT_N + '; i++) {\n'
      + '    vec4 fp = uFoot[i];\n'
      + '    if (fp.w <= 0.002) continue;\n'
      + '    vec2 off = vWd - fp.xy;\n'
      + '    if (dot(off, off) > uFootLen * uFootLen * 1.4) continue;\n'
      + '    float cy = cos(fp.z), sy = sin(fp.z);\n'
      + '    vec2 q = vec2(cy * off.x - sy * off.y, sy * off.x + cy * off.y) / uFootLen;\n'
      + '    float d = fpSD(q);\n'
      + '    float inside = smoothstep(0.03, -0.04, d);\n'
      + '    float tread = 0.7 + 0.3 * smoothstep(0.22, 0.45, abs(fract(q.y * 5.0) - 0.5));\n'
      + '    _fpDark += fp.w * inside * tread;\n'
      + '    _fpRim  += fp.w * (smoothstep(0.13, 0.02, d) - smoothstep(0.02, -0.03, d));\n'
      + '    float fe = 0.08;\n'
      + '    float b0 = smoothstep(0.12, -0.10, d);\n'
      + '    float gx = (smoothstep(0.12, -0.10, fpSD(q + vec2(fe, 0.0))) - b0) / fe;\n'
      + '    float gy = (smoothstep(0.12, -0.10, fpSD(q + vec2(0.0, fe))) - b0) / fe;\n'
      + '    _fpGrad += vec2(cy * gx + sy * gy, -sy * gx + cy * gy) * fp.w;\n'
      + '  }\n'
      + '  _fpDark = clamp(_fpDark, 0.0, 1.0);\n'
      + '  _fpRim  = clamp(_fpRim, 0.0, 1.0);\n'
      // Colour the print from the soil beneath it: darkened tread, pale lifted rim.
      + '  vec3 _soil = vGCol;\n'
      + '  diffuseColor.rgb = mix(_soil * 0.5, _soil * 1.9 + vec3(0.015), _fpRim * 0.7);\n'
      // ALPHA = 0 except on a print → no square overlay, just the boot decals.
      + '  float _cov = clamp(_fpDark + _fpRim * 0.8, 0.0, 1.0);\n'
      + '  diffuseColor.a = _cov * (1.0 - smoothstep(0.80, 1.0, vEdge)) * uReveal;')
      // Bend the shading normal into each print's depression so the soil visibly
      // takes the boot (lit wall on the sun side, shaded floor).
      .replace('#include <normal_fragment_begin>',
        '#include <normal_fragment_begin>\n'
      + '  if (abs(_fpGrad.x) + abs(_fpGrad.y) > 1e-4) {\n'
      + '    normal = normalize(normal + (vTanR * _fpGrad.x + vTanF * _fpGrad.y) * 0.45);\n'
      + '  }\n');
  };
  mat.customProgramCacheKey = () => 'footLayer';
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 1;             // after the coarse mesh (0), before the water patch (2)
  mesh.castShadow = false;
  // NO receiveShadow: the layer floats a hair above the planet mesh — a
  // system-scale shadow caster — so sampling the sun's shadow map here is pure
  // acne (the same reason the water patch and old ground patch skip shadows).
  mesh.receiveShadow = false;
  mesh.visible = false;
  footLayer = {
    mesh, mat, cell, active: false,
    PR: 1, gridHalf: 1, gridValid: false, gridU: 0, gridV: 0,
    gridUp: new THREE.Vector3(), gridRight: new THREE.Vector3(), gridFwd: new THREE.Vector3(),
    reveal: 0, eps: 0.01, footLen: 0.05,
    // Footprint state: foot is the shared uniform array (u, v, yaw, fade per
    // print); age/str are JS-side, fades recomputed each frame from them.
    foot, footAge: new Float32Array(FOOT_N).fill(FOOT_LIFE), footStr: new Float32Array(FOOT_N),
    footNext: 0, strideAcc: 0, strideSide: 1,
  };
}

// Mount the footprint layer for a visit. Worlds with no soft ground at all (gas
// giants, bare rock) stay detached so the per-frame raycast grid never runs.
export function attachFootLayer(body) {
  if (!bodyCanPrint(body)) { detachFootLayer(); return; }
  if (!footLayer) buildFootLayer();
  const fl = footLayer;
  fl.active = true;
  fl.PR = surfaceState.eyeHeight * 14;
  fl.gridValid = false;
  fl.reveal = 0;
  fl.eps     = surfaceState.eyeHeight * 0.45;   // wider sample → gentler base normals
  fl.footLen = surfaceState.eyeHeight * 0.26;   // boot print length
  // Fresh visit → no leftover prints from the previous world.
  fl.foot.fill(0);
  fl.footAge.fill(FOOT_LIFE);
  fl.footNext = 0; fl.strideAcc = 0; fl.strideSide = 1;
  if (footLayerUniforms) {
    footLayerUniforms.uPR.value      = fl.PR;
    footLayerUniforms.uRef.value     = surfaceState.groundRadius;
    footLayerUniforms.uEps.value     = fl.eps;
    footLayerUniforms.uReveal.value  = 0;
    // Share the live cell/foot arrays with the uniforms so refreshFootGrid and
    // the footprint stamps mutate them in place.
    footLayerUniforms.uCell.value    = fl.cell;
    footLayerUniforms.uFoot.value    = fl.foot;
    footLayerUniforms.uFootLen.value = fl.footLen;
  }
  fl.mesh.visible = false;
  if (fl.mesh.parent) fl.mesh.parent.remove(fl.mesh);
  body.mesh.add(fl.mesh);
}

export function detachFootLayer() {
  if (footLayer) {
    footLayer.active = false;
    if (footLayer.mesh.parent) footLayer.mesh.parent.remove(footLayer.mesh);
  }
}

// Re-sample the base-radius + terrain-colour grid in the avatar's current tangent
// frame (FP_GN² downward raycasts), snapshotting that frame. Stores radius in .x
// and the hit face's colour in .yzw of each cell. Reuses the grass raycaster +
// scratch (runs after updateGrass in the loop, so the share is sequential/safe).
function refreshFootGrid() {
  const fl = footLayer, body = surfaceState.body;
  body.mesh.updateMatrixWorld();
  const mw = body.mesh.matrixWorld;
  const high = body.baseRadius * (1 + MAX_LAND_HEIGHT * BODY_HEIGHT_SCALE) + 1;
  fl.gridUp.copy(surfaceState.localUp);
  fl.gridRight.copy(surfaceState.localRight);
  fl.gridFwd.copy(surfaceState.localFwd);
  fl.gridU = surfaceState.grassU;
  fl.gridV = surfaceState.grassV;
  fl.gridHalf = fl.PR * 1.3;
  const footR = surfaceState.groundRadius, GH = fl.gridHalf, GN = FP_GN, cell = fl.cell, ca = body.colorArr;
  for (let iy = 0; iy < GN; iy++) {
    for (let ix = 0; ix < GN; ix++) {
      const gu = (ix / (GN - 1) * 2 - 1) * GH;
      const gv = (iy / (GN - 1) * 2 - 1) * GH;
      _gP.copy(fl.gridUp).multiplyScalar(footR).addScaledVector(fl.gridRight, gu).addScaledVector(fl.gridFwd, gv);
      _gUp.copy(_gP).normalize();
      _grOrigin.copy(_gUp).multiplyScalar(high).applyMatrix4(mw);
      _grDir.copy(_gUp).multiplyScalar(-1).transformDirection(mw).normalize();
      grassRaycaster.set(_grOrigin, _grDir);
      const hits = grassRaycaster.intersectObject(body.mesh, false);
      let r = footR, cr = 0.4, cg = 0.4, cb = 0.4;
      if (hits.length) {
        _grHit.copy(hits[0].point); body.mesh.worldToLocal(_grHit); r = _grHit.length();
        const f = hits[0].face;
        cr = (ca[3 * f.a]     + ca[3 * f.b]     + ca[3 * f.c])     / 3;
        cg = (ca[3 * f.a + 1] + ca[3 * f.b + 1] + ca[3 * f.c + 1]) / 3;
        cb = (ca[3 * f.a + 2] + ca[3 * f.b + 2] + ca[3 * f.c + 2]) / 3;
      }
      const o = (iy * GN + ix) * 4;
      cell[o] = r; cell[o + 1] = cr; cell[o + 2] = cg; cell[o + 3] = cb;
    }
  }
  fl.gridValid = true;
}

// Per-frame: re-anchor the grid when the walker drifts, age the prints, fade in,
// and push the current tangent frame + drifts into the shader. The mesh itself
// never changes — the GPU projects + displaces it from the uniforms.
export function updateFootprints(dt) {
  if (!footLayer || !footLayer.active || viewMode !== 'surface' || !surfaceState.body) return;
  const fl = footLayer, PR = fl.PR;
  if (!fl.gridValid ||
      Math.abs(surfaceState.grassU - fl.gridU) > PR * 0.4 ||
      Math.abs(surfaceState.grassV - fl.gridV) > PR * 0.4) {
    refreshFootGrid();
  }
  fl.reveal += (1 - fl.reveal) * Math.min(1, dt * 4);
  // Age the footprints: a quick press-in, then a long settle-out. Fades are
  // written straight into the shared uniform array, premultiplied by each print's
  // soil softness (footStr). JS state — runs even before the shader has compiled.
  for (let i = 0; i < FOOT_N; i++) {
    const a = (fl.footAge[i] += dt);
    if (a >= FOOT_LIFE) { fl.foot[4 * i + 3] = 0; continue; }
    fl.foot[4 * i + 3] = Math.min(1, a / 0.12)
      * (1 - smoothstep(FOOT_LIFE * 0.55, FOOT_LIFE, a)) * fl.footStr[i];
  }
  // Show the mesh BEFORE the uniforms guard: the shader only compiles (and
  // footLayerUniforms only appears) once the mesh first renders, so gating
  // visibility on the uniforms would deadlock the very first visit. The one
  // pre-compile frame renders at uReveal 0 → fully transparent.
  fl.mesh.visible = true;
  if (!footLayerUniforms) return;
  const u = footLayerUniforms;
  u.uPUp.value.copy(surfaceState.localUp);
  u.uPRight.value.copy(surfaceState.localRight);
  u.uPFwd.value.copy(surfaceState.localFwd);
  u.uGridHalf.value = fl.gridHalf;
  u.uGridDrift.value.set(surfaceState.grassU - fl.gridU, surfaceState.grassV - fl.gridV);
  u.uDrift.value.set(surfaceState.grassU, surfaceState.grassV);
  u.uRef.value = surfaceState.groundRadius;
  u.uReveal.value = fl.reveal;
  u.uPR.value = fl.PR;
  u.uEps.value = fl.eps;
  u.uFootLen.value = fl.footLen;
  u.uFoot.value = fl.foot;
}

// Stamp one boot print at ground-fixed tangent coords (u, v), oriented to a
// heading yaw (radians; the angle of the movement direction in the
// localRight/localFwd basis). strength scales the whole decal.
export function stampFootprint(u, v, yaw, strength) {
  const fl = footLayer;
  if (!fl || !fl.active) return;
  const i = fl.footNext;
  fl.footNext = (i + 1) % FOOT_N;
  fl.foot[4 * i]     = u;
  fl.foot[4 * i + 1] = v;
  fl.foot[4 * i + 2] = yaw;
  fl.foot[4 * i + 3] = 0;            // updateFootprints fades it in from age 0
  fl.footAge[i] = 0;
  fl.footStr[i] = strength;
}

// Local air temperature (°C) under the avatar, mirroring vertexTempC but driven
// by the avatar's body-local up (latitude) and standing height (lapse rate)
// rather than a mesh vertex index.
function bodyTempCAtAvatar(body, h) {
  const clim = body.climate;
  const uy = surfaceState.localUp.y;
  const cosLat = Math.sqrt(Math.max(0, 1 - uy * uy));
  const warmth = Math.pow(cosLat, 1.6);
  const tK = clim.poleK + (clim.equatorK - clim.poleK) * warmth;
  return (tK - KELVIN_ZERO_C) - Math.max(0, h) * CLIMATE_LAPSE_C;
}

// Earth-like worlds print only on sand (beaches/coast) and snow/ice — never on
// grass, jungle, forest, bare rock, or tundra turf. Mirrors colorBodyVertex's
// terrestrial band/zone logic so prints land exactly where the ground reads sandy
// or icy.
function terrestrialFootStrength(body, h) {
  if (h >= ROCK_TOP) return SNOW_FOOT_STR;            // high snow cap (any zone)
  const zoned = body.climate && body.climate.spread > 0.5;
  const zones = zoned ? CLIMATE_LAND_ZONES[body.archetype] : null;
  if (!zones) return h < SAND_TOP ? SAND_FOOT_STR : 0;
  const z = pickLandZone(zones, bodyTempCAtAvatar(body, h));
  if (z.key === 'ice') return SNOW_FOOT_STR;          // ice biome
  if (z.beach && h < SAND_TOP) return SAND_FOOT_STR;  // sandy coast
  return 0;
}

// How strongly the ground under the avatar takes a print (0 = hard/unsuitable
// ground). Archetype-soft planets (venusian/desert/moon_like) print by height
// band; moons print everywhere (regolith/mare/frost); Earth-likes only on
// sand or snow/ice.
export function footprintStrengthHere() {
  const body = surfaceState.body;
  if (!body || !footLayer || !footLayer.active) return 0;
  const h = (surfaceState.groundRadius / body.baseRadius - 1) / BODY_HEIGHT_SCALE;
  if (body.kind !== 'planet') return MOON_FOOT_STR;
  const cfg = FOOTPRINT_GROUND[body.archetype];
  if (cfg) return h < SAND_TOP ? cfg.low : cfg.strength;
  if (body.archetype === 'terrestrial') return terrestrialFootStrength(body, h);
  return 0;
}

// Called from stepSurfaceWalk with this frame's tangent step (du, dv): meter out
// alternating left/right boot prints every half-stride along the path.
export function stampFootprintsFromStep(du, dv) {
  const fl = footLayer;
  if (!fl || !fl.active || !surfaceState.grounded || surfaceState.swimming) return;
  const str = footprintStrengthHere();
  if (str <= 0) return;
  const stepLen = Math.hypot(du, dv);
  if (stepLen <= 1e-9) return;
  fl.strideAcc += stepLen;
  const stride = surfaceState.eyeHeight * 0.55;
  let n = Math.floor(fl.strideAcc / stride);
  if (n <= 0) return;
  fl.strideAcc -= n * stride;
  if (n > 4) n = 4;                              // a hitch frame doesn't dump the whole ring
  const yaw = Math.atan2(du, dv);
  const hu = du / stepLen, hv = dv / stepLen;    // unit heading
  // Place each crossed stride BACK along this frame's heading so prints stay
  // evenly spaced even when one slow frame covers several strides.
  for (let k = n - 1; k >= 0; k--) {
    const back = fl.strideAcc + k * stride;
    const w = surfaceState.eyeHeight * 0.07 * fl.strideSide;
    fl.strideSide = -fl.strideSide;
    stampFootprint(
      surfaceState.grassU - hu * back + hv * w,
      surfaceState.grassV - hv * back - hu * w,
      yaw, str);
  }
}

// Console diagnostic for the footprint system: active print count + the soil
// softness under the avatar (0 = this ground doesn't take prints).
window.footDiag = () => {
  const fl = footLayer;
  if (!fl) return 'footprint layer not built yet (enter a soft-soil surface first)';
  let active = 0;
  for (let i = 0; i < FOOT_N; i++) if (fl.foot[4 * i + 3] > 0.002) active++;
  const slots = [];
  for (let i = 0; i < Math.min(FOOT_N, 20); i++) {
    if (fl.footAge[i] >= FOOT_LIFE && fl.foot[4 * i + 3] === 0) continue;
    slots.push(`${i}:a${fl.footAge[i].toFixed(1)} f${fl.foot[4 * i + 3].toFixed(2)} s${fl.footStr[i].toFixed(2)}`);
  }
  return {
    active, next: fl.footNext, strength: footprintStrengthHere(),
    footLen: fl.footLen, strideAcc: +fl.strideAcc.toFixed(4),
    archetype: surfaceState.body && surfaceState.body.archetype,
    sunElev: surfaceState.sunElev != null ? +surfaceState.sunElev.toFixed(3) : null,
    grassU: +surfaceState.grassU.toFixed(4), grassV: +surfaceState.grassV.toFixed(4),
    slots,
  };
};
