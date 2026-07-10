// Named surface waypoints, pinned to a body by a unit-direction `localPos`.
// Each also owns a small glowing "marker" disc (parented to body.group, same
// look as the orbit-mode hover cursor in interaction/pointer.js) plus a
// floating name label — both shown together in orbit view, gated by a single
// global toggle (#locationMarkersToggle in the Locations tab), not per
// location. Locations aren't focusable via the nav/star-map hierarchy;
// flyToLocation() is a plain camera jump. Every body gets North/South Pole
// locations automatically (see addPolarLocations, called from each
// createBody() call site). The Locations tab list is scoped to whichever
// planet/moon currently has focus — renderLocationList() re-runs on every
// 'focus:changed' (wired in ui/wire-up.js) so switching bodies swaps the
// visible list.
import * as THREE from 'three';
import { camera, controls } from '../core/scene.js';
import {
  focusedBody, locationMarkersVisible, locations, setLocationMarkersVisible,
  setTargetLocation, surfaceVisitBody, targetLocation, viewMode,
} from '../framework/state.js';

const LOCATION_MARKER_COLOR = 0x00f2ff;   // matches the location dot/label accent elsewhere
const LOCATION_MARKER_SCALE = 0.05;       // fraction of body.baseRadius
const LOCATION_MARKER_LIFT  = 0.08;       // sits just proud of the surface, like the old city markers
const _locNormal = new THREE.Vector3(0, 0, 1);

const labelLayer = document.getElementById('locationMarkerLabels');
const markersToggle = document.getElementById('locationMarkersToggle');
if (markersToggle) {
  markersToggle.checked = locationMarkersVisible;
  markersToggle.onchange = () => setLocationMarkersVisible(markersToggle.checked);
}

