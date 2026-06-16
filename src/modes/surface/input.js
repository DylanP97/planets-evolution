// Surface-mode input wiring: drag/pointer-lock look, scroll zoom, key
// handling, and the moon/probe deploy buttons.
import { camera, renderer } from '../../core/scene.js';
import { addMoon } from '../../entities/moons.js';
import { addSatellite } from '../../entities/probes.js';
import { focusedBody, moons, planet, probes, viewMode } from '../../framework/state.js';
import { pointer, raycaster } from '../../interaction/brush.js';
import { setPointerFromEvent } from '../../interaction/pointer.js';
import {
  orbitLinesGroup, setSatelliteOrbitLinesVisible, showSatelliteOrbits
} from '../../system/orbits.js';
import { addMoonBtn, addProbeBtn } from '../../ui/dom.js';
import { updateInfoPanel } from '../../ui/info-panel.js';
import { navDown, navSibling, navUp } from '../../ui/nav.js';
import { renderMoonsList, renderProbesList } from '../../ui/roster.js';
import {
  enterPickMode, exitPickMode, flashPickToast, navVisitBtn, pickTargetBody, surfaceExitBtn, surfaceState
} from './core.js';
import { enterSurfaceMode, exitSurfaceMode } from './mode.js';
import { clearSurfaceKeys, surfaceKeys, toggleSurfaceCamera, tryJump } from './walk.js';

// ====== 33. Surface input ======
export let surfaceDragging = false;
export let surfaceDragLastX = 0;
export let surfaceDragLastY = 0;
export const SURFACE_LOOK_SPEED = 0.0035; // radians per pixel
export const SURFACE_PITCH_LIMIT = Math.PI * 0.49;

renderer.domElement.addEventListener('pointerdown', (e) => {
  if (viewMode === 'pick') {
    if (e.button !== 0) return;
    e.preventDefault();
    setPointerFromEvent(e);
    raycaster.setFromCamera(pointer, camera);
    // Only consider the body that was focused when pick mode started, so
    // the user can't accidentally land on a moon hovering near the planet.
    if (!pickTargetBody || !pickTargetBody.mesh.visible) {
      flashPickToast('Target unavailable');
      exitPickMode();
      return;
    }
    const hits = raycaster.intersectObject(pickTargetBody.mesh, false);
    if (hits.length === 0) {
      flashPickToast('Aim at the body');
      return;
    }
    const hit = hits[0];
    // Reject points below sea level — that's liquid surface. We compare the
    // local hit radius to baseRadius (heights[i] == 0 is sea level, which
    // corresponds to a local radius of baseRadius).
    const localHit = pickTargetBody.mesh.worldToLocal(hit.point.clone());
    if (localHit.length() < pickTargetBody.baseRadius - 0.001) {
      flashPickToast('Liquid surface — pick land');
      return;
    }
    enterSurfaceMode(pickTargetBody, hit.point);
    return;
  }
  if (viewMode === 'surface') {
    // Re-request pointer lock if lost.
    if (document.pointerLockElement !== renderer.domElement) {
      try {
        renderer.domElement.requestPointerLock();
      } catch (err) {}
    }

    // Left OR right drag orbits the camera around the character.
    if (e.button !== 0 && e.button !== 2) return;
    e.preventDefault();
    surfaceDragging = true;
    surfaceDragLastX = e.clientX;
    surfaceDragLastY = e.clientY;
    // Capture can throw (InvalidStateError) if the pointer is already gone
    // — e.g. synthetic input or a tap that lifted mid-handler. The drag
    // still works off pointermove, so a failed capture is non-fatal.
    try { renderer.domElement.setPointerCapture(e.pointerId); } catch (_) {}
  }
});

// Suppress the browser context menu while on a surface so right-drag can
// orbit the camera without popping a menu.
renderer.domElement.addEventListener('contextmenu', (e) => {
  if (viewMode === 'surface') e.preventDefault();
});

renderer.domElement.addEventListener('pointermove', (e) => {
  if (viewMode !== 'surface') return;

  let dx = 0, dy = 0;
  if (document.pointerLockElement === renderer.domElement) {
    dx = e.movementX;
    dy = e.movementY;
  } else if (surfaceDragging) {
    dx = e.clientX - surfaceDragLastX;
    dy = e.clientY - surfaceDragLastY;
    surfaceDragLastX = e.clientX;
    surfaceDragLastY = e.clientY;
  } else {
    return;
  }

  surfaceState.yaw   -= dx * SURFACE_LOOK_SPEED;
  surfaceState.pitch += dy * SURFACE_LOOK_SPEED;
  if (surfaceState.pitch >  SURFACE_PITCH_LIMIT) surfaceState.pitch =  SURFACE_PITCH_LIMIT;
  if (surfaceState.pitch < -SURFACE_PITCH_LIMIT) surfaceState.pitch = -SURFACE_PITCH_LIMIT;
});

export const endSurfaceDrag = (e) => {
  if (!surfaceDragging) return;
  surfaceDragging = false;
  try { renderer.domElement.releasePointerCapture(e.pointerId); } catch (_) {}
};
renderer.domElement.addEventListener('pointerup', endSurfaceDrag);
renderer.domElement.addEventListener('pointercancel', endSurfaceDrag);

