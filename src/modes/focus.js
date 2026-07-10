// Focus switching (body / probe) and the per-frame camera tracking that
// keeps OrbitControls glued to the focused entity.
import { setFocusedBody, setFocusedProbe } from '../framework/state.js';

import * as THREE from 'three';
import { emit } from '../core/bus.js';
import { camera, controls } from '../core/scene.js';
import { focusedBody, focusedProbe } from '../framework/state.js';
import { focusNameEl } from '../ui/dom.js';

// ====== 22. Focus ======
// Camera target each frame is either the focused body's center or the
// focused probe's world position (still parented to its body, so
// rotation/orbit naturally carries the target along).
// Starts null: planets aren't spawned yet at eval time (see bootstrapSolSystem).
// The init tail calls setSystemFocus() anyway, which leaves focusedBody null.
// (focusedBody / focusedProbe both live in framework/state.js; this module
// owns the camera-moving setters that keep them consistent.)

// Switch the focused body. Side effects: recenters OrbitControls on the new
// body's world position at a sensible dolly distance, and re-renders the
// info panel, biome tools, and left panel.
export function setFocus(body) {
  setFocusedBody(body);
  setFocusedProbe(null);
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
  emit('focus:changed');
}

// Focus on a probe. Mirrors setFocus but targets the probe's mesh group and
// keeps focusedBody on the host planet so the Sats tab stays in context.
export function setProbeFocus(probe) {
  setFocusedProbe(probe);
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
  emit('focus:changed');
}

// Per-frame: snap controls.target onto the focused body's current world
// position so the camera stays glued to it as planets orbit and moons swing
// around their parent. The camera position trails along by the same delta,
// so the user's chosen viewing angle is preserved.
export function updateFocusTracking() {
  const newTarget = new THREE.Vector3();
  if (focusedProbe) focusedProbe.mesh.getWorldPosition(newTarget);
  else if (!focusedBody) return;
  else focusedBody.group.getWorldPosition(newTarget);
  const delta = newTarget.clone().sub(controls.target);
  if (delta.lengthSq() > 1e-12) {
    controls.target.copy(newTarget);
    // Keep camera offset relative to target so user-controlled orbit/zoom is preserved.
    camera.position.add(delta);
  }
}

