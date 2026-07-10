// Procedural swim stroke for the avatar arms + the per-frame avatar pose,
// facing, and animation update.
import * as THREE from 'three';
import { scene } from '../../core/scene.js';
import { ASTRO_TURN_RATE, astronaut, updateAvatarNightLook } from './avatar.js';
import {
  _astroMat, _astroQuat, _astroX, _astroZ, _footLocal, _footWorld, _worldHeading, _worldUp
} from './camera.js';
import { surfaceState } from './core.js';
import { surfaceKeys } from './walk.js';

// ── Procedural swim stroke ─────────────────────────────────────────────
// Rotates an upper-arm bone in the avatar PIVOT's sagittal plane (about its
// lateral X axis) — a front-crawl windmill. The mixer has already written
// this frame's clip pose, so we premultiply on top of it. The stroke is
// defined in pivot space and conjugated into the bone's parent space by
// walking the local quaternion chain (bone matrixWorlds aren't fresh at
// this point in the frame, so we can't use getWorldQuaternion).
const _strokeAxis  = new THREE.Vector3(1, 0, 0);
const _qStroke     = new THREE.Quaternion();
const _qChain      = new THREE.Quaternion();
const _qApply      = new THREE.Quaternion();
const _qBlend      = new THREE.Quaternion();
const _qIdentity   = new THREE.Quaternion();
const _strokeChain = [];
export function applyAstronautArmStroke(bone, angle, blend) {
  if (!bone) return;
  _qStroke.setFromAxisAngle(_strokeAxis, angle);
  _qChain.identity();
  _strokeChain.length = 0;
  for (let n = bone.parent; n && n !== astronaut.root; n = n.parent) _strokeChain.push(n);
  for (let i = _strokeChain.length - 1; i >= 0; i--) _qChain.multiply(_strokeChain[i].quaternion);
  // localDelta = chain⁻¹ · stroke · chain, eased in with the prone pose.
  _qApply.copy(_qChain).invert().multiply(_qStroke).multiply(_qChain);
  _qBlend.copy(_qIdentity).slerp(_qApply, blend);
  bone.quaternion.premultiply(_qBlend);
}

