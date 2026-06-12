// Right-hand telemetry panel: composition rollup, climate section, rotation
// and orbit readouts (updateInfoPanel + throttled updateLiveInfo).
import {
  BIOME, BODY_HEIGHT_SCALE, COL, GRASS_TOP, ROCK_TOP, SAND_TOP, SEA_ICE_C, SEA_LEVEL, SEA_VAPOR_C
} from '../core/constants.js';
import { systemName } from '../core/names.js';
import { DEFAULT_MOON_SPEED, MOON_REF_DISTANCE } from '../entities/moons.js';
import { CLIMATE_LAND_ZONES, pickLandZone, vertexTempC } from '../framework/body.js';
import { computeClimate, fmtTemp, surfaceGravityG, tempColor } from '../framework/climate.js';
import { focusedBody, moons, planets } from '../framework/state.js';
import { focusedProbe } from '../modes/focus.js';
import { GAS_BAND_COUNT, gasBiomeById } from '../shaders/gas.js';
import { DEFAULT_SPIN } from '../system/planets.js';

// ====== 23. Info panel ======
export let planetCurrentSeed = 'planet';
export function setPlanetCurrentSeed(v) { planetCurrentSeed = v; }

// Category metadata: label + swatch color (matches the in-world palette). Covers
// both "auto" (height-band) and biome-painted categories for planets and moons.
export const COMP_DISPLAY = {
  water:     { label: 'Water',       color: '#3FA1DC' },
  sand:      { label: 'Sand',        color: '#EDDFB8' },
  grass:     { label: 'Grass',       color: '#4FAE4F' },
  rock:      { label: 'Rock',        color: '#7d6a5a' },
  snow:      { label: 'Snow',        color: '#f0f4f8' },
  forest:    { label: 'Forest',      color: '#1a4d1a' },
  desert:    { label: 'Desert',      color: '#d2b48c' },
  city:      { label: 'Settlements', color: '#808080' },
  // Climate land biomes (terrestrial latitude zones). Colors mirror
  // CLIMATE_LAND_ZONES so the swatch matches the painted surface.
  ice:       { label: 'Ice',         color: '#daf2ff' },
  tundra:    { label: 'Tundra',      color: '#8f9e76' },
  jungle:    { label: 'Jungle',      color: '#15702a' },
  // Sea-state categories (water oceans only): a frozen-over sea and a basin
  // the heat has boiled dry. Colors mirror SEA_ICE_COLOR / SEABED_COLOR.
  seaice:    { label: 'Sea Ice',     color: '#cfe6f0' },
  seabed:    { label: 'Dry Seabed',  color: '#cabfa3' },
  crater:    { label: 'Crater',      color: '#322e29' },
  dust:      { label: 'Dust',        color: '#6f6357' },
  highlight: { label: 'Highlights',  color: '#e2dccf' },
  mare:      { label: 'Mare',        color: '#2a2a30' },
  regolith:  { label: 'Regolith',    color: '#c4b8a0' },
  frost:     { label: 'Frost',       color: '#d8e8f0' },
};
export const PLANET_COMP_ORDER = ['water', 'seaice', 'ice', 'tundra', 'grass', 'jungle', 'forest', 'sand', 'desert', 'seabed', 'rock', 'snow', 'city'];
export const MOON_COMP_ORDER   = ['crater', 'dust', 'rock', 'highlight', 'mare', 'regolith', 'frost', 'city'];

