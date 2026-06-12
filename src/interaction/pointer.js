// Canvas pointer handlers: raycast bodies → start/continue brush strokes,
// place cities, drop gas whirlpools.
import {
  setActiveBrushBody, setActiveVortex, setIsPainting, setLastHitLocal
} from '../framework/state.js';

import { camera, renderer } from '../core/scene.js';
import { addCity } from '../entities/cities.js';
import {
  activeBrushBody, activeVortex, bodies, currentTool, isPainting, lastHitLocal, paintMode, viewMode
} from '../framework/state.js';
import { addGasVortex } from '../shaders/gas.js';
import { cityNameInput } from '../ui/controls.js';
import { updateInfoPanel } from '../ui/info-panel.js';
import {
  brushArcWorldRadius, brushRing, isBrushTool, pointer, raycaster, updateBrushRing
} from './brush.js';

// ====== 15. Pointer handling ======
export function setPointerFromEvent(e) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
}

// Raycast against every body; return { hit, body } for the closest one.
// On full-gas planets the solid mesh is hidden, so we fall back to the
// gas shell — it's the only surface the user can actually click on, and
// its outward normal is a fine proxy for the body's direction.
export function raycastBodies() {
  raycaster.setFromCamera(pointer, camera);
  const meshes = [];
  const meshToBody = new Map();
  for (const b of bodies) {
    let target = null;
    if (b.mesh.visible) target = b.mesh;
    else if (b.matter && b.matter.gas === 'full' && b.gasMesh && b.gasMesh.visible) target = b.gasMesh;
    else if (b.matter && b.matter.plasma && b.plasmaMesh && b.plasmaMesh.visible) target = b.plasmaMesh;
    if (!target) continue;
    meshes.push(target);
    meshToBody.set(target, b);
  }
  const hits = raycaster.intersectObjects(meshes, false);
  if (hits.length === 0) return null;
  const hit = hits[0];
  const body = meshToBody.get(hit.object) || null;
  if (!body) return null;
  return { hit, body };
}

export function worldToBodyLocal(body, worldPoint) {
  return body.mesh.worldToLocal(worldPoint.clone());
}

renderer.domElement.addEventListener('pointerdown', (e) => {
  if (e.button !== 2) return;
  if (!paintMode) return;
  if (viewMode !== 'orbit') return; // brush is meaningless mid-pick / on surface
  e.preventDefault();
  setPointerFromEvent(e);
  const hb = raycastBodies();
  if (!hb) return;

  if (currentTool === 'city') {
    const name = cityNameInput.value || 'New City';
    const localPos = worldToBodyLocal(hb.body, hb.hit.point);
    addCity(hb.body, name, localPos);
  } else if (!isBrushTool()) {
    return;
  } else if (currentTool === 'gaswhirl'
             && hb.body.matter && hb.body.matter.gas === 'full') {
    // Drop a fresh whirlpool at strength 0 and capture the pointer.
    // applyBrushToBody will grow its strength each frame the user holds.
    const localPos = worldToBodyLocal(hb.body, hb.hit.point);
    setActiveVortex(addGasVortex(hb.body, localPos));
    setIsPainting(true);
    setActiveBrushBody(hb.body);
    setLastHitLocal(localPos);
    renderer.domElement.setPointerCapture(e.pointerId);
  } else {
    setIsPainting(true);
    setActiveBrushBody(hb.body);
    setLastHitLocal(worldToBodyLocal(hb.body, hb.hit.point));
    renderer.domElement.setPointerCapture(e.pointerId);
  }
});

renderer.domElement.addEventListener('pointermove', (e) => {
  setPointerFromEvent(e);
  // Brush ring only on Sculpt / Environment (and gas sub-modes).
  if (!paintMode || !isBrushTool() || viewMode !== 'orbit') {
    brushRing.visible = false;
    return;
  }
  const hb = raycastBodies();
  if (!hb) {
    brushRing.visible = false;
    if (isPainting) setLastHitLocal(null);
    return;
  }
  const nWorld = hb.hit.face.normal.clone()
    .transformDirection(hb.body.mesh.matrixWorld)
    .normalize();
  // Scale the ring by the body's local hit radius times its world scale so the
  // visible ring matches the brush footprint on bodies of any size.
  const worldScale = hb.body.group.scale.x;
  const localHitRadius = worldToBodyLocal(hb.body, hb.hit.point).length();
  updateBrushRing(hb.hit.point, nWorld, brushArcWorldRadius(localHitRadius) * worldScale);
  if (isPainting) {
    // Only continue painting on the body we started on, so dragging off doesn't
    // jump the brush to a different body.
    if (hb.body === activeBrushBody) setLastHitLocal(worldToBodyLocal(hb.body, hb.hit.point));
    else setLastHitLocal(null);
  }
});

export function endPaint(e) {
  if (!isPainting) return;
  setIsPainting(false);
  setLastHitLocal(null);
  setActiveBrushBody(null);
  setActiveVortex(null);
  try { renderer.domElement.releasePointerCapture(e.pointerId); } catch (_) {}
  updateInfoPanel();
}
renderer.domElement.addEventListener('pointerup', endPaint);
renderer.domElement.addEventListener('pointercancel', endPaint);

// Suppress the browser context menu over the canvas while paint mode is on.
renderer.domElement.addEventListener('contextmenu', (e) => {
  if (paintMode) e.preventDefault();
});

