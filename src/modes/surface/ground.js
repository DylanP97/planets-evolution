// Near-field ground micro-relief patch + footprint decals (boot SDF stamped
// in the fragment shader, ring buffer of FOOT_N prints).
import * as THREE from 'three';
import { BODY_HEIGHT_SCALE, MAX_LAND_HEIGHT, SAND_TOP } from '../../core/constants.js';
import { smoothstep } from '../../core/utils.js';
import { viewMode } from '../../framework/state.js';
import { surfaceState } from './core.js';
import { _gP, _gUp, _grDir, _grHit, _grOrigin, grassRaycaster } from './grass.js';

// ── Near-field ground detail patch ──────────────────────────────────────
// The base body mesh is one coarse icosphere (detail 7); up close its triangles
// are large relative to the walker, so the bare ground reads smooth/low-poly.
// This is a high-res tessellated patch (GROUND_PATCH_N²) that floats over the
// near field and ADDS real geometric micro-relief, mirroring the working water
// patch almost exactly (sphere projection + displacement + normal-from-gradient
// + rim fade). The differences:
//   • Base radius + colour come from a small GP_GN×GP_GN grid sampled off the
//     REAL mesh by downward raycasts (same trick sampleGrassGround uses), passed
//     to the shader as a vec4[] uniform (radius in .x, terrain colour in .yzw) —
//     so the patch follows the coarse terrain and is painted the same colour,
//     no data-textures (avoids float-texture-filtering pitfalls).
//   • A ground-fixed FBM adds the fine relief on top; its amplitude fades to 0
//     at the rim (just like the alpha) so the patch meets the coarse mesh
//     seamlessly out near the skyline, where aerial fog + curvature hide it.
// polygonOffset biases it just in front of the coarse mesh it sits on. It rides
// the same grassU/grassV treadmill as the other fields, parented to body.mesh.
export const GROUND_PATCH_N = 96;          // patch grid resolution (verts per side)
export const GP_GN          = 12;          // height/colour sample grid (GP_GN² raycasts on re-anchor)
export let groundPatch = null;
export let groundPatchUniforms = null;

// ── Footprints (soft-soil worlds) ──
// Walking on soft ground leaves boot prints. Each print is a decal evaluated
// in the ground patch's FRAGMENT shader (no extra meshes, no z-fighting):
// an oriented boot shape (rounded sole + heel + tread bars) that darkens the
// soil, throws up a pale rim of displaced regolith, and perturbs the shading
// normal into a soft depression — so the soil visibly takes the print. The
// prints live in the same ground-fixed treadmill coords (grassU/grassV) the
// patch's micro-relief uses, so they stay put as the avatar walks away, and
// they "settle" (fade) over about a minute. Ring buffer: oldest slot reused.
export const FOOT_N    = 48;               // live print slots (vec4 uniform array)
export const FOOT_LIFE = 70;               // seconds before a print fully settles away
// Archetypes soft enough to print, with strength per band: `low` applies
// below SAND_TOP (venusian slab flats barely dust over; the regolith and
// dark soil above take a full print).
export const FOOTPRINT_GROUND = {
  venusian:  { strength: 1.0,  low: 0.4 },
  desert:    { strength: 0.75, low: 0.75 },
  moon_like: { strength: 0.9,  low: 0.9 },
};