// Per-archetype labels for the auto-painted height bands. Without these, a
// desert planet reports "Grass" for its mid-elevation band even though that
// band is colored desert-tan — confusing because no green is visible.
export const BAND_KEY_TO_PALETTE = { water: 'deep', sand: 'sand', grass: 'grass', rock: 'rock', snow: 'snow' };
export const ARCHETYPE_BAND_LABELS = {
  terrestrial: { water: 'Ocean',      sand: 'Coast',      grass: 'Grass',      rock: 'Rock',       snow: 'Snow' },
  ocean:       { water: 'Abyss',      sand: 'Deep',       grass: 'Sea',        rock: 'Shoal',      snow: 'Foam' },
  gas_giant:   { water: 'Deep Band',  sand: 'Lower Cloud',grass: 'Mid Cloud',  rock: 'Storm Belt', snow: 'High Cloud' },
  ice_giant:   { water: 'Deep Ice',   sand: 'Ice Shelf',  grass: 'Ice Plain',  rock: 'Ridge',      snow: 'Frost Crown' },
  desert:      { water: 'Basin',      sand: 'Dunes',      grass: 'Flats',      rock: 'Mesa',       snow: 'Salt Peak' },
  lava:        { water: 'Magma',      sand: 'Cinder',     grass: 'Lava Plain', rock: 'Basalt',     snow: 'Ash' },
  ice_planet:  { water: 'Subglacial', sand: 'Snowfield',  grass: 'Pack Ice',   rock: 'Glacier',    snow: 'Ice Peak' },
  jungle:      { water: 'River',      sand: 'Bank',       grass: 'Jungle',     rock: 'Highland',   snow: 'Canopy' },
  swamp:       { water: 'Bog',        sand: 'Marsh',      grass: 'Mossland',   rock: 'Ridge',      snow: 'Mist' },
  toxic:       { water: 'Acid Sea',   sand: 'Sludge',     grass: 'Bloom',      rock: 'Spire',      snow: 'Vapor' },
  venusian:    { water: 'Basalt Basin',sand: 'Basalt Slabs',grass: 'Volcanic Regolith', rock: 'Gravel Field', snow: 'Highland Tessera' },
  metal:       { water: 'Slag Pit',   sand: 'Plate',      grass: 'Sheet',      rock: 'Ridge',      snow: 'Vein' },
  carbon:      { water: 'Tar',        sand: 'Ash Flat',   grass: 'Soot Plain', rock: 'Diamond',    snow: 'Carbon Peak' },
  moon_like:   { water: 'Crater Floor',sand: 'Dust Plain', grass: 'Regolith',   rock: 'Highland',   snow: 'Frost Cap' },
  storm:       { water: 'Squall Sea', sand: 'Foam',       grass: 'Plain',      rock: 'Ridge',      snow: 'Cyclone' },
  living:      { water: 'Blood Sea',  sand: 'Vein',       grass: 'Flesh',      rock: 'Bone',       snow: 'Organ' },
  rogue:       { water: 'Void',       sand: 'Dust',       grass: 'Plain',      rock: 'Ridge',      snow: 'Peak' },
};

export function hexFromNumber(n) {
  return '#' + (n >>> 0).toString(16).padStart(6, '0');
}

// Build the (label, swatch-color) pair for a planet band, using the planet's
// actual palette so the swatch matches what's drawn on the surface.
export function bandMeta(body, key) {
  const arch = body.archetype || 'terrestrial';
  const labels = ARCHETYPE_BAND_LABELS[arch] || ARCHETYPE_BAND_LABELS.terrestrial;
  const label = labels[key] || COMP_DISPLAY[key].label;
  let color;
  if (key === 'water' && body.oceanMesh && body.oceanMesh.visible) {
    // Ocean tint now lives in vertex colors (material.color is neutral white),
    // so use the stored base color for the swatch.
    color = hexFromNumber(body.oceanBaseColor || COL.water);
  } else {
    const palKey = BAND_KEY_TO_PALETTE[key];
    color = body.palette && body.palette[palKey] != null
      ? hexFromNumber(body.palette[palKey])
      : COMP_DISPLAY[key].color;
  }
  return { label, color };
}

// Returns { peak, N, counts } where counts maps a band/biome key to the
// number of vertices in that bucket. Drives the composition rollup in the
// info panel; planet keys differ from moon keys (see PLANET_COMP_ORDER /
// MOON_COMP_ORDER).
export function computeBodyStats(body) {
  let peak = -Infinity;
  const counts = {};
  const hasBiomes = body.biomes != null;
  // Mirror colorBodyVertex: on climate-zoned worlds the auto land band is
  // named by latitude (ice/tundra/grass/jungle) rather than elevation, so the
  // composition rollup matches what's actually painted on the surface.
  const climateZoned = body.kind === 'planet' && body.climate && body.climate.spread > 0.5;
  const zones = climateZoned ? CLIMATE_LAND_ZONES[body.archetype] : null;
  // Water seas report their frozen / boiled-dry state so the rollup matches
  // what the ocean sphere shows (see colorOceanByClimate).
  const seaWater = climateZoned && body.matter && body.matter.liquid && body.oceanIsWater;
  for (let i = 0; i < body.N; i++) {
    const h = body.heights[i];
    if (h > peak) peak = h;
    const b = hasBiomes ? body.biomes[i] : 0;
    let key;
    if (b === 1) key = 'forest';
    else if (b === 2) key = 'desert';
    else if (b === 3) key = 'city';
    else if (b === 4) key = 'tundra';
    else if (b === BIOME.MARE) key = 'mare';
    else if (b === BIOME.REGOLITH) key = 'regolith';
    else if (b === BIOME.FROST) key = 'frost';
    else if (body.kind === 'planet') {
      if (h < SEA_LEVEL) {
        if (seaWater) {
          const tC = vertexTempC(body, i);
          key = tC >= SEA_VAPOR_C ? 'seabed' : (tC <= SEA_ICE_C ? 'seaice' : 'water');
        } else key = 'water';
      }
      else if (h >= ROCK_TOP) key = 'snow';
      else if (zones) {
        const z = pickLandZone(zones, vertexTempC(body, i));
        // Warm zones show a sandy shore at the waterline (matches coloring).
        key = (z.beach && h < SAND_TOP) ? 'sand' : z.key;
      }
      else if (h < SAND_TOP) key = 'sand';
      else if (h < GRASS_TOP) key = 'grass';
      else key = 'rock';
    } else {
      if (h < 0) key = 'crater';
      else if (h < GRASS_TOP) key = 'dust';
      else if (h < ROCK_TOP) key = 'rock';
      else key = 'highlight';
    }
    counts[key] = (counts[key] || 0) + 1;
  }
  return { peak: peak === -Infinity ? 0 : peak, N: body.N, counts };
}

