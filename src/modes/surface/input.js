// Surface-mode input wiring: drag/pointer-lock look, scroll zoom, key
// handling, and the moon/probe deploy buttons.
import { camera, renderer } from '../../core/scene.js';
import { emit } from '../../core/bus.js';
import { addMoon } from '../../entities/moons.js';
import { addSatellite } from '../../entities/probes.js';
import { focusedBody, moons, paused, planet, probes, setPaused, viewMode } from '../../framework/state.js';
import { pointer, raycaster } from '../../interaction/brush.js';
import { setPointerFromEvent } from '../../interaction/pointer.js';
import {
  orbitLinesGroup, setSatelliteOrbitLinesVisible, showSatelliteOrbits
} from '../../system/orbits.js';
import { addMoonBtn, addProbeBtn } from '../../ui/dom.js';
import { updateInfoPanel } from '../../ui/info-panel.js';
import { renderMoonsList, renderProbesList } from '../../ui/roster.js';
import {
  enterPickMode, exitPickMode, flashPickToast, navVisitBtn, pickTargetBody, surfaceExitBtn, surfaceState
} from './core.js';
import { enterSurfaceMode, exitSurfaceMode } from './mode.js';
import { clearSurfaceKeys, surfaceKeys, toggleSurfaceCamera, tryJump } from './walk.js';
import { toggleMinimapExpand, zoomMinimapIn, zoomMinimapOut } from './minimap.js';
import { openPauseMenu, resumeFromPauseMenu } from './pause-menu.js';
import { backToPause } from './controls-page.js';
import { backFromCharacterMenu } from './character-page.js';
import { backFromPlanetMap } from './planet-map.js';
import { keybinds } from './keybinds.js';
import { debugCamActive } from '../debug-cam.js';
import { identifySkyTarget } from './identify.js';

// ====== 33. Surface input ======
// Drag state (surfaceState.dragging/dragPointerId, not a local here) so
// pause-menu.js can force-release an in-flight drag's pointer capture without
// an input.js↔pause-menu.js import cycle — see the field comments in core.js.
export let surfaceDragLastX = 0;
export let surfaceDragLastY = 0;
export const SURFACE_LOOK_SPEED = 0.0035; // radians per pixel
export const SURFACE_PITCH_LIMIT = Math.PI * 0.49;

// Tap-vs-drag tracking for the right mouse button: a quick right-click (little
// look movement, released fast) identifies whatever the crosshair is aimed at
// (see identify.js); a held right-drag just orbits the camera as before.
// Pointer lock means clientX/Y don't move, so we track accumulated look
// movement (the same dx/dy driving yaw/pitch below) instead of cursor travel.
let rightClickActive = false;
let rightClickStartTime = 0;
let rightClickMoveAccum = 0;
const RIGHT_CLICK_MOVE_TOLERANCE = 6;   // radians*1000-ish px-equivalent budget
const RIGHT_CLICK_MAX_HOLD_MS = 400;

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
    // The pause menu (and the dev editor panel, F2) own input while up —
    // don't re-lock or start a drag underneath them (their overlays should
    // already intercept these, but skip explicitly rather than rely solely
    // on z-order).
    if (surfaceState.menuOpen || surfaceState.devPanelOpen) return;
    // Re-request pointer lock if lost.
    if (document.pointerLockElement !== renderer.domElement) {
      try {
        renderer.domElement.requestPointerLock();
      } catch (err) {}
    }

    // Left OR right drag orbits the camera around the character.
    if (e.button !== 0 && e.button !== 2) return;
    e.preventDefault();
    if (e.button === 2) {
      rightClickActive = true;
      rightClickStartTime = performance.now();
      rightClickMoveAccum = 0;
    }
    surfaceState.dragging = true;
    surfaceDragLastX = e.clientX;
    surfaceDragLastY = e.clientY;
    // Capture can throw (InvalidStateError) if the pointer is already gone
    // — e.g. synthetic input or a tap that lifted mid-handler. The drag
    // still works off pointermove, so a failed capture is non-fatal.
    try {
      renderer.domElement.setPointerCapture(e.pointerId);
      surfaceState.dragPointerId = e.pointerId;
    } catch (_) {}
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
  } else if (surfaceState.dragging) {
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
  if (rightClickActive) rightClickMoveAccum += Math.abs(dx) + Math.abs(dy);
});

