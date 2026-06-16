// Surface-mode minimap: a small corner radar that paints a top-down patch of
// the terrain colours immediately around the avatar (sampled by downward
// raycasts onto the body mesh, read straight from body.colorArr so the swatches
// match the real ground), oriented so the avatar's facing points up, with a
// label naming the biome under its feet. Lives only while walking; the overlay
// CSS hides it the rest of the time. Sampling is throttled and the grid is
// small, so the raycast burst stays cheap.
import * as THREE from 'three';
import { biomeNameOfFace } from '../../framework/body.js';
import { viewMode } from '../../framework/state.js';
import { BODY_HEIGHT_SCALE, MAX_LAND_HEIGHT } from '../../core/constants.js';
import { surfaceState } from './core.js';

// DOM (created in index.html). Read once at module load like core.js does for
// its own surface elements — this module never imports from ui/.
const canvas  = document.getElementById('surfaceMinimap');
const biomeEl = document.getElementById('surfaceMinimapBiome');
const ctx = canvas ? canvas.getContext('2d') : null;
const compassEls = {
  N: document.getElementById('mmCardN'), E: document.getElementById('mmCardE'),
  S: document.getElementById('mmCardS'), W: document.getElementById('mmCardW'),
};

const MM_N = 9;                 // grid resolution (MM_N×MM_N cells, odd → has a centre)
const MM_HALF = (MM_N - 1) / 2;
let mmSpan = 0;                 // tangent half-extent the grid covers (body-local units)
let sampleTimer = 0;

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
const MM_R = 51;   // chip orbit radius (px) inside the 120px dial

// Cast straight down at the body under a tangent offset (du east, dv north) from
// the avatar and return the hit face, or null on a miss. Mirrors the sampling
// the grass grid uses (start above the tallest peak, aim at the body centre).
function faceAt(body, footR, du, dv, hi) {
  _mmUp.copy(surfaceState.localUp).multiplyScalar(footR)
    .addScaledVector(_mmRight, du).addScaledVector(_mmFwd, dv).normalize();
  _mmOrigin.copy(_mmUp).multiplyScalar(hi).applyMatrix4(body.mesh.matrixWorld);
  _mmDir.copy(_mmUp).multiplyScalar(-1).transformDirection(body.mesh.matrixWorld).normalize();
  _mmRay.set(_mmOrigin, _mmDir);
  const hits = _mmRay.intersectObject(body.mesh, false);
  return hits.length ? hits[0].face : null;
}

// Re-sample the colour grid + centre biome name, then redraw the canvas.
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
  // Grid spans roughly ±35 eye-heights — a readable slice of nearby ground.
  mmSpan = surfaceState.eyeHeight * 35;
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

  draw();
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
  // Avatar marker: a small triangle at centre pointing up (the facing dir).
  const cx = W / 2, cy = H / 2, s = Math.min(cw, ch) * 0.55;
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

// Place one compass chip at the screen angle of body-local tangent dir `d`,
// measured from the dial's top (= the avatar's facing). atan2(right, up) gives a
// clockwise angle; sin/-cos map it onto the dial so 0 = top, +90° = right.
function placeCard(el, d) {
  if (!el) return;
  const ang = Math.atan2(d.dot(_cRight), d.dot(_cFwd));
  el.style.left = (60 + Math.sin(ang) * MM_R) + 'px';
  el.style.top  = (60 - Math.cos(ang) * MM_R) + 'px';
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

// Per-frame hook from the animate loop (surface branch). The compass tracks
// every frame for smooth rotation; the raycast burst + canvas redraw throttle
// to ~5 Hz.
export function updateMinimap(dt) {
  if (!ctx || viewMode !== 'surface' || !surfaceState.body) return;
  updateCompass();
  sampleTimer -= dt;
  if (sampleTimer > 0) return;
  sampleTimer = 0.2;
  refresh();
}
