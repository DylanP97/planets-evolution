// Cascade planet teardown (planet + its moons, probes, locations, orbit lines).
// Lives in system/ (not ui/) because both the roster's remove button and
// unloadStarSystem() need it — and the system layer must not import ui/.
import { emit } from '../core/bus.js';
import { scene } from '../core/scene.js';
import { renderLocationList } from '../entities/locations.js';
import { freeMoonSlot } from '../entities/moons.js';
import { removeSatelliteAt } from '../entities/probes.js';
import {
  bodies, focusedBody, locations, moons, planets, probes, setTargetLocation, targetLocation
} from '../framework/state.js';
import { disposeOrbitLine, disposeSatelliteOrbitLine } from './orbits.js';

// Cascade-delete a planet: also tears down its moons, probes, and the
// visible orbit line. Refuses to delete the last remaining planet and
// re-focuses on the system view if the deleted planet was focused.
// opts.force — used by unloadStarSystem() to tear down every planet when
// swapping systems: skips the keep-≥1 guard and the per-planet refocus
// (the caller re-focuses once after the new system is built).
export function removePlanetBody(target, opts = {}) {
  if (!target || target.kind !== 'planet') return;
  if (!opts.force && planets.length <= 1) return;
  // Remove moons of this planet first.
  for (let i = moons.length - 1; i >= 0; i--) {
    if (moons[i].parent === target) {
      if (focusedBody === moons[i].body) {
        // moot since focusedBody is the planet, not the moon — but be safe
      }
      scene.remove(moons[i].body.group);
      const bi = bodies.indexOf(moons[i].body);
      if (bi >= 0) bodies.splice(bi, 1);
      moons[i].body.geo.dispose();
      moons[i].body.mesh.material.dispose();
      freeMoonSlot(moons[i].parent, moons[i].slot);
      disposeSatelliteOrbitLine(moons[i]);
      moons.splice(i, 1);
    }
  }
  // Remove probes orbiting this planet.
  for (let i = probes.length - 1; i >= 0; i--) {
    if (probes[i].parent === target) removeSatelliteAt(i);
  }
  // Remove locations on this planet (+ their box markers).
  for (let i = locations.length - 1; i >= 0; i--) {
    const loc = locations[i];
    if (loc.body !== target) continue;
    loc.body.group.remove(loc.marker);
    loc.marker.geometry.dispose();
    loc.marker.material.dispose();
    if (targetLocation === loc) setTargetLocation(null);
    locations.splice(i, 1);
  }
  // Remove the planet itself.
  scene.remove(target.group);
  const bi = bodies.indexOf(target);
  if (bi >= 0) bodies.splice(bi, 1);
  const pi = planets.findIndex(p => p.body === target);
  if (pi >= 0) {
    disposeOrbitLine(planets[pi]);
    planets.splice(pi, 1);
  }
  target.geo.dispose();
  target.mesh.material.dispose();
  if (target.oceanMesh) {
    target.oceanMesh.geometry.dispose();
    target.oceanMesh.material.dispose();
  }
  if (target.ringMesh) {
    target.ringMesh.geometry.dispose();
    target.ringMesh.material.dispose();
  }
  // Bounce to system view: the focus may have been pointing at the planet
  // itself or one of its moons — both destroyed above. Skipped during a
  // bulk system swap (the caller re-focuses once at the end).
  if (!opts.force) {
    emit('focus:system');
    renderLocationList();
  }
}