export function fmtPct(n, total) {
  if (!total) return '0%';
  const p = (n / total) * 100;
  return (p >= 10 ? p.toFixed(0) : p.toFixed(1)) + '%';
}

export function fmtSeconds(s) {
  if (!isFinite(s)) return '∞';
  if (s < 60) return s.toFixed(1) + 's';
  const m = Math.floor(s / 60);
  const r = Math.round(s - m * 60);
  return `${m}m ${r}s`;
}

export function peakWorldHeight(body, peak) {
  return body.baseRadius * Math.max(0, peak) * BODY_HEIGHT_SCALE * body.group.scale.x;
}

export const infoEls = {
  name:         document.getElementById('infoBodyName'),
  subtitle:     document.getElementById('infoSubtitle'),
  composition:  document.getElementById('infoComposition'),
  climateSection: document.getElementById('infoClimateSection'),
  tempMean:     document.getElementById('infoTempMean'),
  tempRangeRow: document.getElementById('infoTempRangeRow'),
  tempRange:    document.getElementById('infoTempRange'),
  tempBar:      document.getElementById('infoTempBar'),
  gravity:      document.getElementById('infoGravity'),
  peak:         document.getElementById('infoPeak'),
  verts:        document.getElementById('infoVerts'),
  moonsRow:     document.getElementById('infoMoonsRow'),
  moons:        document.getElementById('infoMoons'),
  timeSection:  document.getElementById('infoTimeSection'),
  dayPeriod:    document.getElementById('infoDayPeriod'),
  dayTime:      document.getElementById('infoDayTime'),
  orbitSection: document.getElementById('infoOrbitSection'),
  orbitDist:    document.getElementById('infoOrbitDist'),
  orbitOmega:   document.getElementById('infoOrbitOmega'),
  orbitPeriod:  document.getElementById('infoOrbitPeriod'),
  moonSize:     document.getElementById('infoMoonSize'),
};

// Composition rollup for full-gas planets: tally bandBiomes weighted by
// each band's actual surface area on the sphere (sin(latitude) — bands
// near the equator cover more surface than bands near the poles).
// Returns rows sorted by surface fraction descending so the dominant
// biome leads the panel.
export function computeGasComposition(body) {
  const gp = body.gasPaint;
  if (!gp || !gp.bandBiomes) return [];
  const tallies = new Map();
  let total = 0;
  for (let i = 0; i < GAS_BAND_COUNT; i++) {
    const w = Math.sin(((i + 0.5) / GAS_BAND_COUNT) * Math.PI);
    total += w;
    const id = gp.bandBiomes[i];
    tallies.set(id, (tallies.get(id) || 0) + w);
  }
  const rows = [];
  for (const [id, w] of tallies) {
    const biome = gasBiomeById(id);
    if (!biome) continue;
    rows.push({ id, name: biome.name, color: biome.color, frac: total > 0 ? w / total : 0 });
  }
  rows.sort((a, b) => b.frac - a.frac);
  return rows;
}

