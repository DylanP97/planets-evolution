// Save/load: serialize the current star system + locations + session
// context to localStorage, and reconstruct it from saved data. Restoring
// hand-edited terrain/biomes is mechanical — it reuses the exact per-vertex
// writers createBody already calls, just fed from saved arrays instead of
// procedural noise, so nothing in framework/body.js needs to change.
//
// v1 scope: gas-giant band paint (gasPaint) is not restored pixel-for-pixel —
// a saved full-gas planet regenerates a fresh random band pattern via
// applyMatterToBody's own ensureGasPaint call, same as a freshly spawned one.
// Restoring always lands the player in orbit view of the home planet, even if
// they saved mid-walk — re-entering surface mode correctly (camera rig,
// pointer lock, avatar attach) is out of scope for v1.
import * as THREE from 'three';
import { scene } from '../core/scene.js';
import { BASE_RADIUS, ICO_DETAIL } from '../core/constants.js';
import { setSystemNameValue, systemName } from '../core/names.js';
import { encodeTypedArray, decodeFloat32Array, decodeUint8Array } from '../core/utils.js';
import {
  bodies, planets, moons, probes, locations, planet, focusedBody,
  currentArchetype, planetCurrentSeed,
  setPlanet, setCurrentArchetype, setPlanetCurrentSeed,
} from '../framework/state.js';
import {
  createBody, writeBodyVertex, colorBodyVertex, commitBodyChanges,
  applyMatterToBody, applyRingsToBody, bakeOceanShore,
} from '../framework/body.js';
import { registerPlanet } from './planets.js';
import { MOON_BASE_RADIUS, MOON_DETAIL, allocateMoonSlot, updateMoonPosition } from '../entities/moons.js';
import { addSatellite } from '../entities/probes.js';
import { refreshSatelliteOrbitLine } from './orbits.js';
import { addLocation } from '../entities/locations.js';
import { unloadStarSystem, finalizeSystemLoad, setCurrentSystemId, currentSystemId } from './starsystems.js';
import { setFocus } from '../modes/focus.js';

export const SAVE_VERSION = 1;

const INDEX_KEY = 'planet-tiles:save-index';
const LAST_SLOT_KEY = 'planet-tiles:last-slot';
const slotKey = (id) => `planet-tiles:save:${id}`;

function serializeBody(body) {
  return {
    id: body.currentSeed,
    kind: body.kind,
    name: body.name,
    archetype: body.archetype || null,
    currentSeed: body.currentSeed,
    currentAmp: body.currentAmp,
    currentSea: body.currentSea,
    heights: encodeTypedArray(body.heights),
    biomes: encodeTypedArray(body.biomes),
    matter: { ...body.matter },
    oceanColHex: body.oceanIsWater ? null : body.oceanBaseColor,
    gasMode: body.gasMode,
    gasThickness: body.gasThickness,
    gasDensity: body.gasDensity,
    gasCoverage: body.gasCoverage,
    cloudType: body.cloudType,
    coverageVariance: body.coverageVariance,
    coveragePhase: body.coveragePhase,
    rings: { ...body.rings },
    rotationSpeed: body.rotationSpeed,
    scale: body.group.scale.x,
  };
}

export function serializeGame() {
  const planetEntries = planets.map(p => ({
    ...serializeBody(p.body),
    parentId: null,
    orbit: { ...p.orbit },
  }));
  const moonEntries = moons.map(m => ({
    ...serializeBody(m.body),
    parentId: m.parent ? m.parent.currentSeed : null,
    orbit: {
      angle: m.angle, distance: m.distance, speed: m.speed,
      inclination: m.inclination, node: m.node, speedSign: m.speedSign,
    },
  }));
  const probeEntries = probes.map(p => ({
    id: p.seed,
    name: p.name,
    parentId: p.parent ? p.parent.currentSeed : null,
    size: p.size,
    orbit: {
      angle: p.angle, distance: p.distance, speed: p.speed,
      inclination: p.inclination, node: p.node, speedSign: p.speedSign,
    },
  }));
  const locationEntries = locations.map(l => ({
    bodyId: l.body.currentSeed,
    name: l.name,
    localPos: [l.localPos.x, l.localPos.y, l.localPos.z],
  }));
  return {
    version: SAVE_VERSION,
    savedAt: Date.now(),
    systemId: currentSystemId,
    systemName,
    homePlanetId: planet ? planet.currentSeed : null,
    session: {
      currentArchetype,
      planetCurrentSeed,
      focusedBodyId: focusedBody ? focusedBody.currentSeed : null,
    },
    bodies: [...planetEntries, ...moonEntries],
    probes: probeEntries,
    locations: locationEntries,
  };
}

