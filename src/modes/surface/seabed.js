// Sea-bed dressing on ocean worlds — swaying kelp/algae fronds rooted on the
// submerged floor plus the occasional school of fish (a real GLB model), both
// scattered on the SAME treadmill grid as the grass (modes/surface/grass.js).
// The field exists only while walking a liquid-water body, and every instance
// is gated to cells whose terrain sits below sea level (so it only shows where
// there's water above it). Patchiness — a few distinct beds/schools with open
// water between — comes from the cluster scatter, not a spatial mask. Kelp is
// procedural (tapered ribbons that sway in their vertex shader); fish are
// instanced clones of assets/fish.glb that mill slowly in schools and bank as
// they turn. Mirrors grass's grid/treadmill bookkeeping but reads the REAL
// seabed radius (grass clamps to the waterline; here we want the floor below it).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { BODY_HEIGHT_SCALE, MAX_LAND_HEIGHT } from '../../core/constants.js';
import { viewMode } from '../../framework/state.js';
import { surfaceState } from './core.js';
import {
  _gAxisY, _gMat, _gP, _gQuat, _gRot, _gScale, _gUp, _grDir, _grHit, _grOrigin, grassRaycaster
} from './scratch.js';

export const SEABED_GN = 16;            // submerged-mask + floor-height grid resolution
const KELP_COUNT = 1500;                // fronds, scattered into distinct beds by the cluster scatter
const FISH_COUNT = 150;                 // a few small schools
const FISH_URL = 'assets/fish.glb';
export let seabedField = null;
export let kelpUniforms = null;         // captured from kelp's onBeforeCompile

// Patchiness comes from the CLUSTER scatter alone (a handful of tight beds /
// schools with open water between), not a wide spatial mask — an earlier
// body-local "habitat" noise made whole regions barren and you could swim for
// ages without finding any, so it's gone. Everything submerged can host life;
// the beds are just sparse and clumped.