function createLocationMarker() {
  const geo = new THREE.CircleGeometry(1, 24);
  const mat = new THREE.MeshBasicMaterial({
    color: LOCATION_MARKER_COLOR, side: THREE.DoubleSide, transparent: true,
    opacity: 0.85, depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.visible = false;
  return mesh;
}

function disposeLocationMarker(mesh) {
  mesh.geometry.dispose();
  mesh.material.dispose();
}

function createLocationLabel(name) {
  const el = document.createElement('div');
  el.className = 'location-marker-label';
  el.textContent = name;
  el.style.display = 'none';
  if (labelLayer) labelLayer.appendChild(el);
  return el;
}

export function addLocation(body, name, localPos) {
  const marker = createLocationMarker();
  body.group.add(marker);
  const dir = localPos.clone().normalize();
  marker.position.copy(dir).multiplyScalar(body.baseRadius + LOCATION_MARKER_LIFT);
  marker.quaternion.setFromUnitVectors(_locNormal, dir);
  marker.scale.setScalar(body.baseRadius * LOCATION_MARKER_SCALE);
  const loc = { body, name, localPos: dir, marker, labelEl: createLocationLabel(name) };
  locations.push(loc);
  renderLocationList();
  return loc;
}

// Per-frame upkeep: gate the marker discs to orbit view + the global toggle,
// and keep each floating name label pinned over its marker's screen
// position (hidden once the marker rotates onto the far side of its body).
// Called unconditionally from the animate loop alongside updateMoons(dt) —
// cheap, a handful of locations at most.
const _worldPos = new THREE.Vector3();
const _bodyCenter = new THREE.Vector3();
const _toMarker = new THREE.Vector3();
const _toCamera = new THREE.Vector3();
export function updateLocationMarkers() {
  const orbitShow = locationMarkersVisible && viewMode === 'orbit';
  for (const loc of locations) {
    // The screen-projected label overlay below only makes sense against the
    // main orbit camera; the globe widgets (minimap/planet-map) draw their
    // own 3D labels/UI, so the marker MESH also shows for the visited body
    // during a surface visit (their cameras render this same live mesh),
    // but the label div stays orbit-only.
    const show = orbitShow || loc.body === surfaceVisitBody;
    loc.marker.visible = show;
    if (!orbitShow) { loc.labelEl.style.display = 'none'; continue; }

    loc.marker.getWorldPosition(_worldPos);
    loc.body.group.getWorldPosition(_bodyCenter);
    _toMarker.copy(_worldPos).sub(_bodyCenter).normalize();
    _toCamera.copy(camera.position).sub(_bodyCenter).normalize();
    const facingCamera = _toMarker.dot(_toCamera) > 0.05;

    _worldPos.project(camera);
    const onScreen = _worldPos.z < 1 && Math.abs(_worldPos.x) < 1.1 && Math.abs(_worldPos.y) < 1.1;
    if (!facingCamera || !onScreen) { loc.labelEl.style.display = 'none'; continue; }

    loc.labelEl.style.display = '';
    loc.labelEl.style.left = ((_worldPos.x * 0.5 + 0.5) * innerWidth) + 'px';
    loc.labelEl.style.top  = ((-_worldPos.y * 0.5 + 0.5) * innerHeight - 14) + 'px';
  }
}

export function addPolarLocations(body) {
  addLocation(body, 'North Pole', new THREE.Vector3(0, 1, 0));
  addLocation(body, 'South Pole', new THREE.Vector3(0, -1, 0));
}

// Only shows waypoints on the body currently in focus — with nothing
// focused (system view) the list is empty rather than a global dump.
export function renderLocationList() {
  const list = document.getElementById('locationList');
  if (!list) return;
  if (!focusedBody) {
    list.innerHTML = '<p class="hint">Focus a planet or moon to see its locations</p>';
    return;
  }
  list.innerHTML = locations
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => l.body === focusedBody)
    .map(({ l, i }) => `
    <div class="location-row" data-index="${i}">
      <span>${l.name}</span>
      <button class="location-target small-btn${targetLocation === l ? ' active' : ''}" type="button" aria-label="Set as target" title="Set as target">◎</button>
      <button class="location-flyto focus-btn small-btn" type="button">Go</button>
      <button class="location-remove" type="button" aria-label="Remove location">×</button>
    </div>`).join('');
  list.querySelectorAll('.location-row').forEach((row) => {
    const index = parseInt(row.dataset.index, 10);
    row.querySelector('.location-target').onclick = () => {
      const l = locations[index];
      if (l) setTargetLocation(targetLocation === l ? null : l);
      renderLocationList();
    };
    row.querySelector('.location-flyto').onclick = () => {
      const l = locations[index];
      if (l) flyToLocation(l);
    };
    row.querySelector('.location-remove').onclick = () => removeLocationAt(index);
  });
}

export function removeLocationAt(index) {
  const loc = locations[index];
  if (!loc) return;
  loc.body.group.remove(loc.marker);
  disposeLocationMarker(loc.marker);
  if (loc.labelEl.parentNode) loc.labelEl.parentNode.removeChild(loc.labelEl);
  if (targetLocation === loc) setTargetLocation(null);
  locations.splice(index, 1);
  renderLocationList();
}

// Camera-only jump to a location's current world position — deliberately does
// NOT touch focusedBody, so locations stay outside the star-map focus/nav
// hierarchy (they're waypoints, not focusable entities).
export function flyToLocation(loc) {
  const target = loc.localPos.clone().multiplyScalar(loc.body.baseRadius);
  loc.body.mesh.localToWorld(target);
  const planetCenter = new THREE.Vector3();
  loc.body.group.getWorldPosition(planetCenter);
  const normal = target.clone().sub(planetCenter).normalize();
  if (normal.lengthSq() < 1e-6) normal.set(0, 1, 0);
  const effRadius = loc.body.baseRadius * loc.body.group.scale.x;
  const desiredDist = Math.max(effRadius * 1.2, effRadius + 2);
  camera.position.copy(target).addScaledVector(normal, desiredDist);
  controls.target.copy(target);
}