export function buildGroundPatch() {
  const N = GROUND_PATCH_N;
  // ONE cell array, shared by the shader uniform AND refreshGroundGrid — so the
  // raycast samples we write actually reach the GPU (a separate uniform array
  // would stay all-zero → patch collapses to the body centre / invisible).
  const cell = new Float32Array(4 * GP_GN * GP_GN);
  // Footprint slots, shared with the uFoot uniform the same way: per print
  // vec4(u, v, yaw, fade) in ground-fixed tangent coords. fade==0 = empty.
  const foot = new Float32Array(4 * FOOT_N);
  const geo = new THREE.PlaneGeometry(2, 2, N - 1, N - 1);
  geo.rotateX(-Math.PI / 2);        // lie flat in XZ; position.xz ∈ [-1,1] are the tangent coords
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.96, metalness: 0.0,
    transparent: true, opacity: 1.0, side: THREE.DoubleSide,
  });
  mat.polygonOffset = true;         // bias in front of the coarse mesh it overlays
  mat.polygonOffsetFactor = -1;
  mat.polygonOffsetUnits = -1;
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uPUp       = { value: new THREE.Vector3(0, 1, 0) };
    sh.uniforms.uPRight    = { value: new THREE.Vector3(1, 0, 0) };
    sh.uniforms.uPFwd      = { value: new THREE.Vector3(0, 0, 1) };
    sh.uniforms.uPR        = { value: 0.4 };                       // patch half-size (body-local units)
    sh.uniforms.uRef       = { value: 12 };                        // reference radius for tangent curvature
    sh.uniforms.uGridHalf  = { value: 0.5 };                       // half-extent the cell grid covers
    sh.uniforms.uGridDrift = { value: new THREE.Vector2(0, 0) };   // current-frame → snapshot-frame offset
    sh.uniforms.uDrift     = { value: new THREE.Vector2(0, 0) };   // ground-fixed detail offset
    sh.uniforms.uDetailAmp = { value: 0.004 };                     // micro-relief height (body-local units)
    sh.uniforms.uDetailFreq= { value: 40.0 };                      // micro-relief frequency
    sh.uniforms.uEps       = { value: 0.01 };                      // finite-difference step for normals
    sh.uniforms.uReveal    = { value: 0 };                         // fade-in on attach
    sh.uniforms.uCell      = { value: cell };
    sh.uniforms.uFoot      = { value: foot };                      // footprint decals (see above)
    sh.uniforms.uFootLen   = { value: 0.05 };                      // boot length, body-local units
    groundPatchUniforms = sh.uniforms;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>',
        '#include <common>\n'
      + 'uniform vec3 uPUp;\nuniform vec3 uPRight;\nuniform vec3 uPFwd;\n'
      + 'uniform float uPR;\nuniform float uRef;\nuniform float uGridHalf;\n'
      + 'uniform vec2 uGridDrift;\nuniform vec2 uDrift;\n'
      + 'uniform float uDetailAmp;\nuniform float uDetailFreq;\nuniform float uEps;\n'
      + 'uniform vec4 uCell[' + (GP_GN * GP_GN) + '];\n'
      + 'varying float vEdge;\nvarying vec3 vGCol;\nvarying float vDet;\n'
      // #ifndef-guarded: three.js can invoke onBeforeCompile more than once
      // over an already-patched string (program variants), so bare varying
      // declarations here would land twice → "redefinition" compile errors.
      + '#ifndef FP_VARYINGS\n#define FP_VARYINGS\nvarying vec2 vWd;\nvarying vec3 vTanR;\nvarying vec3 vTanF;\n#endif\n'
      + 'float gHash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }\n'
      + 'float gNoise(vec2 x){ vec2 i = floor(x); vec2 f = fract(x); f = f * f * (3.0 - 2.0 * f); return mix(mix(gHash(i), gHash(i + vec2(1.0,0.0)), f.x), mix(gHash(i + vec2(0.0,1.0)), gHash(i + vec2(1.0,1.0)), f.x), f.y); }\n'
      + 'float gFbm(vec2 p){ float a = 0.5; float s = 0.0; for(int k = 0; k < 4; k++){ s += a * gNoise(p); p *= 2.03; a *= 0.5; } return s; }\n'
      + 'vec4 cellAt(vec2 w){ const float GN = ' + GP_GN + '.0; float fx = (w.x / uGridHalf * 0.5 + 0.5) * (GN - 1.0); float fy = (w.y / uGridHalf * 0.5 + 0.5) * (GN - 1.0); fx = clamp(fx, 0.0, GN - 1.0); fy = clamp(fy, 0.0, GN - 1.0); float x0 = floor(fx); float y0 = floor(fy); float x1 = min(x0 + 1.0, GN - 1.0); float y1 = min(y0 + 1.0, GN - 1.0); float tx = fx - x0; float ty = fy - y0; vec4 a = mix(uCell[int(y0 * GN + x0)], uCell[int(y0 * GN + x1)], tx); vec4 b = mix(uCell[int(y1 * GN + x0)], uCell[int(y1 * GN + x1)], tx); return mix(a, b, ty); }')
      .replace('#include <beginnormal_vertex>',
        '#include <beginnormal_vertex>\n'
      + '  vec2 _puv = position.xz;\n'
      + '  float _pu = _puv.x * uPR;\n  float _pv = _puv.y * uPR;\n'
      + '  vec2 _wc = vec2(_pu, _pv) + uGridDrift;\n'
      + '  vec2 _wd = vec2(_pu, _pv) + uDrift;\n'
      + '  float _ef = 1.0 - smoothstep(0.80, 1.0, max(abs(_puv.x), abs(_puv.y)));\n'  // detail → 0 at rim (seamless seam)
      + '  vec4 _cell = cellAt(_wc);\n'
      + '  vGCol = _cell.yzw;\n'
      + '  float _g0 = gFbm(_wd * uDetailFreq);\n'
      + '  vDet = (_g0 - 0.5) * 2.0;\n'
      + '  float _ph = _cell.x + _g0 * uDetailAmp * _ef;\n'   // one-sided: relief only rises above the coarse mesh (no poke-through)
      + '  vec3 _pdir = normalize(uPUp * uRef + uPRight * _pu + uPFwd * _pv);\n'
      + '  float _e = uEps;\n'
      + '  float _hx = cellAt(_wc + vec2(_e, 0.0)).x + gFbm((_wd + vec2(_e, 0.0)) * uDetailFreq) * uDetailAmp * _ef;\n'
      + '  float _hy = cellAt(_wc + vec2(0.0, _e)).x + gFbm((_wd + vec2(0.0, _e)) * uDetailFreq) * uDetailAmp * _ef;\n'
      + '  float _sx = (_hx - _ph) / _e;\n  float _sy = (_hy - _ph) / _e;\n'
      + '  objectNormal = normalize(_pdir - (uPRight * _sx + uPFwd * _sy));\n'
      + '  vEdge = max(abs(_puv.x), abs(_puv.y));')
      .replace('#include <begin_vertex>',
        '#include <begin_vertex>\n  transformed = _pdir * _ph;\n'
      // Footprint plumbing: the ground-fixed coords for the decal lookup and
      // the view-space patch tangents the depression normal is bent along.
      + '  vWd = _wd;\n'
      + '  vTanR = normalize(normalMatrix * uPRight);\n'
      + '  vTanF = normalize(normalMatrix * uPFwd);\n');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>',
        '#include <common>\nvarying float vEdge;\nvarying vec3 vGCol;\nvarying float vDet;\nuniform float uReveal;\n'
      + '#ifndef FP_VARYINGS\n#define FP_VARYINGS\nvarying vec2 vWd;\nvarying vec3 vTanR;\nvarying vec3 vTanF;\n#endif\n'
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
      + '  diffuseColor.rgb = vGCol * (0.96 + 0.06 * vDet);\n'           // terrain colour + faint relief mottle
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
      + '  diffuseColor.rgb *= 1.0 - 0.5 * _fpDark;\n'
      + '  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 1.9 + vec3(0.015), _fpRim * 0.7);\n'
      + '  diffuseColor.a = (1.0 - smoothstep(0.80, 1.0, vEdge)) * uReveal;')
      // Bend the shading normal into each print's depression so the soil
      // visibly takes the boot (lit wall on the sun side, shaded floor).
      .replace('#include <normal_fragment_begin>',
        '#include <normal_fragment_begin>\n'
      + '  if (abs(_fpGrad.x) + abs(_fpGrad.y) > 1e-4) {\n'
      + '    normal = normalize(normal + (vTanR * _fpGrad.x + vTanF * _fpGrad.y) * 0.45);\n'
      + '  }\n');
  };
  mat.customProgramCacheKey = () => 'groundPatch';
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 1;             // after the coarse mesh (0), before the water patch (2)
  mesh.castShadow = false;
  // NO receiveShadow: the patch floats a hair above the planet mesh — a
  // system-scale shadow caster — so sampling the sun's shadow map here is
  // pure acne and renders the whole patch black. (The water patch skips
  // shadows for the same reason.)
  mesh.receiveShadow = false;
  mesh.visible = false;
  groundPatch = {
    mesh, mat, cell,
    PR: 1, gridHalf: 1, gridValid: false, gridU: 0, gridV: 0,
    gridUp: new THREE.Vector3(), gridRight: new THREE.Vector3(), gridFwd: new THREE.Vector3(),
    reveal: 0,
    // Per-visit shader params, pushed every frame by updateGroundPatch (so the
    // very first visit — whose shader only compiles AFTER attach — still gets
    // the right values once the uniforms exist).
    detailAmp: 0.004, detailFreq: 40, eps: 0.01, footLen: 0.05,
    // Footprint state: foot is the shared uniform array (u, v, yaw, fade per
    // print); age/str are JS-side, fades recomputed each frame from them.
    foot, footAge: new Float32Array(FOOT_N).fill(FOOT_LIFE), footStr: new Float32Array(FOOT_N),
    footNext: 0, strideAcc: 0, strideSide: 1,
  };
}

