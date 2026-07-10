// Surface-mode minimap: a small corner radar that paints a top-down patch of
// the terrain colours immediately around the avatar (sampled by downward
// raycasts onto the body mesh, read straight from body.colorArr so the
// swatches match the real ground), oriented so the avatar's facing points
// up, with a label naming the biome under its feet. Lives only while
// walking; the overlay CSS hides it the rest of the time. Sampling is
// throttled and the grid is small, so the raycast burst stays cheap. A thin
// transparent 2D canvas layered on top (#surfaceMinimapOverlay) draws the
// off-screen waypoint arrow/distance readout when the target falls outside
// the sampled patch. The dial can be expanded (more screen space) and
// zoomed (narrower/wider ground span, i.e. finer/coarser cells) via keybinds
// owned by input.js (toggleMinimapExpand/zoomMinimapIn/Out below) — NOT
// mouse buttons, since the pointer is captured for camera-look the whole
// time you're walking and never reaches on-screen controls.
import * as THREE from 'three';
import { biomeNameOfFace, formatLatLon } from '../../framework/body.js';
import { targetLocation, viewMode } from '../../framework/state.js';
import {
  atmosphereFactor, environmentHazard, fmtTemp, tempColor, temperatureAtLatitude
} from '../../framework/climate.js';
import { BODY_HEIGHT_SCALE, MAX_LAND_HEIGHT } from '../../core/constants.js';
import { SKY_LABEL_DAY_ELEV, SKY_LABEL_NIGHT_ELEV } from '../../shaders/gas.js';
import { surfaceState } from './core.js';

// DOM (created in index.html). Read once at module load like core.js does for
// its own surface elements — this module never imports from ui/.
const panelEl    = document.getElementById('surfaceMinimapPanel');
const canvas     = document.getElementById('surfaceMinimap');
const overlayCanvas = document.getElementById('surfaceMinimapOverlay');
const biomeEl    = document.getElementById('surfaceMinimapBiome');
const coordsEl   = document.getElementById('surfaceMinimapCoords');
const timeEl     = document.getElementById('surfaceMinimapTime');
const tempEl     = document.getElementById('surfaceMinimapTemp');
const airEl      = document.getElementById('surfaceMinimapAir');
const ctx        = canvas ? canvas.getContext('2d') : null;
const octx       = overlayCanvas ? overlayCanvas.getContext('2d') : null;
const compassEls = {
  N: document.getElementById('mmCardN'), E: document.getElementById('mmCardE'),
  S: document.getElementById('mmCardS'), W: document.getElementById('mmCardW'),
};

const PX_COMPACT  = 120;
const PX_EXPANDED = 300;

// Zoom multiplies the ground span the grid samples (smaller = zoomed in).
const ZOOM_MIN = 0.4, ZOOM_MAX = 2.5, ZOOM_STEP = 1.3;
let zoom = 1;
let expanded = false;

const MM_N = 9;                 // grid resolution (MM_N×MM_N cells, odd → has a centre)
const MM_HALF = (MM_N - 1) / 2;
let mmSpan = 0;                 // tangent half-extent the grid covers (body-local units)
let sampleTimer = 0;
let _prevSunElev = null;        // previous throttled sample, for the rising/falling trend below

// Dedicated raycaster + scratch so we never disturb the walk/grass casters or
// allocate in the loop. Colours are stored RGB triples per cell.
const _mmRay    = new THREE.Raycaster();
const _mmOrigin = new THREE.Vector3();
const _mmDir    = new THREE.Vector3();
const _mmUp     = new THREE.Vector3();
const _mmRight  = new THREE.Vector3();   // map "east"  = facing × up
const _mmFwd    = new THREE.Vector3();   // map "north" = avatar facing
const _mmCol    = new Float32Array(MM_N * MM_N * 3);
const _mmHas    = new Uint8Array(MM_N * MM_N);
const _mlTangent = new THREE.Vector3();  // scratch: location dir minus its radial component

// The current waypoint (state.targetLocation), projected into the map's
// (du east, dv north) tangent frame — { du, dv, arcDist } or null when
// there's no target on this body / it coincides with the avatar. Drawn as a
// dot on the main canvas when inside the sampled patch, or an arrow +
// distance on the 2D overlay when off the edge.
let _mmTarget = null;

// Compass scratch: planetary north pole axis is body-local +Y, so at the
// avatar's spot east = Y × up and north = up × east (both tangent to the
// surface). Projected onto the radar's (facing-up) frame each frame so the
// N/E/S/W chips rotate to true north as the walker turns.
const _cY     = new THREE.Vector3(0, 1, 0);
const _cFwd   = new THREE.Vector3();
const _cRight = new THREE.Vector3();
const _cEast  = new THREE.Vector3();
const _cNorth = new THREE.Vector3();
const _cDir   = new THREE.Vector3();

