// Developer performance HUD: drives the bottom status strip (#perfHud in
// index.html) with the live frame rate (+ sparkline), frame time, GPU, and the
// renderer's resource / per-frame draw stats — handy while building the 3D
// scene. Two hooks are called from the animate loop in main.js:
//   beginPerfFrame() — at the TOP of the loop, before any rendering.
//   updatePerfHud(dt) — at the BOTTOM, after all rendering.
// We disable renderer.info.autoReset and reset it ourselves in beginPerfFrame
// so the triangle / draw-call counts ACCUMULATE across every render pass in a
// frame (e.g. the underwater post-process pass), giving the true per-frame
// total instead of just the last pass. Self-contained: owns its own DOM refs
// (used nowhere else) and resolves the GPU string once at load.
import { renderer } from '../core/scene.js';
import { viewMode } from '../framework/state.js';

const modeEl  = document.getElementById('perfMode');
const gpuEl   = document.getElementById('perfGpu');
const fpsEl   = document.getElementById('perfFps');
const msEl    = document.getElementById('perfMs');
const trisEl  = document.getElementById('perfTris');
const callsEl = document.getElementById('perfCalls');
const geoEl   = document.getElementById('perfGeo');
const texEl   = document.getElementById('perfTex');
const progEl  = document.getElementById('perfProg');
const memEl   = document.getElementById('perfMem');
const graph   = document.getElementById('perfGraph');

// Take the per-frame draw counters under our own control (see header).
renderer.info.autoReset = false;

// Resolve the GPU name once via the debug-renderer extension. Some browsers
// mask it to a generic string for privacy; we fall back gracefully.
(function initGpu() {
  if (!gpuEl) return;
  let name = 'Unknown';
  try {
    const gl = renderer.getContext();
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    if (dbg) name = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || name;
  } catch { /* leave fallback */ }
  // Chrome wraps the name in ANGLE, e.g.
  // "ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Direct3D11 vs_5_0 ps_5_0, D3D11)".
  // Pull out the readable adapter name.
  const angle = name.match(/ANGLE \([^,]+,\s*(.+?)(?:\s+Direct3D| \(|,).*\)/);
  if (angle) name = angle[1].trim();
  gpuEl.textContent = name;
})();

// JS-heap readout is Chromium-only (performance.memory). Hide the field and
// its separator entirely elsewhere so we don't show a permanent "—".
const _mem = performance.memory;
if (!_mem) {
  document.querySelectorAll('.perf-mem, .perf-mem-sep').forEach((el) => { el.style.display = 'none'; });
}

// ---- FPS sparkline (a tiny scrolling bar graph) -------------------------
// Sized in CSS px but backed by a DPR-scaled buffer so it stays crisp.
const GW = 116, GH = 26;
let gctx = null;
const history = [];               // recent instantaneous FPS, one per frame
if (graph) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  graph.width = GW * dpr;
  graph.height = GH * dpr;
  graph.style.width = GW + 'px';
  graph.style.height = GH + 'px';
  gctx = graph.getContext('2d');
  gctx.scale(dpr, dpr);
}

// Bars are colour-coded against a 60 FPS reference, matching the FPS pill.
function fpsColor(f) { return f >= 50 ? '#3ad07a' : f >= 30 ? '#e0b341' : '#e0533f'; }

function drawGraph() {
  if (!gctx) return;
  gctx.clearRect(0, 0, GW, GH);
  // Faint 60 / 30 FPS guide lines so a dip is easy to read against a target.
  gctx.strokeStyle = 'rgba(0, 242, 255, 0.12)';
  gctx.beginPath();
  gctx.moveTo(0, GH - (60 / 90) * GH + 0.5); gctx.lineTo(GW, GH - (60 / 90) * GH + 0.5);
  gctx.moveTo(0, GH - (30 / 90) * GH + 0.5); gctx.lineTo(GW, GH - (30 / 90) * GH + 0.5);
  gctx.stroke();
  // One 1px bar per frame, newest on the right. Full height = 90 FPS.
  const n = Math.min(history.length, GW);
  for (let i = 0; i < n; i++) {
    const f = history[history.length - n + i];
    const h = Math.max(1, Math.min(1, f / 90) * GH);
    gctx.fillStyle = fpsColor(f);
    gctx.globalAlpha = 0.85;
    gctx.fillRect(i, GH - h, 1, h);
  }
  gctx.globalAlpha = 1;
}

// ---- Numeric readouts ---------------------------------------------------
// Compact integer formatting: 107342 → "107K", 1_500_000 → "1.5M".
function fmt(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'K';
  return String(n);
}

// FPS / frame-time are smoothed over a short window so the text doesn't jitter;
// the sparkline shows the raw per-frame variance. DOM text writes are throttled
// to a few times a second.
let fpsAccum = 0, fpsFrames = 0, fps = 0;
let msEMA = 0;                     // exponential moving average of frame time
let domAccum = 0;

// Reset the per-frame draw counters. Call at the very top of the loop, before
// anything renders, so triangles/calls tally every pass in the frame.
export function beginPerfFrame() {
  renderer.info.reset();
}

export function updatePerfHud(dt) {
  const ms = dt * 1000;
  msEMA = msEMA ? msEMA + (ms - msEMA) * 0.1 : ms;
  if (history.push(dt > 0 ? 1 / dt : 0) > GW) history.shift();
  drawGraph();

  fpsAccum += dt;
  fpsFrames++;
  if (fpsAccum >= 0.5) { fps = fpsFrames / fpsAccum; fpsAccum = 0; fpsFrames = 0; }

  domAccum += dt;
  if (domAccum < 0.25) return;     // throttle the text writes
  domAccum = 0;

  const r = Math.round(fps);
  if (fpsEl) {
    fpsEl.textContent = r + ' FPS';
    fpsEl.className = 'perf-fps ' + (r >= 50 ? 'is-good' : r >= 30 ? 'is-mid' : 'is-bad');
  }
  if (msEl)    msEl.textContent    = msEMA.toFixed(1);
  if (modeEl)  modeEl.textContent  = viewMode === 'surface' ? 'Surface' : 'Orbit';

  const rend = renderer.info.render;
  const memm = renderer.info.memory;
  if (trisEl)  trisEl.textContent  = fmt(rend.triangles);
  if (callsEl) callsEl.textContent = String(rend.calls);
  if (geoEl)   geoEl.textContent   = String(memm.geometries);
  if (texEl)   texEl.textContent   = String(memm.textures);
  if (progEl)  progEl.textContent  = String(renderer.info.programs ? renderer.info.programs.length : 0);
  if (memEl && _mem) memEl.textContent = Math.round(_mem.usedJSHeapSize / 1048576);
}