// Per-frame avatar update: advance its animation, plant its feet on the
// ground (lifted during a jump), and swivel it to face its heading. Reads
// the world vectors that updateSurfaceCamera just computed this frame.
export function updateAstronaut(dt) {
  if (!astronaut) return;
  // Play the locomotion clips in slow motion under low gravity so the legs
  // cycle at the same rate the body actually translates (surfaceState.moveSpeed
  // carries the same locoScale) — keeps the feet planted instead of sliding,
  // and sells the floaty moonwalk feel alongside the lofted jump.
  // Ease the swim pose in/out so wading into deep water reads as a lean
  // into the stroke, not a snap. A model with its own real treadWater clip
  // (upright, legs sculling below) needs none of the procedural prone
  // lift/tilt while idle in water — that lift is tuned for pitching the
  // body FORWARD onto its front, and stacking it under an already-upright
  // clip just floats the character above the waterline. Models without a
  // dedicated treadWater clip keep the old half-tilt approximation instead.
  const swimInput = surfaceKeys.w || surfaceKeys.a || surfaceKeys.s || surfaceKeys.d;
  const hasTread = astronaut.animated && !!astronaut.actions.treadWater;
  let swimTarget = 0;
  if (surfaceState.swimming) swimTarget = swimInput ? 1 : (hasTread ? 0 : 0.5);
  surfaceState.swimBlend += (swimTarget - surfaceState.swimBlend) * Math.min(1, dt * 4);
  const sb = surfaceState.swimBlend;

  if (astronaut.mixer) {
    // The walk clip doubles as the paddle stroke (no swim clip in the set),
    // slowed so the limbs read as pushing water, not marching through it.
    astronaut.mixer.timeScale = surfaceState.locoScale * (1 - 0.45 * sb);
    astronaut.mixer.update(dt);
  }
  if (!astronaut.root.parent || !surfaceState.body) return;
  const mw = surfaceState.body.mesh.matrixWorld;

  // Static (unrigged) models get faked motion: a stride-driven vertical bob,
  // a forward lean while moving, and a gentle side-to-side sway. Applied to
  // `inner` about the foot origin so the feet stay planted. Stride frequency
  // is slowed by the same gravity locoScale as the rigged clips above.
  const inner = astronaut.inner;
  const h = astronaut.nativeHeight;
  let baseRotX = 0, baseRotZ = 0, baseY = astronaut.footOffset.y;
  if (!astronaut.animated) {
    const a = surfaceState.animName;
    const moving = a === 'walk' || a === 'run' || a === 'swim';
    const freq = (a === 'run' ? 9 : (moving ? 5.5 : 2.2)) * surfaceState.locoScale;
    surfaceState.stridePhase += dt * freq;
    const ph = surfaceState.stridePhase;
    const bobAmp  = a === 'run' ? 0.05 : (moving ? 0.03 : 0.006);
    baseRotX = a === 'run' ? 0.20 : (moving ? 0.12 : 0);           // forward lean
    baseRotZ = Math.sin(ph) * (moving ? (a === 'run' ? 0.06 : 0.04) : 0); // sway
    baseY = astronaut.footOffset.y + Math.abs(Math.sin(ph)) * bobAmp * h;
  }

  // Vertical sink for models with their own treadWater/swim clip: they skip
  // the procedural prone overlay below (swimTarget is 0 while idly treading,
  // since the clip itself poses the body — see swimTarget above), but they
  // still root off the same standRadius/floatR the prone fallback needs the
  // lift to cancel. floatR (walk.js) only sinks the foot pivot by
  // eyeHeight*0.32 — tuned for a PRONE body whose back rides the surface. An
  // upright treadWater pose has legs dangling well below that, so without
  // extra sink here the feet (and root) sit right at the waterline and the
  // whole body floats on top instead of the torso riding the surface. Applied
  // whenever swimming (not gated by sb) since the clip poses the body even
  // while idle-treading, when sb is 0.
  const clipSwim = astronaut.animated && !!(astronaut.actions.swim || astronaut.actions.treadWater);
  const treadSink = clipSwim ? (surfaceState.eyeHeight * 0.55) / (astronaut.root.scale.x || 1) : 0;
  if (surfaceState.swimming && clipSwim) baseY -= treadSink;

  // Swim pose overlay (rigged and unrigged alike): pitch the whole model
  // prone about the foot pivot so the head leads along the heading, lift it
  // so the back rides the waterline, slide it back so it stays centred
  // under the camera, and add a slow bob + roll so the water feels alive.
  if (sb > 0.001) {
    surfaceState.swimPhase += dt * (swimInput ? 2.6 : 1.4);
    const swimBob = Math.sin(surfaceState.swimPhase) * 0.035 * h;
    // A model with a real swim/treadWater clip already poses itself prone —
    // the procedural tilt/slide/lift would stack on top and over-rotate (or
    // over-lift) it. Its own bone rotations pitch the body forward about the
    // Hips joint, well above the foot-anchored pivot, so it needs none of the
    // compensating lift the procedural (whole-pivot-rotation) fallback does.
    const tilt  = clipSwim ? 0 : 1.25 * astronaut.facing;
    const slide = clipSwim ? 0 : 0.3 * h * astronaut.facing;
    inner.rotation.x = baseRotX * (1 - sb) + tilt * sb;
    inner.rotation.z = baseRotZ * (1 - sb) + Math.sin(surfaceState.swimPhase * 0.8) * 0.1 * sb;
    // walk.js floats standRadius at (waterline - eyeHeight*0.32) so the body
    // rides prone at the surface; that offset is in WORLD units, but this
    // translation is in the pivot's LOCAL (pre root.scale) space. root.scale
    // is set from ASTRO_HEIGHT_FACTOR (avatar drawn much taller than eyeHeight),
    // so a lift expressed in native mesh units (0.5 * h) came out several times
    // too large once scaled — the avatar visibly floated above the water.
    // Convert back through root.scale so the lift cancels floatR's sink exactly.
    // clipSwim models use treadSink (computed above) instead of proneLift —
    // their own clip poses the Hips, not this whole-pivot rotation/lift.
    const liftScale = astronaut.root.scale.x || 1;
    const proneLift = clipSwim ? -treadSink : (surfaceState.eyeHeight * 0.32) / liftScale;
    inner.position.y = baseY * (1 - sb) + (astronaut.footOffset.y + proneLift + swimBob) * sb;
    inner.position.z = astronaut.footOffset.z - slide * sb;
  } else {
    inner.rotation.x = baseRotX;
    inner.rotation.z = baseRotZ;
    inner.position.y = baseY;
    inner.position.z = astronaut.footOffset.z;
  }

  // Arm stroke while afloat: a continuous alternating windmill (front
  // crawl) during an active stroke; a gentle scull while treading. Layered
  // over the clip pose, faded by the same swim blend as the prone tilt.
  if (sb > 0.01 && astronaut.armBones) {
    const strokeAngle = swimInput
      ? surfaceState.swimPhase * 1.3                         // full circles
      : Math.sin(surfaceState.swimPhase * 2.0) * 0.55 - 0.5; // sculling sway
    applyAstronautArmStroke(astronaut.armBones.L, strokeAngle, sb);
    applyAstronautArmStroke(astronaut.armBones.R, strokeAngle + Math.PI, sb);
  }

  const footRadius = surfaceState.standRadius + surfaceState.jumpOffset;
  _footLocal.copy(surfaceState.localUp).multiplyScalar(footRadius);
  _footWorld.copy(_footLocal).applyMatrix4(mw);
  // The pivot is a scene child, and in surface mode the scene carries the
  // floating-origin shift — convert the world-space foot point to scene-
  // local so the avatar isn't displaced by the shift twice.
  astronaut.root.position.copy(_footWorld).sub(scene.position);

  // Blob shadow: stays ON the ground while the body leaps (counter-offset
  // by the jump height, converted into the pivot's native model units),
  // shrinking and fading with altitude; gone entirely while afloat.
  if (astronaut.shadow) {
    const eh = surfaceState.eyeHeight;
    const jumpN = eh > 0 ? surfaceState.jumpOffset / (eh * 1.2) : 0;
    const fade = Math.max(0, 1 - jumpN * 0.55) * (1 - sb);
    const worldScale = surfaceState.body.group.scale.x || 1;
    const s = astronaut.root.scale.x || 1;
    astronaut.shadow.visible = fade > 0.02;
    astronaut.shadow.material.opacity = 0.6 * fade;
    astronaut.shadow.position.y = (-surfaceState.jumpOffset * worldScale) / s + h * 0.02;
    astronaut.shadow.scale.setScalar(1 / (1 + jumpN * 0.8));
  }

  // Orthonormal basis: Z = facing, Y = up, X = up × Z (right-handed).
  _astroZ.copy(_worldHeading).multiplyScalar(astronaut.facing);
  _astroX.crossVectors(_worldUp, _astroZ).normalize();
  _astroMat.makeBasis(_astroX, _worldUp, _astroZ);
  _astroQuat.setFromRotationMatrix(_astroMat);
  // Smoothly rotate toward the target so turns read as a swivel, not a snap.
  astronaut.root.quaternion.slerp(_astroQuat, Math.min(1, dt * ASTRO_TURN_RATE));
  updateAvatarNightLook(surfaceState.surfaceNight ?? 0);
}