// Local-time readout: sunElev (surfaceState.sunElev, set every frame by
// sky.js) is dot(localUp, directionToSun) — 1 at local noon, -1 at local
// midnight, symmetric around both. That symmetry alone can't tell dawn from
// dusk (elev 0.2 could be either side of noon), so we also track whether it's
// rising or falling since the last throttled sample. acos(elev) gives the
// angle from noon (0..pi); on the falling half that IS the walk from noon to
// midnight, on the rising half it's midnight to noon — map each onto its own
// 12-hour half of the clock.
//
// The phase word (Day/Dawn/Dusk/Night) is keyed to SKY_LABEL_DAY_ELEV/
// SKY_LABEL_NIGHT_ELEV (gas.js) — perceptual midpoints of the sky dome's
// actual fade curve, not its literal 0%/100% endpoints. Using the endpoints
// made "Night" cover the whole -0.94..-0.15 tail of the fade, most of which
// still visibly reads as a lit evening/dawn sky (that's the point of the
// wide fade — a slow dissolve, not a pop) — so the label called it "Night"
// long before the sky agreed. The midpoint thresholds instead mark where the
// sky has actually gotten dark/bright enough that the word matches.
function formatLocalTime(elev, rising) {
  const e = Math.max(-1, Math.min(1, elev));
  const fromNoon = Math.acos(e) / Math.PI; // 0 at noon, 1 at midnight
  const hours = rising ? 12 - fromNoon * 12 : 12 + fromNoon * 12;
  const h = Math.floor(hours) % 24;
  const m = Math.floor((hours - Math.floor(hours)) * 60);
  const clock = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  let phase;
  if (e >= SKY_LABEL_DAY_ELEV) phase = 'Day';
  else if (e > SKY_LABEL_NIGHT_ELEV) phase = rising ? 'Dawn' : 'Dusk';
  else phase = 'Night';
  return `${clock} · ${phase}`;
}

// Cast straight down at the body under a tangent offset (du east, dv north) from
// the avatar and return the hit face, or null on a miss. Starts above the
// tallest peak and aims at the body centre so it never clips through terrain.
function faceAt(body, footR, du, dv, hi) {
  _mmUp.copy(surfaceState.localUp).multiplyScalar(footR)
    .addScaledVector(_mmRight, du).addScaledVector(_mmFwd, dv).normalize();
  _mmOrigin.copy(_mmUp).multiplyScalar(hi).applyMatrix4(body.mesh.matrixWorld);
  _mmDir.copy(_mmUp).multiplyScalar(-1).transformDirection(body.mesh.matrixWorld).normalize();
  _mmRay.set(_mmOrigin, _mmDir);
  const hits = _mmRay.intersectObject(body.mesh, false);
  return hits.length ? hits[0].face : null;
}

