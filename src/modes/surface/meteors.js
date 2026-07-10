// Surface-sky meteor shower: sparse streaking lights overhead while walking
// any world (not gated to an archetype — every planet gets an occasional
// shooting star). Rendered as short additive LineSegments recentred on the
// camera each frame, the same "infinitely far backdrop" trick main.js uses
// for the Milky Way band, so the streaks read as sky, not ground geometry.
// Frequency follows how dark the sky currently is (starMat.opacity, already
// driven by sky.js from real sun elevation) — thick daylight air on an
// atmosphere world quiets them down; airless worlds stay starry and frequent.
import * as THREE from 'three';
import { starMat } from '../../background/starfield.js';
import { camera, scene } from '../../core/scene.js';
import { viewMode } from '../../framework/state.js';
import { surfaceState } from './core.js';

const MAX_METEORS = 5;
const SKY_RADIUS  = 220;      // fixed world-unit distance from camera, independent of body size
const STREAK_LEN  = SKY_RADIUS * 0.05;

let meteorGroup = null;
let meteorMat = null;
let meteorGeo = null;
let meteorPos = null;
let slots = null;             // { active, t, life, start:Vec3, dir:Vec3 }
let spawnTimer = 0;

const _mDir  = new THREE.Vector3();
const _mHead = new THREE.Vector3();
const _mTail = new THREE.Vector3();
const _mR    = new THREE.Vector3();
const _mF    = new THREE.Vector3();

function buildMeteorField() {
  meteorPos = new Float32Array(MAX_METEORS * 2 * 3);
  meteorGeo = new THREE.BufferGeometry();
  meteorGeo.setAttribute('position', new THREE.BufferAttribute(meteorPos, 3).setUsage(THREE.DynamicDrawUsage));
  meteorMat = new THREE.LineBasicMaterial({
    color: 0xfff2d8, transparent: true, opacity: 0, depthWrite: false,
    fog: false, blending: THREE.AdditiveBlending,
  });
  const mesh = new THREE.LineSegments(meteorGeo, meteorMat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 4;
  meteorGroup = new THREE.Group();
  meteorGroup.add(mesh);
  slots = Array.from({ length: MAX_METEORS }, () => ({
    active: false, t: 0, life: 1, start: new THREE.Vector3(), dir: new THREE.Vector3(),
  }));
}

function spawnMeteor(m) {
  const az = Math.random() * Math.PI * 2;
  const el = (0.25 + Math.random() * 0.55) * (Math.PI / 2) * 0.9;   // biased toward upper sky, never grazing ground
  _mR.copy(surfaceState.localRight).multiplyScalar(Math.cos(az) * Math.cos(el));
  _mF.copy(surfaceState.localFwd).multiplyScalar(Math.sin(az) * Math.cos(el));
  _mDir.copy(surfaceState.localUp).multiplyScalar(Math.sin(el)).add(_mR).add(_mF).normalize();
  m.start.copy(_mDir).multiplyScalar(SKY_RADIUS);

  const streakAz = Math.random() * Math.PI * 2;
  _mR.copy(surfaceState.localRight).multiplyScalar(Math.cos(streakAz));
  _mF.copy(surfaceState.localFwd).multiplyScalar(Math.sin(streakAz));
  m.dir.copy(_mR).add(_mF).addScaledVector(surfaceState.localUp, -0.5).normalize();

  m.t = 0;
  m.life = 0.5 + Math.random() * 0.6;
  m.active = true;
}

export function attachMeteors() {
  if (!meteorGroup) buildMeteorField();
  for (const m of slots) m.active = false;
  spawnTimer = 0.5 + Math.random() * 1.5;
  meteorMat.opacity = 0;
  if (!meteorGroup.parent) scene.add(meteorGroup);
}

export function detachMeteors() {
  if (meteorGroup && meteorGroup.parent) meteorGroup.parent.remove(meteorGroup);
}

export function updateMeteors(dt) {
  if (!meteorGroup || viewMode !== 'surface' || !surfaceState.body) return;
  // starMat.opacity runs 0 (full daylight) .. SURFACE_STAR_OPACITY (night/airless).
  const nightFactor = starMat.opacity / 0.95;
  meteorGroup.position.copy(camera.position).sub(scene.position);

  spawnTimer -= dt;
  if (spawnTimer <= 0) {
    spawnTimer = 1.2 + Math.random() * 3.5 + (1 - nightFactor) * 8;   // rarer in daylight
    if (nightFactor > 0.03) {
      const free = slots.find((s) => !s.active);
      if (free) spawnMeteor(free);
    }
  }

  let anyVisible = false;
  for (let i = 0; i < MAX_METEORS; i++) {
    const m = slots[i];
    const a = i * 6;
    if (!m.active) {
      meteorPos[a] = meteorPos[a + 1] = meteorPos[a + 2] = 0;
      meteorPos[a + 3] = meteorPos[a + 4] = meteorPos[a + 5] = 0;
      continue;
    }
    m.t += dt;
    if (m.t >= m.life) { m.active = false; continue; }
    const travel = (m.t / m.life) * SKY_RADIUS * 0.5;
    _mHead.copy(m.start).addScaledVector(m.dir, travel);
    _mTail.copy(_mHead).addScaledVector(m.dir, -STREAK_LEN);
    meteorPos[a] = _mHead.x; meteorPos[a + 1] = _mHead.y; meteorPos[a + 2] = _mHead.z;
    meteorPos[a + 3] = _mTail.x; meteorPos[a + 4] = _mTail.y; meteorPos[a + 5] = _mTail.z;
    anyVisible = true;
  }
  meteorGeo.getAttribute('position').needsUpdate = true;
  meteorMat.opacity = anyVisible ? 0.85 * nightFactor : 0;
}
