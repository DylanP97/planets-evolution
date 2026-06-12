// Real GLB surface props (trees, pines, rocks) scattered over grass worlds
// on the same treadmill grid as the grass.
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as THREE from 'three';
import { BODY_HEIGHT_SCALE, MAX_LAND_HEIGHT } from '../../core/constants.js';
import { viewMode } from '../../framework/state.js';
import { surfaceState } from './core.js';
import {
  _gAxisY, _gMat, _gP, _gQuat, _gRot, _gScale, _gUp, _grDir, _grHit, _grOrigin, grassRaycaster, groundIsGrassFace
} from './grass.js';

// ── Surface props (real GLB trees + rocks) ──────────────────────────────
// CC0 low-poly models (Quaternius, via poly.pizza) loaded once, normalized to
// unit height + grounded (bottom at y=0) like the satellite/astronaut loaders,
// then InstancedMesh-scattered with the SAME past-horizon treadmill + raycast
// height grid as grass/rocks — so props sit on the terrain and never pop in
// (their fade edge is below the skyline). One InstancedMesh per GLB sub-mesh
// (trunk + foliage share one transform array). Trees gate to grass faces; rocks
// to any land. Whole field shows only on terrestrial planets.
export const PROP_GN = 10;            // height/mask grid resolution (raycasts on re-anchor)
export const PROP_SPECS = [
  { url: 'assets/tree.glb', kind: 'tree', count: 110, targetH: 7.0, gate: 'grass', sink: 0.0,  jitter: 0.45 },
  { url: 'assets/pine.glb', kind: 'tree', count: 85,  targetH: 9.0, gate: 'grass', sink: 0.0,  jitter: 0.45 },
  { url: 'assets/rock.glb', kind: 'rock', count: 240, targetH: 1.5, gate: 'land',  sink: 0.28, jitter: 0.7  },
];
export const propTemplateCache = {};
export let propField = null, propBuilding = false, propPendingBody = null;

// Load + normalize a GLB into a list of {geo, mat} sub-meshes: every mesh's node
// transform is baked into a cloned geometry, then the whole model is scaled to
// height 1 and translated so its base sits at y=0, centred on X/Z. The per-
// instance matrix later applies the real world height, yaw, and ground position.
export function loadPropTemplate(url) {
  if (propTemplateCache[url]) return propTemplateCache[url];
  const loader = new GLTFLoader();
  const p = new Promise((resolve, reject) => {
    loader.load(url, (g) => {
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
        if (mat && mat.emissive) { mat.emissive.setHex(0x0c0f0a); mat.emissiveIntensity = 1.0; }  // faint night-side fill
        subs.push({ geo, mat });
      });
      const size = bbox.getSize(new THREE.Vector3());
      const center = bbox.getCenter(new THREE.Vector3());
      const s = 1 / (size.y || 1);
      const m = new THREE.Matrix4().makeScale(s, s, s)
        .multiply(new THREE.Matrix4().makeTranslation(-center.x, -bbox.min.y, -center.z));
      subs.forEach((sub) => { sub.geo.applyMatrix4(m); sub.geo.computeVertexNormals(); });
      resolve({ subs });
    }, undefined, reject);
  });
  propTemplateCache[url] = p;
  return p;
}

