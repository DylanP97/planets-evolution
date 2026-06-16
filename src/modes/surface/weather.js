// Storm-world surface weather: massive forked lightning (fat additive tube
// bolts + sky flash), curved rotating tornado funnels, and rain. Gated to the
// `storm` archetype — attached on surface entry, detached on exit, advanced per
// frame. Everything is parented to the focused body's mesh so it rides the
// planet's spin/orbit exactly like the terrain (same convention as grass/rocks);
// the fields are built around surfaceState.localUp so they stay centred under
// the avatar as the tangent frame rotates while walking.
import * as THREE from 'three';
import { surfaceSkyLight } from '../../core/scene.js';
import { viewMode } from '../../framework/state.js';
import { surfaceState } from './core.js';

export let weatherField = null;

// Full-screen blue-white flash for lightning — sells the strike across the
// whole view. Opacity driven from updateWeather (it decays itself).
const lightningFlashEl = document.getElementById('lightningFlash');

// ── tunables (scaled to eye height at attach so a moon and a giant read the
//    same) ──────────────────────────────────────────────────────────────────
const RAIN_COUNT    = 1800;   // streak count in the box around the avatar
const TORNADO_COUNT = 2;      // drifting funnels on the horizon
const BOLT_SEGS     = 9;      // jagged kinks per bolt path

// Module scratch — updateWeather runs after the grass/rocks passes each frame,
// so it owns its own vectors rather than borrowing the shared surface scratch.
const _wUp = new THREE.Vector3(), _wRight = new THREE.Vector3(), _wFwd = new THREE.Vector3();
const _wP = new THREE.Vector3(), _wTop = new THREE.Vector3();
const _wQuat = new THREE.Quaternion(), _wSpin = new THREE.Quaternion();
const _wScale = new THREE.Vector3(), _wMat = new THREE.Matrix4();
const _wAxisY = new THREE.Vector3(0, 1, 0);

// ── Rain: a single LineSegments cloud of vertical streaks. Each drop carries a
//    tangent offset (u, v) and a height (h) above the ground; we integrate h
//    downward and recycle a drop to the top of the box (with a fresh u, v) when
//    it passes the ground. Positions are rewritten in body-local each frame
//    from the avatar's CURRENT tangent frame, so the box rides the walker.
function buildRain() {
  const pos = new Float32Array(RAIN_COUNT * 2 * 3);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  const mat = new THREE.LineBasicMaterial({
    color: 0xaebfd8, transparent: true, opacity: 0.55, depthWrite: false, fog: true,
  });
  const mesh = new THREE.LineSegments(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  const u = new Float32Array(RAIN_COUNT), v = new Float32Array(RAIN_COUNT), h = new Float32Array(RAIN_COUNT);
  return { mesh, mat, pos, u, v, h };
}

// ── Tornado funnel: a SURFACE of revolution (LatheGeometry) with a concave,
//    narrow-base → wide-top profile — a real funnel silhouette, not a cloud of
//    square point sprites. A patched MeshBasicMaterial scrolls rotating dust
//    bands through the alpha so the column appears to whirl; the whole mesh
//    also spins on its axis each frame. Built once and shared across funnels
//    (placement/spin is per-instance via the matrix), so they share one uTime.
let funnelMat = null;
let funnelUniforms = null;
function buildFunnelGeometry() {
  // Profile in the unit square: radius grows with height on a concave curve
  // (pow > 1), with a faint wobble so the wall isn't a glassy cone. Lathe
  // revolves it into the funnel; uv.y runs base(0)→top(1), uv.x around.
  const N = 40, pts = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const r = 0.04 + 0.46 * Math.pow(t, 1.7) + 0.02 * Math.sin(t * 22.0);
    pts.push(new THREE.Vector2(r, t));
  }
  return new THREE.LatheGeometry(pts, 48);
}
function buildFunnelMaterial() {
  const mat = new THREE.MeshBasicMaterial({
    color: 0x6c6a73, transparent: true, opacity: 0.62,
    side: THREE.DoubleSide, depthWrite: false, fog: true,
  });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = { value: 0 };
    funnelUniforms = sh.uniforms;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vWUv;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\n  vWUv = uv;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vWUv;\nuniform float uTime;')
      .replace('#include <dithering_fragment>',
        // Two scrolling helical band layers → whirling dust. Vertical envelope
        // keeps the base dense and frays the top into wisps.
        '  float _b1 = sin( vWUv.x * 6.2831 * 7.0  - uTime * 7.0  + vWUv.y * 16.0 );\n'
      + '  float _b2 = sin( vWUv.x * 6.2831 * 13.0 + uTime * 11.0 - vWUv.y * 9.0 );\n'
      + '  float _bands = smoothstep( 0.05, 0.95, (_b1 * 0.6 + _b2 * 0.4) * 0.5 + 0.5 );\n'
      + '  float _vert = smoothstep( 0.0, 0.10, vWUv.y ) * (1.0 - smoothstep( 0.55, 1.0, vWUv.y ) * 0.7);\n'
      + '  gl_FragColor.a *= (0.20 + 0.80 * _bands) * (0.35 + 0.9 * _vert);\n'
      + '#include <dithering_fragment>');
  };
  mat.customProgramCacheKey = () => 'tornadoFunnel';
  return mat;
}
function buildFunnel() {
  if (!funnelMat) funnelMat = buildFunnelMaterial();
  const mesh = new THREE.Mesh(buildFunnelGeometry(), funnelMat);
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  return mesh;
}

