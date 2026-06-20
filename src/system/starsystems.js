// Galaxy catalog (constellations → star systems), procedural system
// generation, and star-system load / unload / bootstrap.
import { setSystemNameValue } from '../core/names.js';
import {
  setClimateReady, setFocusedBody, setFocusedCity, setFocusedProbe, setPlanet
} from '../framework/state.js';

import { ROMAN, generateName, systemName } from '../core/names.js';
import { addMoon } from '../entities/moons.js';
import { addSatellite } from '../entities/probes.js';
import { recolorBody } from '../framework/body.js';
import { computeClimate } from '../framework/climate.js';
import { bodies, planets, viewMode } from '../framework/state.js';
import { exitPickMode } from '../modes/surface/core.js';
import { exitSurfaceMode } from '../modes/surface/mode.js';
import { emit } from '../core/bus.js';
import { ALPHA_CENTAURI_SPEC, SOLAR_SYSTEM_SPEC, spawnSolarPlanet } from './planets.js';
import { removePlanetBody } from './teardown.js';

// ====== 34. Star-system load / unload ======
// The 3D scene only ever holds one star system at a time. Switching systems
// (driven by the galaxy/constellation maps, added in later phases) tears the
// current one down and bootstraps another into the same renderer/scene — the
// Sun mesh and starfield are shared and never disposed. Sol is the immutable
// preset, rebuilt from SOLAR_SYSTEM_SPEC every time, so a reload always
// returns home; procedural systems live only in memory for the session.

// ---- Catalog ----------------------------------------------------------
// The galaxy → constellation → star-system tree the maps (Phase 3/4) will
// render. Session-only and rebuilt fresh on every load: Sol always exists
// in Helios Sector; the other constellations start empty and fill with
// user-created systems. mapX/mapY are normalized [0..1] positions for the
// map overlays; the empties are placed now so the galaxy map has anchors.
export const galaxy = {
  id: 'milky-way',
  name: 'Milky Way Galaxy',
  constellations: [
    { id: 'helios-sector', name: 'Helios Sector', mapX: 0.50, mapY: 0.52, starSystems: [
      { id: 'sol', name: 'Sol', isPreset: true, constellationId: 'helios-sector', mapX: 0.50, mapY: 0.50 },
    ] },
    { id: 'centaurus',   name: 'Centaurus',    mapX: 0.40, mapY: 0.44, starSystems: [
      { id: 'alpha-centauri', name: 'Alpha Centauri', isPreset: true, constellationId: 'centaurus',
        mapX: 0.50, mapY: 0.50, planetSpecs: ALPHA_CENTAURI_SPEC, homeIndex: 1 },
    ] },
    { id: 'orion',       name: 'Orion',        mapX: 0.30, mapY: 0.34, starSystems: [] },
    { id: 'lyra',        name: 'Lyra',         mapX: 0.70, mapY: 0.30, starSystems: [] },
    { id: 'draco',       name: 'Draco',        mapX: 0.22, mapY: 0.66, starSystems: [] },
    { id: 'cygnus',      name: 'Cygnus',       mapX: 0.78, mapY: 0.62, starSystems: [] },
    { id: 'carina',      name: 'Carina',       mapX: 0.46, mapY: 0.80, starSystems: [] },
  ],
};
// Scatter the constellations across the galaxy map with rough spacing so the
// sectors look randomly placed (like the systems inside them), not on a fixed
// grid. Session-only — re-rolled each load. mapX/mapY can also be dragged.
(function scatterConstellations() {
  const placed = [];
  const minD = 0.24;
  galaxy.constellations.forEach(con => {
    let x, y, tries = 0;
    do {
      x = 0.15 + Math.random() * 0.70;
      y = 0.18 + Math.random() * 0.60;
      tries++;
    } while (tries < 50 && placed.some(p => Math.hypot(p.x - x, p.y - y) < minD));
    placed.push({ x, y });
    con.mapX = x;
    con.mapY = y;
  });
})();

// id of the system currently built into the 3D scene (set by loadStarSystem).
export let currentSystemId = null;
export let systemSeq = 0; // monotonic counter for unique procedural-system ids
// Where we are above the 3D scene. Declared here (not in 34b) because the
// bottom-nav render reads it during the very first boot, before 34b runs.
export let viewLevel = 'system';            // 'system' | 'constellation' | 'galaxy'
export function setViewLevel(v) { viewLevel = v; }
// Which constellation the constellation map is showing (the galaxy map can
// open any constellation, independent of where the loaded system lives).
export let viewedConstellationId = null;
export function setViewedConstellationId(v) { viewedConstellationId = v; }

export function allStarSystems() {
  return galaxy.constellations.flatMap(c => c.starSystems);
}
export function findStarSystem(id) {
  return allStarSystems().find(s => s.id === id) || null;
}
export function findConstellation(id) {
  return galaxy.constellations.find(c => c.id === id) || null;
}