export const endSurfaceDrag = (e) => {
  // A genuine release (not a lost-pointer cancel) of a right button that
  // barely moved and wasn't held long is a "look at" tap, not a drag-orbit.
  if (e.type === 'pointerup' && e.button === 2 && rightClickActive
      && rightClickMoveAccum < RIGHT_CLICK_MOVE_TOLERANCE
      && performance.now() - rightClickStartTime < RIGHT_CLICK_MAX_HOLD_MS) {
    identifySkyTarget();
  }
  rightClickActive = false;
  if (!surfaceState.dragging) return;
  surfaceState.dragging = false;
  surfaceState.dragPointerId = null;
  try { renderer.domElement.releasePointerCapture(e.pointerId); } catch (_) {}
};
renderer.domElement.addEventListener('pointerup', endSurfaceDrag);
renderer.domElement.addEventListener('pointercancel', endSurfaceDrag);

// The browser releases pointer lock on its own for Esc, alt-tab, or the
// window losing focus — this is the single place that catches all of those
// and opens the pause menu, rather than silently exiting to orbit (a full
// exitSurfaceMode() teardown the user never asked for).
document.addEventListener('pointerlockchange', () => {
  // Skip while the dev editor panel is up — it drops pointer lock itself
  // (ui/dev-panel.js) so the cursor can reach its sliders; that's not the
  // browser/user releasing lock the way Esc or alt-tab would be.
  if (document.pointerLockElement !== renderer.domElement && viewMode === 'surface'
      && !surfaceState.devPanelOpen) {
    openPauseMenu();
  }
});

// Scroll in surface mode: in first person it zooms the FOV; in third person
// it dollies the trail distance (surfaceState.thirdZoom). We piggyback on the
// canvas wheel event so we intercept it before OrbitControls (disabled anyway).
renderer.domElement.addEventListener('wheel', (e) => {
  if (viewMode !== 'surface') return;
  e.preventDefault();
  const step = e.deltaY > 0 ? 1.08 : 1 / 1.08;
  if (surfaceState.cameraMode === 'first') {
    surfaceState.fov = Math.max(20, Math.min(95, surfaceState.fov * step));
    camera.fov = surfaceState.fov;
    camera.updateProjectionMatrix();
  } else {
    // Third person zooms the trail distance instead — its own state, so
    // dollying here never disturbs the first-person FOV (and vice versa).
    surfaceState.thirdZoom = Math.max(0.5, Math.min(3.0, surfaceState.thirdZoom * step));
  }
}, { passive: false });

