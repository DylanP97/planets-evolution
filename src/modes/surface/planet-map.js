// Full-planet map: reached from the pause menu (surfaceMapBtn). Where
// minimap.js samples a small tangent-plane patch around the avatar every
// 200ms, this samples the WHOLE sphere once (on open) as an equirectangular
// lat/lon grid — same "raycast down, read body.colorArr" technique, just
// walked over every (lat, lon) cell instead of a local (du, dv) patch, and
// projected straight (lon -> x, lat -> y) instead of a forward-up tangent
// frame. Static once drawn; re-generated only when the panel is (re)opened,
// so the raycast burst (thousands of casts) never touches the animate loop.
// Click a named-location marker to toggle it as the current waypoint.
import * as THREE from 'three';
import { repVertexOfFace, formatLatLon } from '../../framework/body.js';
import { locations, setTargetLocation, targetLocation } from '../../framework/state.js';
import { oceanTempState } from '../../framework/climate.js';
import { BODY_HEIGHT_SCALE, MAX_LAND_HEIGHT, SEA_LEVEL, SEA_ICE_COLOR, SEA_STEAM_COLOR } from '../../core/constants.js';
import { surfaceState } from './core.js';

const panelEl  = document.getElementById('surfacePlanetMapMenu');
const canvas   = document.getElementById('surfacePlanetMap');
const titleEl  = document.getElementById('surfacePlanetMapTitle');
const ctx      = canvas ? canvas.getContext('2d') : null;
const backBtn  = document.getElementById('surfacePlanetMapBackBtn');

// Grid resolution: 2:1 aspect matches the equirectangular projection
// (360° of longitude over 180° of latitude). One-off cost on open, so this
// can run well above the minimap's per-frame grid without any frame hit.
const COLS = 160, ROWS = 80;
const _col = new Float32Array(COLS * ROWS * 3);
const _has = new Uint8Array(COLS * ROWS);

const _ray    = new THREE.Raycaster();
const _origin = new THREE.Vector3();
const _dir    = new THREE.Vector3();
const _up     = new THREE.Vector3();     // scratch: body-local direction for the cell being sampled
const _waterCol = new THREE.Color();
const _iceCol   = new THREE.Color(SEA_ICE_COLOR);
const _steamCol = new THREE.Color(SEA_STEAM_COLOR);
const _blendCol = new THREE.Color();

// Body-local direction for a given lat/lon (radians) — inverse of
// formatLatLon's lat = asin(up.y), lon = atan2(up.x, -up.z).
function dirForLatLon(lat, lon, out) {
  const cl = Math.cos(lat);
  out.set(cl * Math.sin(lon), Math.sin(lat), -cl * Math.cos(lon));
  return out;
}

// Cast straight down at the body along a body-local direction and return the
// hit face, or null on a miss. Mirrors minimap.js's faceAt, minus the
// tangent-plane offset — every cell here IS the "up" direction.
function faceAtDir(body, dirLocal, hi) {
  _origin.copy(dirLocal).multiplyScalar(hi).applyMatrix4(body.mesh.matrixWorld);
  _dir.copy(dirLocal).multiplyScalar(-1).transformDirection(body.mesh.matrixWorld).normalize();
  _ray.set(_origin, _dir);
  const hits = _ray.intersectObject(body.mesh, false);
  return hits.length ? hits[0].face : null;
}

// Named-location markers projected to canvas-space (lon, lat) fractions,
// refreshed alongside the colour grid. Each keeps the source `loc` too, so a
// click can hit-test against it and toggle it as the waypoint.
let _locs = [];

function generate() {
  const body = surfaceState.body;
  if (!body || !ctx) return;
  body.mesh.updateMatrixWorld();
  const hi = body.baseRadius * (1 + MAX_LAND_HEIGHT * BODY_HEIGHT_SCALE) + 1;

  const hasOcean = !!(body.oceanMesh && body.oceanMesh.visible && body.matter && body.matter.liquid);
  if (hasOcean) _waterCol.set(body.oceanBaseColor || 0x2277aa);
  const oceanZoned = hasOcean && body.oceanIsWater && body.climate && body.climate.spread > 0.5;

  for (let iy = 0; iy < ROWS; iy++) {
    const lat = (Math.PI / 2) - ((iy + 0.5) / ROWS) * Math.PI; // +90 at top row
    for (let ix = 0; ix < COLS; ix++) {
      const lon = -Math.PI + ((ix + 0.5) / COLS) * Math.PI * 2;
      dirForLatLon(lat, lon, _up);
      const f = faceAtDir(body, _up, hi);
      const cellIdx = iy * COLS + ix;
      if (!f) { _has[cellIdx] = 0; continue; }
      const o = cellIdx * 3;
      const h = (body.heights[f.a] + body.heights[f.b] + body.heights[f.c]) / 3;
      const rv = 3 * repVertexOfFace(body, f);
      if (hasOcean && h < SEA_LEVEL) {
        if (oceanZoned) {
          const r = oceanTempState(body, _up.x, _up.y, _up.z);
          if (r.state === 'ice')        _blendCol.copy(_waterCol).lerp(_iceCol, r.t);
          else if (r.state === 'steam') _blendCol.copy(_waterCol).lerp(_steamCol, r.t);
          else _blendCol.copy(_waterCol);
        } else {
          _blendCol.copy(_waterCol);
        }
        const depthT = Math.min(1, (SEA_LEVEL - h) / 0.4);
        _col[o]     = body.colorArr[rv]     + (_blendCol.r - body.colorArr[rv])     * (0.55 + 0.45 * depthT);
        _col[o + 1] = body.colorArr[rv + 1] + (_blendCol.g - body.colorArr[rv + 1]) * (0.55 + 0.45 * depthT);
        _col[o + 2] = body.colorArr[rv + 2] + (_blendCol.b - body.colorArr[rv + 2]) * (0.55 + 0.45 * depthT);
      } else {
        _col[o]     = body.colorArr[rv];
        _col[o + 1] = body.colorArr[rv + 1];
        _col[o + 2] = body.colorArr[rv + 2];
      }
      _has[cellIdx] = 1;
    }
  }

  _locs = [];
  for (const loc of locations) {
    if (loc.body !== body) continue;
    const lat = Math.asin(Math.max(-1, Math.min(1, loc.localPos.y)));
    const lon = Math.atan2(loc.localPos.x, -loc.localPos.z);
    _locs.push({ loc, u: (lon + Math.PI) / (Math.PI * 2), v: 1 - (lat + Math.PI / 2) / Math.PI });
  }

  if (titleEl) titleEl.textContent = `${body.name} — ${formatLatLon(surfaceState.localUp)}`;

  draw();
}

