// Free-fly DEBUG camera. Press F to detach the camera from whatever it's
// tracking (OrbitControls target in orbit mode, or the avatar in surface mode)
// and fly it around freely: WASD to move, mouse to look, Space/C to rise/sink,
// Shift to go fast. Press F (or Esc) again to snap back to the normal camera.
//
// This module owns its own input listeners and a per-frame `updateDebugCam`.
// While active, main.js skips `controls.update()` and the surface-camera rig so
// nothing fights us for the camera transform.
import * as THREE from 'three';
import { camera, controls, renderer } from '../core/scene.js';
import { paused, setPaused, viewMode } from '../framework/state.js';
import { surfaceState } from './surface/core.js';

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const LOOK_SPEED = 0.0028;            // radians per pixel of mouse movement
const PITCH_LIMIT = Math.PI * 0.49;   // keep just shy of straight up/down
const ROLL_SPEED = 1.6;               // radians per second while holding Q/E

let active = false;
let prevControlsEnabled = true;
let prevFov = 45;
let prevPaused = false;
let dragging = false;
let dragLastX = 0, dragLastY = 0;

// Free camera state: a world-space position + yaw/pitch/roll look angles.
// Roll banks the whole view around its own forward axis (Q/E).
const pos = new THREE.Vector3();
let yaw = 0;
let pitch = 0;
let roll = 0;

// Held movement keys (independent of the surface-walk key state).
const keys = { w: false, a: false, s: false, d: false, up: false, down: false, fast: false, rollL: false, rollR: false };

const _fwd   = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up    = new THREE.Vector3();
const _move  = new THREE.Vector3();
const _look  = new THREE.Vector3();

console.log('[debug-cam] loaded — press F to toggle free-fly camera');

export function debugCamActive() { return active; }

function clearKeys() {
  keys.w = keys.a = keys.s = keys.d = keys.up = keys.down = keys.fast = keys.rollL = keys.rollR = false;
}

// Floating-point look direction from yaw/pitch (yaw around world Y, pitch up/down).
function lookDir(out) {
  const cp = Math.cos(pitch);
  out.set(cp * Math.sin(yaw), Math.sin(pitch), cp * Math.cos(yaw));
  return out;
}

export function toggleDebugCam() {
  active ? disableDebugCam() : enableDebugCam();
}

export function enableDebugCam() {
  if (active) return;
  active = true;
  // Seed the free camera from wherever the camera currently is/looks.
  pos.copy(camera.position);
  camera.getWorldDirection(_look);
  pitch = Math.asin(Math.max(-1, Math.min(1, _look.y)));
  yaw   = Math.atan2(_look.x, _look.z);
  roll  = 0;
  // Take the camera off OrbitControls so it can't snap back each frame.
  prevControlsEnabled = controls.enabled;
  controls.enabled = false;
  // A wide-ish FOV reads nicely for a fly-around; remember the old one.
  prevFov = camera.fov;
  // Freeze the sim so the world holds still while inspecting it; restore on exit.
  prevPaused = paused;
  syncPause(true);
  showHud(true);
}

export function disableDebugCam() {
  if (!active) return;
  active = false;
  dragging = false;
  clearKeys();
  controls.enabled = prevControlsEnabled;
  camera.fov = prevFov;
  camera.updateProjectionMatrix();
  syncPause(prevPaused);   // resume the sim unless it was already paused
  showHud(false);
}

// Set pause state and keep the System-tab "Pause" checkbox in sync (via
// getElementById, not an import, to avoid a modes→ui layering edge).
function syncPause(v) {
  setPaused(v);
  const pauseInput = document.getElementById('pauseRot');
  if (pauseInput) pauseInput.checked = v;
}

// Per-frame: apply mouse-look + WASD fly. Called from the animate loop only
// while active, after the world has advanced.
export function updateDebugCam(dt) {
  if (!active) return;
  // Movement speed scales with the scene's scale so it feels right whether
  // we're flying around a solar system or standing on a planet's surface.
  let scale;
  if (viewMode === 'surface' && surfaceState.body) {
    scale = surfaceState.eyeHeight * 18;          // human-ish on a surface
  } else {
    scale = Math.max(2, camera.position.distanceTo(controls.target)) * 0.9;
  }
  const speed = scale * (keys.fast ? 6 : 1) * dt;

  // Integrate roll while Q/E are held.
  if (keys.rollL) roll -= ROLL_SPEED * dt;
  if (keys.rollR) roll += ROLL_SPEED * dt;

  // Build an orthonormal camera basis: forward from yaw/pitch, then a right/up
  // pair that's level with the world — finally banked around forward by `roll`,
  // so all of strafe, rise/sink and the rendered horizon tilt together.
  lookDir(_fwd);
  _right.crossVectors(_fwd, WORLD_UP).normalize();
  _up.crossVectors(_right, _fwd).normalize();
  if (roll !== 0) {
    _right.applyAxisAngle(_fwd, roll);
    _up.applyAxisAngle(_fwd, roll);
  }

  _move.set(0, 0, 0);
  if (keys.w)    _move.add(_fwd);
  if (keys.s)    _move.sub(_fwd);
  if (keys.d)    _move.add(_right);
  if (keys.a)    _move.sub(_right);
  if (keys.up)   _move.add(_up);
  if (keys.down) _move.sub(_up);
  if (_move.lengthSq() > 0) pos.addScaledVector(_move.normalize(), speed);

  camera.up.copy(_up);
  camera.position.copy(pos);
  camera.lookAt(_look.copy(pos).add(_fwd));
}