// Re-sample the colour grid + centre biome name, refresh the text readouts,
// then redraw the canvas.
function refresh() {
  const body = surfaceState.body;
  if (!body || !ctx) return;
  body.mesh.updateMatrixWorld();
  const footR = surfaceState.groundRadius;
  const hi = body.baseRadius * (1 + MAX_LAND_HEIGHT * BODY_HEIGHT_SCALE) + 1;

  // Map frame: "north" (up on the minimap) is the direction the avatar faces,
  // so the radar turns with the walker like a forward-up minimap.
  _mmFwd.copy(surfaceState.faceLocal).normalize();
  _mmRight.crossVectors(_mmFwd, surfaceState.localUp).normalize();
  // Grid spans roughly ±70 eye-heights at 1x zoom — a readable slice of
  // nearby ground; the zoom keys scale that span up or down.
  mmSpan = surfaceState.eyeHeight * 70 * zoom;
  const cell = mmSpan / MM_HALF;

  for (let iy = 0; iy < MM_N; iy++) {
    for (let ix = 0; ix < MM_N; ix++) {
      const du = (ix - MM_HALF) * cell;
      const dv = (MM_HALF - iy) * cell;          // +north at the top row
      const f = faceAt(body, footR, du, dv, hi);
      const o = (iy * MM_N + ix) * 3;
      if (f) {
        _mmCol[o]     = body.colorArr[3 * f.a];
        _mmCol[o + 1] = body.colorArr[3 * f.a + 1];
        _mmCol[o + 2] = body.colorArr[3 * f.a + 2];
        _mmHas[iy * MM_N + ix] = 1;
      } else {
        _mmHas[iy * MM_N + ix] = 0;
      }
    }
  }

  // Centre cell names the biome the avatar stands on.
  const cf = faceAt(body, footR, 0, 0, hi);
  if (biomeEl) biomeEl.textContent = cf ? biomeNameOfFace(body, cf) : '—';
  if (coordsEl) coordsEl.textContent = formatLatLon(surfaceState.localUp);
  if (timeEl) {
    const elev = surfaceState.sunElev;
    if (elev == null) {
      timeEl.textContent = '—';
    } else {
      const rising = _prevSunElev != null && elev > _prevSunElev;
      timeEl.textContent = formatLocalTime(elev, rising);
    }
    _prevSunElev = elev;
  }
  if (tempEl || airEl) {
    try {
      const latRad = Math.asin(Math.max(-1, Math.min(1, surfaceState.localUp.y)));
      const kelvin = temperatureAtLatitude(body, latRad);
      const hazard = environmentHazard(body, latRad);
      if (tempEl) {
        tempEl.textContent = fmtTemp(kelvin);
        tempEl.style.color = tempColor(kelvin);
        tempEl.classList.toggle('mm-danger', hazard.tooHot || hazard.tooCold);
      }
      if (airEl) {
        if (hazard.toxic) {
          airEl.textContent = 'TOXIC';
        } else {
          airEl.textContent = Math.round(atmosphereFactor(body) * 100) + '% O2';
        }
        airEl.classList.toggle('mm-danger', hazard.toxic || hazard.noOxygen);
      }
    } catch (err) {
      console.error('[surface-detail] Temp/Air readout failed:', err);
    }
  }

  // Waypoint: project the target location into the map's (du east, dv north)
  // tangent frame via a great-circle offset from the avatar. Drawn as a dot
  // on the main canvas when it falls inside the sampled patch, or an arrow +
  // distance on the overlay when it's off the edge.
  _mmTarget = null;
  if (targetLocation && targetLocation.body === body) {
    const tAngle = surfaceState.localUp.angleTo(targetLocation.localPos);
    const tArc = tAngle * footR;
    _mlTangent.copy(targetLocation.localPos)
      .addScaledVector(surfaceState.localUp, -targetLocation.localPos.dot(surfaceState.localUp));
    if (_mlTangent.lengthSq() >= 1e-10) {
      _mlTangent.normalize();
      _mmTarget = {
        du: _mlTangent.dot(_mmRight) * tArc,
        dv: _mlTangent.dot(_mmFwd) * tArc,
        arcDist: tArc,
      };
    }
  }

  draw();
  drawOverlay();
}

function draw() {
  const W = canvas.width, H = canvas.height;
  const cw = W / MM_N, ch = H / MM_N;
  ctx.clearRect(0, 0, W, H);
  for (let iy = 0; iy < MM_N; iy++) {
    for (let ix = 0; ix < MM_N; ix++) {
      const o = (iy * MM_N + ix) * 3;
      if (_mmHas[iy * MM_N + ix]) {
        const r = (_mmCol[o]     * 255) | 0;
        const g = (_mmCol[o + 1] * 255) | 0;
        const b = (_mmCol[o + 2] * 255) | 0;
        ctx.fillStyle = `rgb(${r},${g},${b})`;
      } else {
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
      }
      // +0.5 overdraw kills hairline seams between cells.
      ctx.fillRect(ix * cw, iy * ch, cw + 0.5, ch + 0.5);
    }
  }

  const cx = W / 2, cy = H / 2;

  // Waypoint dot, only when inside the sampled patch (the overlay arrow
  // handles the off-edge case).
  if (_mmTarget) {
    const half = Math.min(W, H) / 2;
    const rawX = (_mmTarget.du / mmSpan) * half;
    const rawY = -(_mmTarget.dv / mmSpan) * half;
    if (Math.hypot(rawX, rawY) <= half) {
      ctx.beginPath();
      ctx.arc(cx + rawX, cy + rawY, Math.min(cw, ch) * 0.28, 0, Math.PI * 2);
      ctx.fillStyle = '#ffcc33';
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.lineWidth = 1.5;
      ctx.fill();
      ctx.stroke();
    }
  }

  // Avatar marker: a small triangle at centre pointing up (the facing dir).
  const s = Math.min(cw, ch) * 0.55;
  ctx.beginPath();
  ctx.moveTo(cx, cy - s);
  ctx.lineTo(cx - s * 0.7, cy + s * 0.6);
  ctx.lineTo(cx + s * 0.7, cy + s * 0.6);
  ctx.closePath();
  ctx.fillStyle = '#00f2ff';
  ctx.strokeStyle = 'rgba(0,0,0,0.65)';
  ctx.lineWidth = 1.5;
  ctx.fill();
  ctx.stroke();
}

