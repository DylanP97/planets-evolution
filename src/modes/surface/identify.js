// Right-click sky/body identification: a quick (non-drag) right-click while
// walking a surface raycasts along the camera's forward vector — pointer
// lock pins the OS cursor to the crosshair at screen center, so the aim IS
// the camera direction, unlike orbit-mode picking which raycasts from the
// mouse position — against every other body + the Sun, and surfaces a
// "Name — distance, day length" toast for the nearest hit. Wired up from a
// pointerdown/pointerup tap-vs-drag check in input.js.
import * as THREE from 'three';
import { camera } from '../../core/scene.js';
import { sunMesh } from '../../core/sun.js';
import { bodies } from '../../framework/state.js';
import { surfaceState } from './core.js';

const _camPos = new THREE.Vector3();
const _camDir = new THREE.Vector3();
const _raycaster = new THREE.Raycaster();

export const skyIdentifyToastEl = document.getElementById('skyIdentifyToast');
let toastTimer = 0;

// Local formatter — modes/ can't import ui/info-panel.js (layering: ui/ is
// the top layer), so this mirrors its fmtSeconds rather than importing it.
function fmtSeconds(s) {
  if (!isFinite(s)) return '∞';
  if (s < 60) return s.toFixed(1) + 's';
  const m = Math.floor(s / 60);
  const r = Math.round(s - m * 60);
  return `${m}m ${r}s`;
}

function showIdentifyToast(text) {
  if (!skyIdentifyToastEl) return;
  skyIdentifyToastEl.textContent = text;
  skyIdentifyToastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => skyIdentifyToastEl.classList.remove('show'), 2600);
}

export function identifySkyTarget() {
  const here = surfaceState.body;
  if (!here) return;
  camera.getWorldPosition(_camPos);
  camera.getWorldDirection(_camDir);
  _raycaster.set(_camPos, _camDir);

  // Candidate meshes: every other planet/moon (solid surface if it has one,
  // else its gas shell), plus the Sun when its real disc is drawn (airless
  // worlds — atmosphere worlds paint their own sun into the sky shader, so
  // there's no mesh to hit; see surfaceState.paintsSunDisc in sky.js).
  const targets = [];
  for (const b of bodies) {
    if (b === here) continue;
    if (b.kind !== 'planet' && b.kind !== 'moon') continue;
    if (b.matter && b.matter.solid && b.mesh.visible) targets.push({ mesh: b.mesh, body: b });
    else if (b.gasMesh && b.gasMesh.visible) targets.push({ mesh: b.gasMesh, body: b });
  }
  if (sunMesh.visible) targets.push({ mesh: sunMesh, body: null });

  let best = null;
  for (const t of targets) {
    const hits = _raycaster.intersectObject(t.mesh, false);
    if (hits.length && (!best || hits[0].distance < best.dist)) {
      best = { dist: hits[0].distance, body: t.body };
    }
  }
  if (!best) { showIdentifyToast('Nothing in view'); return; }

  const name = best.body ? best.body.name : 'The Sun';
  let extra = '';
  if (best.body && best.body.kind === 'planet') {
    const w = best.body.rotationSpeed;
    if (w != null && w > 1e-6) extra = ` · day ${fmtSeconds(Math.PI * 2 / w)}`;
  }
  showIdentifyToast(`${name} — ${best.dist.toFixed(1)} u away${extra}`);
}