// ── Input ─────────────────────────────────────────────────────────────
function applyLook(dx, dy) {
  yaw   -= dx * LOOK_SPEED;
  pitch -= dy * LOOK_SPEED;
  if (pitch >  PITCH_LIMIT) pitch =  PITCH_LIMIT;
  if (pitch < -PITCH_LIMIT) pitch = -PITCH_LIMIT;
}

renderer.domElement.addEventListener('pointermove', (e) => {
  if (!active) return;
  if (document.pointerLockElement === renderer.domElement) {
    applyLook(e.movementX, e.movementY);
  } else if (dragging) {
    applyLook(e.clientX - dragLastX, e.clientY - dragLastY);
    dragLastX = e.clientX;
    dragLastY = e.clientY;
  }
});
renderer.domElement.addEventListener('pointerdown', (e) => {
  if (!active || document.pointerLockElement === renderer.domElement) return;
  dragging = true;
  dragLastX = e.clientX;
  dragLastY = e.clientY;
});
const endDrag = () => { dragging = false; };
renderer.domElement.addEventListener('pointerup', endDrag);
renderer.domElement.addEventListener('pointercancel', endDrag);

document.addEventListener('keydown', (e) => {
  // Don't hijack keys while typing in a field.
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;

  const k = e.key.toLowerCase();
  if (k === 'f') { console.log('[debug-cam] F pressed → active:', !active); toggleDebugCam(); e.preventDefault(); return; }
  if (!active) return;

  if (e.key === 'Escape') { disableDebugCam(); return; }

  if (k === 'w' || k === 'arrowup')         { keys.w = true; e.preventDefault(); }
  else if (k === 's' || k === 'arrowdown')  { keys.s = true; e.preventDefault(); }
  else if (k === 'a' || k === 'arrowleft')  { keys.a = true; e.preventDefault(); }
  else if (k === 'd' || k === 'arrowright') { keys.d = true; e.preventDefault(); }
  else if (k === ' ' || e.code === 'Space') { keys.up = true; e.preventDefault(); }
  else if (k === 'c')                       { keys.down = true; e.preventDefault(); }
  else if (k === 'q')                       { keys.rollL = true; e.preventDefault(); }
  else if (k === 'e')                       { keys.rollR = true; e.preventDefault(); }
  else if (k === 'shift')                   { keys.fast = true; }
});
document.addEventListener('keyup', (e) => {
  if (!active) return;
  const k = e.key.toLowerCase();
  if (k === 'w' || k === 'arrowup')         keys.w = false;
  else if (k === 's' || k === 'arrowdown')  keys.s = false;
  else if (k === 'a' || k === 'arrowleft')  keys.a = false;
  else if (k === 'd' || k === 'arrowright') keys.d = false;
  else if (k === ' ' || e.code === 'Space') keys.up = false;
  else if (k === 'c')                       keys.down = false;
  else if (k === 'q')                       keys.rollL = false;
  else if (k === 'e')                       keys.rollR = false;
  else if (k === 'shift')                   keys.fast = false;
});
// Drop held keys if focus leaves the window mid-fly.
window.addEventListener('blur', clearKeys);

// ── On-screen indicator ───────────────────────────────────────────────
let hudEl = null;
function showHud(on) {
  if (on && !hudEl) {
    hudEl = document.createElement('div');
    hudEl.id = 'debugCamHud';
    hudEl.style.cssText = [
      'position:fixed', 'top:12px', 'left:50%', 'transform:translateX(-50%)',
      'z-index:9999', 'padding:6px 14px', 'border-radius:6px',
      'background:rgba(8,12,24,0.78)', 'border:1px solid rgba(120,180,255,0.5)',
      'color:#cfe0ff', 'font:12px/1.3 monospace', 'letter-spacing:0.04em',
      'pointer-events:none', 'white-space:nowrap',
    ].join(';');
    hudEl.textContent = 'DEBUG CAM — WASD move · Space/C up·down · Q/E roll · Shift fast · drag to look · F/Esc exit';
    document.body.appendChild(hudEl);
  }
  if (hudEl) hudEl.style.display = on ? 'block' : 'none';
}