// The overlay canvas only ever draws the off-screen waypoint indicator —
// the grid + avatar + in-range waypoint are drawn on the main canvas above.
function drawOverlay() {
  if (!octx) return;
  const W = overlayCanvas.width, H = overlayCanvas.height;
  octx.clearRect(0, 0, W, H);
  if (!_mmTarget) return;

  const cx = W / 2, cy = H / 2, half = Math.min(W, H) / 2;
  const rawX = (_mmTarget.du / mmSpan) * half;
  const rawY = -(_mmTarget.dv / mmSpan) * half;
  const rawDist = Math.hypot(rawX, rawY);
  const distFrac = rawDist / half;
  if (distFrac <= 1) return;   // on-screen: the dot drawn in draw() already shows it

  const distText = `${_mmTarget.arcDist.toFixed(1)} u`;
  const ux = rawX / rawDist, uy = rawY / rawDist;
  const rimR = half * 0.92;
  const tx = cx + ux * rimR, ty = cy + uy * rimR;
  const ang = Math.atan2(uy, ux);
  const s2 = 6;
  octx.fillStyle = '#ffcc33';
  octx.strokeStyle = 'rgba(0,0,0,0.75)';
  octx.lineWidth = 1.5;
  octx.beginPath();
  octx.moveTo(tx + Math.cos(ang) * s2, ty + Math.sin(ang) * s2);
  octx.lineTo(tx + Math.cos(ang + 2.5) * s2, ty + Math.sin(ang + 2.5) * s2);
  octx.lineTo(tx + Math.cos(ang - 2.5) * s2, ty + Math.sin(ang - 2.5) * s2);
  octx.closePath();
  octx.fill();
  octx.stroke();
  octx.font = 'bold 10px sans-serif';
  octx.fillStyle = '#ffcc33';
  octx.textAlign = 'center';
  const lx2 = cx + ux * (rimR - 14), ly2 = cy + uy * (rimR - 14);
  octx.fillText(distText, lx2, ly2);
}

// Place one compass chip at the screen angle of body-local tangent dir `d`,
// measured from the dial's top (= the avatar's facing). atan2(right, up) gives a
// clockwise angle; sin/-cos map it onto the dial so 0 = top, +90° = right.
// Radius/centre read the canvas's CURRENT css size, so chips track the dial
// through expand/collapse without a separate resize hook.
function placeCard(el, d) {
  if (!el) return;
  const half = canvas.clientWidth / 2;
  const r = half * 0.85;
  const ang = Math.atan2(d.dot(_cRight), d.dot(_cFwd));
  el.style.left = (half + Math.sin(ang) * r) + 'px';
  el.style.top  = (half - Math.cos(ang) * r) + 'px';
}

// Smoothly (every frame, un-throttled) rotate the N/E/S/W chips to true north.
function updateCompass() {
  if (!compassEls.N) return;
  _cFwd.copy(surfaceState.faceLocal).normalize();
  _cRight.crossVectors(_cFwd, surfaceState.localUp).normalize();
  // east = Y × up; degenerate only within ~a hair of a pole, where "east" is
  // undefined — hide the chips there rather than spin wildly.
  _cEast.crossVectors(_cY, surfaceState.localUp);
  const atPole = _cEast.lengthSq() < 1e-7;
  for (const k in compassEls) if (compassEls[k]) compassEls[k].style.display = atPole ? 'none' : '';
  if (atPole) return;
  _cEast.normalize();
  _cNorth.crossVectors(surfaceState.localUp, _cEast).normalize();
  placeCard(compassEls.N, _cNorth);
  placeCard(compassEls.S, _cDir.copy(_cNorth).negate());
  placeCard(compassEls.E, _cEast);
  placeCard(compassEls.W, _cDir.copy(_cEast).negate());
}

// Swap the compact/expanded canvas raster size. Re-samples right away so
// the new resolution doesn't wait out the throttle looking stale.
function setExpanded(v) {
  expanded = v;
  if (panelEl) panelEl.classList.toggle('expanded', v);
  const px = v ? PX_EXPANDED : PX_COMPACT;
  if (canvas) { canvas.width = px; canvas.height = px; }
  if (overlayCanvas) { overlayCanvas.width = px; overlayCanvas.height = px; }
  if (viewMode === 'surface' && surfaceState.body) refresh();
}

function setZoom(z) {
  zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
  if (viewMode === 'surface' && surfaceState.body) refresh();
}

// Keyboard entry points — wired to keys by input.js (M / [ / ]), since the
// pointer is locked to camera-look the whole time this dial is visible.
export function toggleMinimapExpand() { setExpanded(!expanded); }
export function zoomMinimapIn()  { setZoom(zoom / ZOOM_STEP); }
export function zoomMinimapOut() { setZoom(zoom * ZOOM_STEP); }

// Per-frame hook from the animate loop (surface branch). The compass tracks
// every frame for smooth rotation; the raycast burst + canvas redraw + text
// readouts throttle to ~5 Hz.
export function updateMinimap(dt) {
  if (!ctx || viewMode !== 'surface' || !surfaceState.body) return;
  updateCompass();
  sampleTimer -= dt;
  if (sampleTimer > 0) return;
  sampleTimer = 0.2;
  refresh();
}
