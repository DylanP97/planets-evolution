// Real GLB surface props (trees, pines, rocks) scattered over grass worlds
// on the same treadmill grid as the grass.
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as THREE from 'three';
import { BODY_HEIGHT_SCALE, MAX_LAND_HEIGHT } from '../../core/constants.js';
import { viewMode } from '../../framework/state.js';
import { surfaceState } from './core.js';
import { FACE_BIOME, groundBiomeOfFace } from '../../framework/body.js';
import {
  _gAxisY, _gMat, _gP, _gQuat, _gRot, _gScale, _gUp, _grDir, _grHit, _grOrigin, grassRaycaster
} from './scratch.js';

// ── Surface props (real GLB trees + rocks) ──────────────────────────────
// CC0 low-poly models (Quaternius, via poly.pizza) loaded once, normalized to
// unit height + grounded (bottom at y=0) like the satellite/astronaut loaders,
// then InstancedMesh-scattered with the SAME past-horizon treadmill + raycast
// height grid as grass/rocks — so props sit on the terrain and never pop in
// (their fade edge is below the skyline). One InstancedMesh per GLB sub-mesh
// (trunk + foliage share one transform array). Each spec gates to ONE surface
// biome (groundBiomeOfFace): pines → forest ground, boulders → tundra ground,
// and a dense jungle layer (palm canopy + fern/bush/flower understory) → the
// tropical jungle band. Grass / coast / ice / desert ground grows no props.
// Whole field shows only on terrestrial planets.
export const PROP_GN = 20;            // height/mask grid resolution (raycasts on re-anchor)
// Distance-fade tuning, all in EYE-HORIZONS (1 = √(2·R·eyeHeight), the geometric
// horizon from the avatar's eye). A prop's crown crests the skyline from much
// farther than its base, and a prop on a hilltop farther still, so its top is
// visible out to reach = CAM_HORIZON + HILL_REACH + √targetH:
//   • CAM_HORIZON — the VIEWPOINT's horizon. Not 1 (the eye) but ~1.5, because
//     the third-person camera sits ~2.1× the avatar's height above ground
//     (camera.js: 0.6 chest aim + 1.5 lift), so it sees that much farther.
//   • HILL_REACH  — terrain margin: a prop on a ridge is lifted above the
//     spherical horizon, becoming visible from extra √(hillHeight/eyeHeight)
//     horizons out. Grass hills run several eye-heights, so ~2 covers them.
//   • √targetH    — the prop's own height contribution.
// A prop is fully solid out to its reach, then dithers out over FADE_BAND just
// beyond (occluded by curvature there). The field radius extends PR_MARGIN past
// the fade, and counts scale ~radius² (capped) so the much larger patch keeps
// the old near-field density instead of thinning out. COUNT_CAP bounds the worst
// case — LOWER it if the framerate drops while walking (the fade fix itself is
// free); the tallest props lose a little far-field density first.
const CAM_HORIZON = 1.6;
const HILL_REACH  = 2.0;
const FADE_BAND = 0.4;
const PR_MARGIN = 0.15;
const COUNT_CAP = 20;
export function propReach(targetH) { return CAM_HORIZON + HILL_REACH + Math.sqrt(targetH); }
function propCountScale(targetH) {
  const s = (propReach(targetH) + FADE_BAND + PR_MARGIN) / 1.35;   // vs the old field radius
  return Math.min(COUNT_CAP, s * s);
}
// colR is the solid-cylinder collision radius as a fraction of the prop's world
// height: trees get a slim trunk footprint (you can't pass through, but the wide
// canopy doesn't block); GLB rocks get a wide footprint matching their squat
// silhouette. resolvePropCollision treats every shown instance as an obstacle,
// except specs flagged noCollide (soft understory foliage you brush through).
// gate selects the per-biome mask each spec scatters on (see groundBiomeOfFace
// in grass.js): 'forest' = forest ground only (pines), 'tundra' = tundra ground
// only (boulders), 'jungle' = the tropical jungle band (palms + understory).
// Each biome gets ONLY its own props: grass/coast/ice/desert ground stays clear
// of trees and rocks (grass biome reads as open meadow), forest grows pines (no
// other tree), tundra grows rocks (no trees), and the jungle layers a dense palm
// canopy + fern/bush/flower understory so the tropics read as thick rainforest.
export const PROP_SPECS = [
  { url: 'assets/pine.glb',           kind: 'tree', count: 95,  targetH: 9.0,  gate: 'forest', sink: 0.0,  jitter: 0.45, colR: 0.05 },
  { url: 'assets/rock.glb',           kind: 'rock', count: 55,  targetH: 1.5,  gate: 'tundra', sink: 0.28, jitter: 0.7,  colR: 0.42 },
  // Dense jungle vegetation — tropical jungle ground (climate band or painted).
  { url: 'assets/palm.glb',           kind: 'tree', count: 120, targetH: 11.0, gate: 'jungle', sink: 0.0,  jitter: 0.4,  colR: 0.05 },
  { url: 'assets/jungle-bush.glb',    kind: 'bush', count: 200, targetH: 2.2,  gate: 'jungle', sink: 0.06, jitter: 0.5,  colR: 0.0, noCollide: true },
  { url: 'assets/fern.glb',           kind: 'bush', count: 220, targetH: 1.6,  gate: 'jungle', sink: 0.05, jitter: 0.5,  colR: 0.0, noCollide: true },
  { url: 'assets/jungle-flowers.glb', kind: 'bush', count: 140, targetH: 1.8,  gate: 'jungle', sink: 0.06, jitter: 0.5,  colR: 0.0, noCollide: true },
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
      // Taller props need a larger field (they stay visible farther out), so scale
      // the instance count ~radius² to hold density steady over the bigger patch.
      const count = Math.round(spec.count * propCountScale(spec.targetH));
      // Shared per-instance distance fade (1 = solid, 0 = gone), applied as DITHERED
      // alpha (alphaHash) so distant props dissolve into the haze near the skyline
      // instead of standing as a hard silhouette band. Dithering needs no transparency
      // sorting, so instanced foliage stays artifact-free — and it works at night too
      // (unlike fog, which we dim on the dark side).
      const fadeArr = new Float32Array(count).fill(1);
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
        const mesh = new THREE.InstancedMesh(sub.geo, sub.mat, count);
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.frustumCulled = false;
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        mesh.visible = false;
        return mesh;
      });
      const baseUV = new Float32Array(count * 2);
      const yaw = new Float32Array(count);
      const sizeJit = new Float32Array(count);
      // Cluster scatter (copses of trees, rock piles) with open ground between.
      let i = 0;
      while (i < count) {
        const cx = Math.random() * 2 - 1, cy = Math.random() * 2 - 1;
        const n  = spec.kind === 'tree' ? 1 + (Math.random() * 4 | 0) : 2 + (Math.random() * 8 | 0);
        const cr = spec.kind === 'tree' ? 0.03 + Math.random() * 0.06 : 0.02 + Math.random() * 0.05;
        for (let k = 0; k < n && i < count; k++, i++) {
          const a = Math.random() * Math.PI * 2, rr = Math.sqrt(Math.random()) * cr;
          baseUV[2 * i]     = Math.max(-1, Math.min(1, cx + Math.cos(a) * rr));
          baseUV[2 * i + 1] = Math.max(-1, Math.min(1, cy + Math.sin(a) * rr));
          yaw[i]     = Math.random() * Math.PI * 2;
          sizeJit[i] = 1 - spec.jitter * Math.random();
        }
      }
      return { spec, count, meshes, baseUV, yaw, sizeJit, fadeArr, PR: 1, fadeNear: 0, fadeFar: 0 };
    });
    propField = {
      groups, PR: 1, gridHalf: 1, gridValid: false, gridU: 0, gridV: 0,
      lastU: NaN, lastV: NaN, placed: false,   // re-place props only when the walker actually moves
      gridUp: new THREE.Vector3(), gridRight: new THREE.Vector3(), gridFwd: new THREE.Vector3(),
      grid: new Float32Array(PROP_GN * PROP_GN),
      gridForest: new Float32Array(PROP_GN * PROP_GN),
      gridTundra: new Float32Array(PROP_GN * PROP_GN),
      gridJungle: new Float32Array(PROP_GN * PROP_GN),
    };
    console.info('[surface-detail] prop GLBs loaded — groups:', groups.map(g => g.spec.url + '×' + g.count).join(', '));
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
  // Per-group fade keyed to each prop's own crest-the-skyline distance: solid out
  // to reach·horizon, dithered out over FADE_BAND beyond it (occluded by curvature
  // there), and the field radius PR_MARGIN past that. pf.PR tracks the largest
  // group so the shared height/biome grid covers every group's field.
  let maxPR = 0;
  for (const g of pf.groups) {
    const reach = propReach(g.spec.targetH);
    g.fadeNear = horizon * reach;
    g.fadeFar  = horizon * (reach + FADE_BAND);
    g.PR = Math.max(surfaceState.eyeHeight * 30, g.fadeFar + horizon * PR_MARGIN);
    if (g.PR > maxPR) maxPR = g.PR;
  }
  pf.PR = maxPR;
  pf.gridValid = false;
  pf.placed = false;
  pf.lastU = NaN; pf.lastV = NaN;
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

