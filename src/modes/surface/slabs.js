// Instanced flat bedrock SLABS for the Martian (desert) "Flats" biome.
//
// Where rocks.js scatters sparse upright boulders, this lays LARGE, LONG, FLAT
// rock plates flush with the ground — the platy / flagstone bedrock you see on
// real Mars: fractured slabs of flat rock at ground level, separated by thin
// sandy gaps. Same treadmill + raycast-height-grid machinery as grass/rocks, but
// the scatter is a jittered lattice (near-full coverage with gaps) instead of
// clusters, and each plate is sunk so only its flat top shows, oriented to the
// surface normal so it reads as level bedrock rather than a tumbled boulder.
import * as THREE from 'three';
import {
  BODY_HEIGHT_SCALE, MAX_LAND_HEIGHT
} from '../../core/constants.js';
import { compKeyAt } from '../../framework/body.js';
import { viewMode } from '../../framework/state.js';
import { surfaceState } from './core.js';
import { GRASS_GN, grassGroundRadius } from './grass.js';
import {
  _gAxisY, _gMat, _gP, _gQuat, _gRot, _gScale, _gTilt, _gUp, _grCol, _grDir, _grHit, _grOrigin, _grTint, grassRaycaster
} from './scratch.js';

export const SLAB_COUNT = 800;       // plates in the field buffer (spread past the horizon → sparse near field)
export const SLAB_GN    = GRASS_GN;  // reuse grassGroundRadius (identical GN + grid layout)
export let slabField = null;

// Martian rust palette for the plates (dusty rust → deep ochre → muted orange).
const SLAB_BIAS = new THREE.Color(0x8a4326);   // pull the sampled ground toward Mars rust
const SLAB_BIAS_AMT = 0.5;

// One irregular flat plate: a low 7-sided prism whose rim is pushed in/out per
// edge (angular flagstone outline) and whose top is gently uneven. Built wide +
// thin; the per-instance scale stretches it into long/large slabs. flatShading
// renders it faceted like chipped rock. Vertex colour bakes a lit top / dark
// sides so the plate reads 3D even lying flat.
export function buildSlabGeometry() {
  const geo = new THREE.CylinderGeometry(1.0, 0.9, 1.0, 7, 1);
  const pos = geo.getAttribute('position');
  const v = new THREE.Vector3();
  const col = [];
  const hash = (n) => { const s = Math.sin(n * 127.1) * 43758.5453; return s - Math.floor(s); };
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const rad = Math.hypot(v.x, v.z);
    if (rad > 0.3) {
      // Per-edge radius jitter keyed on the angle, so the cap rim and the wall
      // share it (vertices at the same angle move together → no cracked walls).
      const ang = Math.atan2(v.z, v.x);
      const jr = 0.74 + hash(ang * 3.17 + 1.0) * 0.55;
      v.x = Math.cos(ang) * rad * jr;
      v.z = Math.sin(ang) * rad * jr;
    }
    if (v.y > 0.3) v.y += (hash(v.x * 5.1 + v.z * 7.3) - 0.5) * 0.16;  // uneven, near-flat top
    pos.setXYZ(i, v.x, v.y, v.z);
    const shade = v.y > 0.0 ? 0.74 + 0.26 * hash(i * 1.7) : 0.42;     // lit crown, shaded rim
    col.push(shade, shade, shade);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeVertexNormals();
  return geo;
}

