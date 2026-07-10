// Floating-origin shift (skinned-mesh float32 fix) and the per-frame surface
// camera transform (first/third person).
import * as THREE from 'three';
import { camera, scene } from '../../core/scene.js';
import { surfaceState } from './core.js';

const _worldEye    = new THREE.Vector3();
const _worldLook   = new THREE.Vector3();   // normalized world look direction (yaw+pitch)
export const _worldUp     = new THREE.Vector3();   // normalized world surface normal
export const _worldHeading= new THREE.Vector3();   // normalized world heading (yaw only, level)
const _localLookDir= new THREE.Vector3();
const _localHeading= new THREE.Vector3();
const _eyeLocal    = new THREE.Vector3();
export const _footLocal   = new THREE.Vector3();
export const _footWorld   = new THREE.Vector3();
export const _astroZ      = new THREE.Vector3();
export const _astroX      = new THREE.Vector3();
export const _astroMat    = new THREE.Matrix4();
export const _astroQuat   = new THREE.Quaternion();
const _lookAtTmp   = new THREE.Vector3();
const _camLocalTmp = new THREE.Vector3();
const _detailM4    = new THREE.Matrix4();
const _detailM3    = new THREE.Matrix3();

// ── Floating origin (surface mode only) ───────────────────────────────
// Planets orbit up to ~900 world units out while the avatar is ~0.01 units
// tall. Skinned-mesh bone matrices are uploaded to the GPU as float32, and
// at those coordinates one float32 step is a visible fraction of the
// avatar's height — the rig trembles at idle (walking masks it). The fix:
// every surface frame, slide the WHOLE scene so the walker sits at the
// world origin. Everything (bodies, lights, stars) is a scene child, so
// geometry and lighting are unchanged — only the float32 magnitudes
// shrink. The camera isn't a scene child, but surface mode rebuilds its
// transform from the (shifted) body matrix every frame anyway. Cleared on
// exit (see exitSurfaceMode); scene children positioned from world-space
// values must subtract scene.position (the avatar pivot, the milkyway).
const _originTmp = new THREE.Vector3();
export function updateSurfaceOrigin() {
  const body = surfaceState.body;
  if (!body) return;
  // Last frame's matrixWorld carries last frame's shift — consistent with
  // the scene.position we adjust here. Being a frame stale only means the
  // origin lands within one frame of planet motion of zero, which is fine.
  _originTmp.copy(surfaceState.localEye).applyMatrix4(body.mesh.matrixWorld);
  scene.position.sub(_originTmp);
  // Re-bake every matrix now so all the surface math this frame (raycasts,
  // camera, avatar placement) sees the new shift coherently.
  scene.updateMatrixWorld(true);
}

export function updateSurfaceCamera() {
  const body = surfaceState.body;
  if (!body) return;
  body.mesh.updateMatrixWorld();
  const mw = body.mesh.matrixWorld;

  // Look direction (yaw + pitch) and a level heading (yaw only). Order
  // matters — yaw last so the horizon stays level relative to the surface.
  _localLookDir.copy(surfaceState.localFwd)
    .applyAxisAngle(surfaceState.localRight, surfaceState.pitch)
    .applyAxisAngle(surfaceState.localUp, surfaceState.yaw)
    .normalize();

  // Eye/head sits at the support surface (ground, or the waterline while
  // swimming) + eyeHeight, lifted by any active jump.
  const eyeRadius = surfaceState.standRadius + surfaceState.eyeHeight + surfaceState.jumpOffset;
  _eyeLocal.copy(surfaceState.localUp).multiplyScalar(eyeRadius);

  // Body matrix carries the group scale, so transformed directions come out
  // scaled — normalize them to get unit world vectors. _worldHeading is the
  // avatar's facing (its movement direction), not the camera look.
  _worldEye.copy(_eyeLocal).applyMatrix4(mw);
  _worldUp.copy(surfaceState.localUp).transformDirection(mw).normalize();
  _worldLook.copy(_localLookDir).transformDirection(mw).normalize();
  _worldHeading.copy(surfaceState.faceLocal).transformDirection(mw).normalize();

  camera.up.copy(_worldUp);
  if (surfaceState.cameraMode === 'first') {
    camera.position.copy(_worldEye);
    _lookAtTmp.copy(_worldEye).add(_worldLook);
    camera.lookAt(_lookAtTmp);
  } else {
    // Third person framed in units of a fixed reference height — NOT the
    // avatar's actual rendered height. If this used charWorldH directly, the
    // camera would trail back in exact proportion to ASTRO_HEIGHT_FACTOR,
    // canceling it out: the avatar's on-screen size would be invariant no
    // matter how that tuning knob is set (only the world around it would
    // appear to zoom). Pin the frame to eyeHeight so ASTRO_HEIGHT_FACTOR
    // actually changes how big the avatar looks on screen.
    const ch = surfaceState.eyeHeight * (body.group.scale.x || 1);
    // Chest aim point still uses the avatar's real height so the look-at
    // target tracks its actual proportions.
    const aimH = surfaceState.charWorldH || ch;
    // Foot point in world (support surface + any jump lift).
    _footLocal.copy(surfaceState.localUp)
      .multiplyScalar(surfaceState.standRadius + surfaceState.jumpOffset);
    _footWorld.copy(_footLocal).applyMatrix4(mw);
    // Aim at the chest.
    _lookAtTmp.copy(_footWorld).addScaledVector(_worldUp, aimH * 0.6);
    // Trail distance/elevation in character-heights, scaled by the wheel
    // zoom (thirdZoom — independent of the first-person FOV zoom). Lift
    // scales along so the look-down angle stays constant while zooming.
    const z = surfaceState.thirdZoom;
    const dist = ch * 2.2 * z;         // trail distance in character-heights
    const lift = ch * 1.0 * z;         // camera elevation
    camera.position.copy(_lookAtTmp)
      .addScaledVector(_worldLook, -dist)
      .addScaledVector(_worldUp, lift);
    // Never let the look-around drag the camera under the ground: clamp its
    // distance from planet-centre to stay a hair above the standing surface.
    // While SWIMMING the floor is the seabed, not the waterline — pitching
    // the view up lets the camera dip below the surface for an underwater
    // peek (updateSurfaceSkyEffects swaps in the murk the moment it does).
    const minR = surfaceState.swimming
      ? Math.max(surfaceState.groundRadius + surfaceState.eyeHeight * 0.3,
                 surfaceState.standRadius - surfaceState.eyeHeight * 2.2)
      : surfaceState.standRadius + surfaceState.eyeHeight * 0.4;
    _camLocalTmp.copy(camera.position);
    body.mesh.worldToLocal(_camLocalTmp);
    if (_camLocalTmp.length() < minR) {
      _camLocalTmp.setLength(minR);
      body.mesh.localToWorld(_camLocalTmp);
      camera.position.copy(_camLocalTmp);
    }
    camera.lookAt(_lookAtTmp);
  }

  // Refresh the ground-detail object→view rotation (uBodyToView) AFTER the
  // camera is positioned this frame, so the procedural relief lights correctly
  // as the body spins underfoot (and there's no stale-camera flicker on entry).
  // Only the visited body's material carries an active uSurfaceDetail.
  const _dsh = body.mesh.material.userData.detailShader;
  if (_dsh && _dsh.uniforms.uSurfaceDetail.value > 0.001) {
    camera.updateMatrixWorld();
    _detailM4.copy(camera.matrixWorld).invert().multiply(mw);   // viewMatrix · modelMatrix
    _detailM3.setFromMatrix4(_detailM4);
    _dsh.uniforms.uBodyToView.value.copy(_detailM3);
  }
}