// If the browser releases pointer lock (ESC), also exit surface mode.
document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement !== renderer.domElement && viewMode === 'surface') {
    exitSurfaceMode();
  }
});

// Scroll in surface mode: in first person it zooms the FOV. Third person has
// a fixed framing, so scroll does nothing there. We piggyback on the canvas
// wheel event so we intercept it before OrbitControls (disabled anyway).
renderer.domElement.addEventListener('wheel', (e) => {
  if (viewMode !== 'surface') return;
  e.preventDefault();
  if (surfaceState.cameraMode !== 'first') return;   // no zoom in third person
  const step = e.deltaY > 0 ? 1.08 : 1 / 1.08;
  surfaceState.fov = Math.max(20, Math.min(95, surfaceState.fov * step));
  camera.fov = surfaceState.fov;
  camera.updateProjectionMatrix();
}, { passive: false });

// ESC cancels pick mode or exits surface mode. Keeps a clean way out
// when the user gets stuck without reaching the on-screen button.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (viewMode === 'pick') exitPickMode();
    else if (viewMode === 'surface') exitSurfaceMode();
    return;
  }

  // Don't hijack keys while the user is editing a name field.
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;

  const k = e.key.toLowerCase();

  // Toggle orbits (global shortcut)
  if (k === 'o') {
    const next = !showSatelliteOrbits;
    setSatelliteOrbitLinesVisible(next);
    const satInput = document.getElementById('showSatelliteOrbits');
    if (satInput) satInput.checked = next;

    const orbitsInput = document.getElementById('showOrbits');
    if (orbitsInput) {
      orbitsInput.checked = next;
      orbitLinesGroup.visible = next;
    }
    e.preventDefault();
    return;
  }

  // Navigation (orbit/pick modes)
  if (viewMode !== 'surface') {
    if (k === 'arrowup' || k === 'w') { navUp(); e.preventDefault(); }
    else if (k === 'arrowdown' || k === 's') { navDown(); e.preventDefault(); }
    else if (k === 'arrowleft' || k === 'a') { navSibling(-1); e.preventDefault(); }
    else if (k === 'arrowright' || k === 'd') { navSibling(1); e.preventDefault(); }
    return;
  }

  // Movement (surface mode)
  if (k === 'w' || k === 'arrowup')    { surfaceKeys.w = true; e.preventDefault(); }
  else if (k === 's' || k === 'arrowdown')  { surfaceKeys.s = true; e.preventDefault(); }
  else if (k === 'a' || k === 'arrowleft')  { surfaceKeys.a = true; e.preventDefault(); }
  else if (k === 'd' || k === 'arrowright') { surfaceKeys.d = true; e.preventDefault(); }
  else if (k === 'shift') surfaceKeys.shift = true;
  else if (k === 'c') { surfaceKeys.dive = true; e.preventDefault(); }
  // Space: jump on land (one-shot) AND held = swim-up while afloat. tryJump
  // no-ops while swimming, so the same key does both without conflict.
  else if (k === ' ' || e.code === 'Space') { surfaceKeys.ascend = true; tryJump(); e.preventDefault(); }
  else if (k === 'v') { toggleSurfaceCamera(); e.preventDefault(); }
});
document.addEventListener('keyup', (e) => {
  const k = e.key.toLowerCase();
  if (k === 'w' || k === 'arrowup')    surfaceKeys.w = false;
  else if (k === 's' || k === 'arrowdown')  surfaceKeys.s = false;
  else if (k === 'a' || k === 'arrowleft')  surfaceKeys.a = false;
  else if (k === 'd' || k === 'arrowright') surfaceKeys.d = false;
  else if (k === 'shift') surfaceKeys.shift = false;
  else if (k === 'c') surfaceKeys.dive = false;
  else if (k === ' ' || e.code === 'Space') surfaceKeys.ascend = false;
});
// If the window loses focus mid-walk, drop all held keys so the camera
// doesn't keep drifting on its own when the user returns.
window.addEventListener('blur', clearSurfaceKeys);

if (navVisitBtn) {
  navVisitBtn.onclick = () => {
    if (viewMode === 'orbit') enterPickMode();
    else if (viewMode === 'pick') exitPickMode();
    else if (viewMode === 'surface') exitSurfaceMode();
  };
}
if (surfaceExitBtn) surfaceExitBtn.onclick = exitSurfaceMode;

addMoonBtn.onclick = () => {
  const parent = (focusedBody && focusedBody.kind === 'planet') ? focusedBody : planet;
  const ownCount = moons.reduce((n, m) => n + (m.parent === parent ? 1 : 0), 0);
  const defaultDistance = 18 + ownCount * 8;
  if (addMoon(parent, 1.2, defaultDistance)) {
    renderMoonsList();
    updateInfoPanel();
  }
};

addProbeBtn.onclick = () => {
  const parent = (focusedBody && focusedBody.kind === 'planet') ? focusedBody : planet;
  if (!parent) return;
  const ownCount = probes.reduce((n, p) => n + (p.parent === parent ? 1 : 0), 0);
  const defaultDistance = 16 + ownCount * 6;
  if (addSatellite(parent, 1.0, defaultDistance)) {
    renderProbesList();
  }
};

