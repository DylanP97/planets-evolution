// Soft little air bubbles that trickle up around the avatar while it's
// submerged (surfaceState.swimming). A small Points cloud added straight to the
// scene — NOT parented to the avatar pivot, because a PointsMaterial's sprite
// size ignores the pivot's tiny per-visit scale and would balloon. Instead each
// bubble is positioned in scene-local space every frame off the avatar's foot
// point (astronaut.root.position, already floating-origin corrected) plus the
// world-space "up" (away from the planet centre), so the stream rises correctly
// regardless of how the body is spinning. Bubbles wobble as they climb, fade in
// at the body and out near the top, then respawn — a steady gentle fizz while
// swimming, gone (faded out) the moment the avatar surfaces.
import * as THREE from 'three';
import { scene } from '../../core/scene.js';
import { viewMode } from '../../framework/state.js';
import { astronaut } from './avatar.js';
import { surfaceState } from './core.js';
import { cameraSubmerged } from './underwater-pass.js';

const BUBBLE_COUNT = 22;
let bubbles = null;          // { points, mat, geo, pos, aScale, aAlpha, ang, rad, prog, speed, wob, sizeJ, vis }

// Soft bubble sprite: translucent core with a slightly brighter rim + a small
// highlight, so it reads as a rounded air pocket rather than a flat dot.
function buildBubbleTexture() {
  const cnv = document.createElement('canvas');
  cnv.width = cnv.height = 64;
  const ctx = cnv.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
  g.addColorStop(0.0, 'rgba(220,240,255,0.10)');
  g.addColorStop(0.62, 'rgba(200,230,255,0.16)');
  g.addColorStop(0.84, 'rgba(235,248,255,0.55)');   // bright rim
  g.addColorStop(1.0, 'rgba(235,248,255,0.0)');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(32, 32, 30, 0, Math.PI * 2); ctx.fill();
  // little specular highlight, upper-left
  const h = ctx.createRadialGradient(24, 22, 0, 24, 22, 8);
  h.addColorStop(0, 'rgba(255,255,255,0.7)');
  h.addColorStop(1, 'rgba(255,255,255,0.0)');
  ctx.fillStyle = h;
  ctx.beginPath(); ctx.arc(24, 22, 8, 0, Math.PI * 2); ctx.fill();
  const tex = new THREE.CanvasTexture(cnv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function buildBubbles() {
  const N = BUBBLE_COUNT;
  const pos = new Float32Array(N * 3);
  const aScale = new Float32Array(N).fill(1);
  const aAlpha = new Float32Array(N).fill(0);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('aScale', new THREE.BufferAttribute(aScale, 1).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('aAlpha', new THREE.BufferAttribute(aAlpha, 1).setUsage(THREE.DynamicDrawUsage));
  const mat = new THREE.PointsMaterial({
    map: buildBubbleTexture(),
    size: 0.02, sizeAttenuation: true,
    transparent: true, depthWrite: false, depthTest: true,
    blending: THREE.NormalBlending,
  });
  // Per-point size (aScale) + per-point fade (aAlpha) injected into the stock
  // PointsMaterial shader (the two tokens below exist verbatim in three 0.160).
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aScale;\nattribute float aAlpha;\nvarying float vAlpha;')
      .replace('gl_PointSize = size;', 'gl_PointSize = size * aScale;\n  vAlpha = aAlpha;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vAlpha;')
      .replace('vec4 diffuseColor = vec4( diffuse, opacity );', 'vec4 diffuseColor = vec4( diffuse, opacity * vAlpha );');
  };
  mat.customProgramCacheKey = () => 'diveBubbles';
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = 3;
  points.visible = false;

  const ang = new Float32Array(N), rad = new Float32Array(N), prog = new Float32Array(N);
  const speed = new Float32Array(N), wob = new Float32Array(N), sizeJ = new Float32Array(N);
  for (let i = 0; i < N; i++) respawnBubble({ ang, rad, prog, speed, wob, sizeJ }, i, true);
  bubbles = { points, mat, geo, pos, aScale, aAlpha, ang, rad, prog, speed, wob, sizeJ, vis: 0 };
}

// (Re)seed one bubble's per-instance motion. `spread` distributes the initial
// rise progress so the stream is already populated when swimming starts.
function respawnBubble(b, i, spread) {
  b.ang[i]   = Math.random() * Math.PI * 2;
  b.rad[i]   = 0.38 + Math.random() * 0.3;            // ring AROUND the body (frac of char height), never through it
  b.prog[i]  = spread ? Math.random() : Math.random() * 0.08;
  b.speed[i] = 0.35 + Math.random() * 0.4;            // rise progress per second
  b.wob[i]   = Math.random() * Math.PI * 2;
  b.sizeJ[i] = 0.45 + Math.random() * 0.9;            // per-bubble size jitter
}

export function attachBubbles() {
  if (!bubbles) buildBubbles();
  bubbles.vis = 0;
  bubbles.points.visible = false;
  bubbles.mat.size = Math.max(0.001, (surfaceState.charWorldH || surfaceState.eyeHeight) * 0.02);
  if (!bubbles.points.parent) scene.add(bubbles.points);
  for (let i = 0; i < BUBBLE_COUNT; i++) { respawnBubble(bubbles, i, true); bubbles.aAlpha[i] = 0; }
}

export function detachBubbles() {
  if (bubbles && bubbles.points.parent) bubbles.points.parent.remove(bubbles.points);
}

const _up = new THREE.Vector3(), _t1 = new THREE.Vector3(), _t2 = new THREE.Vector3(), _pick = new THREE.Vector3();
let _time = 0;

export function updateBubbles(dt) {
  if (!bubbles || viewMode !== 'surface' || !surfaceState.body || !astronaut || !astronaut.root.parent) {
    if (bubbles) bubbles.points.visible = false;
    return;
  }
  const b = bubbles;
  // Only fizz while the avatar is actually BELOW the surface (diving) — not while
  // bobbing at the waterline, where `swimming` is already true but the body is
  // in the air. Ease in/out so breaking the surface fades the stream off.
  const target = cameraSubmerged() ? 1 : 0;
  b.vis += (target - b.vis) * Math.min(1, dt * 4);
  if (b.vis <= 0.01 && target === 0) { b.points.visible = false; return; }
  b.points.visible = true;

  const body = surfaceState.body;
  body.mesh.updateMatrixWorld();
  // World-space up = away from planet centre. A direction, so the floating-origin
  // translation on the scene doesn't matter (it has no rotation/scale).
  _up.copy(surfaceState.localUp).transformDirection(body.mesh.matrixWorld).normalize();
  // Two tangents spanning the plane perpendicular to up, for the lateral spread.
  _pick.set(0, 1, 0);
  if (Math.abs(_up.y) > 0.9) _pick.set(1, 0, 0);
  _t1.crossVectors(_up, _pick).normalize();
  _t2.crossVectors(_up, _t1).normalize();

  const charH = surfaceState.charWorldH || (surfaceState.eyeHeight * 0.9);
  const base = astronaut.root.position;                // scene-local foot point
  const riseBase = charH * 0.1, riseSpan = charH * 0.9;
  _time += dt;
  const t = _time;

  for (let i = 0; i < BUBBLE_COUNT; i++) {
    b.prog[i] += b.speed[i] * dt;
    if (b.prog[i] >= 1) respawnBubble(b, i, false);
    const p = b.prog[i];
    const a = b.ang[i] + Math.sin(t * 0.7 + b.wob[i]) * 0.5;       // slow swirl
    const rr = b.rad[i] * charH * (1 + 0.18 * Math.sin(t * 3 + b.wob[i]));   // gentle wobble
    const lift = riseBase + p * riseSpan;
    const x = base.x + _up.x * lift + (_t1.x * Math.cos(a) + _t2.x * Math.sin(a)) * rr;
    const y = base.y + _up.y * lift + (_t1.y * Math.cos(a) + _t2.y * Math.sin(a)) * rr;
    const z = base.z + _up.z * lift + (_t1.z * Math.cos(a) + _t2.z * Math.sin(a)) * rr;
    b.pos[3 * i] = x; b.pos[3 * i + 1] = y; b.pos[3 * i + 2] = z;
    // Fade in off the body, hold, fade out as it nears the top.
    const fin = Math.min(1, p / 0.12);
    const fout = Math.min(1, (1 - p) / 0.3);
    b.aAlpha[i] = Math.min(fin, fout) * b.vis * 0.7;
    b.aScale[i] = b.sizeJ[i] * (0.6 + 0.6 * p);                    // swell slightly while rising
  }
  b.geo.getAttribute('position').needsUpdate = true;
  b.geo.getAttribute('aScale').needsUpdate = true;
  b.geo.getAttribute('aAlpha').needsUpdate = true;
}