export function attachGroundPatch(body) {
  if (!groundPatch) buildGroundPatch();
  const gp = groundPatch;
  gp.PR = surfaceState.eyeHeight * 14;
  gp.gridValid = false;
  gp.reveal = 0;
  // Per-archetype micro-relief: venusian ground is coarse volcanic rubble, so
  // its bumps run taller and chunkier than the soft default ("rocky mud").
  const venus = body.archetype === 'venusian';
  gp.detailAmp  = surfaceState.eyeHeight * (venus ? 0.09 : 0.05);  // softer default avoids self-shadow speckle
  gp.detailFreq = 1 / (surfaceState.eyeHeight * (venus ? 0.6 : 0.9));
  gp.eps        = surfaceState.eyeHeight * 0.45;                   // wider sample → gentler normals
  gp.footLen    = surfaceState.eyeHeight * 0.26;                   // boot print length
  // Fresh visit → no leftover prints from the previous world.
  gp.foot.fill(0);
  gp.footAge.fill(FOOT_LIFE);
  gp.footNext = 0; gp.strideAcc = 0; gp.strideSide = 1;
  if (groundPatchUniforms) {
    groundPatchUniforms.uPR.value        = gp.PR;
    groundPatchUniforms.uRef.value       = surfaceState.groundRadius;
    groundPatchUniforms.uDetailAmp.value = gp.detailAmp;
    groundPatchUniforms.uDetailFreq.value= gp.detailFreq;
    groundPatchUniforms.uEps.value       = gp.eps;
    groundPatchUniforms.uReveal.value    = 0;
    // Share the live cell/foot arrays with the uniforms so refreshGroundGrid
    // and the footprint stamps mutate them in place.
    groundPatchUniforms.uCell.value      = gp.cell;
    groundPatchUniforms.uFoot.value      = gp.foot;
    groundPatchUniforms.uFootLen.value   = gp.footLen;
  }
  gp.mesh.visible = false;
  if (gp.mesh.parent) gp.mesh.parent.remove(gp.mesh);
  body.mesh.add(gp.mesh);
}

