// WASD/arrow walking, sprint, jump physics, ground-radius sampling, swim
// buoyancy riding the global ocean sphere's oceanWave swell.
import * as THREE from 'three';
import { BODY_HEIGHT_SCALE, MAX_LAND_HEIGHT } from '../../core/constants.js';
import { oceanSwellDisp } from '../../framework/materials.js';
import { viewMode } from '../../framework/state.js';
import { astronaut, setAstronautAction } from './avatar.js';
import { surfaceState } from './core.js';
import { footprintStrengthHere, stampFootprint, stampFootprintsFromStep } from './footprints.js';
import { resolvePropCollision } from './props.js';
import { resolveRockCollision } from './rocks.js';

export const surfaceKeys = { w: false, a: false, s: false, d: false, shift: false, dive: false, ascend: false };
// Mutable so the dev panel can retune sprint/swim pace live.
export const walkTuning = {
  sprintMult: 2.0,
  swimVertSpeed: 3.0,   // free-swim rise/dive rate, eye-heights per second
};
const _walkHeading = new THREE.Vector3();
const _walkStrafe  = new THREE.Vector3();
const _walkDelta   = new THREE.Vector3();
const _walkNewUp   = new THREE.Vector3();
const _walkAxis    = new THREE.Vector3();

export function clearSurfaceKeys() {
  surfaceKeys.w = surfaceKeys.a = surfaceKeys.s = surfaceKeys.d = surfaceKeys.shift = surfaceKeys.dive = surfaceKeys.ascend = false;
}

// Dedicated raycaster for terrain-following so we don't disturb the shared
// `raycaster`'s state that pick mode relies on.
export const groundRaycaster = new THREE.Raycaster();
const _groundOrigin   = new THREE.Vector3();
const _groundDir      = new THREE.Vector3();
const _groundHitLocal = new THREE.Vector3();

// Sample the body's actual surface radius beneath a body-local up
// direction by casting a ray straight down at the terrain. Returns the
// local radius of the ground (per-vertex displacement included), or null
// if the ray misses (shouldn't happen aiming at the body's center).
export function sampleGroundRadius(body, localUpDir) {
  body.mesh.updateMatrixWorld();
  // Start above the tallest possible peak so we never begin below ground.
  const high = body.baseRadius * (1 + MAX_LAND_HEIGHT * BODY_HEIGHT_SCALE) + 1;
  _groundOrigin.copy(localUpDir).multiplyScalar(high).applyMatrix4(body.mesh.matrixWorld);
  _groundDir.copy(localUpDir).multiplyScalar(-1).transformDirection(body.mesh.matrixWorld).normalize();
  groundRaycaster.set(_groundOrigin, _groundDir);
  const hits = groundRaycaster.intersectObject(body.mesh, false);
  if (hits.length === 0) return null;
  _groundHitLocal.copy(hits[0].point);
  body.mesh.worldToLocal(_groundHitLocal);
  let ground = _groundHitLocal.length();
  // Ocean bodies USED to clamp the walker to the waterline here. Now the eye
  // follows the real seabed, so wading off a beach actually sinks you below
  // sea level and underwater fog kicks in (see updateSurfaceSkyEffects).
  return ground;
}