// ── Lightning: fat additive TUBE bolts (TubeGeometry along a jagged CatmullRom
//    path) so a strike reads as a big electric ray from any angle — not the
//    1px hairline a Line gives. Each strike rebuilds a fresh group of one main
//    trunk plus a few branches, shown for a split second with a flicker.
const BOLT_COLOR = 0xdce6ff;
function makeTube(points, radius) {
  const curve = new THREE.CatmullRomCurve3(points);
  const geo = new THREE.TubeGeometry(curve, points.length * 3, radius, 6, false);
  const mat = new THREE.MeshBasicMaterial({
    color: BOLT_COLOR, transparent: true, opacity: 1,
    blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 3;
  mesh.userData.baseOp = 1;          // flicker scales relative to this (overridden per layer)
  return mesh;
}

// Build a jittered cloud→ground path (array of body-local Vector3) ending at
// the given ground offset, then return the tube group (trunk + branches).
function buildBolt(wf, gu, gv) {
  const up = surfaceState.localUp, right = surfaceState.localRight, fwd = surfaceState.localFwd;
  const footR = surfaceState.groundRadius;
  const top = footR + wf.H * 1.7;
  const pts = [];
  for (let i = 0; i <= BOLT_SEGS; i++) {
    const t = i / BOLT_SEGS;                          // 0 = cloud, 1 = ground
    const rad = top + (footR - top) * t;
    const jit = (1 - t) * wf.eh * 7 + wf.eh * 1.5;    // wide wander up high, tightening near the strike
    const ou = gu * t + (Math.random() * 2 - 1) * jit;
    const ov = gv * t + (Math.random() * 2 - 1) * jit;
    pts.push(new THREE.Vector3().copy(up).multiplyScalar(rad).addScaledVector(right, ou).addScaledVector(fwd, ov));
  }
  const group = new THREE.Group();
  // Outer halo (fat, dim) + inner core (thin, bright) → a glowing ray.
  const halo = makeTube(pts, wf.eh * 0.7); halo.material.opacity = 0.5; halo.userData.baseOp = 0.5;
  const core = makeTube(pts, wf.eh * 0.22);
  group.add(halo, core);
  // A couple of forks peeling off the lower trunk and stabbing down/sideways.
  const forks = 1 + (Math.random() * 3 | 0);
  for (let k = 0; k < forks; k++) {
    const sIdx = 3 + (Math.random() * (BOLT_SEGS - 4) | 0);
    const fpts = [pts[sIdx].clone()];
    let cur = pts[sIdx].clone();
    const steps = 2 + (Math.random() * 3 | 0);
    for (let j = 0; j < steps; j++) {
      const drop = wf.H * (0.10 + Math.random() * 0.18);
      cur = cur.clone()
        .addScaledVector(up, -drop)
        .addScaledVector(right, (Math.random() * 2 - 1) * wf.eh * 9)
        .addScaledVector(fwd, (Math.random() * 2 - 1) * wf.eh * 9);
      fpts.push(cur);
    }
    const fork = makeTube(fpts, wf.eh * 0.13); fork.material.opacity = 0.85; fork.userData.baseOp = 0.85;
    group.add(fork);
  }
  return group;
}

function disposeBolt(group) {
  for (const m of group.children) { m.geometry.dispose(); m.material.dispose(); }
  if (group.parent) group.parent.remove(group);
}

// Attach the (lazily built) weather rig to a storm world for a fresh visit.
// No-op on every other archetype, so the caller can attach unconditionally.
export function attachWeather(body) {
  if (!body || body.archetype !== 'storm') return;
  if (!weatherField) {
    weatherField = {
      rain: buildRain(),
      funnels: Array.from({ length: TORNADO_COUNT }, buildFunnel),
      funnelState: Array.from({ length: TORNADO_COUNT }, () => ({ u: 0, v: 0, spin: 0, phase: 0 })),
      boltGroup: new THREE.Group(),   // holds the live strike's tubes
      group: new THREE.Group(),
      time: 0,
      strikeTimer: 1.0, boltLife: 0, flash: 0,
      eh: 0.04, R: 1, H: 1, fall: 1, streak: 0.05, windU: 0,
    };
    const wf = weatherField;
    wf.group.add(wf.rain.mesh, wf.boltGroup);
    for (const f of wf.funnels) wf.group.add(f);
  }
  const wf = weatherField;
  const eh = surfaceState.eyeHeight;
  wf.eh     = eh;
  wf.R      = eh * 34;
  wf.H      = eh * 46;
  wf.fall   = eh * 64;
  wf.streak = eh * 1.6;
  wf.windU  = eh * 10;
  wf.strikeTimer = 0.3 + Math.random() * 0.8;
  wf.boltLife = 0;
  wf.flash = 0;

  const r = wf.rain;
  for (let i = 0; i < RAIN_COUNT; i++) {
    r.u[i] = (Math.random() * 2 - 1) * wf.R;
    r.v[i] = (Math.random() * 2 - 1) * wf.R;
    r.h[i] = Math.random() * wf.H;
  }
  // Funnel size + scatter.
  wf.funnelH     = eh * 34;
  wf.funnelWidth = eh * 17;        // multiplies the lathe radius (top radius ≈ eh·8.5)
  wf.funnelDrift = eh * 1.4;
  for (let k = 0; k < TORNADO_COUNT; k++) {
    const s = wf.funnelState[k];
    const a = Math.random() * Math.PI * 2;
    const d = wf.R * (0.45 + 0.4 * Math.random());
    s.u = Math.cos(a) * d;
    s.v = Math.sin(a) * d;
    s.spin  = (1.1 + Math.random() * 0.9) * (Math.random() < 0.5 ? 1 : -1);
    s.phase = Math.random() * Math.PI * 2;
  }

  // Clear any leftover bolt from a previous visit.
  while (wf.boltGroup.children.length) disposeBolt(wf.boltGroup.children[0]);

  if (wf.group.parent) wf.group.parent.remove(wf.group);
  body.mesh.add(wf.group);
  if (lightningFlashEl) lightningFlashEl.style.opacity = '0';
}

export function detachWeather() {
  if (weatherField) {
    while (weatherField.boltGroup.children.length) disposeBolt(weatherField.boltGroup.children[0]);
    if (weatherField.group.parent) weatherField.group.parent.remove(weatherField.group);
  }
  if (lightningFlashEl) lightningFlashEl.style.opacity = '0';
}

// Fire a strike: rebuild the bolt group with 1–3 trunks at random ground
// points and punch the flash. (Some strikes are sky-glow only — no trunk.)
function strike(wf, withBolt) {
  wf.flash = 0.6 + Math.random() * 0.45;
  while (wf.boltGroup.children.length) disposeBolt(wf.boltGroup.children[0]);
  if (!withBolt) { wf.boltLife = 0; return; }
  wf.boltLife = 0.16;
  const n = 1 + (Math.random() < 0.4 ? 1 : 0) + (Math.random() < 0.2 ? 1 : 0);   // occasional multi-strike
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, dist = wf.R * (0.15 + 0.7 * Math.random());
    wf.boltGroup.add(buildBolt(wf, Math.cos(a) * dist, Math.sin(a) * dist));
  }
}

// Per-frame: advance rain, spin/drift the funnels, run the lightning scheduler.
export function updateWeather(dt) {
  if (!weatherField || viewMode !== 'surface') return;
  const body = surfaceState.body;
  if (!body || body.archetype !== 'storm') return;
  const wf = weatherField;
  wf.time += dt;
  if (funnelUniforms) funnelUniforms.uTime.value = wf.time;
  _wUp.copy(surfaceState.localUp);
  _wRight.copy(surfaceState.localRight);
  _wFwd.copy(surfaceState.localFwd);
  const footR = surfaceState.groundRadius;

  // ── Rain ────────────────────────────────────────────────────────────────
  const r = wf.rain, pos = r.pos, fall = wf.fall * dt, lean = wf.windU * dt;
  const sLen = wf.streak, R = wf.R, H = wf.H;
  for (let i = 0; i < RAIN_COUNT; i++) {
    r.h[i] -= fall;
    r.u[i] += lean;
    if (r.h[i] <= 0) {
      r.h[i] += H;
      r.u[i] = (Math.random() * 2 - 1) * R;
      r.v[i] = (Math.random() * 2 - 1) * R;
    } else if (r.u[i] > R) {
      r.u[i] -= 2 * R;
    }
    const u = r.u[i], v = r.v[i];
    _wP.copy(_wUp).multiplyScalar(footR + r.h[i]).addScaledVector(_wRight, u).addScaledVector(_wFwd, v);
    _wTop.copy(_wUp).multiplyScalar(sLen).addScaledVector(_wRight, -wf.windU * 0.04);
    const a = 6 * i, b = a + 3;
    pos[a] = _wP.x; pos[a + 1] = _wP.y; pos[a + 2] = _wP.z;
    pos[b] = _wP.x + _wTop.x; pos[b + 1] = _wP.y + _wTop.y; pos[b + 2] = _wP.z + _wTop.z;
  }
  r.mesh.geometry.getAttribute('position').needsUpdate = true;

  // ── Tornado funnels ──────────────────────────────────────────────────────
  for (let k = 0; k < TORNADO_COUNT; k++) {
    const f = wf.funnels[k], s = wf.funnelState[k];
    s.phase += s.spin * dt;
    s.u += Math.cos(s.phase * 0.3) * wf.funnelDrift * dt;
    s.v += Math.sin(s.phase * 0.37) * wf.funnelDrift * dt;
    const dr = Math.hypot(s.u, s.v);
    if (dr > wf.R) { s.u *= wf.R / dr; s.v *= wf.R / dr; }
    _wP.copy(_wUp).multiplyScalar(footR).addScaledVector(_wRight, s.u).addScaledVector(_wFwd, s.v);
    _wQuat.setFromUnitVectors(_wAxisY, _wUp);
    _wQuat.multiply(_wSpin.setFromAxisAngle(_wAxisY, s.phase * 2.4));   // fast visible whirl
    _wScale.set(wf.funnelWidth, wf.funnelH, wf.funnelWidth);
    _wMat.compose(_wP, _wQuat, _wScale);
    f.matrix.copy(_wMat);
  }

  // ── Lightning scheduler ──────────────────────────────────────────────────
  wf.strikeTimer -= dt;
  if (wf.strikeTimer <= 0) {
    wf.strikeTimer = 0.5 + Math.random() * 1.6;     // very frequent
    strike(wf, Math.random() < 0.75);
  }
  if (wf.boltLife > 0) {
    wf.boltLife -= dt;
    // Flicker the whole bolt group's brightness over its split-second life.
    const f = wf.boltLife > 0 ? (0.45 + 0.55 * Math.random()) : 0;
    wf.boltGroup.visible = f > 0;
    for (const g of wf.boltGroup.children) for (const m of g.children) m.material.opacity = m.userData.baseOp != null ? m.userData.baseOp * f : f;
  } else if (wf.boltGroup.children.length) {
    while (wf.boltGroup.children.length) disposeBolt(wf.boltGroup.children[0]);
  }
  if (wf.flash > 0) {
    wf.flash = Math.max(0, wf.flash - dt * 3.0);
    surfaceSkyLight.intensity += wf.flash * 1.6;     // ground gets a quick blue-white pulse
  }
  if (lightningFlashEl) {
    const op = wf.flash * 0.6;
    lightningFlashEl.style.opacity = op > 0.002 ? op.toFixed(3) : '0';
  }
}