export function detachGroundPatch() {
  if (groundPatch && groundPatch.mesh.parent) groundPatch.mesh.parent.remove(groundPatch.mesh);
}

// Re-sample the base-radius + terrain-colour grid in the avatar's current tangent
// frame (GP_GN² downward raycasts), snapshotting that frame. Stores radius in .x
// and the hit face's colour in .yzw of each cell. Reuses the grass raycaster +
// scratch (runs after updateGrass in the loop, so the share is sequential/safe).
export function refreshGroundGrid() {
  const gp = groundPatch, body = surfaceState.body;
  body.mesh.updateMatrixWorld();
  const mw = body.mesh.matrixWorld;
  const high = body.baseRadius * (1 + MAX_LAND_HEIGHT * BODY_HEIGHT_SCALE) + 1;
  gp.gridUp.copy(surfaceState.localUp);
  gp.gridRight.copy(surfaceState.localRight);
  gp.gridFwd.copy(surfaceState.localFwd);
  gp.gridU = surfaceState.grassU;
  gp.gridV = surfaceState.grassV;
  gp.gridHalf = gp.PR * 1.3;
  const footR = surfaceState.groundRadius, GH = gp.gridHalf, GN = GP_GN, cell = gp.cell, ca = body.colorArr;
  for (let iy = 0; iy < GN; iy++) {
    for (let ix = 0; ix < GN; ix++) {
      const gu = (ix / (GN - 1) * 2 - 1) * GH;
      const gv = (iy / (GN - 1) * 2 - 1) * GH;
      _gP.copy(gp.gridUp).multiplyScalar(footR).addScaledVector(gp.gridRight, gu).addScaledVector(gp.gridFwd, gv);
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
  gp.gridValid = true;
}

// Per-frame: re-anchor the grid when the walker drifts, fade in, and push the
// current tangent frame + drifts into the shader. The mesh itself never changes —
// the GPU projects + displaces it from the uniforms.
export function updateGroundPatch(dt) {
  if (!groundPatch || viewMode !== 'surface' || !surfaceState.body) return;
  const gp = groundPatch, PR = gp.PR;
  if (!gp.gridValid ||
      Math.abs(surfaceState.grassU - gp.gridU) > PR * 0.4 ||
      Math.abs(surfaceState.grassV - gp.gridV) > PR * 0.4) {
    refreshGroundGrid();
  }
  gp.reveal += (1 - gp.reveal) * Math.min(1, dt * 4);
  // Age the footprints: a quick press-in, then a long settle-out. Fades are
  // written straight into the shared uniform array, premultiplied by each
  // print's soil softness (footStr). JS state — runs even before the shader
  // has compiled.
  for (let i = 0; i < FOOT_N; i++) {
    const a = (gp.footAge[i] += dt);
    if (a >= FOOT_LIFE) { gp.foot[4 * i + 3] = 0; continue; }
    gp.foot[4 * i + 3] = Math.min(1, a / 0.12)
      * (1 - smoothstep(FOOT_LIFE * 0.55, FOOT_LIFE, a)) * gp.footStr[i];
  }
  // Show the mesh BEFORE the uniforms guard: the shader only compiles (and
  // groundPatchUniforms only appears) once the mesh first renders, so gating
  // visibility on the uniforms would deadlock the very first visit. The one
  // pre-compile frame renders at uReveal 0 → fully transparent.
  gp.mesh.visible = true;
  if (!groundPatchUniforms) return;
  const u = groundPatchUniforms;
  u.uPUp.value.copy(surfaceState.localUp);
  u.uPRight.value.copy(surfaceState.localRight);
  u.uPFwd.value.copy(surfaceState.localFwd);
  u.uGridHalf.value = gp.gridHalf;
  u.uGridDrift.value.set(surfaceState.grassU - gp.gridU, surfaceState.grassV - gp.gridV);
  u.uDrift.value.set(surfaceState.grassU, surfaceState.grassV);
  u.uRef.value = surfaceState.groundRadius;
  u.uReveal.value = gp.reveal;
  // Per-visit params, pushed here (not just on attach) because the very first
  // visit compiles the shader AFTER attachGroundPatch ran — see buildGroundPatch.
  u.uPR.value         = gp.PR;
  u.uDetailAmp.value  = gp.detailAmp;
  u.uDetailFreq.value = gp.detailFreq;
  u.uEps.value        = gp.eps;
  u.uFootLen.value    = gp.footLen;
  u.uFoot.value       = gp.foot;
}

// Stamp one boot print at ground-fixed tangent coords (u, v), oriented to a
// heading yaw (radians; the angle of the movement direction in the
// localRight/localFwd basis). strength scales the whole decal.
export function stampFootprint(u, v, yaw, strength) {
  const gp = groundPatch;
  if (!gp) return;
  const i = gp.footNext;
  gp.footNext = (i + 1) % FOOT_N;
  gp.foot[4 * i]     = u;
  gp.foot[4 * i + 1] = v;
  gp.foot[4 * i + 2] = yaw;
  gp.foot[4 * i + 3] = 0;            // updateGroundPatch fades it in from age 0
  gp.footAge[i] = 0;
  gp.footStr[i] = strength;
}

// How strongly the ground under the avatar takes a print (0 = hard ground or
// not a soft-soil archetype). Venusian slab flats (below SAND_TOP) only dust
// over; the regolith/soil bands above take a full print.
export function footprintStrengthHere() {
  const body = surfaceState.body;
  const cfg = body && FOOTPRINT_GROUND[body.archetype];
  if (!cfg || !groundPatch) return 0;
  const h = (surfaceState.groundRadius / body.baseRadius - 1) / BODY_HEIGHT_SCALE;
  return h < SAND_TOP ? cfg.low : cfg.strength;
}

// Called from stepSurfaceWalk with this frame's tangent step (du, dv): meter
// out alternating left/right boot prints every half-stride along the path.
export function stampFootprintsFromStep(du, dv) {
  const gp = groundPatch;
  if (!gp || !surfaceState.grounded || surfaceState.swimming) return;
  const str = footprintStrengthHere();
  if (str <= 0) return;
  const stepLen = Math.hypot(du, dv);
  if (stepLen <= 1e-9) return;
  gp.strideAcc += stepLen;
  const stride = surfaceState.eyeHeight * 0.55;
  let n = Math.floor(gp.strideAcc / stride);
  if (n <= 0) return;
  gp.strideAcc -= n * stride;
  if (n > 4) n = 4;                              // a hitch frame doesn't dump the whole ring
  const yaw = Math.atan2(du, dv);
  const hu = du / stepLen, hv = dv / stepLen;    // unit heading
  // Place each crossed stride BACK along this frame's heading so prints stay
  // evenly spaced even when one slow frame covers several strides.
  for (let k = n - 1; k >= 0; k--) {
    const back = gp.strideAcc + k * stride;
    const w = surfaceState.eyeHeight * 0.07 * gp.strideSide;
    gp.strideSide = -gp.strideSide;
    stampFootprint(
      surfaceState.grassU - hu * back + hv * w,
      surfaceState.grassV - hv * back - hu * w,
      yaw, str);
  }
}