// Overwrite heights/biomes/coloring/matter on a freshly-created body from
// saved data, then push it into the vertex/normal pipeline exactly like
// createBody's own initial pass. `oceanCol` mirrors applyMatterToBody's own
// param: null keeps the archetype's "real water" tint, a hex number pins a
// fixed non-water color (lava, toxic, …).
function restoreBodyFromSave(body, saved) {
  body.currentSeed = saved.currentSeed;
  body.currentAmp = saved.currentAmp;
  body.currentSea = saved.currentSea;
  if (saved.archetype) body.archetype = saved.archetype;
  body.heights.set(decodeFloat32Array(saved.heights));
  body.biomes.set(decodeUint8Array(saved.biomes));
  applyMatterToBody(body, saved.matter, saved.oceanColHex ?? null);
  body.gasThickness = saved.gasThickness;
  body.gasDensity = saved.gasDensity;
  body.gasCoverage = saved.gasCoverage;
  body.cloudType = saved.cloudType;
  body.coverageVariance = saved.coverageVariance;
  body.coveragePhase = saved.coveragePhase;
  body.rotationSpeed = saved.rotationSpeed;
  if (saved.rings) {
    body.rings = { ...saved.rings };
    applyRingsToBody(body);
  }
  for (let i = 0; i < body.N; i++) {
    writeBodyVertex(body, i);
    colorBodyVertex(body, i);
  }
  commitBodyChanges(body);
  if (body.matter.liquid) bakeOceanShore(body);
  body.group.scale.setScalar(saved.scale);
}

export function buildSystemFromSave(data) {
  unloadStarSystem();
  setSystemNameValue(data.systemName || 'Sol');
  setCurrentSystemId(data.systemId || null);

  const byId = new Map(); // saved id -> rebuilt body

  const savedPlanets = data.bodies.filter(b => b.kind === 'planet');
  const savedMoons = data.bodies.filter(b => b.kind === 'moon');

  for (const saved of savedPlanets) {
    const body = createBody({
      kind: 'planet', name: saved.name, baseRadius: BASE_RADIUS, detail: ICO_DETAIL,
      hasOcean: !!saved.matter.liquid,
    });
    bodies.push(body);
    scene.add(body.group);
    restoreBodyFromSave(body, saved);
    registerPlanet(body, saved.archetype, saved.currentSeed, saved.orbit);
    byId.set(saved.id, body);
  }

  for (const saved of savedMoons) {
    const parent = byId.get(saved.parentId) || null;
    const body = createBody({
      kind: 'moon', name: saved.name, baseRadius: MOON_BASE_RADIUS, detail: MOON_DETAIL,
      hasOcean: false,
    });
    bodies.push(body);
    scene.add(body.group);
    restoreBodyFromSave(body, saved);
    const slot = parent ? allocateMoonSlot(parent) : -1;
    const moon = {
      body, parent, seed: saved.currentSeed,
      angle: saved.orbit.angle, inclination: saved.orbit.inclination,
      node: saved.orbit.node, speedSign: saved.orbit.speedSign ?? 1,
      size: saved.scale, distance: saved.orbit.distance, speed: saved.orbit.speed,
      slot,
    };
    moons.push(moon);
    refreshSatelliteOrbitLine(moon);
    updateMoonPosition(moon);
    byId.set(saved.id, body);
  }

  for (const saved of (data.probes || [])) {
    const parent = byId.get(saved.parentId) || null;
    addSatellite(parent, saved.size, saved.orbit.distance, {
      name: saved.name, seed: saved.id,
      inclination: saved.orbit.inclination, node: saved.orbit.node,
      speedSign: saved.orbit.speedSign, speed: saved.orbit.speed,
    });
  }

  for (const loc of (data.locations || [])) {
    const body = byId.get(loc.bodyId);
    if (body) addLocation(body, loc.name, new THREE.Vector3(...loc.localPos));
  }

  const home = byId.get(data.homePlanetId) || (planets[0] && planets[0].body) || null;
  setPlanet(home);
  setCurrentArchetype(data.session?.currentArchetype || currentArchetype);
  setPlanetCurrentSeed(data.session?.planetCurrentSeed || planetCurrentSeed);

  finalizeSystemLoad();

  const focusId = data.session?.focusedBodyId;
  const focusBody = focusId ? byId.get(focusId) : null;
  if (focusBody) setFocus(focusBody);
}

export function restoreGame(data) {
  buildSystemFromSave(data);
}

// ---- Slot storage (localStorage) --------------------------------------

function readIndex() {
  try { return JSON.parse(localStorage.getItem(INDEX_KEY) || '[]'); } catch (_) { return []; }
}
function writeIndex(index) {
  try { localStorage.setItem(INDEX_KEY, JSON.stringify(index)); } catch (_) {}
}

export function listSaveSlots() {
  return readIndex().sort((a, b) => b.timestamp - a.timestamp);
}

export function hasAnySave() {
  return readIndex().length > 0;
}

export function saveToSlot(name) {
  const data = serializeGame();
  const slotId = `save-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  try {
    localStorage.setItem(slotKey(slotId), JSON.stringify(data));
  } catch (err) {
    console.error('[save] failed to write slot', err);
    return null;
  }
  const index = readIndex();
  index.push({ slotId, name: name || data.systemName, timestamp: data.savedAt, systemName: data.systemName });
  writeIndex(index);
  localStorage.setItem(LAST_SLOT_KEY, slotId);
  return slotId;
}

export function loadFromSlot(slotId) {
  const raw = localStorage.getItem(slotKey(slotId));
  if (!raw) return false;
  let data;
  try { data = JSON.parse(raw); } catch (_) { return false; }
  restoreGame(data);
  localStorage.setItem(LAST_SLOT_KEY, slotId);
  return true;
}

export function deleteSlot(slotId) {
  localStorage.removeItem(slotKey(slotId));
  writeIndex(readIndex().filter(s => s.slotId !== slotId));
}

export function lastSlotId() {
  return localStorage.getItem(LAST_SLOT_KEY);
}