export function buildSlabField() {
  const geo = buildSlabGeometry();
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.96, metalness: 0.0, flatShading: true,
    // Depth bias toward the camera so a plate lying nearly coplanar with the
    // terrain wins the depth test cleanly instead of shimmering (z-fighting).
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, SLAB_COUNT);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;

  const baseUV  = new Float32Array(SLAB_COUNT * 2);  // normalized [-1,1], scaled by PR at runtime
  const yaw     = new Float32Array(SLAB_COUNT);
  const size    = new Float32Array(SLAB_COUNT);      // overall plate footprint (wide size range)
  const lenJit  = new Float32Array(SLAB_COUNT);      // long axis (plates run long)
  const widJit  = new Float32Array(SLAB_COUNT);      // cross axis
  const thkJit  = new Float32Array(SLAB_COUNT);      // thickness (kept ~independent of size → big plates stay flat)
  const tint    = new THREE.Color();
  // Clustered, size-TIERED scatter (like the boulder field) with open sand
  // between: each cluster rolls a tier — a few BIG flat slabs that cover real
  // ground, medium plates, or small platy rubble. This gives the size variety
  // ("some take more square metres") and the gaps the uniform lattice lacked.
  let i = 0;
  while (i < SLAB_COUNT) {
    const cx = Math.random() * 2 - 1, cy = Math.random() * 2 - 1;
    const roll = Math.random();
    let n, spread, sizeLo, sizeHi;
    if (roll < 0.14) {                 // big slabs — broad flat sheets of bedrock
      n = 1 + (Math.random() * 2 | 0);
      spread = 0.02 + Math.random() * 0.035;
      sizeLo = 2.4; sizeHi = 4.2;
    } else if (roll < 0.55) {          // medium plates
      n = 2 + (Math.random() * 4 | 0);
      spread = 0.03 + Math.random() * 0.06;
      sizeLo = 1.0; sizeHi = 2.3;
    } else {                           // small platy rubble
      n = 3 + (Math.random() * 6 | 0);
      spread = 0.025 + Math.random() * 0.05;
      sizeLo = 0.45; sizeHi = 1.05;
    }
    for (let k = 0; k < n && i < SLAB_COUNT; k++, i++) {
      const a = Math.random() * Math.PI * 2;
      const rr = Math.pow(Math.random(), 0.7) * spread;
      baseUV[2 * i]     = Math.max(-1, Math.min(1, cx + Math.cos(a) * rr));
      baseUV[2 * i + 1] = Math.max(-1, Math.min(1, cy + Math.sin(a) * rr));
      yaw[i]    = Math.random() * Math.PI * 2;
      const st = Math.random();
      size[i]   = sizeLo + (sizeHi - sizeLo) * (k === 0 ? Math.pow(st, 0.5) : st * st);  // lead slab largest
      lenJit[i] = 1.0 + Math.random() * 1.35;        // 1.0..2.35 — some plates run long
      widJit[i] = 0.7 + Math.random() * 0.55;        // 0.7..1.25
      thkJit[i] = 0.7 + Math.random() * 0.7;
      // Per-slab colour: spread across the rust→ochre→orange palette via a warm
      // brightness jitter, multiplied over the ground-sampled base in update.
      const b = 0.72 + Math.random() * 0.5;
      tint.setRGB(b * (0.96 + Math.random() * 0.22), b * (0.84 + Math.random() * 0.16), b * (0.7 + Math.random() * 0.16));
      mesh.setColorAt(i, tint);
    }
  }
  mesh.instanceColor.needsUpdate = true;
  mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  slabField = {
    mesh, mat, baseUV, yaw, size, lenJit, widJit, thkJit,
    reveal: 0, targetReveal: 0, sampleTimer: 0, PR: 1, slabSpan: 0.02, slabThick: 0.01,
    grid: new Float32Array(SLAB_GN * SLAB_GN),       // ground radii in a snapshot tangent frame
    gridFlats: new Float32Array(SLAB_GN * SLAB_GN),  // 1 = Flats cell, 0 = not
    gridHalf: 1, gridValid: false, gridU: 0, gridV: 0,
    gridUp: new THREE.Vector3(), gridRight: new THREE.Vector3(), gridFwd: new THREE.Vector3(),
  };
}

