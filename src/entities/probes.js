// Probes — GLB satellites orbiting planets (no editable surface): template
// loading, slots, per-frame orbit + self-spin.
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as THREE from 'three';
import { scene } from '../core/scene.js';
import { planet, probes } from '../framework/state.js';
import { focusedProbe, setFocus } from '../modes/focus.js';
import {
  applySatelliteOrbitOpts, disposeSatelliteOrbitLine, refreshSatelliteOrbitLine, syncSatelliteOrbitLinePosition
} from '../system/orbits.js';
import { setSystemFocus } from '../ui/nav.js';
import { satelliteWorldOffset } from './moons.js';

// ====== 17. Probes (artificial satellites) ======
// Unlike moons, probes are not editable bodies — they're a loaded 3D mesh
// (.glb) orbiting a parent planet. They reuse the moon orbit math but skip
// the createBody pipeline entirely (no terrain, biome, archetype, etc.).
export const MAX_PROBES = 4;
export const PROBE_REF_DISTANCE = 22;
export const DEFAULT_PROBE_SPEED = (60 / 3000) * Math.PI * 2; // a touch faster than moons
export const PROBE_BASE_SIZE = 1.0; // target on-screen length at size === 1
export let probeSeedCounter = 0;
// probes[] itself lives in framework/state.js
export const probeSlotsByParent = new Map();

// Cached parsed GLB. Each addSatellite clones it so multiple probes share
// geometry/material instances and we only pay the network/parse cost once.
export let satelliteTemplate = null;
export let satelliteTemplateLoading = null;

export function loadSatelliteTemplate() {
  if (satelliteTemplate) return Promise.resolve(satelliteTemplate);
  if (satelliteTemplateLoading) return satelliteTemplateLoading;
  const loader = new GLTFLoader();
  satelliteTemplateLoading = new Promise((resolve, reject) => {
    loader.load(
      'assets/satellite.glb',
      (gltf) => {
        const root = gltf.scene;
        // Center the model on its bounding-box center so orbit pivot is sane.
        const bbox = new THREE.Box3().setFromObject(root);
        const center = bbox.getCenter(new THREE.Vector3());
        root.position.sub(center);
        // Normalize so the model's longest axis is PROBE_BASE_SIZE units.
        const size = bbox.getSize(new THREE.Vector3());
        const longest = Math.max(size.x, size.y, size.z) || 1;
        const norm = PROBE_BASE_SIZE / longest;
        root.scale.multiplyScalar(norm);
        satelliteTemplate = root;
        resolve(root);
      },
      undefined,
      (err) => {
        console.error('[probe] failed to load satellite.glb', err);
        reject(err);
      }
    );
  });
  return satelliteTemplateLoading;
}

export function probeOrbitPlane(slot) {
  // Offset the inclination/node from moons so a planet with both doesn't
  // end up with co-planar orbits.
  return {
    inclination: (slot % 2 === 0 ? 1 : -1) * (0.22 + 0.14 * slot),
    node: slot * 0.85 + 0.4,
    phase: (slot / MAX_PROBES) * Math.PI * 2 + Math.PI / 5,
  };
}

export function allocateProbeSlot(parent) {
  let used = probeSlotsByParent.get(parent);
  if (!used) { used = new Set(); probeSlotsByParent.set(parent, used); }
  for (let i = 0; i < MAX_PROBES; i++) {
    if (!used.has(i)) { used.add(i); return i; }
  }
  return -1;
}

export function freeProbeSlot(parent, slot) {
  const used = probeSlotsByParent.get(parent);
  if (used) used.delete(slot);
}

const _probeLookTarget = new THREE.Vector3();

export function orientProbeToPlanet(p) {
  if (!p.parent || !p.mesh) return;
  p.parent.group.getWorldPosition(_probeLookTarget);
  p.mesh.lookAt(_probeLookTarget);
}

export function updateProbePosition(p) {
  const off = satelliteWorldOffset(p);
  const pp = p.parent ? p.parent.group.position : { x: 0, y: 0, z: 0 };
  p.mesh.position.set(off.x + pp.x, off.y + pp.y, off.z + pp.z);
  syncSatelliteOrbitLinePosition(p);
  orientProbeToPlanet(p);
}

export function addSatellite(parent, size, distance, opts = {}) {
  const host = parent || planet;
  if (!host) return null;
  const ownCount = probes.reduce((n, p) => n + (p.parent === host ? 1 : 0), 0);
  if (ownCount >= MAX_PROBES) return null;
  const slot = allocateProbeSlot(host);
  if (slot < 0) return null;
  const plane = probeOrbitPlane(slot);
  const name = opts.name || `${host.name} · Probe ${ownCount + 1}`;
  // A placeholder mesh holds the slot until the GLB resolves — that way
  // sliders and orbit math work the instant the user clicks Deploy.
  const group = new THREE.Group();
  group.name = name;
  group.scale.setScalar(size);
  scene.add(group);

  const probe = {
    mesh: group,
    parent: host,
    name,
    seed: opts.seed || ('probe-' + (++probeSeedCounter)),
    angle: plane.phase,
    inclination: plane.inclination,
    node: plane.node,
    speedSign: 1,
    size,
    distance,
    speed: opts.speed ?? DEFAULT_PROBE_SPEED,
    slot,
  };
  applySatelliteOrbitOpts(probe, opts, plane);
  probes.push(probe);
  refreshSatelliteOrbitLine(probe);
  updateProbePosition(probe);

  loadSatelliteTemplate().then((template) => {
    // Probe may have been removed before the GLB resolved — bail then.
    if (!probes.includes(probe)) return;
    const clone = template.clone(true);
    group.add(clone);
  }).catch(() => {
    // Fallback marker so the user still sees something if the GLB fails.
    if (!probes.includes(probe)) return;
    const fallback = new THREE.Mesh(
      new THREE.BoxGeometry(0.6, 0.6, 0.6),
      new THREE.MeshStandardMaterial({ color: 0xcccccc, metalness: 0.5, roughness: 0.4 })
    );
    group.add(fallback);
  });

  return probe;
}

export function removeSatelliteAt(index) {
  const probe = probes[index];
  if (!probe) return;
  // Drop focus to the host planet before tearing down the mesh so the
  // camera tracker doesn't chase a removed object.
  if (focusedProbe === probe) {
    if (probe.parent) setFocus(probe.parent); else setSystemFocus();
  }
  scene.remove(probe.mesh);
  probe.mesh.traverse((obj) => {
    if (obj.isMesh) {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        mats.forEach(m => m.dispose());
      }
    }
  });
  freeProbeSlot(probe.parent, probe.slot);
  disposeSatelliteOrbitLine(probe);
  probes.splice(index, 1);
}

export function setSatelliteSize(index, size) {
  const p = probes[index];
  if (!p) return;
  p.size = size;
  p.mesh.scale.setScalar(size);
}

export function setSatelliteDistance(index, distance) {
  const p = probes[index];
  if (!p) return;
  p.distance = distance;
  refreshSatelliteOrbitLine(p);
  updateProbePosition(p);
}

export function updateSatellites(dt) {
  for (const p of probes) {
    const sign = p.speedSign ?? 1;
    const omega = sign * p.speed * Math.pow(PROBE_REF_DISTANCE / p.distance, 1.5);
    p.angle += omega * dt;
    updateProbePosition(p);
  }
}