// ---- Procedural generator --------------------------------------------
// Build a planetSpecs array (same shape as SOLAR_SYSTEM_SPEC) for a new
// system: 4–9 planets on Kepler-ish widening orbits, weighted archetypes
// (commoner rock/desert/gas/ice over exotic), giants get rings + more moons.
// Star archetype is excluded — the central Sun is the shared mesh at origin.
export function randomArchetypeKey() {
  // Weighted bag: terrestrial-ish and giants are common; exotics are rare.
  const weighted = [
    'terrestrial','terrestrial','desert','desert','moon_like','moon_like',
    'gas_giant','gas_giant','ice_giant','ice_planet','ocean','venusian',
    'lava','jungle','swamp','toxic','metal','carbon','storm','living','rogue',
  ];
  return weighted[(Math.random() * weighted.length) | 0];
}
export function generateStarSystemSpec(seed) {
  const rand = (a, b) => a + Math.random() * (b - a);
  const planetCount = 4 + ((Math.random() * 6) | 0); // 4..9
  const specs = [];
  let distance = rand(110, 160);
  for (let i = 0; i < planetCount; i++) {
    const arch = randomArchetypeKey();
    const isGiant = arch === 'gas_giant' || arch === 'ice_giant';
    const size = isGiant ? rand(0.45, 0.78) : rand(0.14, 0.30);
    // Inner planets orbit faster; tie speed to distance (∝ 1/dist) like Sol.
    const speed = (0.0175 * (120 / distance)) * rand(0.8, 1.2);
    // Moons: giants 0–4, rocky worlds 0–2 (innermost rarely keeps any).
    const moonMax = isGiant ? 4 : 2;
    const moonCount = Math.max(0, Math.round(rand(-0.4, moonMax)));
    const moons = [];
    for (let m = 0; m < moonCount; m++) {
      moons.push({
        name: generateName('moon'),
        size: rand(0.22, isGiant ? 0.45 : 0.34),
        distance: (isGiant ? 18 : 8) + m * rand(5, 9),
        seed: `${seed}-p${i}-m${m}`,
      });
    }
    const spec = {
      name: `Planet ${ROMAN[i] || i + 1}`,
      archetype: arch,
      size,
      distance: Math.round(distance),
      speed,
      inclination: rand(-0.08, 0.08),
      angle: Math.random() * Math.PI * 2,
      seed: `${seed}-p${i}`,
      moons,
    };
    if (isGiant && Math.random() < 0.45) {
      spec.rings = { enabled: true, intensity: rand(0.5, 0.9) };
    }
    specs.push(spec);
    distance += rand(90, 190);
  }
  return specs;
}