export function attachSlabs(body) {
  if (body.archetype !== 'desert') { detachSlabs(); return; }   // Martian flats only
  if (!slabField) buildSlabField();
  const sf = slabField;
  const eh = surfaceState.eyeHeight;
  // Reach PAST the visible horizon (same trick as grass/rocks): the edge fade
  // then lands beyond the skyline, where the planet's own curvature occludes it,
  // so plates never visibly fade in as you walk. Sparse over that large area —
  // which is what "way too many" wanted dialed back.
  const _horizon = Math.sqrt(2 * body.baseRadius * eh);
  sf.PR        = Math.max(eh * 30, _horizon * 1.8);   // past the skyline (fade hidden), but denser than boulder spacing
  sf.slabSpan  = eh * 0.95;                         // base plate radius (× per-slab size tier)
  sf.slabThick = eh * 0.14;                         // low — plates read as ground-level bedrock
  sf.reveal = 0;
  sf.targetReveal = 0;
  sf.sampleTimer = 0;
  sf.gridValid = false;
  sf.mesh.visible = false;
  if (sf.mesh.parent) sf.mesh.parent.remove(sf.mesh);
  body.mesh.add(sf.mesh);
}

export function detachSlabs() {
  if (slabField && slabField.mesh.parent) slabField.mesh.parent.remove(slabField.mesh);
}

// True when terrain face `f` is the Martian Flats biome. Classified through the
// canonical compKeyAt ('grass' = the Flats band on desert), so a PAINTED "Flats"
// (BAND_GRASS) and the natural flats band resolve identically — painted and
// natural ground must grow the same slabs.
export function groundIsFlatsFace(body, f) {
  if (body.kind !== 'planet' || body.archetype !== 'desert') return false;
  return compKeyAt(body, f.a) === 'grass';                       // Flats band, natural OR painted
}

// Throttled probe: is the avatar on (or near) Flats, and what ground colour?
export function sampleSlabGround() {
  const body = surfaceState.body, sf = slabField;
  if (!body) { sf.targetReveal = 0; return; }
  body.mesh.updateMatrixWorld();
  const mw = body.mesh.matrixWorld;
  const high = body.baseRadius * (1 + MAX_LAND_HEIGHT * BODY_HEIGHT_SCALE) + 1;
  const footR = surfaceState.groundRadius;
  const up = surfaceState.localUp, right = surfaceState.localRight, fwd = surfaceState.localFwd;
  const d = sf.PR * 0.5;
  let onFlats = false, tf = null;
  for (let s = 0; s < 5; s++) {
    const ou = s === 1 ? d : s === 2 ? -d : 0;
    const ov = s === 3 ? d : s === 4 ? -d : 0;
    _grHit.copy(up).multiplyScalar(footR).addScaledVector(right, ou).addScaledVector(fwd, ov).normalize();
    _grOrigin.copy(_grHit).multiplyScalar(high).applyMatrix4(mw);
    _grDir.copy(_grHit).multiplyScalar(-1).transformDirection(mw).normalize();
    grassRaycaster.set(_grOrigin, _grDir);
    const hits = grassRaycaster.intersectObject(body.mesh, false);
    const f = hits.length ? hits[0].face : null;
    if (f && groundIsFlatsFace(body, f)) { onFlats = true; if (s === 0 || !tf) tf = f; }
  }
  sf.targetReveal = onFlats ? 1 : 0;
  if (tf) {                                          // base plate colour = ground + rust bias
    const ca = body.colorArr;
    _grCol.setRGB(
      (ca[3 * tf.a]     + ca[3 * tf.b]     + ca[3 * tf.c])     / 3,
      (ca[3 * tf.a + 1] + ca[3 * tf.b + 1] + ca[3 * tf.c + 1]) / 3,
      (ca[3 * tf.a + 2] + ca[3 * tf.b + 2] + ca[3 * tf.c + 2]) / 3,
    );
    _grTint.copy(_grCol).lerp(SLAB_BIAS, SLAB_BIAS_AMT);
    sf.mat.color.copy(_grTint);
  }
}

