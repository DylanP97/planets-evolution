// Visible orbit ellipse lines for planets and satellites (moons + probes).
import * as THREE from 'three';
import { scene } from '../core/scene.js';
import { planets, moons, probes } from '../framework/state.js';

export const ORBIT_LINE_SEGMENTS = 192;
export const orbitLinesGroup = new THREE.Group();
scene.add(orbitLinesGroup);

export const satelliteOrbitLinesGroup = new THREE.Group();
scene.add(satelliteOrbitLinesGroup);

export let showSatelliteOrbits = true;
export function setShowSatelliteOrbits(v) { showSatelliteOrbits = v; }

export const ORBIT_DEG = Math.PI / 180;

export const LEGACY_ORBIT_PATHS = {
  equatorial_west_east: { inclination: 0, node: 0, speedSign: 1 },
  equatorial_east_west: { inclination: 0, node: 0, speedSign: -1 },
  polar_north_south:    { inclination: Math.PI / 2, node: 0, speedSign: 1 },
  polar_south_north:    { inclination: Math.PI / 2, node: 0, speedSign: -1 },
  inclined:             { inclination: 0.42, node: 0.55, speedSign: 1 },
};

export function buildOrbitLineGeometry(distance, inclination) {
  const pts = new Float32Array(ORBIT_LINE_SEGMENTS * 3);
  const ci = Math.cos(inclination || 0);
  const si = Math.sin(inclination || 0);
  for (let i = 0; i < ORBIT_LINE_SEGMENTS; i++) {
    const t = (i / ORBIT_LINE_SEGMENTS) * Math.PI * 2;
    const x  = Math.cos(t) * distance;
    const z0 = Math.sin(t) * distance;
    pts[3 * i]     = x;
    pts[3 * i + 1] = -z0 * si;
    pts[3 * i + 2] = z0 * ci;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pts, 3));
  return geo;
}

export function refreshOrbitLine(entry) {
  const { distance, inclination } = entry.orbit;
  if (!entry.orbitLine) {
    const geo = buildOrbitLineGeometry(distance, inclination);
    const mat = new THREE.LineBasicMaterial({
      color: 0x00f2ff,
      transparent: true,
      opacity: 0.32,
      depthWrite: false,
    });
    entry.orbitLine = new THREE.LineLoop(geo, mat);
    orbitLinesGroup.add(entry.orbitLine);
  } else {
    entry.orbitLine.geometry.dispose();
    entry.orbitLine.geometry = buildOrbitLineGeometry(distance, inclination);
  }
}

export function disposeOrbitLine(entry) {
  if (!entry.orbitLine) return;
  orbitLinesGroup.remove(entry.orbitLine);
  entry.orbitLine.geometry.dispose();
  entry.orbitLine.material.dispose();
  entry.orbitLine = null;
}

export function applySatelliteOrbitPlane(sat, inclination, node, speedSign) {
  sat.inclination = inclination;
  sat.node = node;
  sat.speedSign = speedSign < 0 ? -1 : 1;
  refreshSatelliteOrbitLine(sat);
}

export function applySatelliteOrbitOpts(sat, opts, planeDefaults) {
  if (opts.orbitPath && LEGACY_ORBIT_PATHS[opts.orbitPath]) {
    const p = LEGACY_ORBIT_PATHS[opts.orbitPath];
    applySatelliteOrbitPlane(sat, p.inclination, p.node, p.speedSign);
    return;
  }
  applySatelliteOrbitPlane(
    sat,
    opts.inclination ?? planeDefaults.inclination,
    opts.node ?? planeDefaults.node,
    opts.speedSign ?? 1,
  );
}

export function buildSatelliteOrbitLineGeometry(distance, inclination, node) {
  const pts = new Float32Array(ORBIT_LINE_SEGMENTS * 3);
  const ci = Math.cos(inclination || 0);
  const si = Math.sin(inclination || 0);
  const cn = Math.cos(node || 0);
  const sn = Math.sin(node || 0);
  for (let i = 0; i < ORBIT_LINE_SEGMENTS; i++) {
    const t = (i / ORBIT_LINE_SEGMENTS) * Math.PI * 2;
    const x0 = Math.cos(t) * distance;
    const z0 = Math.sin(t) * distance;
    const y1 = -z0 * si;
    const z1 = z0 * ci;
    pts[3 * i]     = x0 * cn - z1 * sn;
    pts[3 * i + 1] = y1;
    pts[3 * i + 2] = x0 * sn + z1 * cn;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pts, 3));
  return geo;
}

export function syncSatelliteOrbitLinePosition(sat) {
  if (!sat.orbitLine || !sat.parent) return;
  const pp = sat.parent.group.position;
  sat.orbitLine.position.set(pp.x, pp.y, pp.z);
}

export function refreshSatelliteOrbitLine(sat) {
  const { distance, inclination, node } = sat;
  if (!sat.orbitLine) {
    const geo = buildSatelliteOrbitLineGeometry(distance, inclination, node);
    const mat = new THREE.LineBasicMaterial({
      color: sat.body ? 0xaaccff : 0xffaa44,
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
    });
    sat.orbitLine = new THREE.LineLoop(geo, mat);
    satelliteOrbitLinesGroup.add(sat.orbitLine);
  } else {
    sat.orbitLine.geometry.dispose();
    sat.orbitLine.geometry = buildSatelliteOrbitLineGeometry(distance, inclination, node);
  }
  syncSatelliteOrbitLinePosition(sat);
  sat.orbitLine.visible = showSatelliteOrbits;
}

export function disposeSatelliteOrbitLine(sat) {
  if (!sat.orbitLine) return;
  satelliteOrbitLinesGroup.remove(sat.orbitLine);
  sat.orbitLine.geometry.dispose();
  sat.orbitLine.material.dispose();
  sat.orbitLine = null;
}

export function setSatelliteOrbitLinesVisible(visible) {
  setShowSatelliteOrbits(visible);
  for (const m of moons) if (m.orbitLine) m.orbitLine.visible = visible;
  for (const p of probes) if (p.orbitLine) p.orbitLine.visible = visible;
}