export function buildPropField() {
  Promise.all(PROP_SPECS.map((sp) => loadPropTemplate(sp.url))).then((templates) => {
    const groups = PROP_SPECS.map((spec, gi) => {
      const tpl = templates[gi];
      // Shared per-instance distance fade (1 = solid, 0 = gone), applied as DITHERED
      // alpha (alphaHash) so distant props dissolve into the haze near the skyline
      // instead of standing as a hard silhouette band. Dithering needs no transparency
      // sorting, so instanced foliage stays artifact-free — and it works at night too
      // (unlike fog, which we dim on the dark side).
      const fadeArr = new Float32Array(spec.count).fill(1);
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
        sub.mat.customProgramCacheKey = () => 'propFade:' + spec.url;
        const mesh = new THREE.InstancedMesh(sub.geo, sub.mat, spec.count);
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.frustumCulled = false;
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        mesh.visible = false;
        return mesh;
      });
      const baseUV = new Float32Array(spec.count * 2);
      const yaw = new Float32Array(spec.count);
      const sizeJit = new Float32Array(spec.count);
      // Cluster scatter (copses of trees, rock piles) with open ground between.
      let i = 0;
      while (i < spec.count) {
        const cx = Math.random() * 2 - 1, cy = Math.random() * 2 - 1;
        const n  = spec.kind === 'tree' ? 1 + (Math.random() * 4 | 0) : 2 + (Math.random() * 8 | 0);
        const cr = spec.kind === 'tree' ? 0.03 + Math.random() * 0.06 : 0.02 + Math.random() * 0.05;
        for (let k = 0; k < n && i < spec.count; k++, i++) {
          const a = Math.random() * Math.PI * 2, rr = Math.sqrt(Math.random()) * cr;
          baseUV[2 * i]     = Math.max(-1, Math.min(1, cx + Math.cos(a) * rr));
          baseUV[2 * i + 1] = Math.max(-1, Math.min(1, cy + Math.sin(a) * rr));
          yaw[i]     = Math.random() * Math.PI * 2;
          sizeJit[i] = 1 - spec.jitter * Math.random();
        }
      }
      return { spec, meshes, baseUV, yaw, sizeJit, fadeArr };
    });
    propField = {
      groups, PR: 1, gridHalf: 1, gridValid: false, gridU: 0, gridV: 0,
      gridUp: new THREE.Vector3(), gridRight: new THREE.Vector3(), gridFwd: new THREE.Vector3(),
      grid: new Float32Array(PROP_GN * PROP_GN),
      gridGrass: new Float32Array(PROP_GN * PROP_GN),
      gridLand: new Float32Array(PROP_GN * PROP_GN),
    };
    console.info('[surface-detail] prop GLBs loaded — groups:', groups.map(g => g.spec.url + '×' + g.spec.count).join(', '));
    if (propPendingBody && viewMode === 'surface') attachProps(propPendingBody);
    propPendingBody = null;
  }).catch((err) => { console.error('[surface] prop GLB load failed', err); propBuilding = false; });
}

export function attachProps(body) {
  if (!propField) {
    if (!propBuilding) { propBuilding = true; buildPropField(); }
    propPendingBody = body;
    return;
  }
  const pf = propField;
  const horizon = Math.sqrt(2 * body.baseRadius * surfaceState.eyeHeight);
  pf.PR = Math.max(surfaceState.eyeHeight * 30, horizon * 1.35);
  pf.fadeNear = horizon * 0.75;   // props fully solid within this tangent distance
  pf.fadeFar  = horizon * 1.12;   // ...dithered to nothing by here (just past the skyline)
  pf.gridValid = false;
  for (const g of pf.groups) for (const m of g.meshes) {
    m.visible = false;
    if (m.parent) m.parent.remove(m);
    body.mesh.add(m);
  }
}

export function detachProps() {
  if (!propField) return;
  for (const g of propField.groups) for (const m of g.meshes) if (m.parent) m.parent.remove(m);
}

export function refreshPropGrid() {
  const pf = propField, body = surfaceState.body;
  body.mesh.updateMatrixWorld();
  const mw = body.mesh.matrixWorld;
  const high = body.baseRadius * (1 + MAX_LAND_HEIGHT * BODY_HEIGHT_SCALE) + 1;
  pf.gridUp.copy(surfaceState.localUp);
  pf.gridRight.copy(surfaceState.localRight);
  pf.gridFwd.copy(surfaceState.localFwd);
  pf.gridU = surfaceState.grassU;
  pf.gridV = surfaceState.grassV;
  pf.gridHalf = pf.PR * 1.3;
  const footR = surfaceState.groundRadius, GH = pf.gridHalf, GN = PROP_GN;
  const liquid = !!(body.matter && body.matter.liquid);
  for (let iy = 0; iy < GN; iy++) {
    for (let ix = 0; ix < GN; ix++) {
      const gu = (ix / (GN - 1) * 2 - 1) * GH;
      const gv = (iy / (GN - 1) * 2 - 1) * GH;
      _gP.copy(pf.gridUp).multiplyScalar(footR).addScaledVector(pf.gridRight, gu).addScaledVector(pf.gridFwd, gv);
      _gUp.copy(_gP).normalize();
      _grOrigin.copy(_gUp).multiplyScalar(high).applyMatrix4(mw);
      _grDir.copy(_gUp).multiplyScalar(-1).transformDirection(mw).normalize();
      grassRaycaster.set(_grOrigin, _grDir);
      const hits = grassRaycaster.intersectObject(body.mesh, false);
      let r = footR, isGrass = 0, isLand = 0;
      if (hits.length) {
        _grHit.copy(hits[0].point); body.mesh.worldToLocal(_grHit); r = _grHit.length();
        isGrass = groundIsGrassFace(body, hits[0].face) ? 1 : 0;
        isLand  = (!liquid || r >= body.baseRadius) ? 1 : 0;   // above sea level = plantable land
      }
      const o = iy * GN + ix;
      pf.grid[o] = r; pf.gridGrass[o] = isGrass; pf.gridLand[o] = isLand;
    }
  }
  pf.gridValid = true;
}

