// Surface-walk shared state (surfaceState), visit-button state, pick mode,
// and the body-local frame builder.
import { setViewMode } from '../../framework/state.js';

import * as THREE from 'three';
import { controls } from '../../core/scene.js';
import { focusedBody, viewMode } from '../../framework/state.js';
import { brushRing } from '../../interaction/brush.js';
import { focusedCity, focusedProbe } from '../focus.js';

// ====== 32. Surface walk ======
// Lets the user stand on a planet/moon as a microscopic person. Three modes:
//   orbit  — default; OrbitControls drives the camera.
//   pick   — Visit button armed, awaiting a click on a valid landing spot.
//   surface— camera is at ground level; left-drag = look, scroll = FOV zoom.
// Eligibility: body.matter.solid && kind is 'planet' or 'moon'. Bodies with
// matter.solid === false (gas/ice giants) auto-fail; clicks below sea level
// fail too (liquid surface).

export const navVisitBtn        = document.getElementById('navVisit');
export const surfaceOverlay     = document.getElementById('surfaceOverlay');
export const surfaceLocationEl  = document.getElementById('surfaceLocationName');
export const surfaceExitBtn     = document.getElementById('surfaceExitBtn');
export const pickToastEl        = document.getElementById('pickToast');

// viewMode ('orbit' | 'pick' | 'surface') lives in framework/state.js
export let pickTargetBody = null;             // body being targeted in pick mode (focused at activation)
export function setPickTargetBody(v) { pickTargetBody = v; }
export const surfaceState = {
  body: null,
  localEye: new THREE.Vector3(),       // eye position in body-local (mesh) coords
  localUp:  new THREE.Vector3(0, 1, 0),// surface normal in body-local
  localFwd: new THREE.Vector3(0, 0, 1),// initial forward, tangent to surface
  localRight: new THREE.Vector3(1, 0, 0),
  faceLocal: new THREE.Vector3(0, 0, 1),// direction the avatar faces (movement dir while moving, look heading at idle)
  yaw: 0,
  pitch: 0,
  fov: 60,
  eyeHeight: 0.04,                     // body-local units above surface (eye/head height)
  groundRadius: 0,                     // body-local radius of the standing surface
  moveSpeed: 0,                        // body-local units per second when walking
  // Camera rig: 'third' trails the astronaut, 'first' sits at the eye.
  cameraMode: 'third',
  camDist: 0,                          // third-person trail distance (body-local units)
  charWorldH: 0,                       // avatar's actual rendered world height (camera framing unit)
  // Jump physics, all in body-local radial units along localUp.
  jumpOffset: 0,                       // current height above the ground sphere
  vertVel: 0,                          // vertical velocity (units/sec)
  grounded: true,
  jumpSpeed: 0,                        // launch velocity, sized per body
  gravity: 0,                          // pulls the jump back down, sized per body × surface gravity
  gravityG: 1,                         // body's surface gravity (Earth = 1 g), shown in telemetry
  locoScale: 1,                        // gravity-driven locomotion rate (slows walk + animation in low-g)
  // Astronaut animation state machine: 'idle' | 'walk' | 'run' | 'jump' | 'swim'.
  animName: 'idle',
  stridePhase: 0,                      // drives procedural bob/sway for unrigged models
  // Swimming: deep water can't support the walker, so the body floats at the
  // waterline instead of riding the seabed. standRadius is the effective
  // support radius for the feet/eye (groundRadius on land, just under sea
  // level while afloat); swimBlend eases the avatar between upright and the
  // prone paddling pose; swimPhase clocks the bob/roll.
  swimming: false,
  standRadius: 0,
  swimBlend: 0,
  swimPhase: 0,
  // Grass treadmill: how far (in body-local tangent units) the walker has
  // drifted from the patch origin along localRight / localFwd. The grass
  // field wraps blades modulo the patch size against these so the lawn reads
  // as ground-fixed while staying centered on the avatar. Reset on entry.
  grassU: 0,
  grassV: 0,
  // True while the global ocean sphere is hidden for a water-world surface
  // visit (the local water patch takes over). Restored on exit.
  oceanHidden: false,
  // Saved orbit state, restored on exit.
  savedFov: 45,
  savedNear: 0.1,
  savedFar: 7000,
  savedCamPos: new THREE.Vector3(),
  savedTarget: new THREE.Vector3(),
  // Atmosphere shell gets reconfigured when inside: flipped to DoubleSide
  // so the inside faces render, and (for dense atmospheres) promoted to
  // an opaque occluder so other bodies don't bleed through the sky.
  gasMeshAdjusted: null,               // the gasMesh whose material we touched
  savedGas: null,                      // snapshot of material state to restore on exit
  savedSunVisible: null,               // sunMesh + corona visibility before surface visit
  paintsSunDisc: false,                // true if the body's atmosphere shader draws its own sun disc
};

export function isBodyVisitable(body) {
  if (!body) return false;
  if (body.kind !== 'planet' && body.kind !== 'moon') return false;
  return !!(body.matter && body.matter.solid);
}

export function updateVisitButtonState() {
  if (!navVisitBtn) return;
  const canVisit = !focusedCity && !focusedProbe && isBodyVisitable(focusedBody);
  navVisitBtn.disabled = !canVisit;
  navVisitBtn.classList.toggle('active', viewMode === 'pick' || viewMode === 'surface');
  if (viewMode === 'surface') {
    navVisitBtn.querySelector('.nav-action-label').textContent = 'ON SURFACE';
  } else if (viewMode === 'pick') {
    navVisitBtn.querySelector('.nav-action-label').textContent = 'PICK A SPOT…';
  } else {
    navVisitBtn.querySelector('.nav-action-label').textContent = 'VISIT SURFACE';
  }
}

export let pickToastTimer = 0;
export function flashPickToast(msg) {
  if (!pickToastEl) return;
  pickToastEl.textContent = msg;
  pickToastEl.classList.add('show');
  clearTimeout(pickToastTimer);
  pickToastTimer = setTimeout(() => pickToastEl.classList.remove('show'), 1800);
}

export function enterPickMode() {
  if (viewMode !== 'orbit') return;
  if (!isBodyVisitable(focusedBody)) return;
  setViewMode('pick');
  pickTargetBody = focusedBody;
  document.body.classList.add('pick-mode');
  // Hide the sculpt ring immediately — it stays painted on the surface
  // until the next pointermove otherwise, which feels stale.
  brushRing.visible = false;
  // Disable orbit drag so the next left-click goes to our pick handler.
  controls.enabled = false;
  updateVisitButtonState();
}

export function exitPickMode() {
  if (viewMode !== 'pick') return;
  setViewMode('orbit');
  pickTargetBody = null;
  document.body.classList.remove('pick-mode');
  controls.enabled = true;
  updateVisitButtonState();
}

// Build an orthonormal basis at a body-local point. Up is the radial unit
// vector; forward is an arbitrary tangent (we pick the world-Y projection,
// falling back to world-X if the up vector is nearly aligned with Y so we
// never get a degenerate cross product at the poles).
export function buildLocalFrame(localPos, outUp, outFwd, outRight) {
  outUp.copy(localPos).normalize();
  const ref = Math.abs(outUp.y) > 0.95
    ? new THREE.Vector3(1, 0, 0)
    : new THREE.Vector3(0, 1, 0);
  outRight.copy(ref).cross(outUp).normalize();
  outFwd.copy(outUp).cross(outRight).normalize();
}