// A tall tapered frond pointing +Y, base at y=0, tip at y=1, gentle forward
// lean, dark→light gradient (fake AO at the holdfast). `aH` carries normalized
// height for height-weighted sway in the shader.
function buildKelpGeometry() {
  const segs = 6, halfBase = 0.06;
  const pos = [], col = [], nrm = [], aH = [], idx = [];
  for (let s = 0; s <= segs; s++) {
    const y = s / segs;
    const hw = halfBase * (1 - y * 0.7);
    const z = y * y * 0.22;
    pos.push(-hw, y, z,  hw, y, z);
    const shade = 0.35 + 0.65 * y;
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

// Cluster scatter into kelp beds / fish schools: pick a clump centre, drop a
// handful of instances in a tight disc around it, with open water between.
function scatterClusters(count, baseUV, yaw, sizeJit, extra, perClumpMin, perClumpSpan, radMin, radSpan) {
  let i = 0;
  while (i < count) {
    const cx = Math.random() * 2 - 1, cy = Math.random() * 2 - 1;
    const n  = perClumpMin + (Math.random() * perClumpSpan | 0);
    const cr = radMin + Math.random() * radSpan;
    for (let k = 0; k < n && i < count; k++, i++) {
      const a = Math.random() * Math.PI * 2, rr = Math.sqrt(Math.random()) * cr;
      baseUV[2 * i]     = Math.max(-1, Math.min(1, cx + Math.cos(a) * rr));
      baseUV[2 * i + 1] = Math.max(-1, Math.min(1, cy + Math.sin(a) * rr));
      yaw[i]     = Math.random() * Math.PI * 2;
      sizeJit[i] = 0.7 + Math.random() * 0.6;
      if (extra) extra(i);
    }
  }
}

// Load assets/fish.glb once, bake node transforms into cloned geometries, align
// the fish's longest horizontal axis to +Z (swim forward) regardless of how the
// source was modelled, centre it on all axes, and scale it to unit length. Each
// sub-mesh keeps its own textured material (we only add a fade attribute).
let fishTemplatePromise = null;
function loadFishTemplate() {
  if (fishTemplatePromise) return fishTemplatePromise;
  const loader = new GLTFLoader();
  fishTemplatePromise = new Promise((resolve, reject) => {
    loader.load(FISH_URL, (g) => {
      g.scene.updateMatrixWorld(true);
      const subs = [];
      const bbox = new THREE.Box3();
      g.scene.traverse((o) => {
        if (!o.isMesh) return;
        const geo = o.geometry.clone();
        geo.applyMatrix4(o.matrixWorld);
        geo.computeBoundingBox();
        bbox.union(geo.boundingBox);
        const mat = Array.isArray(o.material) ? o.material[0] : o.material;
        if (mat && mat.emissive) { mat.emissive.setHex(0x0a0d12); mat.emissiveIntensity = 1.0; }  // faint deep-water fill
        subs.push({ geo, mat });
      });
      const size = bbox.getSize(new THREE.Vector3());
      const center = bbox.getCenter(new THREE.Vector3());
      const len = Math.max(size.x, size.z) || 1;
      const R = new THREE.Matrix4();
      if (size.x > size.z) R.makeRotationY(-Math.PI / 2);   // long axis X → Z (nose forward)
      const M = new THREE.Matrix4().makeScale(1 / len, 1 / len, 1 / len)
        .multiply(R)
        .multiply(new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z));
      subs.forEach((sub) => { sub.geo.applyMatrix4(M); sub.geo.computeVertexNormals(); });
      resolve({ subs });
    }, undefined, reject);
  });
  return fishTemplatePromise;
}

function buildSeabedField() {
  // ── Kelp/algae fronds (procedural) ─────────────────────────────────
  const kelpGeo = buildKelpGeometry();
  const kelpFade = new Float32Array(KELP_COUNT).fill(1);
  kelpGeo.setAttribute('aFade', new THREE.InstancedBufferAttribute(kelpFade, 1).setUsage(THREE.DynamicDrawUsage));
  const kelpMat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.85, metalness: 0.0, side: THREE.DoubleSide,
  });
  kelpMat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = { value: 0 };
    sh.uniforms.uSway = { value: 0.32 };
    kelpUniforms = sh.uniforms;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>',
        '#include <common>\nattribute float aH;\nattribute float aFade;\nuniform float uTime;\nuniform float uSway;')
      .replace('#include <color_vertex>',
        '#include <color_vertex>\n  vColor = mix(vec3(1.0), vColor, clamp(aFade, 0.0, 1.0));')
      .replace('#include <begin_vertex>',
        '#include <begin_vertex>\n'
      + '  float _kph = instanceMatrix[3][0] * 9.0 + instanceMatrix[3][2] * 6.0;\n'
      + '  float _ksw = uSway * pow(aH, 1.4) * (sin(uTime * 0.9 + _kph) * 0.7 + sin(uTime * 1.7 + _kph * 1.5) * 0.3);\n'
      + '  transformed.x += _ksw;\n'
      + '  transformed.z += _ksw * 0.5;\n');
  };
  kelpMat.customProgramCacheKey = () => 'seabedKelp';
  const kelpMesh = new THREE.InstancedMesh(kelpGeo, kelpMat, KELP_COUNT);
  kelpMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  kelpMesh.frustumCulled = false;
  kelpMesh.castShadow = false;
  kelpMesh.receiveShadow = false;
  kelpMesh.visible = false;

  const kelpUV = new Float32Array(KELP_COUNT * 2);
  const kelpYaw = new Float32Array(KELP_COUNT);
  const kelpJit = new Float32Array(KELP_COUNT);
  const _kc = new THREE.Color();
  // Fewer, larger, denser clumps = a handful of distinct lush kelp beds with
  // open water between, rather than a uniform lawn of single tufts.
  scatterClusters(KELP_COUNT, kelpUV, kelpYaw, kelpJit, (i) => {
    const t = Math.random();
    _kc.setRGB(0.10 + t * 0.10, 0.30 + Math.random() * 0.20, 0.16 + t * 0.12);   // olive → teal
    kelpMesh.setColorAt(i, _kc);
  }, 25, 30, 0.02, 0.04);
  kelpMesh.instanceColor.needsUpdate = true;
  kelpMesh.instanceColor.setUsage(THREE.StaticDrawUsage);

  seabedField = {
    kelp: { mesh: kelpMesh, baseUV: kelpUV, yaw: kelpYaw, jit: kelpJit, fadeArr: kelpFade, count: KELP_COUNT },
    fish: null,                                          // filled in once fish.glb resolves
    PR: 1, bladeH: 0.02,
    grid: new Float32Array(SEABED_GN * SEABED_GN),       // real seabed radius per cell
    gridSub: new Float32Array(SEABED_GN * SEABED_GN),    // 1 = submerged (floor below sea level)
    gridHalf: 1, gridValid: false, gridU: 0, gridV: 0,
    gridUp: new THREE.Vector3(), gridRight: new THREE.Vector3(), gridFwd: new THREE.Vector3(),
    lastU: NaN, lastV: NaN, placed: false, time: 0, pendingBody: null,
  };

  // Fish load lazily; wire them in when ready (and attach if we're already down).
  loadFishTemplate().then((tpl) => {
    if (!seabedField) return;
    buildFishGroup(tpl);
    if (seabedField.pendingBody && viewMode === 'surface') {
      for (const m of seabedField.fish.meshes) { if (m.parent) m.parent.remove(m); seabedField.pendingBody.mesh.add(m); }
    }
  }).catch((err) => console.error('[seabed] fish GLB load failed', err));
}