// Re-sample the height + Flats-mask grid in the avatar's current tangent frame.
export function refreshSlabGrid() {
  const sf = slabField, body = surfaceState.body;
  body.mesh.updateMatrixWorld();
  const mw = body.mesh.matrixWorld;
  const high = body.baseRadius * (1 + MAX_LAND_HEIGHT * BODY_HEIGHT_SCALE) + 1;
  sf.gridUp.copy(surfaceState.localUp);
  sf.gridRight.copy(surfaceState.localRight);
  sf.gridFwd.copy(surfaceState.localFwd);
  sf.gridU = surfaceState.grassU;
  sf.gridV = surfaceState.grassV;
  sf.gridHalf = sf.PR * 1.3;
  const footR = surfaceState.groundRadius, GH = sf.gridHalf, GN = SLAB_GN;
  for (let iy = 0; iy < GN; iy++) {
    for (let ix = 0; ix < GN; ix++) {
      const gu = (ix / (GN - 1) * 2 - 1) * GH;
      const gv = (iy / (GN - 1) * 2 - 1) * GH;
      _gP.copy(sf.gridUp).multiplyScalar(footR).addScaledVector(sf.gridRight, gu).addScaledVector(sf.gridFwd, gv);
      _gUp.copy(_gP).normalize();
      _grOrigin.copy(_gUp).multiplyScalar(high).applyMatrix4(mw);
      _grDir.copy(_gUp).multiplyScalar(-1).transformDirection(mw).normalize();
      grassRaycaster.set(_grOrigin, _grDir);
      const hits = grassRaycaster.intersectObject(body.mesh, false);
      let r = footR, isFlats = 0;
      if (hits.length) {
        _grHit.copy(hits[0].point); body.mesh.worldToLocal(_grHit); r = _grHit.length();
        isFlats = groundIsFlatsFace(body, hits[0].face) ? 1 : 0;
      }
      sf.grid[iy * GN + ix] = r;
      sf.gridFlats[iy * GN + ix] = isFlats;
    }
  }
  sf.gridValid = true;
}

// Bilinear Flats coverage (0..1) from the snapshot mask grid.
export function slabMask(sf, su, sv) {
  const GN = SLAB_GN, GH = sf.gridHalf;
  let fx = (su / GH * 0.5 + 0.5) * (GN - 1);
  let fy = (sv / GH * 0.5 + 0.5) * (GN - 1);
  fx = fx < 0 ? 0 : fx > GN - 1 ? GN - 1 : fx;
  fy = fy < 0 ? 0 : fy > GN - 1 ? GN - 1 : fy;
  const x0 = fx | 0, y0 = fy | 0;
  const x1 = x0 < GN - 1 ? x0 + 1 : x0, y1 = y0 < GN - 1 ? y0 + 1 : y0;
  const tx = fx - x0, ty = fy - y0, g = sf.gridFlats;
  const a = g[y0 * GN + x0] + (g[y0 * GN + x1] - g[y0 * GN + x0]) * tx;
  const b = g[y1 * GN + x0] + (g[y1 * GN + x1] - g[y1 * GN + x0]) * tx;
  return a + (b - a) * ty;
}

