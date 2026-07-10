// Developer live-tuning side panel (#devPanel), open while walking a surface
// or flying the free debug camera (default key F2 — rebindable on the
// Controls page, see keybinds.js; the keydown listener is at the bottom).
// Exposes every safely-live-editable parameter across terrain/water/sky/lighting/
// climate/avatar/grass as slider rows grouped into collapsible sections, each
// writing straight into the same mutable state the renderer already reads
// every frame (surfaceState fields, *Tuning objects, shader uniforms) — no
// extra plumbing, no rebuild step. Self-contained DOM (built once, appended
// to <body>), matching the perf-hud.js precedent for a dev-only overlay.
import { camera, renderer } from '../core/scene.js';
import { sunMesh } from '../core/sun.js';
import {
  brushRadius, brushStrength, brushRaise, setBrushRadius, setBrushStrength, setBrushRaise,
  viewMode,
} from '../framework/state.js';
import { climateTuning, computeClimate, colorOceanByClimate } from '../framework/climate.js';
import { twilightTuning, applyTwilightTuning } from '../shaders/gas.js';
import { surfaceState } from '../modes/surface/core.js';
import { lightingTuning } from '../modes/surface/surface-lighting.js';
import { walkTuning } from '../modes/surface/walk.js';
import { waterTuning } from '../modes/surface/water.js';
import { grassUniforms } from '../modes/surface/grass.js';
import { uwFogTuning } from '../modes/surface/underwater-pass.js';
import { keybinds, keyLabel } from '../modes/surface/keybinds.js';
import { debugCamActive } from '../modes/debug-cam.js';

let panelEl = null;
let bodyEl = null;
let isOpen = false;

// Available while walking a surface, and also while flying the free debug
// camera (modes/debug-cam.js) — the latter is itself a dev tool, often used
// in orbit view where surfaceState.body is null; every row above already
// guards its own body-dependent state (oceanShader() etc.), so it's safe to
// open with no visited body — the Sky/Sun/Lighting sections still work.
function panelAvailable() { return viewMode === 'surface' || debugCamActive(); }

function oceanShader() {
  const b = surfaceState.body;
  return b && b.oceanMesh ? b.oceanMesh.material.userData.shader : null;
}

// ---- Slider / toggle row builders ----------------------------------------
function fmt(v, decimals) {
  return Number.isFinite(v) ? v.toFixed(decimals) : '—';
}

function resolve(v) { return typeof v === 'function' ? v() : v; }

function addRow(container, { label, min, max, step, decimals = 2, get, set, disabled }) {
  const row = document.createElement('div');
  row.className = 'dp-row';
  const top = document.createElement('div');
  top.className = 'dp-row-top';
  const lab = document.createElement('span');
  lab.className = 'dp-label';
  lab.textContent = label;
  const val = document.createElement('span');
  val.className = 'dp-val';
  top.appendChild(lab);
  top.appendChild(val);
  const input = document.createElement('input');
  input.type = 'range';
  const loRaw = resolve(min), hiRaw = resolve(max);
  input.min = String(loRaw);
  input.max = String(hiRaw);
  input.step = String(step ?? ((hiRaw - loRaw) / 200 || 0.001));
  const current = get();
  input.value = String(Number.isFinite(current) ? current : loRaw);
  val.textContent = fmt(current, decimals);
  input.disabled = !!resolve(disabled);
  row.classList.toggle('dp-disabled', input.disabled);
  input.oninput = () => {
    const v = parseFloat(input.value);
    set(v);
    val.textContent = fmt(v, decimals);
  };
  row.appendChild(top);
  row.appendChild(input);
  container.appendChild(row);
  return { row, input, val, refresh: () => {
    const lo = resolve(min), hi = resolve(max);
    input.min = String(lo);
    input.max = String(hi);
    input.disabled = !!resolve(disabled);
    row.classList.toggle('dp-disabled', input.disabled);
    const v = get();
    if (document.activeElement !== input) input.value = String(Number.isFinite(v) ? v : lo);
    val.textContent = fmt(v, decimals);
  } };
}