// Console diagnostic: run `propDiag()` in DevTools while standing on a planet.
// Reports, for every prop group, where it goes solid→fade→gone in EYE-HORIZONS
// (1 horizon = the geometric skyline from the avatar's eye) so we can see at a
// glance whether the fade band sits past the visible horizon or inside the view.
window.propDiag = () => {
  const pf = propField, body = surfaceState.body;
  if (!pf) return 'props not built yet (enter a surface first)';
  if (!body) return 'no body';
  const horizon = Math.sqrt(2 * body.baseRadius * surfaceState.eyeHeight);
  const h = (n) => +(n / horizon).toFixed(2);   // express a distance in eye-horizons
  return {
    VERSION: 'props-fade-v5',
    body: body.name, kind: body.kind, archetype: body.archetype,
    shows: body.kind === 'planet' && body.archetype === 'terrestrial',
    eyeHeight: +surfaceState.eyeHeight.toFixed(4),
    baseRadius: +body.baseRadius.toFixed(2),
    horizonDist: +horizon.toFixed(4),
    gridValid: pf.gridValid, placed: pf.placed,
    maxPR_horizons: h(pf.PR),
    groups: pf.groups.map((g) => ({
      url: g.spec.url, count: g.count, gate: g.spec.gate,
      solidTo_h: h(g.fadeNear), goneAt_h: h(g.fadeFar), edgeAt_h: h(g.PR),
      anyVisible: g.meshes.some((m) => m.visible),
    })),
  };
};

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
      let r = footR, isForest = 0, isTundra = 0, isJungle = 0;
      if (hits.length) {
        _grHit.copy(hits[0].point); body.mesh.worldToLocal(_grHit); r = _grHit.length();
        const code = groundBiomeOfFace(body, hits[0].face);
        isForest = code === FACE_BIOME.FOREST ? 1 : 0;
        isTundra = code === FACE_BIOME.TUNDRA ? 1 : 0;
        isJungle = code === FACE_BIOME.JUNGLE ? 1 : 0;
      }
      const o = iy * GN + ix;
      pf.grid[o] = r; pf.gridForest[o] = isForest; pf.gridTundra[o] = isTundra; pf.gridJungle[o] = isJungle;
    }
  }
  pf.gridValid = true;
}