// ---- Catalog mutations (session only) --------------------------------
// Create a new procedural system inside a constellation, generating and
// caching its planetSpecs immediately so the system is reproducible for the
// session. Returns the new catalog entry (not yet loaded into the scene).
export function createStarSystem(constellationId) {
  const con = findConstellation(constellationId);
  if (!con) return null;
  const id = `sys-${++systemSeq}-${Math.floor(Math.random() * 1e4).toString(36)}`;
  const seed = `${id}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  const entry = {
    id,
    name: generateName('system'),
    isPreset: false,
    constellationId,
    seed,
    planetSpecs: generateStarSystemSpec(seed),
    // Random position within the constellation's local map bounds.
    mapX: 0.5 + (Math.random() - 0.5) * 0.7,
    mapY: 0.5 + (Math.random() - 0.5) * 0.7,
  };
  con.starSystems.push(entry);
  return entry;
}

// Remove a system from the catalog. Sol (preset) is undeletable. Refuses to
// delete the system currently in the scene — callers exit to a map / load
// another system first. Returns true on success.
export function deleteStarSystem(id) {
  const sys = findStarSystem(id);
  if (!sys || sys.isPreset) return false;
  if (id === currentSystemId) return false;
  const con = findConstellation(sys.constellationId);
  if (!con) return false;
  const idx = con.starSystems.indexOf(sys);
  if (idx >= 0) con.starSystems.splice(idx, 1);
  return true;
}

// Load a system by catalog id (convenience wrapper over loadStarSystem).
export function loadStarSystemById(id) {
  const sys = findStarSystem(id);
  if (!sys) return false;
  loadStarSystem(sys);
  return true;
}

// Build a system's bodies from a spec array (same shape as SOLAR_SYSTEM_SPEC:
// each entry is a planet with optional moons[]/probes[]/rings). spawnSolarPlanet
// is archetype-agnostic, so it serves both the preset and procedural systems.
// Returns the spawned planet bodies in spec order. Deliberately defined down
// here: moon/probe seeding needs moons[]/probes[]/cities[] and the climate
// model declared above. spawnSolarPlanet/addMoon/addSatellite are hoisted.
export function buildSystemFromSpec(specArray) {
  const spawned = specArray.map(spawnSolarPlanet);
  specArray.forEach((spec, i) => {
    const parent = spawned[i];
    (spec.moons || []).forEach(moonSpec => {
      addMoon(parent, moonSpec.size, moonSpec.distance, {
        name: moonSpec.name,
        seed: moonSpec.seed,
        inclination: moonSpec.inclination,
        node: moonSpec.node,
        speedSign: moonSpec.speedSign,
        orbitPath: moonSpec.orbitPath,
      });
    });
    (spec.probes || []).forEach(probeSpec => {
      addSatellite(parent, probeSpec.size, probeSpec.distance, {
        name: probeSpec.name,
        seed: probeSpec.seed,
        inclination: probeSpec.inclination,
        node: probeSpec.node,
        speedSign: probeSpec.speedSign,
        orbitPath: probeSpec.orbitPath,
        speed: probeSpec.speed,
      });
    });
  });
  return spawned;
}

// Build Sol from the immutable preset. Earth is the home/default body.
export function bootstrapSolSystem() {
  setSystemNameValue('Sol');
  const solarBodies = buildSystemFromSpec(SOLAR_SYSTEM_SPEC);
  setPlanet(solarBodies[2]); // Earth — the conventional home/default body
}

// Tear down every body in the current system. removePlanetBody already
// cascade-deletes a planet's moons, probes, cities, and orbit line and
// disposes geometry/materials; with { force } it skips the keep-≥1 guard and
// the per-planet refocus. Afterwards bodies/planets/moons/probes/cities are
// all empty. The shared Sun, starfield, and renderer are left intact.
export function unloadStarSystem() {
  if (viewMode === 'surface') exitSurfaceMode();
  else if (viewMode === 'pick') exitPickMode();
  // Drop focus first so nothing renders against a body we're about to
  // dispose (finalizeSystemLoad's list renders run before setSystemFocus).
  setFocusedBody(null);
  setFocusedCity(null);
  setFocusedProbe(null);
  // Snapshot first: removePlanetBody mutates planets[] as it runs.
  for (const body of planets.map(p => p.body)) {
    removePlanetBody(body, { force: true });
  }
  setPlanet(null);
}

// Post-build step shared by every system (Sol or procedural): enable the
// climate model, repaint solid surfaces for frost, and settle into the
// system-wide view. The ui refreshes go out as bus events (handled in
// ui/wire-up.js) so this module never imports ui/. Mirrors the original
// end-of-init tail; events fire in the original call order.
export function finalizeSystemLoad() {
  // The world is now fully built and the climate model (section 22b) exists,
  // so switch frost on and repaint every solid body — polar ice and altitude
  // frost show from the first frame. Gas giants and stars skip the repaint
  // (no visible solid surface) but still get a cached climate for the panel.
  setClimateReady(true);
  for (const b of bodies) {
    computeClimate(b);
    // Only planets render latitude frost; moons keep their fixed palette.
    if (b.kind === 'planet' && b.matter && b.matter.solid) recolorBody(b);
  }
  emit('ui:satellite-lists');
  emit('ui:biome-tools');
  // Default to the system-wide view so the user sees the whole system.
  emit('focus:system');
  emit('ui:active-tool');
  emit('ui:info');
}

// Build a non-Sol preset (e.g. Alpha Centauri) from the planetSpecs attached
// to its immutable catalog entry. homeIndex picks the default/home body
// (the habitable world), falling back to the innermost planet.
export function bootstrapPresetSystem(system) {
  setSystemNameValue(system.name);
  const spawned = buildSystemFromSpec(system.planetSpecs || []);
  const home = system.homeIndex != null ? spawned[system.homeIndex] : spawned[0];
  setPlanet(home || spawned[0] || null);
}

// Build a user-created system from the planetSpecs cached on its catalog
// entry (generated once, at create time, so revisiting in the same session
// reproduces it exactly). planet (home/default) is the innermost planet.
export function bootstrapProceduralSystem(system) {
  setSystemNameValue(system.name);
  const spawned = buildSystemFromSpec(system.planetSpecs || []);
  setPlanet(spawned[0] || null);
}

// Swap the live system. A null system or one flagged isPreset rebuilds Sol;
// any other spec is generated procedurally (generator added in a later
// phase). Hooked up to the map overlays once those exist.
export function loadStarSystem(system) {
  unloadStarSystem();
  if (!system || system.id === 'sol') bootstrapSolSystem();
  else if (system.isPreset && system.planetSpecs) bootstrapPresetSystem(system);
  else bootstrapProceduralSystem(system);
  currentSystemId = (system && system.id) || 'sol';
  finalizeSystemLoad();
}

// Initial boot — `loadStarSystem(findStarSystem('sol'))` — is issued from
// main.js, after every UI module has been evaluated (it fans out into the
// info panel, nav bar, and left panel, which must have their DOM refs ready).