function addToggle(container, { label, get, set }) {
  const row = document.createElement('label');
  row.className = 'dp-toggle';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = !!get();
  cb.onchange = () => set(cb.checked);
  const span = document.createElement('span');
  span.textContent = label;
  row.appendChild(cb);
  row.appendChild(span);
  container.appendChild(row);
  return { row, refresh: () => { cb.checked = !!get(); } };
}

function addSection(root, title, open) {
  const det = document.createElement('details');
  det.className = 'dp-section';
  if (open) det.open = true;
  const sum = document.createElement('summary');
  sum.textContent = title;
  det.appendChild(sum);
  const body = document.createElement('div');
  body.className = 'dp-section-body';
  det.appendChild(body);
  root.appendChild(det);
  return body;
}

function addNote(container, text) {
  const p = document.createElement('div');
  p.className = 'dp-note';
  p.textContent = text;
  container.appendChild(p);
}

// ---- Build ------------------------------------------------------------
const refreshers = [];

function build() {
  panelEl = document.createElement('div');
  panelEl.id = 'devPanel';
  panelEl.setAttribute('aria-hidden', 'true');

  const header = document.createElement('div');
  header.className = 'dp-header';
  const title = document.createElement('span');
  title.textContent = 'DEV EDITOR';
  const hint = document.createElement('span');
  hint.className = 'dp-hint';
  hint.textContent = keyLabel(keybinds.devPanel) + '  to close';
  header.appendChild(title);
  header.appendChild(hint);
  panelEl.appendChild(header);

  bodyEl = document.createElement('div');
  bodyEl.className = 'dp-body';
  panelEl.appendChild(bodyEl);

  // ── Sky / Day-Night ──
  {
    const s = addSection(bodyEl, 'Sky · Day-Night', true);
    refreshers.push(addRow(s, {
      label: 'Twilight night edge', min: -1, max: 0, decimals: 3,
      get: () => twilightTuning.night,
      set: (v) => { twilightTuning.night = v; applyTwilightTuning(); },
    }));
    refreshers.push(addRow(s, {
      label: 'Twilight peak low', min: -0.5, max: 0.5, decimals: 3,
      get: () => twilightTuning.peakLo,
      set: (v) => { twilightTuning.peakLo = v; applyTwilightTuning(); },
    }));
    refreshers.push(addRow(s, {
      label: 'Twilight peak high', min: -0.5, max: 0.5, decimals: 3,
      get: () => twilightTuning.peakHi,
      set: (v) => { twilightTuning.peakHi = v; applyTwilightTuning(); },
    }));
    refreshers.push(addRow(s, {
      label: 'Twilight day edge', min: 0, max: 1, decimals: 3,
      get: () => twilightTuning.day,
      set: (v) => { twilightTuning.day = v; applyTwilightTuning(); },
    }));
    refreshers.push(addRow(s, {
      label: 'Sun scale', min: 0.5, max: 8, decimals: 2,
      get: () => sunMesh.material.uniforms.uScale.value,
      set: (v) => { sunMesh.material.uniforms.uScale.value = v; },
    }));
    refreshers.push(addRow(s, {
      label: 'Sun plasma speed', min: 0, max: 3, decimals: 2,
      get: () => sunMesh.material.uniforms.uSpeed.value,
      set: (v) => { sunMesh.material.uniforms.uSpeed.value = v; },
    }));
    refreshers.push(addRow(s, {
      label: 'Sun brightness', min: 0.2, max: 3, decimals: 2,
      get: () => sunMesh.material.uniforms.uBright.value,
      set: (v) => { sunMesh.material.uniforms.uBright.value = v; },
    }));
    refreshers.push(addRow(s, {
      label: 'Sun whiten', min: 0, max: 1, decimals: 2,
      get: () => sunMesh.material.uniforms.uWhiten.value,
      set: (v) => { sunMesh.material.uniforms.uWhiten.value = v; },
    }));
  }

  // ── Lighting ──
  {
    const s = addSection(bodyEl, 'Lighting');
    refreshers.push(addRow(s, {
      label: 'Sun intensity (day)', min: 0, max: 3, decimals: 2,
      get: () => lightingTuning.sunDay, set: (v) => { lightingTuning.sunDay = v; },
    }));
    refreshers.push(addRow(s, {
      label: 'Sun intensity (night)', min: 0, max: 1, decimals: 2,
      get: () => lightingTuning.sunNight, set: (v) => { lightingTuning.sunNight = v; },
    }));
    refreshers.push(addRow(s, {
      label: 'Ambient (day)', min: 0, max: 0.3, decimals: 3,
      get: () => lightingTuning.ambDay, set: (v) => { lightingTuning.ambDay = v; },
    }));
    refreshers.push(addRow(s, {
      label: 'Ambient (night)', min: 0, max: 0.1, decimals: 3,
      get: () => lightingTuning.ambNight, set: (v) => { lightingTuning.ambNight = v; },
    }));
    refreshers.push(addRow(s, {
      label: 'Moonlight intensity', min: 0, max: 1.5, decimals: 2,
      get: () => lightingTuning.moonBase, set: (v) => { lightingTuning.moonBase = v; },
    }));
  }

  // ── Ocean (current body) ──
  {
    const s = addSection(bodyEl, 'Ocean · Water');
    addNote(s, 'Applies to the ocean underfoot; disabled on dry worlds.');
    const oceanRow = (label, uniform, min, max, decimals) => refreshers.push(addRow(s, {
      label, min, max, decimals,
      get: () => { const sh = oceanShader(); return sh ? sh.uniforms[uniform].value : min; },
      set: (v) => { const sh = oceanShader(); if (sh) sh.uniforms[uniform].value = v; },
      disabled: () => !oceanShader(),
    }));
    // Not an oceanRow: uWaveAmp itself is recomputed from eyeHeight every
    // frame by main.js's surface-mode loop (would immediately stomp a direct
    // edit), so this drives the multiplier that feeds that computation instead.
    refreshers.push(addRow(s, {
      label: 'Wave amplitude', min: 0, max: 1, decimals: 2,
      get: () => waterTuning.waveAmpMul,
      set: (v) => { waterTuning.waveAmpMul = v; },
      disabled: () => !oceanShader(),
    }));
    oceanRow('Shore foam strength', 'uShoreFoam', 0, 1, 2);
    oceanRow('Shore foam width', 'uShoreW', 0, 0.5, 3);
    oceanRow('Shore foam edge sharpness', 'uFoamPow', 0.5, 8, 2);
    oceanRow('Shore foam texture scale', 'uFoamScale', 10, 300, 0);
    oceanRow('Shore foam bubble speed', 'uFoamSpeed', 0, 3, 2);
    oceanRow('Shore foam patch coverage lo', 'uFoamLo', 0, 1, 2);
    oceanRow('Shore foam patch coverage hi', 'uFoamHi', 0, 1, 2);
    oceanRow('Wave steepness (Gerstner)', 'uGerstner', 0, 2, 2);
    oceanRow('Whitecap foam strength', 'uCrestFoam', 0, 1, 2);
    oceanRow('Ripple normal strength', 'uNormScale', 0, 2, 2);
    oceanRow('Ripple tiling', 'uNormTile', 1, 40, 1);
    oceanRow('Alpha (clear, grazing)', 'uClearA', 0, 1, 2);
    oceanRow('Alpha (opaque)', 'uOpaqueA', 0, 1, 2);
  }

  // ── Underwater fog ──
  {
    const s = addSection(bodyEl, 'Underwater Fog');
    const fogRow = (label, key, min, max, decimals) => refreshers.push(addRow(s, {
      label, min, max, decimals,
      get: () => uwFogTuning[key], set: (v) => { uwFogTuning[key] = v; },
    }));
    fogRow('Near band', 'nearF', 0, 3, 2);
    fogRow('Mid band', 'midF', 0, 3, 2);
    fogRow('Far band', 'farF', 0, 3, 2);
    fogRow('Mid strength', 'midStrength', 0, 1, 2);
    fogRow('Deep strength', 'deepStrength', 0, 1, 2);
    fogRow('Visibility (surface)', 'visSurface', 0, 40, 1);
    fogRow('Visibility (floor)', 'visFloor', 0, 40, 1);
    fogRow('Visibility per depth', 'visPerDepth', 0, 20, 1);
    fogRow('Tint (surface)', 'tintSurface', 0, 1, 2);
    fogRow('Tint (deep)', 'tintDeep', 0, 1, 2);
    fogRow('Tint follows sea color', 'tintFollow', 0, 1, 2);
  }

  // ── Terrain brush ──
  {
    const s = addSection(bodyEl, 'Terrain Brush');
    refreshers.push(addRow(s, {
      label: 'Brush radius', min: 0.02, max: 1, decimals: 3,
      get: () => brushRadius, set: (v) => setBrushRadius(v),
    }));
    refreshers.push(addRow(s, {
      label: 'Brush strength', min: 0.1, max: 5, decimals: 2,
      get: () => brushStrength, set: (v) => setBrushStrength(v),
    }));
    refreshers.push(addToggle(s, {
      label: 'Raise (unchecked = lower)',
      get: () => brushRaise, set: (v) => setBrushRaise(v),
    }));
  }

  // ── Climate ──
  {
    const s = addSection(bodyEl, 'Climate');
    addNote(s, 'Recomputes the visited body\'s temperature model on edit.');
    const applyClimate = () => {
      if (!surfaceState.body) return;
      computeClimate(surfaceState.body);
      colorOceanByClimate(surfaceState.body);
    };
    refreshers.push(addRow(s, {
      label: 'Reference temperature (K)', min: 100, max: 400, decimals: 0,
      get: () => climateTuning.refKelvin,
      set: (v) => { climateTuning.refKelvin = v; applyClimate(); },
    }));
    refreshers.push(addRow(s, {
      label: 'Reference distance', min: 50, max: 600, decimals: 0,
      get: () => climateTuning.refDistance,
      set: (v) => { climateTuning.refDistance = v; applyClimate(); },
    }));
    refreshers.push(addRow(s, {
      label: 'Heat redistribution', min: 0, max: 1, decimals: 2,
      get: () => climateTuning.heatRedistribution,
      set: (v) => { climateTuning.heatRedistribution = v; applyClimate(); },
    }));
  }

  // ── Avatar / Camera ──
  {
    const s = addSection(bodyEl, 'Avatar · Camera');
    refreshers.push(addRow(s, {
      label: 'FOV', min: 20, max: 95, decimals: 0,
      get: () => surfaceState.fov,
      set: (v) => {
        surfaceState.fov = v;
        if (surfaceState.cameraMode === 'first') {
          camera.fov = v;
          camera.updateProjectionMatrix();
        }
      },
    }));
    refreshers.push(addRow(s, {
      label: 'Move speed', min: 0, max: () => surfaceState.eyeHeight * 30 || 1, decimals: 4,
      get: () => surfaceState.moveSpeed,
      set: (v) => { surfaceState.moveSpeed = v; },
    }));
    refreshers.push(addRow(s, {
      label: 'Jump speed', min: 0, max: () => surfaceState.eyeHeight * 30 || 1, decimals: 4,
      get: () => surfaceState.jumpSpeed,
      set: (v) => { surfaceState.jumpSpeed = v; },
    }));
    refreshers.push(addRow(s, {
      label: 'Gravity', min: 0, max: () => surfaceState.eyeHeight * 80 || 1, decimals: 4,
      get: () => surfaceState.gravity,
      set: (v) => { surfaceState.gravity = v; },
    }));
    refreshers.push(addRow(s, {
      label: 'Third-person zoom', min: 0.5, max: 3, decimals: 2,
      get: () => surfaceState.thirdZoom,
      set: (v) => { surfaceState.thirdZoom = v; },
    }));
    refreshers.push(addRow(s, {
      label: 'Sprint multiplier', min: 1, max: 4, decimals: 2,
      get: () => walkTuning.sprintMult, set: (v) => { walkTuning.sprintMult = v; },
    }));
    refreshers.push(addRow(s, {
      label: 'Swim vertical speed', min: 0.5, max: 8, decimals: 2,
      get: () => walkTuning.swimVertSpeed, set: (v) => { walkTuning.swimVertSpeed = v; },
    }));
  }

  // ── Grass / Vegetation ──
  {
    const s = addSection(bodyEl, 'Grass · Vegetation');
    addNote(s, 'Density/height require a regenerate step — only wind is live.');
    refreshers.push(addRow(s, {
      label: 'Wind strength', min: 0, max: 1, decimals: 2,
      get: () => grassUniforms ? grassUniforms.uWind.value : 0,
      set: (v) => { if (grassUniforms) grassUniforms.uWind.value = v; },
      disabled: () => !grassUniforms,
    }));
  }

  document.body.appendChild(panelEl);
}

