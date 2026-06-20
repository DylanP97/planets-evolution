// Instanced rock field for desert/venusian worlds + rock collision push-out.
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
export const ROCK_COUNT = 640;       // bumped so clusters still read over the larger past-horizon patch
export const ROCK_GN    = GRASS_GN;     // reuse grassGroundRadius (identical GN + grid layout)
export let rockField = null;

// One lumpy low-poly rock: an icosahedron whose every vertex is pushed in/out
// by a position-hash noise. Duplicate verts at shared corners hash identically
// (same position in -> same offset out), so the faces stay welded - no cracks.
// flatShading then renders the irregular hull faceted, like a chipped stone.
export function buildRockGeometry() {
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

export function buildRockField() {
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

export function attachRocks(body) {
  if (!rockField) buildRockField();
  const rf = rockField;
  // Same past-the-horizon radius as grass so boulders never pop in ahead of you.
  const _horizon = Math.sqrt(2 * body.baseRadius * surfaceState.eyeHeight);
  rf.PR    = Math.max(surfaceState.eyeHeight * 30, _horizon * 2.5);
  rf.rockH = surfaceState.eyeHeight * 0.5;       // base boulder size (scaled per instance)
  rf.reveal = 0;
  rf.targetReveal = 0;
  rf.sampleTimer = 0;
  rf.gridValid = false;
  rf.mesh.visible = false;
  if (rf.mesh.parent) rf.mesh.parent.remove(rf.mesh);
  body.mesh.add(rf.mesh);
}

export function detachRocks() {
  if (rockField && rockField.mesh.parent) rockField.mesh.parent.remove(rockField.mesh);
}

// Archetypes whose surface-walk ground grows the instanced boulder field,
// with the tint bias blended over the sampled ground colour. Desert keeps
// its rust-red Mars litter; venusian gets grey angular basalt clasts that
// sit a step lighter than the near-black soil so they read against it.
export const ROCK_GROUND_TINT = {
  desert:   { bias: new THREE.Color(0x9c4a2a), biasAmt: 0.45, mul: 0.9 },
  venusian: { bias: new THREE.Color(0x5b5349), biasAmt: 0.65, mul: 1.0 },
};

// True when terrain face `f` is dry rocky ground on a boulder-field archetype:
// the flats + mesa bands (not basins/dunes/peaks). Classified through the
// canonical compKeyAt so a PAINTED Flats/Mesa band grows the same boulders as
// the natural band it reproduces — natural and painted ground must match
// (compKeyAt folds BAND_GRASS→'grass', BAND_ROCK→'rock', etc.).
export function groundIsRockFace(body, f) {
  if (body.kind !== 'planet' || !ROCK_GROUND_TINT[body.archetype]) return false;
  const key = compKeyAt(body, f.a);
  return key === 'grass' || key === 'rock';                 // flats + mesa, natural OR painted
}

// Throttled biome probe: is the avatar on rocky ground, and what colour?
export function sampleRockGround() {
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
  if (tf) {                                          // tint from the ground + archetype bias
    const ca = body.colorArr;
    _grCol.setRGB(
      (ca[3 * tf.a]     + ca[3 * tf.b]     + ca[3 * tf.c])     / 3,
      (ca[3 * tf.a + 1] + ca[3 * tf.b + 1] + ca[3 * tf.c + 1]) / 3,
      (ca[3 * tf.a + 2] + ca[3 * tf.b + 2] + ca[3 * tf.c + 2]) / 3,
    );
    const rg = ROCK_GROUND_TINT[body.archetype] || ROCK_GROUND_TINT.desert;
    _grTint.copy(_grCol).lerp(rg.bias, rg.biasAmt).multiplyScalar(rg.mul);
    rf.mat.color.copy(_grTint);
  }
}

// Re-sample the height + rock-mask grid in the avatar's current tangent frame.
export function refreshRockGrid() {
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
export function rockMask(rf, su, sv) {
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
export function resolveRockCollision(du, dv) {
  _rkOut[0] = du; _rkOut[1] = dv;
  const rf = rockField, body = surfaceState.body;
  if (!rf || !rf.mesh.visible || rf.reveal < 0.5 || !body || !ROCK_GROUND_TINT[body.archetype]) return _rkOut;
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
export function updateRocks(dt) {
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