export function stepSurfaceWalk(dt) {
  if (viewMode !== 'surface' || !surfaceState.body) return;

  // Jump physics: integrate vertical motion along the surface normal. Runs
  // every frame (not just on input) so a leap always arcs back to ground.
  if (!surfaceState.grounded) {
    surfaceState.vertVel -= surfaceState.gravity * dt;
    surfaceState.jumpOffset += surfaceState.vertVel * dt;
    if (surfaceState.jumpOffset <= 0) {
      surfaceState.jumpOffset = 0;
      surfaceState.vertVel = 0;
      surfaceState.grounded = true;
      // Landing from a leap punches BOTH boot prints into soft soil at once.
      const landStr = footprintStrengthHere();
      if (landStr > 0 && !surfaceState.swimming) {
        const fy = Math.atan2(
          surfaceState.faceLocal.dot(surfaceState.localRight),
          surfaceState.faceLocal.dot(surfaceState.localFwd));
        const lw = surfaceState.eyeHeight * 0.08;
        const lpu = Math.cos(fy), lpv = -Math.sin(fy);   // perpendicular of the facing
        stampFootprint(surfaceState.grassU + lpu * lw, surfaceState.grassV + lpv * lw, fy, Math.min(1, landStr * 1.2));
        stampFootprint(surfaceState.grassU - lpu * lw, surfaceState.grassV - lpv * lw, fy, Math.min(1, landStr * 1.2));
      }
    }
  }

  // ── Swim state ──────────────────────────────────────────────────────
  // Deep water on a water world can't support the walker: once the seabed
  // drops more than ~a body height below sea level, switch to swimming and
  // float at the waterline (head out) instead of riding the seabed.
  // Hysteresis (enter 1.05·eh, exit 0.9·eh) stops the flag flickering on a
  // noisy seabed sample; standRadius eases between the two supports so the
  // hand-off reads as buoyancy, not a teleport.
  {
    const b = surfaceState.body;
    const eh = surfaceState.eyeHeight;
    const inWaterBody = !!(b.matter && b.matter.liquid && b.oceanIsWater);
    const depth = inWaterBody ? (b.baseRadius - surfaceState.groundRadius) : 0;
    const wasSwimming = surfaceState.swimming;
    if (!surfaceState.swimming && depth > eh * 1.05)    surfaceState.swimming = true;
    else if (surfaceState.swimming && depth < eh * 0.9) surfaceState.swimming = false;
    let standTarget;
    if (surfaceState.swimming) {
      // Buoyancy + free dive. The swell follows the ACTUAL oceanWave at the
      // avatar's object-space spot (localUp·baseRadius), so the surface float
      // bobs with the very crests rolling past.
      const px = surfaceState.localUp.x * b.baseRadius;
      const pz = surfaceState.localUp.z * b.baseRadius;
      const waterR  = b.baseRadius + oceanSwellDisp(b, px, pz);
      const floatR  = waterR - eh * 0.32;                      // resting float at the surface
      const bottomR = surfaceState.groundRadius + eh * 0.6;    // just above the seabed
      // Free 3D swim: C dives, Space rises, neutral hovers (no auto-buoyancy so
      // you stay where you leave it). Clamp between the seabed and the bobbing
      // surface so you can roam the whole water column but not clip ground or
      // launch out of the sea. The camera rides standRadius, so going under
      // flips cameraSubmerged and the underwater fog takes over for free.
      if (!wasSwimming) surfaceState.swimRadius = floatR;       // enter at the surface
      const vert = (surfaceKeys.ascend ? 1 : 0) - (surfaceKeys.dive ? 1 : 0);
      surfaceState.swimRadius += vert * eh * walkTuning.swimVertSpeed * dt;
      surfaceState.swimRadius = Math.max(bottomR, Math.min(floatR, surfaceState.swimRadius));
      standTarget = surfaceState.swimRadius;
      // headUnderwater must reflect the actual HEAD radius (standRadius + eh,
      // per camera.js's eyeRadius), not standRadius alone — comparing swimRadius
      // itself against a margin below floatR let this flip true while the head
      // was still ~0.2eh ABOVE the water line, so bubbles fired while the
      // avatar was only wading. Require the head to clear a margin BELOW
      // waterR so it only trips once fully, unambiguously submerged.
      surfaceState.headUnderwater = (surfaceState.swimRadius + eh) < waterR - eh * 0.2;
    } else {
      standTarget = surfaceState.groundRadius;
      surfaceState.headUnderwater = false;
    }
    surfaceState.standRadius += (standTarget - surfaceState.standRadius) * Math.min(1, dt * 8);
  }

  const fwdInput    = (surfaceKeys.w ? 1 : 0) + (surfaceKeys.s ? -1 : 0);
  const strafeInput = (surfaceKeys.d ? 1 : 0) + (surfaceKeys.a ? -1 : 0);
  const moving = fwdInput !== 0 || strafeInput !== 0;

  // Drive the animation state machine: afloat → swim while actually stroking,
  // treadWater while just holding position at the surface (covers the
  // splash-down out of a leap too — the prone blend doubles as a dive);
  // airborne → jump; on the ground → run (sprint) / walk / idle on input.
  if (surfaceState.swimming)       setAstronautAction(moving ? 'swim' : 'treadWater');
  else if (!surfaceState.grounded) setAstronautAction('jump');
  else if (moving)                 setAstronautAction(surfaceKeys.shift ? 'run' : 'walk');
  else                             setAstronautAction('idle');

  // Heading and strafe in local space: take the basis vectors and rotate
  // them by the current yaw about local up, so "forward" is whichever way
  // the camera currently looks.
  _walkHeading.copy(surfaceState.localFwd)
    .applyAxisAngle(surfaceState.localUp, surfaceState.yaw);
  _walkStrafe.copy(surfaceState.localRight)
    .applyAxisAngle(surfaceState.localUp, surfaceState.yaw);

  // The avatar faces the direction it actually MOVES (not the camera), so the
  // forward walk/run clip matches strafing and diagonal motion instead of
  // looking like it's running forwards sideways. Idle keeps the look heading.
  if (moving) {
    surfaceState.faceLocal.copy(_walkHeading).multiplyScalar(fwdInput)
      .addScaledVector(_walkStrafe, strafeInput).normalize();
  } else {
    surfaceState.faceLocal.copy(_walkHeading);
    return;
  }

  // Water drag: swimming is half walking pace (with a gentler sprint), and
  // wading below sea level is slower than striding on land, so stepping
  // into water feels heavier.
  const submerged = surfaceState.body.matter && surfaceState.body.matter.liquid &&
    (surfaceState.groundRadius + surfaceState.eyeHeight) < surfaceState.body.baseRadius;
  const sprintMult = surfaceKeys.shift ? (surfaceState.swimming ? 1.5 : walkTuning.sprintMult) : 1;
  const dragMult   = surfaceState.swimming ? 0.5 : (submerged ? 0.55 : 1);
  const speed = surfaceState.moveSpeed * sprintMult * dragMult;
  const step  = speed * dt;
  _walkDelta.set(0, 0, 0)
    .addScaledVector(_walkHeading, fwdInput * step)
    .addScaledVector(_walkStrafe,  strafeInput * step);

  // Collision: convert the tangent step to (du,dv), let solid obstacles
  // block/deflect it, then rebuild the step from the resolved values. The
  // instanced desert/venusian boulders (rocks.js) and the GLB trees + rocks
  // on terrestrial worlds (props.js) are each resolved in turn so neither can
  // be walked through.
  let _rkDu = _walkDelta.dot(surfaceState.localRight);
  let _rkDv = _walkDelta.dot(surfaceState.localFwd);
  const _rkRes = resolveRockCollision(_rkDu, _rkDv);
  _rkDu = _rkRes[0]; _rkDv = _rkRes[1];
  const _ppRes = resolvePropCollision(_rkDu, _rkDv);
  _rkDu = _ppRes[0]; _rkDv = _ppRes[1];
  _walkDelta.copy(surfaceState.localRight).multiplyScalar(_rkDu)
    .addScaledVector(surfaceState.localFwd, _rkDv);
  surfaceState.localEye.add(_walkDelta);

  // Feed the grass treadmill: how far this step drifted along the (pre-
  // transport) tangent basis the field places blades against.
  surfaceState.grassU += _walkDelta.dot(surfaceState.localRight);
  surfaceState.grassV += _walkDelta.dot(surfaceState.localFwd);

  // Soft-soil worlds: meter boot prints along the path just walked.
  stampFootprintsFromStep(_rkDu, _rkDv);

  // new up = normalized eye position after the tangent step.
  _walkNewUp.copy(surfaceState.localEye).normalize();

  // Terrain-follow: sample the real ground height under the new spot so we
  // rise over mountains and dip into valleys instead of clipping through
  // them. Smooth toward it so the faceted icosphere doesn't jolt the eye.
  const sampled = sampleGroundRadius(surfaceState.body, _walkNewUp);
  if (sampled != null) surfaceState.groundRadius = sampled;
  // The eye rides the support surface: the seabed/terrain on foot, the
  // waterline while swimming (standRadius eases between the two).
  const targetRadius = surfaceState.standRadius + surfaceState.eyeHeight;
  const curRadius = surfaceState.localEye.length();
  const lerp = Math.min(1, dt * 10);
  surfaceState.localEye.copy(_walkNewUp)
    .multiplyScalar(curRadius + (targetRadius - curRadius) * lerp);

  // Parallel-transport the local frame from oldUp → newUp by rotating
  // about their common perpendicular. Tiny moves leave the frame nearly
  // unchanged; large moves rotate it the correct amount so localFwd
  // stays tangent to the sphere instead of drifting off-surface.
  _walkAxis.crossVectors(surfaceState.localUp, _walkNewUp);
  const sinA = _walkAxis.length();
  if (sinA > 1e-6) {
    _walkAxis.divideScalar(sinA);
    const cosA  = surfaceState.localUp.dot(_walkNewUp);
    const angle = Math.atan2(sinA, cosA);
    surfaceState.localFwd.applyAxisAngle(_walkAxis, angle).normalize();
    surfaceState.localRight.applyAxisAngle(_walkAxis, angle).normalize();
  }
  surfaceState.localUp.copy(_walkNewUp);
}

// Launch a jump if we're standing on the ground. Mid-air presses are
// ignored (no double-jump) so the arc stays predictable, and water gives
// nothing to push off — no jumping while swimming.
export function tryJump() {
  if (viewMode !== 'surface' || !surfaceState.grounded || surfaceState.swimming) return;
  surfaceState.vertVel = surfaceState.jumpSpeed;
  surfaceState.grounded = false;
}

// Flip between the trailing third-person rig and the eye-level first-person
// view. The avatar is hidden in first person so it doesn't fill the screen.
export function toggleSurfaceCamera() {
  if (viewMode !== 'surface') return;
  surfaceState.cameraMode = surfaceState.cameraMode === 'third' ? 'first' : 'third';
  if (astronaut) astronaut.root.visible = surfaceState.cameraMode === 'third';
}