// Build the instanced fish school from the loaded template (one InstancedMesh
// per sub-mesh). Distance fade is dithered alpha (alphaHash), like the props.
function buildFishGroup(tpl) {
  const fadeArr = new Float32Array(FISH_COUNT).fill(1);
  const meshes = tpl.subs.map((sub) => {
    sub.geo.setAttribute('aFade', new THREE.InstancedBufferAttribute(fadeArr, 1).setUsage(THREE.DynamicDrawUsage));
    sub.mat.alphaHash = true;
    sub.mat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aFade;\nvarying float vFade;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vFade = aFade;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vFade;')
        .replace('#include <color_fragment>', '#include <color_fragment>\n  diffuseColor.a *= vFade;');
    };
    sub.mat.customProgramCacheKey = () => 'seabedFish';
    const mesh = new THREE.InstancedMesh(sub.geo, sub.mat, FISH_COUNT);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.visible = false;
    return mesh;
  });
  const baseUV = new Float32Array(FISH_COUNT * 2);
  const yaw = new Float32Array(FISH_COUNT);
  const jit = new Float32Array(FISH_COUNT);
  const level = new Float32Array(FISH_COUNT);   // 0..1 height through the water column
  const phase = new Float32Array(FISH_COUNT);   // per-fish weave phase
  scatterClusters(FISH_COUNT, baseUV, yaw, jit, (i) => {
    level[i] = 0.3 + Math.random() * 0.5;
    phase[i] = Math.random() * Math.PI * 2;
  }, 10, 20, 0.01, 0.03);
  seabedField.fish = { meshes, baseUV, yaw, jit, level, phase, fadeArr, count: FISH_COUNT };
}

// True only on liquid-water worlds — the only place a seabed makes sense.
function bodyHasSeabed(body) {
  return !!(body && body.kind === 'planet' && body.matter && body.matter.liquid && body.oceanIsWater);
}

function fishMeshes() { return seabedField && seabedField.fish ? seabedField.fish.meshes : []; }

export function attachSeabed(body) {
  if (!seabedField) buildSeabedField();
  const sf = seabedField;
  sf.pendingBody = body;
  const horizon = Math.sqrt(2 * body.baseRadius * surfaceState.eyeHeight);
  sf.PR = Math.max(surfaceState.eyeHeight * 30, horizon * 1.6);
  sf.bladeH = surfaceState.eyeHeight * 1.1;    // shorter fronds (was 2.4× eye height)
  sf.gridValid = false;
  sf.placed = false;
  sf.lastU = NaN; sf.lastV = NaN;
  sf.kelp.mesh.visible = false;
  if (sf.kelp.mesh.parent) sf.kelp.mesh.parent.remove(sf.kelp.mesh);
  body.mesh.add(sf.kelp.mesh);
  for (const m of fishMeshes()) { m.visible = false; if (m.parent) m.parent.remove(m); body.mesh.add(m); }
}