// The per-cell biome mask a spec is gated to (see PROP_SPECS.gate).
function propMaskFor(pf, gate) {
  return gate === 'forest' ? pf.gridForest : gate === 'tundra' ? pf.gridTundra : pf.gridJungle;
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

// Per-frame: place every prop instance against the shared grid. Each spec only
// shows where its biome mask passes (pines on forest, rocks on tundra, jungle
// layer on jungle); all follow terrain height and only appear on terrestrial
// planets. No reveal-scaling here — the past-horizon radius means
// the edge fade is occluded by the planet's curvature, so nothing visibly grows.
export function updateProps(dt) {
  if (!propField || viewMode !== 'surface' || !surfaceState.body) return;
  const body = surfaceState.body, pf = propField;
  const show = body.kind === 'planet' && body.archetype === 'terrestrial';
  if (!show) { for (const g of pf.groups) for (const m of g.meshes) m.visible = false; return; }
  const gridPR = pf.PR;   // grid spans the largest group's field; regrid on that scale
  let gridRefreshed = false;
  if (!pf.gridValid ||
      Math.abs(surfaceState.grassU - pf.gridU) > gridPR * 0.4 ||
      Math.abs(surfaceState.grassV - pf.gridV) > gridPR * 0.4) {
    refreshPropGrid();
    gridRefreshed = true;
  }
  for (const g of pf.groups) for (const m of g.meshes) m.visible = true;
  // Props are static relative to the ground, so their matrices only change when
  // the treadmill shifts (walker moved) or the grid re-anchored. Skip the whole
  // re-place (now a much larger instance count) while standing still — this is
  // what buys the bigger, pop-free fields without a per-frame cost at idle.
  const moved = surfaceState.grassU !== pf.lastU || surfaceState.grassV !== pf.lastV;
  if (!moved && !gridRefreshed && pf.placed) return;
  pf.lastU = surfaceState.grassU;
  pf.lastV = surfaceState.grassV;
  pf.placed = true;
  const eh = surfaceState.eyeHeight;
  const up = surfaceState.localUp, right = surfaceState.localRight, fwd = surfaceState.localFwd;
  const footR = surfaceState.groundRadius;
  const uOff = surfaceState.grassU, vOff = surfaceState.grassV;
  const driftU = surfaceState.grassU - pf.gridU, driftV = surfaceState.grassV - pf.gridV;
  for (const g of pf.groups) {
    const spec = g.spec, targetH = spec.targetH * eh, sink = spec.sink;
    const PR = g.PR, period = PR * 2, fadeNear = g.fadeNear, fadeFar = g.fadeFar;
    const maskArr = propMaskFor(pf, spec.gate);
    for (let i = 0; i < g.count; i++) {
      let u = g.baseUV[2 * i]     * PR - uOff;
      let v = g.baseUV[2 * i + 1] * PR - vOff;
      u -= period * Math.floor((u + PR) / period);
      v -= period * Math.floor((v + PR) / period);
      const present = propBilinear(maskArr, pf.gridHalf, driftU + u, driftV + v) > 0.4 ? 1 : 0;
      // Horizon haze: dissolve toward the skyline via dithered alpha (not scale),
      // so props never stand as a hard band and nothing visibly "grows" as you walk.
      const dist = Math.sqrt(u * u + v * v);
      let a = (fadeFar - dist) / (fadeFar - fadeNear);
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

// Prop collision: treat each nearby shown prop as a solid disc in the avatar's
// tangent (treadmill) frame and stop/deflect the proposed step (du,dv) at its
// edge — so trees and GLB rocks are obstacles you can't walk through. Short
// rocks are stepped over, and once a jump clears a rock's height you pass over
// it; trees are too tall to clear. Mirrors resolveRockCollision (rocks.js) but
// fans out over the prop groups and gates each instance on the same biome mask
// updateProps uses, so only props that are actually shown block movement.
const _ppOut = [0, 0];
export function resolvePropCollision(du, dv) {
  _ppOut[0] = du; _ppOut[1] = dv;
  const pf = propField, body = surfaceState.body;
  if (!pf || !pf.gridValid || !body) return _ppOut;
  if (!(body.kind === 'planet' && body.archetype === 'terrestrial')) return _ppOut;
  const eh = surfaceState.eyeHeight;
  const uOff = surfaceState.grassU, vOff = surfaceState.grassV;
  const driftU = surfaceState.grassU - pf.gridU, driftV = surfaceState.grassV - pf.gridV;
  const minColH = eh * 0.18;          // shorter than this: just step over
  const bodyR   = eh * 0.20;          // avatar half-width padding
  const near    = eh * 5;             // ignore props beyond this tangent range
  const airborne = !surfaceState.grounded;
  let nu = du, nv = dv;
  for (const g of pf.groups) {
    const spec = g.spec, targetH = spec.targetH * eh;
    if (spec.noCollide) continue;                              // soft foliage: walk through
    const PR = g.PR, period = PR * 2;
    const maskArr = propMaskFor(pf, spec.gate);
    for (let i = 0; i < g.count; i++) {
      const sc = targetH * g.sizeJit[i];                       // prop world height
      if (sc < minColH) continue;                              // step over tiny props
      if (airborne && surfaceState.jumpOffset > sc) continue;  // jump cleared its top
      let u = g.baseUV[2 * i]     * PR - uOff;
      let v = g.baseUV[2 * i + 1] * PR - vOff;
      u -= period * Math.floor((u + PR) / period);
      v -= period * Math.floor((v + PR) / period);
      if (u < -near || u > near || v < -near || v > near) continue;
      // Only block where the prop is actually placed (its biome mask passes).
      if (propBilinear(maskArr, pf.gridHalf, driftU + u, driftV + v) <= 0.4) continue;
      const colR = sc * spec.colR + bodyR;
      const dx = nu - u, dy = nv - v;
      const d2 = dx * dx + dy * dy;
      if (d2 < colR * colR) {                                  // proposed pos inside the prop
        const d = Math.sqrt(d2) || 1e-5;
        const push = colR / d;                                 // shove back out to the edge (slides)
        nu = u + dx * push;
        nv = v + dy * push;
      }
    }
  }
  _ppOut[0] = nu; _ppOut[1] = nv;
  return _ppOut;
}

// WASD walking. Movement happens in body-local space along the tangent
// plane at the current standing point, then the position is renormalized
// to the standing sphere (groundRadius + eyeHeight). The local frame is
// parallel-transported across the surface so yaw stays meaningful — the
// direction the user faces relative to "north" remains consistent step
// to step.
