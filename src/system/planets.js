// Sol-system spec, the planet orbit registry, per-frame orbit advance and
// spin, and spawnSolarPlanet.
import { scene } from '../core/scene.js';
import { BASE_RADIUS, ICO_DETAIL } from '../core/constants.js';
import { ARCHETYPES } from '../framework/archetypes.js';
import { createBody, regenerateBody, applyRingsToBody } from '../framework/body.js';
import {
  bodies, planets, currentArchetype, setCurrentArchetype
} from '../framework/state.js';
import { refreshOrbitLine } from './orbits.js';

export const SOLAR_SYSTEM_SPEC = [
  { name: 'Mercury', archetype: 'moon_like',   size: 0.15, distance:  120, speed: 0.0175,  inclination:  0.06, angle: 0.20, seed: 'mercury', moons: [] },
  { name: 'Venus',   archetype: 'venusian',    size: 0.24, distance:  190, speed: 0.0125,  inclination: -0.05, angle: 1.10, seed: 'venus',   moons: [] },
  { name: 'Earth',   archetype: 'terrestrial', size: 0.27, distance:  270, speed: 0.0090,  inclination:  0.03, angle: 2.10, seed: 'earth',
    moons: [ { name: 'Moon', size: 0.30, distance: 10, seed: 'luna' } ],
    probes: [
      { name: 'ISS', size: 0.14, distance: 5, speed: 0.015, seed: 'iss', inclination: 0, node: 0, speedSign: 1 },
      { name: 'Tiangong', size: 0.13, distance: 6, speed: 0.012, seed: 'tiangong', inclination: Math.PI / 2, node: 0, speedSign: 1 },
    ] },
  { name: 'Mars',    archetype: 'desert',      size: 0.19, distance:  360, speed: 0.0065,  inclination: -0.08, angle: 3.20, seed: 'mars',    moons: [] },
  { name: 'Jupiter', archetype: 'gas_giant',   size: 0.72, distance:  520, speed: 0.0035,  inclination:  0.02, angle: 4.30, seed: 'jupiter',
    moons: [
      { name: 'Io',       size: 0.30, distance: 22, seed: 'io' },
      { name: 'Europa',   size: 0.28, distance: 28, seed: 'europa' },
      { name: 'Ganymede', size: 0.42, distance: 34, seed: 'ganymede' },
      { name: 'Callisto', size: 0.38, distance: 42, seed: 'callisto' },
    ] },
  { name: 'Saturn',  archetype: 'gas_giant',   size: 0.63, distance:  720, speed: 0.0025,  inclination: -0.04, angle: 5.10, seed: 'saturn',
    rings: { enabled: true, intensity: 0.80 },
    moons: [ { name: 'Titan', size: 0.45, distance: 24, seed: 'titan' } ] },
  { name: 'Uranus',  archetype: 'ice_giant',   size: 0.45, distance:  920, speed: 0.00175, inclination:  0.08, angle: 0.60, seed: 'uranus',  moons: [] },
  { name: 'Neptune', archetype: 'ice_giant',   size: 0.43, distance: 1120, speed: 0.00125, inclination: -0.06, angle: 5.80, seed: 'neptune', moons: [] },
];

export const DEFAULT_SPIN = (Math.PI * 2) / 360;

export function updatePlanetOrbitPosition(p) {
  const o = p.orbit;
  const x = Math.cos(o.angle) * o.distance;
  const z0 = Math.sin(o.angle) * o.distance;
  const inc = o.inclination || 0;
  const ci = Math.cos(inc), si = Math.sin(inc);
  p.body.group.position.set(x, -z0 * si, z0 * ci);
}

export function updatePlanetOrbits(dt) {
  for (const p of planets) {
    p.orbit.angle += p.orbit.speed * dt;
    updatePlanetOrbitPosition(p);
  }
}

export function registerPlanet(body, archetype, seedStr, orbit) {
  body.archetype = archetype;
  body.currentSeed = seedStr;
  if (body.rotationSpeed == null) body.rotationSpeed = DEFAULT_SPIN;
  const entry = { body, orbit: { ...orbit } };
  planets.push(entry);
  updatePlanetOrbitPosition(entry);
  refreshOrbitLine(entry);
  return entry;
}

export function spawnSolarPlanet(spec) {
  const arch = ARCHETYPES[spec.archetype];
  const body = createBody({
    kind: 'planet',
    name: spec.name,
    baseRadius: BASE_RADIUS,
    detail: ICO_DETAIL,
    hasOcean: arch.hasOcean,
  });
  bodies.push(body);
  scene.add(body.group);
  body.group.scale.setScalar(spec.size);
  // regenerateBody reads currentArchetype off the module scope; flip it
  // briefly so the correct palette/matter is applied without disturbing UI.
  const prev = currentArchetype;
  setCurrentArchetype(spec.archetype);
  regenerateBody(body, spec.seed, arch.amp, arch.sea);
  setCurrentArchetype(prev);
  body.currentAmp = arch.amp;
  body.currentSea = arch.sea;
  registerPlanet(body, spec.archetype, spec.seed, {
    angle: spec.angle,
    distance: spec.distance,
    speed: spec.speed,
    inclination: spec.inclination,
  });
  if (spec.rings) {
    body.rings.enabled   = spec.rings.enabled ?? true;
    body.rings.intensity = spec.rings.intensity ?? 0.65;
    applyRingsToBody(body);
  }
  return body;
}
// ====== 20. Planet rotation ======
// Each planet carries its own spin rate (rad/s) so the System tab's Spin
// slider can tune them independently. registerPlanet() seeds new bodies
// with DEFAULT_SPIN (declared earlier, alongside the planets[] array, so
// it's available when the first planets register at module init time).
export function updatePlanetRotation(dt) {
  for (const p of planets) {
    const w = p.body.rotationSpeed ?? DEFAULT_SPIN;
    p.body.group.rotation.y += w * dt;
  }
}