export function propBilinear(arr, gridHalf, su, sv) {
  const GN = PROP_GN, GH = gridHalf;
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

// Per-frame: place every prop instance against the shared grid. Trees stand on
// grass, rocks on any land; both follow terrain height and only appear on
// terrestrial planets. No reveal-scaling here — the past-horizon radius means
// the edge fade is occluded by the planet's curvature, so nothing visibly grows.
export function updateProps(dt) {
  if (!propField || viewMode !== 'surface' || !surfaceState.body) return;
  const body = surfaceState.body, pf = propField;
  const show = body.kind === 'planet' && body.archetype === 'terrestrial';
  if (!show) { for (const g of pf.groups) for (const m of g.meshes) m.visible = false; return; }
  const PR = pf.PR;
  if (!pf.gridValid ||
      Math.abs(surfaceState.grassU - pf.gridU) > PR * 0.4 ||
      Math.abs(surfaceState.grassV - pf.gridV) > PR * 0.4) {
    refreshPropGrid();
  }
  const period = PR * 2, eh = surfaceState.eyeHeight;
  const up = surfaceState.localUp, right = surfaceState.localRight, fwd = surfaceState.localFwd;
  const footR = surfaceState.groundRadius;
  const uOff = surfaceState.grassU, vOff = surfaceState.grassV;
  const driftU = surfaceState.grassU - pf.gridU, driftV = surfaceState.grassV - pf.gridV;
  for (const g of pf.groups) {
    const spec = g.spec, targetH = spec.targetH * eh, sink = spec.sink;
    const maskArr = spec.gate === 'grass' ? pf.gridGrass : pf.gridLand;
    for (let i = 0; i < spec.count; i++) {
      let u = g.baseUV[2 * i]     * PR - uOff;
      let v = g.baseUV[2 * i + 1] * PR - vOff;
      u -= period * Math.floor((u + PR) / period);
      v -= period * Math.floor((v + PR) / period);
      const present = propBilinear(maskArr, pf.gridHalf, driftU + u, driftV + v) > 0.4 ? 1 : 0;
      // Horizon haze: dissolve toward the skyline via dithered alpha (not scale),
      // so props never stand as a hard band and nothing visibly "grows" as you walk.
      const dist = Math.sqrt(u * u + v * v);
      let a = (pf.fadeFar - dist) / (pf.fadeFar - pf.fadeNear);
      a = a < 0 ? 0 : a > 1 ? 1 : a;
      a = a * a * (3 - 2 * a);
      const fade = present ? a : 0;
      if (fade <= 0.01) { g.fadeArr[i] = 0; _gMat.makeScale(0, 0, 0); for (const m of g.meshes) m.setMatrixAt(i, _gMat); continue; }
      g.fadeArr[i] = fade;
      _gP.copy(up).multiplyScalar(footR).addScaledVector(right, u).addScaledVector(fwd, v);
      _gUp.copy(_gP).normalize();
      const r = propBilinear(pf.grid, pf.gridHalf, driftU + u, driftV + v) - sink * targetH * g.sizeJit[i];
      _gP.copy(_gUp).multiplyScalar(r);
      _gQuat.setFromUnitVectors(_gAxisY, _gUp);
      _gRot.setFromAxisAngle(_gUp, g.yaw[i]);
      _gQuat.premultiply(_gRot);
      const sc = targetH * g.sizeJit[i];
      _gScale.set(sc, sc, sc);
      _gMat.compose(_gP, _gQuat, _gScale);
      for (const m of g.meshes) { m.visible = true; m.setMatrixAt(i, _gMat); }
    }
    for (const m of g.meshes) { m.instanceMatrix.needsUpdate = true; m.geometry.getAttribute('aFade').needsUpdate = true; }
  }
}

// WASD walking. Movement happens in body-local space along the tangent
// plane at the current standing point, then the position is renormalized
// to the standing sphere (groundRadius + eyeHeight). The local frame is
// parallel-transported across the surface so yaw stays meaningful — the
// direction the user faces relative to "north" remains consistent step
// to step.