// Fill the Climate section from a fresh climate computation. Stars and gas
// giants get a mean reading; the equator/poles row is hidden when a body has
// no meaningful latitude spread (e.g. a star). The bar tints from pole color
// (left) to equator color (right) for an at-a-glance hot/cold read.
export function renderClimateSection(body) {
  if (!infoEls.climateSection) return;
  const c = computeClimate(body);
  infoEls.climateSection.style.display = '';
  infoEls.tempMean.textContent = fmtTemp(c.meanK);
  infoEls.tempMean.style.color = tempColor(c.meanK);
  if (c.spread > 1) {
    infoEls.tempRangeRow.style.display = '';
    infoEls.tempRange.textContent = `${fmtTemp(c.equatorK)} / ${fmtTemp(c.poleK)}`;
    infoEls.tempBar.style.background =
      `linear-gradient(90deg, ${tempColor(c.poleK)}, ${tempColor(c.meanK)}, ${tempColor(c.equatorK)})`;
    infoEls.tempBar.style.display = '';
  } else {
    infoEls.tempRangeRow.style.display = 'none';
    infoEls.tempBar.style.background = tempColor(c.meanK);
    infoEls.tempBar.style.display = '';
  }
}

export function updateInfoPanel() {
  if (!infoEls.name) return; // info panel removed from HTML — nothing to update
  if (focusedProbe) {
    // Probes are artificial satellites, not surveyable bodies — show their
    // identity and orbit rather than composition/terrain stats.
    infoEls.name.textContent = focusedProbe.name;
    infoEls.subtitle.textContent = `Probe · seed "${focusedProbe.seed}"`;
    infoEls.composition.innerHTML =
      `<div class="info-row"><span>Artificial satellite</span></div>` +
      `<div class="info-row"><span>Orbiting</span><span>${focusedProbe.parent?.name || '—'}</span></div>` +
      `<div class="info-row"><span>Orbit dist</span><span>${focusedProbe.distance.toFixed(1)} u</span></div>`;
    if (infoEls.gravity) infoEls.gravity.textContent = '—';
    infoEls.peak.textContent = '—';
    infoEls.verts.textContent = '—';
    infoEls.moonsRow.style.display = 'none';
    if (infoEls.climateSection) infoEls.climateSection.style.display = 'none';
    infoEls.timeSection.style.display = 'none';
    infoEls.orbitSection.style.display = 'none';
    return;
  }
  if (!focusedBody) {
    // System view — no specific body in focus.
    infoEls.name.textContent = `${systemName} System`;
    infoEls.subtitle.textContent = `${planets.length} planet${planets.length === 1 ? '' : 's'} · ${moons.length} satellite${moons.length === 1 ? '' : 's'}`;
    infoEls.composition.innerHTML = '<div class="info-row"><span>System overview</span></div>';
    if (infoEls.gravity) infoEls.gravity.textContent = '—';
    infoEls.peak.textContent = '—';
    infoEls.verts.textContent = '—';
    infoEls.moonsRow.style.display = '';
    infoEls.moons.textContent = moons.length;
    if (infoEls.climateSection) infoEls.climateSection.style.display = 'none';
    infoEls.timeSection.style.display = 'none';
    infoEls.orbitSection.style.display = 'none';
    return;
  }
  const body = focusedBody;
  infoEls.name.textContent = body.name;
  const isPlasma = !!(body.matter && body.matter.plasma);
  const seed = body.kind === 'planet'
    ? (body.currentSeed || planetCurrentSeed)
    : (moons.find(m => m.body === body)?.seed || '');
  const kindLabel = isPlasma ? 'Star' : (body.kind === 'planet' ? 'Planet' : 'Moon');
  infoEls.subtitle.textContent = kindLabel + (seed ? ` · seed "${seed}"` : '');

  // Full-gas planets and stars don't have per-vertex biomes; their
  // composition is reported from their own model (gas band LUT / fixed
  // plasma layers). Peak/verts also swap — neither has a terrain peak.
  const isGasFull = !!(body.matter && body.matter.gas === 'full');
  let rows = [];
  let stats = null;
  if (isPlasma) {
    // Fixed photosphere layers, colored from the body's plasma uniforms.
    const pu = body.plasmaMesh && body.plasmaMesh.material.uniforms;
    const hx = c => '#' + c.getHexString();
    const layers = pu ? [
      { name: 'Photosphere',    color: hx(pu.uColorMid.value),  frac: 0.62 },
      { name: 'Granulation',    color: hx(pu.uColorLow.value),  frac: 0.24 },
      { name: 'Bright Faculae', color: hx(pu.uColorHot.value),  frac: 0.09 },
      { name: 'Cool Lanes',     color: hx(pu.uColorDeep.value), frac: 0.05 },
    ] : [];
    rows = layers.map(c =>
      `<div class="comp-row">` +
      `<span class="comp-swatch" style="background:${c.color}"></span>` +
      `<span>${c.name}</span>` +
      `<span class="comp-pct">${(c.frac * 100).toFixed(0)}%</span>` +
      `</div>`
    );
  } else if (isGasFull) {
    const comp = computeGasComposition(body);
    rows = comp.map(c =>
      `<div class="comp-row">` +
      `<span class="comp-swatch" style="background:${hexFromNumber(c.color)}"></span>` +
      `<span>${c.name}</span>` +
      `<span class="comp-pct">${(c.frac * 100).toFixed(0)}%</span>` +
      `</div>`
    );
  } else {
    stats = computeBodyStats(body);
    const order = body.kind === 'planet' ? PLANET_COMP_ORDER : MOON_COMP_ORDER;
    for (const key of order) {
      const count = stats.counts[key] || 0;
      if (count === 0) continue;
      const meta = body.kind === 'planet' && key in BAND_KEY_TO_PALETTE
        ? bandMeta(body, key)
        : COMP_DISPLAY[key];
      rows.push(
        `<div class="comp-row">` +
        `<span class="comp-swatch" style="background:${meta.color}"></span>` +
        `<span>${meta.label}</span>` +
        `<span class="comp-pct">${fmtPct(count, stats.N)}</span>` +
        `</div>`
      );
    }
  }
  infoEls.composition.innerHTML = rows.join('') || '<div class="info-row"><span>—</span></div>';

  if (isGasFull || isPlasma) {
    infoEls.peak.textContent = '—';
    infoEls.verts.textContent = body.N.toLocaleString();
  } else {
    const worldPeak = peakWorldHeight(body, stats.peak);
    const pctOfRadius = stats.peak * BODY_HEIGHT_SCALE * 100;
    infoEls.peak.textContent = `${worldPeak.toFixed(2)} u (${pctOfRadius.toFixed(1)}%)`;
    infoEls.verts.textContent = stats.N.toLocaleString();
  }

  // Surface gravity — meaningful for any planet or moon (stars handled by
  // the probe/plasma readouts elsewhere). Suffix a quick qualitative read.
  if (infoEls.gravity) {
    if (isPlasma) {
      infoEls.gravity.textContent = '—';
    } else {
      const g = surfaceGravityG(body);
      const note = g < 0.5 ? 'low' : (g <= 1.2 ? 'Earth-like' : 'high');
      infoEls.gravity.textContent = `${g.toFixed(2)} g (${note})`;
    }
  }

  renderClimateSection(body);

  const isPlanet = body.kind === 'planet';
  infoEls.moonsRow.style.display = isPlanet ? '' : 'none';
  if (isPlanet) infoEls.moons.textContent = moons.length;
  infoEls.timeSection.style.display = isPlanet ? '' : 'none';
  infoEls.orbitSection.style.display = isPlanet ? 'none' : '';

  updateLiveInfo();
}

