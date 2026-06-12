// Focus switching (body / city / probe) and the per-frame camera tracking
// that keeps OrbitControls glued to the focused entity.
import { setFocusedBody } from '../framework/state.js';

import * as THREE from 'three';
import { camera, controls } from '../core/scene.js';
import { renderCityList } from '../entities/cities.js';
import { focusedBody } from '../framework/state.js';
import { focusNameEl, updateBiomeTools } from '../ui/controls.js';
import { updateInfoPanel } from '../ui/info-panel.js';
import { applyFocusToLeftPanel } from '../ui/left-panel.js';
import { renderFocusBadges } from '../ui/roster.js';

// ====== 22. Focus ======
// Camera target each frame is either the focused body's center, or — if a city
// is selected — that city marker's world position (still parented to its body,
// so rotation/orbit naturally carries the target along).
// Starts null: planets aren't spawned yet at eval time (see bootstrapSolSystem).
// The init tail calls setSystemFocus() anyway, which leaves focusedBody null.
// (focusedBody itself lives in framework/state.js.)
export let focusedCity = null;
export function setFocusedCity(v) { focusedCity = v; }
// Probes are not editable bodies, so they get their own focus slot rather
// than riding on focusedBody (which everywhere assumes a planet/moon with a
// .kind, .group, baseRadius, matter, …). When a probe is focused we keep
// focusedBody pointing at its host planet so the left panel stays anchored
// to that planet's Sats tab; focusedProbe distinguishes the two.
export let focusedProbe = null;
export function setFocusedProbe(v) { focusedProbe = v; }

// Switch the focused body. Side effects: clears focusedCity, recenters
// OrbitControls on the new body's world position at a sensible dolly
// distance, and re-renders the info panel, biome tools, and left panel.
export function setFocus(body) {
  setFocusedBody(body);
  focusedCity = null;
  focusedProbe = null;
  focusNameEl.textContent = body.name;
  const newTarget = new THREE.Vector3();
  body.group.getWorldPosition(newTarget);
  const effRadius = body.baseRadius * body.group.scale.x;
  const desiredDist = Math.max(effRadius * 3.2, effRadius + 4);
  let dir = camera.position.clone().sub(controls.target);
  if (dir.lengthSq() < 1e-6) dir.set(0, 0.3, 1);
  dir.normalize();
  camera.position.copy(newTarget).addScaledVector(dir, desiredDist);
  controls.target.copy(newTarget);
  renderFocusBadges();
  updateBiomeTools();
  updateInfoPanel();
  if (typeof applyFocusToLeftPanel === 'function') applyFocusToLeftPanel();
}

export function setCityFocus(city) {
  setFocusedBody(city.body);
  focusedCity = city;
  focusedProbe = null;
  focusNameEl.textContent = `${city.name} · ${city.body.name}`;
  const newTarget = new THREE.Vector3();
  city.mesh.getWorldPosition(newTarget);
  // Closer framing than a whole-body focus — settlement is a point, not a sphere.
  const effRadius = city.body.baseRadius * city.body.group.scale.x;
  const desiredDist = Math.max(effRadius * 1.2, effRadius + 2);
  // Look at the city from "above" the local surface: prefer the surface normal
  // direction so the city sits centered with the body curving away.
  const normal = newTarget.clone().sub(city.body.group.getWorldPosition(new THREE.Vector3())).normalize();
  if (normal.lengthSq() < 1e-6) normal.set(0, 1, 0);
  camera.position.copy(newTarget).addScaledVector(normal, desiredDist);
  controls.target.copy(newTarget);
  renderFocusBadges();
  renderCityList();
  updateBiomeTools();
  updateInfoPanel();
  if (typeof applyFocusToLeftPanel === 'function') applyFocusToLeftPanel();
}

// Focus on a probe. Mirrors setFocus but targets the probe's mesh group and
// keeps focusedBody on the host planet so the Sats tab stays in context.
export function setProbeFocus(probe) {
  focusedProbe = probe;
  focusedCity = null;
  setFocusedBody(probe.parent);
  focusNameEl.textContent = probe.name;
  const newTarget = new THREE.Vector3();
  probe.mesh.getWorldPosition(newTarget);
  // The mesh group is scaled by probe.size, so frame relative to that.
  const desiredDist = Math.max(probe.size * 6, probe.size + 4);
  let dir = camera.position.clone().sub(controls.target);
  if (dir.lengthSq() < 1e-6) dir.set(0, 0.3, 1);
  dir.normalize();
  camera.position.copy(newTarget).addScaledVector(dir, desiredDist);
  controls.target.copy(newTarget);
  renderFocusBadges();
  updateBiomeTools();
  updateInfoPanel();
  if (typeof applyFocusToLeftPanel === 'function') applyFocusToLeftPanel();
}

// Per-frame: snap controls.target onto the focused body's current world
// position so the camera stays glued to it as planets orbit and moons swing
// around their parent. The camera position trails along by the same delta,
// so the user's chosen viewing angle is preserved.
export function updateFocusTracking() {
  const newTarget = new THREE.Vector3();
  if (focusedProbe) focusedProbe.mesh.getWorldPosition(newTarget);
  else if (!focusedBody) return;
  else if (focusedCity) focusedCity.mesh.getWorldPosition(newTarget);
  else focusedBody.group.getWorldPosition(newTarget);
  const delta = newTarget.clone().sub(controls.target);
  if (delta.lengthSq() > 1e-12) {
    controls.target.copy(newTarget);
    // Keep camera offset relative to target so user-controlled orbit/zoom is preserved.
    camera.position.add(delta);
  }
}