function refreshAll() {
  for (const r of refreshers) {
    if (r && typeof r.refresh === 'function') r.refresh();
  }
}

export function openDevPanel() {
  if (!panelEl) build();
  if (isOpen) return;
  isOpen = true;
  surfaceState.devPanelOpen = true;
  panelEl.setAttribute('aria-hidden', 'false');
  panelEl.classList.add('open');
  refreshAll();
  // Pointer lock traps ALL mouse events on the canvas (no real cursor
  // position, so clicks can't hit-test the panel's DOM at all) — drop it so
  // the OS cursor is free to reach the sliders. input.js won't re-request
  // lock while surfaceState.devPanelOpen is true (see its pointerdown guard).
  if (document.pointerLockElement === renderer.domElement) {
    document.exitPointerLock();
  }
}

export function closeDevPanel() {
  if (!isOpen) return;
  isOpen = false;
  surfaceState.devPanelOpen = false;
  if (panelEl) {
    panelEl.setAttribute('aria-hidden', 'true');
    panelEl.classList.remove('open');
  }
  // Resume mouse-look where it left off (mirrors input.js's own re-lock on
  // canvas pointerdown) — only while actually walking, and not if the pause
  // menu is what's now on top.
  if (viewMode === 'surface' && !surfaceState.menuOpen) {
    try { renderer.domElement.requestPointerLock(); } catch (_) {}
  }
}

export function toggleDevPanel() {
  if (isOpen) closeDevPanel(); else openDevPanel();
}

export function isDevPanelOpen() { return isOpen; }

// Called once per frame from main.js's animate loop (cheap no-op while
// closed). Force-closes if the user leaves surface mode AND stops flying the
// debug camera from underneath the panel (Esc → pause menu → exit, or F to
// drop out of debug-cam), and keeps readouts honest against any other system
// that might also be touching the same live state.
export function updateDevPanel() {
  if (!isOpen) return;
  if (!panelAvailable()) { closeDevPanel(); return; }
  refreshAll();
}

// The devPanel keybind (default F2, rebindable on the Controls page — see
// keybinds.js/controls-page.js) toggles the panel while walking a surface OR
// flying the free debug camera. Self-registered here (ui/ may freely add DOM
// listeners) rather than routed through input.js's own keydown handler,
// since it needs to fire regardless of which mode owns the keyboard.
document.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() !== keybinds.devPanel) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  if (!panelAvailable()) return;
  e.preventDefault();
  toggleDevPanel();
});