export function updateLiveInfo() {
  if (!infoEls.dayPeriod) return; // info panel removed from HTML
  if (focusedProbe) return; // probe panel has no live day/orbit readouts
  if (!focusedBody) return;
  const body = focusedBody;
  if (body.kind === 'planet') {
    const w = body.rotationSpeed ?? DEFAULT_SPIN;
    const period = w > 1e-6 ? (Math.PI * 2 / w) : Infinity;
    infoEls.dayPeriod.textContent = fmtSeconds(period);
    const twoPi = Math.PI * 2;
    const phase = ((body.group.rotation.y % twoPi) + twoPi) % twoPi / twoPi;
    const hh = Math.floor(phase * 24);
    const mm = Math.floor((phase * 24 - hh) * 60);
    infoEls.dayTime.textContent = `${hh.toString().padStart(2, '0')}:${mm.toString().padStart(2, '0')}`;
  } else {
    const m = moons.find(mn => mn.body === body);
    if (!m) return;
    const speed = m.speed ?? DEFAULT_MOON_SPEED;
    const omega = speed * Math.pow(MOON_REF_DISTANCE / m.distance, 1.5);
    const period = omega > 1e-6 ? (Math.PI * 2 / omega) : Infinity;
    infoEls.orbitDist.textContent = m.distance.toFixed(1) + ' u';
    infoEls.orbitOmega.textContent = omega.toFixed(3) + ' rad/s';
    infoEls.orbitPeriod.textContent = fmtSeconds(period);
    infoEls.moonSize.textContent = (m.size * 2 * body.baseRadius).toFixed(2) + ' u';
  }
}

