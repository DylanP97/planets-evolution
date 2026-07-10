// Polar aurora: a soft green glow spread across the night sky near a body's
// pole, on worlds with a real atmosphere (bodies without air have no
// magnetosphere/glow to speak of, so airless worlds skip it entirely). There
// is no axial tilt anywhere in this game (planets.js spins bodies about their
// local +Y only — updatePlanetRotation), so a body's pole IS local +Y and
// "how close to the pole" reduces to |localUp.y|. A handful of tall, hazy
// RAY patches scattered near the pole, each oriented TANGENT to the sky
// sphere (like the cloud noise painted on the atmosphere shell) rather than
// standing up off the ground, so it lies flat against the sky like a cloud
// streak. Gaussian falloff in both axes (never a hard edge — the visible
// glow dies out well inside the mesh bounds, unlike a smoothstep edge fade
// which still reads as a shape). Parented to body.mesh so it rides the
// body's spin for free; position is pinned to the true polar axis, not the
// avatar's tangent frame, since aurora belongs to a compass direction.
import * as THREE from 'three';
import { starMat } from '../../background/starfield.js';
import { viewMode } from '../../framework/state.js';
import { surfaceState } from './core.js';

const RAY_COUNT = 4;
const POLE_GATE_START = 0.5;    // |localUp.y| below this: no aurora
const POLE_GATE_FULL  = 0.75;   // at/above this: fully in range
const NIGHT_GATE_START = 0.55;  // starMat opacity fraction below this: no aurora (excludes twilight)
const NIGHT_GATE_FULL  = 0.85;
const RAY_OPACITY = 0.45;

let auroraGroup = null;
let strands = null;             // { mesh, mat, basePos:Vec3 }
let curBody = null;

const _aUp = new THREE.Vector3();
const _aRadial = new THREE.Vector3();
const _aTan1 = new THREE.Vector3();
const _aTan2 = new THREE.Vector3();
const _aArb = new THREE.Vector3();
const _aMat = new THREE.Matrix4();

// Object-space geometry: thin along X, tall along Y. The vertex shader
// pushes points along local Z (the sky sphere's outward normal once
// oriented) to fold/ripple the patch.
const VERT = /* glsl */ `
  uniform float uTime;
  uniform float uPhase;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vec3 p = position;
    float h = uv.y;
    float fold = sin(h * 5.0 + uTime * 0.3 + uPhase) * 0.10
               + sin(h * 11.0 - uTime * 0.5 + uPhase * 1.7) * 0.04;
    p.z += fold;
    p.x += sin(h * 2.4 + uTime * 0.18 + uPhase) * 0.05;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;
// Gaussian falloff in both axes: at the plane edge (dx or dy = 1) the
// envelope is already near-zero, so the glow dies out INSIDE the mesh
// bounds rather than being clipped by them — that's what keeps this from
// reading as a rectangle floating in the sky.
const FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uPhase;
  uniform float uOpacity;
  uniform vec3 uColor;
  uniform float uSigmaX;
  uniform float uSigmaY;
  varying vec2 vUv;
  void main() {
    float dx = (vUv.x - 0.5) * 2.0;
    float dy = (vUv.y - 0.5) * 2.0;
    float envelope = exp(-(dx * dx * uSigmaX + dy * dy * uSigmaY));
    // Gaussian alone doesn't reach zero by the mesh boundary (dx or dy = 1)
    // at these sigmas, which left the plane's edge visible as a hard line.
    // Force true zero there so the glow always dies out inside the mesh.
    float edgeFade = smoothstep(1.0, 0.55, max(abs(dx), abs(dy)));
    envelope *= edgeFade;
    // Soft, low-contrast vertical shimmer — a hazy suggestion of striation
    // rather than crisp bands, so the curtain reads as diffuse light.
    float streakA = sin(vUv.x * 10.0 + sin(vUv.y * 3.0 + uTime * 0.15 + uPhase) * 0.4 - uTime * 0.4 + uPhase * 3.0) * 0.5 + 0.5;
    float streakB = sin(vUv.x * 5.0 - uTime * 0.2 + uPhase * 2.0) * 0.5 + 0.5;
    float shimmer = mix(streakA, streakB, 0.35) * 0.5 + 0.5;
    float pulse = 0.65 + 0.3 * sin(uTime * 0.15 + uPhase * 2.0);
    float a = envelope * shimmer * pulse * uOpacity;
    vec3 col = uColor * (0.6 + 0.5 * shimmer);
    gl_FragColor = vec4(col, a);
  }
`;