export function detachSeabed() {
  if (!seabedField) return;
  if (seabedField.kelp.mesh.parent) seabedField.kelp.mesh.parent.remove(seabedField.kelp.mesh);
  for (const m of fishMeshes()) if (m.parent) m.parent.remove(m);
  seabedField.pendingBody = null;
}

// Re-sample the submerged mask and real seabed radius in the avatar's current
// tangent frame. GN×GN downward raycasts (same burst as the grass grid).
function refreshSeabedGrid() {
  const sf = seabedField, body = surfaceState.body;
  body.mesh.updateMatrixWorld();
  const mw = body.mesh.matrixWorld;
  const high = body.baseRadius * (1 + MAX_LAND_HEIGHT * BODY_HEIGHT_SCALE) + 1;
  sf.gridUp.copy(surfaceState.localUp);
  sf.gridRight.copy(surfaceState.localRight);
  sf.gridFwd.copy(surfaceState.localFwd);
  sf.gridU = surfaceState.grassU;
  sf.gridV = surfaceState.grassV;
  sf.gridHalf = sf.PR * 1.3;
  const footR = surfaceState.groundRadius, GH = sf.gridHalf, GN = SEABED_GN;
  const seaR = body.baseRadius;
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
      let r = footR, sub = 0;
      if (hits.length) {
        _grHit.copy(hits[0].point); body.mesh.worldToLocal(_grHit); r = _grHit.length();
        sub = r < seaR - body.baseRadius * 0.0005 ? 1 : 0;
      }
      const o = iy * GN + ix;
      sf.grid[o] = r; sf.gridSub[o] = sub;
    }
  }
  sf.gridValid = true;
}

function seabedBilinear(arr, gridHalf, su, sv) {
  const GN = SEABED_GN, GH = gridHalf;
  let fx = (su / GH * 0.5 + 0.5) * (GN - 1);
  let fy = (sv / GH * 0.5 + 0.5) * (GN - 1);
  fx = fx < 0 ? 0 : fx > GN - 1 ? GN - 1 : fx;
  fy = fy < 0 ? 0 : fy > GN - 1 ? GN - 1 : fy;
  const x0 = fx | 0, y0 = fy | 0;
  const x1 = x0 < GN - 1 ? x0 + 1 : x0, y1 = y0 < GN - 1 ? y0 + 1 : y0;
  const tx = fx - x0, ty = fy - y0;
  const a = arr[y0 * GN + x0] + (arr[y0 * GN + x1] - arr[y0 * GN + x0]) * tx;
  const b = arr[y1 * GN + x0] + (arr[y1 * GN + x1] - arr[y1 * GN + x0]) * tx;
  return a + (b - a) * ty;
}

