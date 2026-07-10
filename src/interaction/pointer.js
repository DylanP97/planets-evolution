// Canvas pointer handlers: raycast bodies → start/continue brush strokes,
// place locations, drop gas whirlpools.
import {
  setActiveBrushBody, setActiveVortex, setIsPainting, setLastHitLocal
} from '../framework/state.js';

import * as THREE from 'three';
import { camera, renderer, scene } from '../core/scene.js';
import { biomeNameOfFace, formatLatLon } from '../framework/body.js';
import { addLocation } from '../entities/locations.js';
import {
  activeBrushBody, activeVortex, bodies, currentTool, isPainting, lastHitLocal, paintMode, viewMode
} from '../framework/state.js';
import { addGasVortex } from '../shaders/gas.js';
import { locationNameInput } from '../ui/dom.js';
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

  if (currentTool === 'location') {
    const name = locationNameInput.value || 'New Location';
    const localPos = worldToBodyLocal(hb.body, hb.hit.point);
    addLocation(hb.body, name, localPos);
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

// Pointer tracking. The actual marker placement happens every frame in
// updateOrbitInteraction (called from the animate loop), NOT here: the planets
// rotate and orbit continuously, so a marker positioned once on pointermove
// slides off the surface as the body turns beneath it. Re-raycasting from the
// cursor's screen position each frame keeps every marker (brush ring, hover dot,
// location/satellite placement preview) glued to whatever is under the cursor — and
// keeps the biome readout current as the terrain rotates past a still cursor.
let pointerOverCanvas = false;
let lastClientX = 0, lastClientY = 0;
renderer.domElement.addEventListener('pointermove', (e) => {
  setPointerFromEvent(e);
  lastClientX = e.clientX; lastClientY = e.clientY;
  pointerOverCanvas = true;
});
renderer.domElement.addEventListener('pointerenter', () => { pointerOverCanvas = true; });

// Orbit-mode hover tooltip + cyan surface dot. The tooltip names the terrain
// face under the cursor via the SAME biomeNameOfFace the surface minimap reads,
// so orbit and surface readouts always agree. The dot marks the exact spot the
// reading comes from (the OS cursor is hidden over the canvas). Only solid
// terrain reports a biome — gas/plasma shells have no per-vertex terrain.
const hoverBiomeTip = document.getElementById('hoverBiomeTip');
const hoverDot = new THREE.Mesh(
  new THREE.CircleGeometry(1, 24),
  new THREE.MeshBasicMaterial({
    color: 0x00f2ff, side: THREE.DoubleSide, transparent: true, opacity: 0.95,
    depthWrite: false, depthTest: false,
  })
);
hoverDot.renderOrder = 999;
hoverDot.visible = false;
scene.add(hoverDot);
const _nWorld  = new THREE.Vector3();   // scratch: world-space surface normal
const _dotLook = new THREE.Vector3();   // scratch: hoverDot lookAt target
const _localHit = new THREE.Vector3();  // scratch: hit point in body-local space
const _hoverDir = new THREE.Vector3();  // scratch: normalized hit dir, for the lat/long readout

function hideHoverBiome() {
  if (hoverBiomeTip) hoverBiomeTip.setAttribute('aria-hidden', 'true');
  hoverDot.visible = false;
}

// Per-frame (animate loop): refresh every cursor-anchored marker from a fresh
// raycast, so rotation/orbit can't drift them off the surface.
export function updateOrbitInteraction() {
  if (viewMode !== 'orbit' || !pointerOverCanvas) {
    brushRing.visible = false;
    hideHoverBiome();
    if (isPainting) setLastHitLocal(null);
    return;
  }
  const hb = raycastBodies();
  const brushActive = paintMode && isBrushTool();

  // Brush cursor ring (Sculpt / Environment / gas sub-modes).
  if (brushActive && hb) {
    _nWorld.copy(hb.hit.face.normal).transformDirection(hb.body.mesh.matrixWorld).normalize();
    // Ring footprint = brush arc at the hit radius, scaled to the body's world size.
    _localHit.copy(hb.hit.point); hb.body.mesh.worldToLocal(_localHit);
    const worldScale = hb.body.group.scale.x;
    updateBrushRing(hb.hit.point, _nWorld, brushArcWorldRadius(_localHit.length()) * worldScale);
  } else {
    brushRing.visible = false;
  }

  // Keep an active paint stroke pinned to the spot the cursor currently points
  // at (re-derived each frame so the brush follows the surface as it rotates,
  // and never jumps to a different body mid-stroke).
  if (isPainting && isBrushTool()) {
    if (hb && hb.body === activeBrushBody) {
      _localHit.copy(hb.hit.point); activeBrushBody.mesh.worldToLocal(_localHit);
      setLastHitLocal(_localHit.clone());
    } else {
      setLastHitLocal(null);
    }
  }

  // Hover biome tooltip + dot (solid terrain only). The dot is suppressed while
  // the brush ring is already marking the spot, to avoid two overlapping cursors.
  if (hb && hb.hit.object === hb.body.mesh && hb.hit.face) {
    if (hoverBiomeTip) {
      _hoverDir.copy(hb.hit.point); hb.body.mesh.worldToLocal(_hoverDir).normalize();
      hoverBiomeTip.textContent = biomeNameOfFace(hb.body, hb.hit.face) + ' · ' + formatLatLon(_hoverDir);
      hoverBiomeTip.style.left = (lastClientX + 16) + 'px';
      hoverBiomeTip.style.top  = (lastClientY + 16) + 'px';
      hoverBiomeTip.setAttribute('aria-hidden', 'false');
    }
    if (!brushActive) {
      _nWorld.copy(hb.hit.face.normal).transformDirection(hb.body.mesh.matrixWorld).normalize();
      const worldRadius = hb.body.baseRadius * hb.body.group.scale.x;
      hoverDot.position.copy(hb.hit.point).addScaledVector(_nWorld, worldRadius * 0.01);
      hoverDot.lookAt(_dotLook.copy(hb.hit.point).add(_nWorld));
      hoverDot.scale.setScalar(worldRadius * 0.025);
      hoverDot.visible = true;
    } else {
      hoverDot.visible = false;
    }
  } else {
    hideHoverBiome();
  }
}

renderer.domElement.addEventListener('pointerleave', () => {
  pointerOverCanvas = false;
  brushRing.visible = false;
  hideHoverBiome();
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

