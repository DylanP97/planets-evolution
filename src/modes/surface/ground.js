// Near-field ground micro-relief patch (currently DISABLED — see
// ENABLE_GROUND_PATCH). Footprints used to live in this patch's shader; they
// now have their own decoupled layer in footprints.js.
import * as THREE from 'three';
import { BODY_HEIGHT_SCALE, MAX_LAND_HEIGHT } from '../../core/constants.js';
import { viewMode } from '../../framework/state.js';
import { surfaceState } from './core.js';
import { _gP, _gUp, _grDir, _grHit, _grOrigin, grassRaycaster } from './scratch.js';

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

// DISABLED. The patch is a translucent square plane laid over the coarse
// terrain right around the avatar; it shaded differently from the ground it
// covered, so it read as a dark square by day (and a pale square by night)
// that tracked the camera on every world — the "square shadow/light around the
// character" bug. Until its lighting is made to match the body mesh exactly,
// we don't attach it. Footprints used to ride in this patch's shader; they now
// live in their own decoupled layer (footprints.js), so they work even with the
// patch off. Flip this to re-enable the micro-relief once the seam is fixed.
export const ENABLE_GROUND_PATCH = false;

export function buildGroundPatch() {
  const N = GROUND_PATCH_N;
  // ONE cell array, shared by the shader uniform AND refreshGroundGrid — so the
  // raycast samples we write actually reach the GPU (a separate uniform array
  // would stay all-zero → patch collapses to the body centre / invisible).
  const cell = new Float32Array(4 * GP_GN * GP_GN);
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
        '#include <begin_vertex>\n  transformed = _pdir * _ph;\n');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>',
        '#include <common>\nvarying float vEdge;\nvarying vec3 vGCol;\nvarying float vDet;\nuniform float uReveal;\n')
      .replace('#include <color_fragment>',
        '#include <color_fragment>\n'
      + '  diffuseColor.rgb = vGCol * (0.96 + 0.06 * vDet);\n'           // terrain colour + faint relief mottle
      + '  diffuseColor.a = (1.0 - smoothstep(0.80, 1.0, vEdge)) * uReveal;');
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
    detailAmp: 0.004, detailFreq: 40, eps: 0.01,
  };
}

export function attachGroundPatch(body) {
  if (!ENABLE_GROUND_PATCH) return;   // disabled — see ENABLE_GROUND_PATCH note
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
  if (groundPatchUniforms) {
    groundPatchUniforms.uPR.value        = gp.PR;
    groundPatchUniforms.uRef.value       = surfaceState.groundRadius;
    groundPatchUniforms.uDetailAmp.value = gp.detailAmp;
    groundPatchUniforms.uDetailFreq.value= gp.detailFreq;
    groundPatchUniforms.uEps.value       = gp.eps;
    groundPatchUniforms.uReveal.value    = 0;
    // Share the live cell array with the uniform so refreshGroundGrid mutates it
    // in place.
    groundPatchUniforms.uCell.value      = gp.cell;
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
  if (!ENABLE_GROUND_PATCH) return;   // disabled — see ENABLE_GROUND_PATCH note
  if (!groundPatch || viewMode !== 'surface' || !surfaceState.body) return;
  const gp = groundPatch, PR = gp.PR;
  if (!gp.gridValid ||
      Math.abs(surfaceState.grassU - gp.gridU) > PR * 0.4 ||
      Math.abs(surfaceState.grassV - gp.gridV) > PR * 0.4) {
    refreshGroundGrid();
  }
  gp.reveal += (1 - gp.reveal) * Math.min(1, dt * 4);
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
}