// Per-frame: advance the current/swim clock (always, so kelp sways even idle),
// then re-place instances only when the treadmill shifted / the grid re-anchored
// (kelp), or every frame (fish, since they mill).
export function updateSeabed(dt) {
  if (!seabedField || viewMode !== 'surface' || !surfaceState.body) return;
  const sf = seabedField, body = surfaceState.body;
  sf.time += dt;
  if (kelpUniforms) kelpUniforms.uTime.value = sf.time;

  if (!bodyHasSeabed(body)) {
    sf.kelp.mesh.visible = false;
    for (const m of fishMeshes()) m.visible = false;
    return;
  }

  const PR = sf.PR;
  let gridRefreshed = false;
  if (!sf.gridValid ||
      Math.abs(surfaceState.grassU - sf.gridU) > PR * 0.4 ||
      Math.abs(surfaceState.grassV - sf.gridV) > PR * 0.4) {
    refreshSeabedGrid();
    gridRefreshed = true;
  }

  // Hide everything if no submerged cell is in range (walker is inland).
  let any = false;
  for (let k = 0; k < sf.gridSub.length; k++) if (sf.gridSub[k] > 0) { any = true; break; }
  sf.kelp.mesh.visible = any;
  for (const m of fishMeshes()) m.visible = any;
  if (!any) return;

  const moved = surfaceState.grassU !== sf.lastU || surfaceState.grassV !== sf.lastV;
  const placeKelp = moved || gridRefreshed || !sf.placed;
  sf.lastU = surfaceState.grassU;
  sf.lastV = surfaceState.grassV;
  sf.placed = true;

  const up = surfaceState.localUp, right = surfaceState.localRight, fwd = surfaceState.localFwd;
  const footR = surfaceState.groundRadius;
  const uOff = surfaceState.grassU, vOff = surfaceState.grassV;
  const driftU = surfaceState.grassU - sf.gridU, driftV = surfaceState.grassV - sf.gridV;

  if (placeKelp) placeKelpGroup(sf, up, right, fwd, footR, uOff, vOff, driftU, driftV);
  if (sf.fish) placeFishGroup(sf, up, right, fwd, footR, uOff, vOff, driftU, driftV);
}

// Per-instance mask × edge fade, shared by kelp + fish: 0 off a submerged cell
// or past the patch edge; smooth 0..1 otherwise.
function maskFade(sf, u, v, driftU, driftV, fadeNear, fadeFar) {
  const sub = seabedBilinear(sf.gridSub, sf.gridHalf, driftU + u, driftV + v);
  if (sub <= 0.5) return 0;
  const dist = Math.sqrt(u * u + v * v);
  let edge = (fadeFar - dist) / (fadeFar - fadeNear);
  edge = edge < 0 ? 0 : edge > 1 ? 1 : edge;
  return edge * edge * (3 - 2 * edge);
}

// Roots a frond on each submerged cell, capping height to the local water depth
// so fronds stay under the surface.
function placeKelpGroup(sf, up, right, fwd, footR, uOff, vOff, driftU, driftV) {
  const grp = sf.kelp, PR = sf.PR, period = PR * 2;
  const fadeNear = PR * 0.82, fadeFar = PR;
  const seaR = surfaceState.body.baseRadius;
  for (let i = 0; i < grp.count; i++) {
    let u = grp.baseUV[2 * i]     * PR - uOff;
    let v = grp.baseUV[2 * i + 1] * PR - vOff;
    u -= period * Math.floor((u + PR) / period);
    v -= period * Math.floor((v + PR) / period);
    const fade = maskFade(sf, u, v, driftU, driftV, fadeNear, fadeFar);
    if (fade <= 0.01) { grp.fadeArr[i] = 0; _gMat.makeScale(0, 0, 0); grp.mesh.setMatrixAt(i, _gMat); continue; }
    grp.fadeArr[i] = fade;
    _gP.copy(up).multiplyScalar(footR).addScaledVector(right, u).addScaledVector(fwd, v);
    _gUp.copy(_gP).normalize();
    const r = seabedBilinear(sf.grid, sf.gridHalf, driftU + u, driftV + v);
    const depth = Math.max(0, seaR - r);
    _gP.copy(_gUp).multiplyScalar(r);
    _gQuat.setFromUnitVectors(_gAxisY, _gUp);
    _gRot.setFromAxisAngle(_gUp, grp.yaw[i]);
    _gQuat.premultiply(_gRot);
    let h = sf.bladeH * grp.jit[i] * fade;
    h = Math.min(h, depth * 0.85);          // keep fronds under the surface
    const w = h * 0.5;
    _gScale.set(w, h, w);
    _gMat.compose(_gP, _gQuat, _gScale);
    grp.mesh.setMatrixAt(i, _gMat);
  }
  grp.mesh.instanceMatrix.needsUpdate = true;
  grp.mesh.geometry.getAttribute('aFade').needsUpdate = true;
}