function draw() {
  const W = canvas.width, H = canvas.height;
  const cw = W / COLS, ch = H / ROWS;
  ctx.clearRect(0, 0, W, H);
  for (let iy = 0; iy < ROWS; iy++) {
    for (let ix = 0; ix < COLS; ix++) {
      const cellIdx = iy * COLS + ix;
      if (_has[cellIdx]) {
        const o = cellIdx * 3;
        const r = (_col[o]     * 255) | 0;
        const g = (_col[o + 1] * 255) | 0;
        const b = (_col[o + 2] * 255) | 0;
        ctx.fillStyle = `rgb(${r},${g},${b})`;
      } else {
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
      }
      ctx.fillRect(ix * cw, iy * ch, cw + 0.5, ch + 0.5);
    }
  }

  // Avatar marker at its current lat/lon.
  const up = surfaceState.localUp;
  const alat = Math.asin(Math.max(-1, Math.min(1, up.y)));
  const alon = Math.atan2(up.x, -up.z);
  const au = (alon + Math.PI) / (Math.PI * 2);
  const av = 1 - (alat + Math.PI / 2) / Math.PI;
  const ax = au * W, ay = av * H;
  const s = Math.min(cw, ch) * 1.2 + 3;
  ctx.beginPath();
  ctx.arc(ax, ay, s, 0, Math.PI * 2);
  ctx.fillStyle = '#00f2ff';
  ctx.strokeStyle = 'rgba(0,0,0,0.7)';
  ctx.lineWidth = 1.5;
  ctx.fill();
  ctx.stroke();

  // Named-location markers; the current waypoint (if any) is highlighted.
  for (const { loc, u, v } of _locs) {
    const lx = u * W, ly = v * H;
    const isTarget = targetLocation === loc;
    ctx.beginPath();
    ctx.arc(lx, ly, isTarget ? 4.5 : 3, 0, Math.PI * 2);
    ctx.fillStyle = isTarget ? '#ffcc33' : 'rgba(64,224,255,0.95)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.65)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.font = '10px sans-serif';
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.fillText(loc.name, lx, ly - 6);
  }
}

// Click a marker (within a small pixel radius) to toggle it as the waypoint.
let downX = 0, downY = 0;
function onPointerDown(ev) { downX = ev.clientX; downY = ev.clientY; }

function onPointerUp(ev) {
  if (Math.hypot(ev.clientX - downX, ev.clientY - downY) > 6) return;
  if (!_locs.length) return;
  const rect = canvas.getBoundingClientRect();
  const px = (ev.clientX - rect.left) / rect.width * canvas.width;
  const py = (ev.clientY - rect.top) / rect.height * canvas.height;

  let best = null, bestDist = Infinity;
  for (const { loc, u, v } of _locs) {
    const d = Math.hypot(px - u * canvas.width, py - v * canvas.height);
    if (d < bestDist) { bestDist = d; best = loc; }
  }
  if (best && bestDist <= 12) {
    setTargetLocation(targetLocation === best ? null : best);
    draw();
  }
}

export function openPlanetMap() {
  surfaceState.pauseView = 'map';
  const pauseBoxEl = document.getElementById('surfacePauseMenu');
  if (pauseBoxEl) pauseBoxEl.classList.remove('show');
  if (panelEl) panelEl.classList.add('show');
  generate();
}

export function backFromPlanetMap() {
  surfaceState.pauseView = 'pause';
  if (panelEl) panelEl.classList.remove('show');
  const pauseBoxEl = document.getElementById('surfacePauseMenu');
  if (pauseBoxEl) pauseBoxEl.classList.add('show');
}

if (backBtn) backBtn.onclick = backFromPlanetMap;
if (canvas) {
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointerup', onPointerUp);
}