function buildPatch(hueSeed) {
  const geo = new THREE.PlaneGeometry(1, 1, 1, 24);
  const color = new THREE.Color().setHSL(0.34, 0.85, 0.4 + hueSeed * 0.06);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 }, uPhase: { value: hueSeed * 6.283 },
      uOpacity: { value: 0 }, uColor: { value: color },
      uSigmaX: { value: 2.4 }, uSigmaY: { value: 1.5 },
    },
    vertexShader: VERT, fragmentShader: FRAG,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  return { mesh, mat, basePos: new THREE.Vector3() };
}

function buildAurora() {
  auroraGroup = new THREE.Group();
  strands = Array.from({ length: RAY_COUNT }, (_, i) => buildPatch(i / RAY_COUNT));
  for (const s of strands) auroraGroup.add(s.mesh);
}

// Orient+place a patch tangent to the sky sphere at a point scattered near
// zenith on the polar side, so it lies FLAT against the sky like a cloud
// streak instead of standing up off the ground.
function placeStrand(s, poleSign, eh) {
  const R = surfaceState.groundRadius + eh * 90;
  const coneAngle = (0.06 + Math.random() * 0.3) * Math.PI;
  const az = Math.random() * Math.PI * 2;
  _aUp.set(0, poleSign, 0);
  _aArb.set(1, 0, 0);
  _aTan1.crossVectors(_aUp, _aArb).normalize();
  _aTan2.crossVectors(_aUp, _aTan1).normalize();
  _aRadial.copy(_aUp).multiplyScalar(Math.cos(coneAngle))
    .addScaledVector(_aTan1, Math.sin(coneAngle) * Math.cos(az))
    .addScaledVector(_aTan2, Math.sin(coneAngle) * Math.sin(az));
  _aRadial.normalize();
  s.basePos.copy(_aRadial).multiplyScalar(R);

  // Tangent basis at that point: xAxis = patch width, yAxis = hangs down
  // (length), zAxis = outward normal (the folding/rippling direction).
  _aArb.set(0, 1, 0);
  if (Math.abs(_aRadial.dot(_aArb)) > 0.95) _aArb.set(1, 0, 0);
  _aTan1.crossVectors(_aArb, _aRadial).normalize();
  _aTan2.crossVectors(_aRadial, _aTan1).normalize();
  _aMat.makeBasis(_aTan1, _aTan2, _aRadial);
  _aMat.setPosition(s.basePos);

  const width = eh * (40 + Math.random() * 26);
  const height = eh * (200 + Math.random() * 130);
  const scaleMat = new THREE.Matrix4().makeScale(width, height, 1);
  s.mesh.matrix.copy(_aMat).multiply(scaleMat);
  s.mesh.matrixWorldNeedsUpdate = true;
}

export function attachAurora(body) {
  if (!auroraGroup) buildAurora();
  curBody = body;
  const eh = surfaceState.eyeHeight;
  const poleSign = surfaceState.localUp.y >= 0 ? 1 : -1;
  for (const s of strands) placeStrand(s, poleSign, eh);
  if (auroraGroup.parent !== body.mesh) {
    if (auroraGroup.parent) auroraGroup.parent.remove(auroraGroup);
    body.mesh.add(auroraGroup);
  }
}

export function detachAurora() {
  if (auroraGroup && auroraGroup.parent) auroraGroup.parent.remove(auroraGroup);
  curBody = null;
}

export function updateAurora(dt) {
  if (!auroraGroup || viewMode !== 'surface' || !surfaceState.body || surfaceState.body !== curBody) return;
  if (!surfaceState.paintsSunDisc) { auroraGroup.visible = false; return; }

  const poleCloseness = Math.abs(surfaceState.localUp.y);
  const poleFactor = Math.min(1, Math.max(0,
    (poleCloseness - POLE_GATE_START) / (POLE_GATE_FULL - POLE_GATE_START)));

  const nightFrac = starMat.opacity / 0.95;
  const nightFactor = Math.min(1, Math.max(0,
    (nightFrac - NIGHT_GATE_START) / (NIGHT_GATE_FULL - NIGHT_GATE_START)));

  const gate = poleFactor * nightFactor;

  for (const s of strands) {
    s.mat.uniforms.uTime.value += dt;
    s.mat.uniforms.uOpacity.value = gate * RAY_OPACITY;
  }
  auroraGroup.visible = gate > 0.003;
}