// Per-frame: refresh the probe + grid as needed, then lay every plate flat on
// the terrain (oriented to the surface normal, sunk so only the top shows).
export function updateSlabs(dt) {
  if (!slabField || viewMode !== 'surface' || !surfaceState.body) return;
  const sf = slabField;
  if (surfaceState.body.archetype !== 'desert') { sf.mesh.visible = false; return; }

  sf.sampleTimer -= dt;
  if (sf.sampleTimer <= 0) { sf.sampleTimer = 0.4; sampleSlabGround(); }

  sf.reveal += (sf.targetReveal - sf.reveal) * Math.min(1, dt * 4);
  if (sf.reveal <= 0.01) { sf.mesh.visible = false; return; }
  sf.mesh.visible = true;

  const PR = sf.PR;
  if (!sf.gridValid ||
      Math.abs(surfaceState.grassU - sf.gridU) > PR * 0.4 ||
      Math.abs(surfaceState.grassV - sf.gridV) > PR * 0.4) {
    refreshSlabGrid();
  }

  const period = PR * 2, span = sf.slabSpan, thick = sf.slabThick, reveal = sf.reveal;
  const up = surfaceState.localUp, right = surfaceState.localRight, fwd = surfaceState.localFwd;
  const footR = surfaceState.groundRadius;
  const uOff = surfaceState.grassU, vOff = surfaceState.grassV;
  const driftU = surfaceState.grassU - sf.gridU, driftV = surfaceState.grassV - sf.gridV;
  for (let i = 0; i < SLAB_COUNT; i++) {
    let u = sf.baseUV[2 * i]     * PR - uOff;
    let v = sf.baseUV[2 * i + 1] * PR - vOff;
    u -= period * Math.floor((u + PR) / period);
    v -= period * Math.floor((v + PR) / period);
    const au = u < 0 ? -u : u, av = v < 0 ? -v : v;
    let ef = (1.0 - (au > av ? au : av) / PR) * 9.0;          // full to ~0.89·PR, thin fade beyond
    ef = ef < 0 ? 0 : ef > 1 ? 1 : ef;
    let mf = (slabMask(sf, driftU + u, driftV + v) - 0.25) * 2.0;
    mf = mf < 0 ? 0 : mf > 1 ? 1 : mf;
    let fade = ef * mf * reveal;
    if (fade <= 0.004) { _gMat.makeScale(0, 0, 0); sf.mesh.setMatrixAt(i, _gMat); continue; }
    fade = fade * fade * (3 - 2 * fade);                      // smoothstep ease
    const su = driftU + u, sv = driftV + v;
    _gP.copy(up).multiplyScalar(footR).addScaledVector(right, u).addScaledVector(fwd, v);
    _gUp.copy(_gP).normalize();
    const grR = grassGroundRadius(sf, su, sv);
    const halfThick = thick * sf.thkJit[i] * 0.5;
    // Local terrain slope from the height grid (finite difference across roughly
    // the plate's own footprint). The plate is laid flush with THIS slope, not the
    // radial up — so on a hillside it lies parallel to the ground (anchored) rather
    // than cutting a wedge into it (one edge buried, the other floating + glitching).
    const e = span * sf.size[i] * 0.6 + span;
    const dru = (grassGroundRadius(sf, su + e, sv) - grassGroundRadius(sf, su - e, sv)) / (2 * e);
    const drv = (grassGroundRadius(sf, su, sv + e) - grassGroundRadius(sf, su, sv - e)) / (2 * e);
    _gTilt.copy(_gUp).addScaledVector(right, -dru).addScaledVector(fwd, -drv).normalize();
    // Half-immersed: centre ~at the ground so the top emerges and the underside is
    // buried; the small lift + polygon offset keep the top from z-fighting the soil.
    const r = grR + halfThick * 0.1;
    _gP.copy(_gUp).multiplyScalar(r);
    // Lay flush with the local slope: plate +Y → terrain normal, then spin about it.
    _gQuat.setFromUnitVectors(_gAxisY, _gTilt);
    _gRot.setFromAxisAngle(_gTilt, sf.yaw[i]);
    _gQuat.premultiply(_gRot);
    // Long/large flat plate: footprint = base span × the per-slab size tier
    // (big sheets vs small rubble) × aspect (length × width); thin in Y and
    // INDEPENDENT of size, so big plates stay flat rather than tall. Fade scales
    // them smoothly at the biome seam (the field-edge fade is past the horizon).
    const plate = span * sf.size[i];
    const sx = plate * sf.lenJit[i] * fade;
    const sz = plate * sf.widJit[i] * fade;
    const sy = thick * sf.thkJit[i] * fade;
    _gScale.set(sx, sy, sz);
    _gMat.compose(_gP, _gQuat, _gScale);
    sf.mesh.setMatrixAt(i, _gMat);
  }
  sf.mesh.instanceMatrix.needsUpdate = true;
}
