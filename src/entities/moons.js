import { scene } from '../core/scene.js';
import { createBody, regenerateBody } from '../framework/body.js';
import { bodies, focusedBody, moons, planet } from '../framework/state.js';
import { setFocus } from '../modes/focus.js';
import {
  applySatelliteOrbitOpts, disposeSatelliteOrbitLine, refreshSatelliteOrbitLine, syncSatelliteOrbitLinePosition
} from '../system/orbits.js';
import { updateInfoPanel } from '../ui/info-panel.js';

// ====== 16. Moons (each is a full editable body) ======
// Moons are built once at MOON_BASE_RADIUS = 1 and resized via group.scale,
// so the slider can change apparent size without rebuilding geometry.
export const MOON_BASE_RADIUS = 1;
export const MOON_DETAIL = 4;            // ~1280 verts; smaller bodies don't need planet-level density
export const MAX_MOONS = 4;              // per parent planet
export const MOON_REF_DISTANCE = 22;
// Each moon now owns its own orbital speed; this is the default for new moons.
export const DEFAULT_MOON_SPEED = (40 / 3000) * Math.PI * 2;
export let moonSeedCounter = 0;          // ensures each new moon gets a distinct seed
// moons[] itself lives in framework/state.js
// Slot tracking is per-parent so each planet has its own 0..MAX_MOONS slots.
export const moonSlotsByParent = new Map();

// Maps a slot index to a unique orbit plane (inclination + ascending node)
// and starting phase, so concurrent moons of the same planet don't overlap
// visually. Slots alternate sign so moons fan above + below the ecliptic.
export function moonOrbitPlane(slot) {
  return {
    inclination: (slot % 2 === 0 ? 1 : -1) * (0.08 + 0.18 * slot),
    node: slot * 1.1,
    phase: (slot / MAX_MOONS) * Math.PI * 2,
  };
}

export function allocateMoonSlot(parent) {
  let used = moonSlotsByParent.get(parent);
  if (!used) { used = new Set(); moonSlotsByParent.set(parent, used); }
  for (let i = 0; i < MAX_MOONS; i++) {
    if (!used.has(i)) { used.add(i); return i; }
  }
  return -1;
}

export function freeMoonSlot(parent, slot) {
  const used = moonSlotsByParent.get(parent);
  if (used) used.delete(slot);
}

export function satelliteWorldOffset(sat) {
  const x0 = Math.cos(sat.angle) * sat.distance;
  const z0 = Math.sin(sat.angle) * sat.distance;
  const ci = Math.cos(sat.inclination), si = Math.sin(sat.inclination);
  const y1 = -z0 * si;
  const z1 = z0 * ci;
  const cn = Math.cos(sat.node), sn = Math.sin(sat.node);
  return {
    x: x0 * cn - z1 * sn,
    y: y1,
    z: x0 * sn + z1 * cn,
  };
}

export function updateMoonPosition(m) {
  const off = satelliteWorldOffset(m);
  const pp = m.parent ? m.parent.group.position : { x: 0, y: 0, z: 0 };
  m.body.group.position.set(off.x + pp.x, off.y + pp.y, off.z + pp.z);
  syncSatelliteOrbitLinePosition(m);
}

export function addMoon(parent, size, distance, opts = {}) {
  const host = parent || planet;
  const ownCount = moons.reduce((n, m) => n + (m.parent === host ? 1 : 0), 0);
  if (ownCount >= MAX_MOONS) return null;
  const slot = allocateMoonSlot(host);
  if (slot < 0) return null;
  const plane = moonOrbitPlane(slot);
  const seed = opts.seed || ('moon-' + (++moonSeedCounter));
  const name = opts.name || `${host.name} · Moon ${ownCount + 1}`;
  const body = createBody({
    kind: 'moon',
    name,
    baseRadius: MOON_BASE_RADIUS,
    detail: MOON_DETAIL,
    hasOcean: false,
  });
  body.group.scale.setScalar(size);
  regenerateBody(body, seed, 1.6, 0.0); // moons start fully above "sea" — no ocean
  scene.add(body.group);
  bodies.push(body);
  const moon = {
    body,
    parent: host,
    seed,
    angle: plane.phase,
    inclination: plane.inclination,
    node: plane.node,
    speedSign: 1,
    size,
    distance,
    speed: DEFAULT_MOON_SPEED,
    slot,
  };
  applySatelliteOrbitOpts(moon, opts, plane);
  moons.push(moon);
  refreshSatelliteOrbitLine(moon);
  updateMoonPosition(moon);
  return moon;
}

export function removeMoonAt(index) {
  const moon = moons[index];
  if (!moon) return;
  if (focusedBody === moon.body) setFocus(moon.parent || planet);
  scene.remove(moon.body.group);
  const bi = bodies.indexOf(moon.body);
  if (bi >= 0) bodies.splice(bi, 1);
  moon.body.geo.dispose();
  moon.body.mesh.material.dispose();
  freeMoonSlot(moon.parent, moon.slot);
  disposeSatelliteOrbitLine(moon);
  moons.splice(index, 1);
  updateInfoPanel();
}

export function setMoonSize(index, size) {
  const m = moons[index];
  if (!m) return;
  m.size = size;
  m.body.group.scale.setScalar(size);
}

export function setMoonDistance(index, distance) {
  const m = moons[index];
  if (!m) return;
  m.distance = distance;
  refreshSatelliteOrbitLine(m);
  updateMoonPosition(m);
}

export function updateMoons(dt) {
  for (const m of moons) {
    const speed = m.speed ?? DEFAULT_MOON_SPEED;
    const sign = m.speedSign ?? 1;
    const omega = sign * speed * Math.pow(MOON_REF_DISTANCE / m.distance, 1.5);
    m.angle += omega * dt;
    updateMoonPosition(m);
  }
}

