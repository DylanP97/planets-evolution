// Surface-mode pause menu: shown whenever pointer lock drops mid-walk — the
// user hitting Esc, alt-tabbing, or the window losing focus — instead of the
// old behaviour of silently tearing down the visit and dropping back to
// orbit. input.js's pointerlockchange handler is the single trigger for
// opening it; Resume re-requests the lock, Return to Orbit calls the real
// exitSurfaceMode() teardown. Movement/physics freeze while it's open (see
// surfaceState.menuOpen, read by main.js's animate loop).
import { renderer } from '../../core/scene.js';
import { emit } from '../../core/bus.js';
import { clearSurfaceKeys } from './walk.js';
import { surfaceState } from './core.js';
import { exitSurfaceMode } from './mode.js';
import { openControlsMenu } from './controls-page.js';
import { openCharacterMenu } from './character-page.js';
import { openPlanetMap } from './planet-map.js';
import { inRoom, currentRoom } from '../../net/connection.js';

const menuEl     = document.getElementById('surfacePauseMenu');
const controlsEl = document.getElementById('surfaceControlsMenu');
const characterEl = document.getElementById('surfaceCharacterMenu');
const mapEl      = document.getElementById('surfacePlanetMapMenu');
const roomCodeEl = document.getElementById('surfacePauseRoomCode');
const resumeBtn  = document.getElementById('surfaceResumeBtn');
const controlsBtn = document.getElementById('surfaceControlsBtn');
const characterBtn = document.getElementById('surfaceCharacterBtn');
const mapBtn     = document.getElementById('surfaceMapBtn');
const saveBtn    = document.getElementById('surfaceSaveBtn');
const exitBtn    = document.getElementById('surfacePauseExitBtn');

export function openPauseMenu() {
  if (surfaceState.menuOpen) return;
  surfaceState.menuOpen = true;
  surfaceState.pauseView = 'pause';
  clearSurfaceKeys();
  // A camera-drag holds setPointerCapture on the canvas, which routes ALL of
  // that pointer's events (including the click that would hit Resume/Return)
  // to the canvas regardless of on-screen z-order. Force it off so a drag
  // held through Esc doesn't eat the very click meant to dismiss this menu.
  if (surfaceState.dragging) {
    if (surfaceState.dragPointerId != null) {
      try { renderer.domElement.releasePointerCapture(surfaceState.dragPointerId); } catch (_) {}
    }
    surfaceState.dragging = false;
    surfaceState.dragPointerId = null;
  }
  // The on-screen room-code badge (start-menu.js's showRoomCode) sits under
  // pointer lock while walking, so it's unreadable/unclickable in practice —
  // this is the one place the host can actually see and select the code.
  if (roomCodeEl) roomCodeEl.textContent = inRoom() ? `ROOM: ${currentRoom()}` : '';
  if (menuEl) menuEl.classList.add('show');
}

export function closePauseMenu() {
  if (!surfaceState.menuOpen) return;
  surfaceState.menuOpen = false;
  surfaceState.pauseView = null;
  if (menuEl) menuEl.classList.remove('show');
  if (controlsEl) controlsEl.classList.remove('show');
  if (characterEl) characterEl.classList.remove('show');
  if (mapEl) mapEl.classList.remove('show');
}

// Re-requesting pointer lock needs a user gesture (click or keydown both
// qualify) — callable from both the Resume button and the Esc key.
export function resumeFromPauseMenu() {
  closePauseMenu();
  try { renderer.domElement.requestPointerLock(); } catch (err) {}
}

if (resumeBtn) resumeBtn.onclick = resumeFromPauseMenu;
if (controlsBtn) controlsBtn.onclick = openControlsMenu;
if (characterBtn) characterBtn.onclick = openCharacterMenu;
if (mapBtn) mapBtn.onclick = openPlanetMap;
if (saveBtn) saveBtn.onclick = () => emit('menu:save-game');
if (exitBtn) exitBtn.onclick = () => { closePauseMenu(); exitSurfaceMode(); };