// ESC cancels pick mode or exits surface mode. Keeps a clean way out
// when the user gets stuck without reaching the on-screen button.
document.addEventListener('keydown', (e) => {
  // P toggles pause everywhere — orbit, surface, even while flying the debug
  // camera — so it runs ahead of the debug-cam guard below. Skip while typing.
  {
    const tp = e.target;
    const typing = tp && (tp.tagName === 'INPUT' || tp.tagName === 'TEXTAREA' || tp.isContentEditable);
    if (!typing && e.key.toLowerCase() === keybinds.pause) {
      setPaused(!paused);
      // Keep the System-tab "Pause" checkbox in sync (getElementById, not an
      // import, to avoid a modes→ui layering edge — same pattern as 'o' below).
      const pauseInput = document.getElementById('pauseRot');
      if (pauseInput) pauseInput.checked = paused;
      e.preventDefault();
      return;
    }
  }
  // While the free-fly debug camera owns the keyboard, swallow every other
  // shortcut (orbit-mode nav, surface WASD, the 'o' orbit toggle, even Esc —
  // debug-cam handles its own exit) so flying around can't change planets,
  // walk the avatar, or jump systems out from under us.
  if (debugCamActive()) return;
  if (e.key === 'Escape') {
    if (viewMode === 'pick') exitPickMode();
    // Surface mode needs no explicit handling for the FIRST Esc: the
    // browser's own handling releases pointer lock on its own, which the
    // pointerlockchange listener above turns into openPauseMenu(). Once the
    // menu is open, Esc backs out one level at a time: off the Controls
    // page first, then resume.
    else if (viewMode === 'surface' && surfaceState.menuOpen) {
      if (surfaceState.pauseView === 'controls') backToPause();
      else if (surfaceState.pauseView === 'character') backFromCharacterMenu();
      else if (surfaceState.pauseView === 'map') backFromPlanetMap();
      else resumeFromPauseMenu();
    }
    // Orbit view has no pointer-lock/typed input to protect, so Esc simply
    // toggles a lightweight menu (Resume/Save) — the ui/ layer owns the
    // actual overlay, this only announces the toggle via the bus.
    else if (viewMode === 'orbit') emit('menu:toggle-orbit-menu');
    return;
  }

  // The pause menu owns all input while it's up (mouse now works over it —
  // see pointer-events in surface.css); don't let keys leak through to
  // movement/toggles behind it.
  if (viewMode === 'surface' && surfaceState.menuOpen) return;

  // Don't hijack keys while the user is editing a name field.
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;

  const k = e.key.toLowerCase();

  // Toggle orbits (global shortcut)
  if (k === keybinds.orbits) {
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

  if (viewMode !== 'surface') return;

  // Movement (surface mode) — rebindable primary key (keybinds.js/Controls
  // page) plus a permanent arrow-key fallback that's never remapped.
  if (k === keybinds.forward || k === 'arrowup')    { surfaceKeys.w = true; e.preventDefault(); }
  else if (k === keybinds.back  || k === 'arrowdown')  { surfaceKeys.s = true; e.preventDefault(); }
  else if (k === keybinds.left  || k === 'arrowleft')  { surfaceKeys.a = true; e.preventDefault(); }
  else if (k === keybinds.right || k === 'arrowright') { surfaceKeys.d = true; e.preventDefault(); }
  else if (k === keybinds.run) surfaceKeys.shift = true;
  else if (k === keybinds.dive) { surfaceKeys.dive = true; e.preventDefault(); }
  // Jump: one-shot on land AND held = swim-up while afloat. tryJump no-ops
  // while swimming, so the same key does both without conflict.
  else if (k === keybinds.jump) { surfaceKeys.ascend = true; tryJump(); e.preventDefault(); }
  else if (k === keybinds.camera) { toggleSurfaceCamera(); e.preventDefault(); }
  // Minimap expand + zoom, kept off the mouse entirely — the pointer is
  // locked to camera-look while walking and can't reach on-screen buttons.
  else if (k === keybinds.mapSize) { toggleMinimapExpand(); e.preventDefault(); }
  else if (k === keybinds.zoomOut) { zoomMinimapOut(); e.preventDefault(); }
  else if (k === keybinds.zoomIn) { zoomMinimapIn(); e.preventDefault(); }
  // G: log grassDiag() to the console without unlocking the pointer (Esc
  // exits surface mode entirely, so there's no way to reach devtools and type
  // while standing still mid-walk — see window.grassDiag's own doc comment).
  else if (k === 'g') { if (window.grassDiag) console.info('[grassDiag] ' + JSON.stringify(window.grassDiag(), null, 1)); e.preventDefault(); }
});
document.addEventListener('keyup', (e) => {
  const k = e.key.toLowerCase();
  if (k === keybinds.forward || k === 'arrowup')    surfaceKeys.w = false;
  else if (k === keybinds.back  || k === 'arrowdown')  surfaceKeys.s = false;
  else if (k === keybinds.left  || k === 'arrowleft')  surfaceKeys.a = false;
  else if (k === keybinds.right || k === 'arrowright') surfaceKeys.d = false;
  else if (k === keybinds.run) surfaceKeys.shift = false;
  else if (k === keybinds.dive) surfaceKeys.dive = false;
  else if (k === keybinds.jump) surfaceKeys.ascend = false;
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