// Hovers each fish in the water column over a submerged cell, milling it slowly
// in a circle (the school drifts about), and yaws it to face its path. Schools
// fade out in shallow water so they stay offshore, not lapping the beach.
function placeFishGroup(sf, up, right, fwd, footR, uOff, vOff, driftU, driftV) {
  const grp = sf.fish, PR = sf.PR, period = PR * 2;
  const fadeNear = PR * 0.82, fadeFar = PR;
  const seaR = surfaceState.body.baseRadius;
  const t = sf.time, eh = surfaceState.eyeHeight;
  const swim = eh * 5;                                   // weave amplitude in tangent units
  const FISH_MIN_DEPTH = eh * 4;                         // no fish in water shallower than this
  for (let i = 0; i < grp.count; i++) {
    const ph = grp.phase[i];
    const wu = Math.cos(t * 0.35 + ph) * swim;
    const wv = Math.sin(t * 0.35 + ph) * swim;
    let u = grp.baseUV[2 * i]     * PR - uOff + wu;
    let v = grp.baseUV[2 * i + 1] * PR - vOff + wv;
    u -= period * Math.floor((u + PR) / period);
    v -= period * Math.floor((v + PR) / period);
    const r = seabedBilinear(sf.grid, sf.gridHalf, driftU + u, driftV + v);
    const depth = Math.max(0, seaR - r);
    // Keep schools offshore: fade them out in shallow water near the coast.
    let depthFade = (depth - FISH_MIN_DEPTH) / FISH_MIN_DEPTH;
    depthFade = depthFade < 0 ? 0 : depthFade > 1 ? 1 : depthFade;
    const fade = maskFade(sf, u, v, driftU, driftV, fadeNear, fadeFar) * depthFade;
    if (fade <= 0.01) { grp.fadeArr[i] = 0; _gMat.makeScale(0, 0, 0); for (const m of grp.meshes) m.setMatrixAt(i, _gMat); continue; }
    grp.fadeArr[i] = fade;
    _gP.copy(up).multiplyScalar(footR).addScaledVector(right, u).addScaledVector(fwd, v);
    _gUp.copy(_gP).normalize();
    const lift = Math.min(depth * grp.level[i], depth - eh * 0.4);
    _gP.copy(_gUp).multiplyScalar(r + Math.max(eh * 0.4, lift));
    // Face the tangent velocity of the circular weave.
    const heading = Math.atan2(-Math.sin(t * 0.35 + ph), Math.cos(t * 0.35 + ph));
    _gQuat.setFromUnitVectors(_gAxisY, _gUp);
    _gRot.setFromAxisAngle(_gUp, heading);
    _gQuat.premultiply(_gRot);
    const s = eh * 0.45 * grp.jit[i];                    // tiny fish (~half an eye-height long)
    _gScale.set(s, s, s);
    _gMat.compose(_gP, _gQuat, _gScale);
    for (const m of grp.meshes) m.setMatrixAt(i, _gMat);
  }
  for (const m of grp.meshes) {
    m.instanceMatrix.needsUpdate = true;
    m.geometry.getAttribute('aFade').needsUpdate = true;
  }
}

// Console diagnostic: `seabedDiag()` in DevTools while walking a water world.
window.seabedDiag = () => {
  const sf = seabedField, body = surfaceState.body;
  if (!sf) return 'seabed not built yet (enter a water world surface first)';
  let subCells = 0;
  for (let k = 0; k < sf.gridSub.length; k++) if (sf.gridSub[k] > 0) subCells++;
  return {
    VERSION: 'seabed-v3',
    body: body && body.name, hasSeabed: bodyHasSeabed(body),
    kelpVisible: sf.kelp.mesh.visible, fishLoaded: !!sf.fish,
    fishVisible: fishMeshes().some((m) => m.visible),
    gridValid: sf.gridValid,
    submergedCells: subCells + '/' + sf.gridSub.length,
    PR: sf.PR, bladeH: sf.bladeH, kelpCount: KELP_COUNT, fishCount: FISH_COUNT,
  };
};
