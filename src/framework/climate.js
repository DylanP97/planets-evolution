import * as THREE from 'three';
import {
  KELVIN_ZERO_C, COL, SEA_ICE_COLOR, SEA_STEAM_COLOR, SEA_VAPOR_C, SEA_BOIL_C,
  SEA_ICE_NOISE_C, SEA_ICE_C, SEA_THAW_C, SEA_ICE_GLOW, BASE_RADIUS
} from '../core/constants.js';
import { planets, moons } from './state.js';
import { smoothstep } from '../core/utils.js';

export const TEMP_REF_DISTANCE   = 270;
export const TEMP_REF_KELVIN     = 255;
export const HEAT_REDISTRIBUTION = 0.82;

export const ARCHETYPE_CLIMATE = {
  terrestrial: { base:   0, greenhouse:  60, airSpread: 120 },
  ocean:       { base:   4, greenhouse:  55, airSpread:  90 },
  gas_giant:   { base:  20, greenhouse:  40, airSpread:  60 },
  ice_giant:   { base:  -5, greenhouse:  30, airSpread:  55 },
  desert:      { base:   8, greenhouse:  20, airSpread: 130 },
  lava:        { override: 1100, airSpread: 60 },
  ice_planet:  { base: -30, greenhouse:  20, airSpread: 120 },
  jungle:      { base:   0, greenhouse:  50, airSpread:  60 },
  swamp:       { base:   0, greenhouse:  45, airSpread:  70 },
  toxic:       { base:   5, greenhouse:  90, airSpread:  90 },
  venusian:    { base:   0, greenhouse: 430, airSpread:  60 },
  metal:       { base:   0, greenhouse:   0, airSpread: 150 },
  carbon:      { base:  10, greenhouse:  30, airSpread: 110 },
  moon_like:   { base:   0, greenhouse:   0, airSpread: 150 },
  storm:       { base:   5, greenhouse:  40, airSpread:  90 },
  living:      { base:   5, greenhouse:  35, airSpread:  75 },
  rogue:       { override:   35, airSpread:  10 },
  star:        { override: 5800, airSpread:   0 },
};

export const DEFAULT_CLIMATE = { base: 0, greenhouse: 0, airSpread: 130 };

export function sunDistanceOf(body) {
  const p = planets.find(pl => pl.body === body);
  if (p) return p.orbit.distance;
  const m = moons.find(mn => mn.body === body);
  if (m) {
    const pp = planets.find(pl => pl.body === m.parent);
    if (pp) return pp.orbit.distance;
  }
  return TEMP_REF_DISTANCE;
}

export function atmosphereFactor(body) {
  const m = body.matter;
  if (!m || !m.gas) return 0;
  if (m.gas === 'full') return 1;
  const density   = Math.max(0, Math.min(1, body.gasDensity ?? 0.3));
  const thickness = Math.max(0, (body.gasThickness ?? 1.1) - 1.0);
  return Math.max(0, Math.min(1, density * 0.8 + thickness * 2.0));
}

export function computeClimate(body) {
  const arch = body.archetype || (body.kind === 'moon' ? 'moon_like' : 'terrestrial');
  const cfg = ARCHETYPE_CLIMATE[arch] || DEFAULT_CLIMATE;
  const dist = Math.max(1, sunDistanceOf(body));
  const equilibrium = TEMP_REF_KELVIN * Math.sqrt(TEMP_REF_DISTANCE / dist);
  const atmo = atmosphereFactor(body);
  const meanK = cfg.override != null
    ? cfg.override
    : equilibrium + (cfg.base || 0) + (cfg.greenhouse || 0) * atmo;
  const spread = (cfg.airSpread || 0) * (1 - HEAT_REDISTRIBUTION * atmo);
  const climate = {
    distance: dist,
    equilibriumK: equilibrium,
    atmosphere: atmo,
    meanK,
    equatorK: meanK + spread * 0.35,
    poleK:    meanK - spread * 0.65,
    spread,
  };
  body.climate = climate;
  return climate;
}

export function temperatureAtLatitude(body, latRad) {
  const c = body.climate || computeClimate(body);
  const warmth = Math.max(0, Math.cos(latRad)) ** 1.6;
  return c.poleK + (c.equatorK - c.poleK) * warmth;
}

export function fmtTemp(k) {
  const c = k - KELVIN_ZERO_C;
  if (Math.abs(c) >= 1000) return (c / 1000).toFixed(1) + 'k°C';
  return Math.round(c) + '°C';
}

export function colorOceanByClimate(body) {
  const om = body.oceanMesh;
  if (!om || !body.matter || !body.matter.liquid) return;
  const geo = om.geometry;
  const pos = geo.attributes.position;
  const colA = geo.attributes.color, glowA = geo.attributes.aGlow, evapA = geo.attributes.aEvap;
  const n = pos.count;
  const base = new THREE.Color(body.oceanBaseColor || COL.water);
  const clim = body.climate;
  const zoned = body.oceanIsWater && clim && clim.spread > 0.5;
  if (!zoned) {
    for (let i = 0; i < n; i++) {
      colA.setXYZ(i, base.r, base.g, base.b);
      glowA.setX(i, 0); evapA.setX(i, 0);
    }
  } else {
    const ice = new THREE.Color(SEA_ICE_COLOR);
    const steam = new THREE.Color(SEA_STEAM_COLOR);
    for (let i = 0; i < n; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const inv = 1 / Math.hypot(x, y, z);
      const ux = x * inv, uy = y * inv, uz = z * inv;
      const warmth = Math.pow(Math.sqrt(Math.max(0, 1 - uy * uy)), 1.6);
      const tC = (clim.poleK + (clim.equatorK - clim.poleK) * warmth) - KELVIN_ZERO_C;
      let glow = 0, evap = 0, c;
      if (tC >= SEA_VAPOR_C) {
        c = steam; evap = 1;
      } else if (tC >= SEA_BOIL_C) {
        c = base.clone().lerp(steam, smoothstep(SEA_BOIL_C, SEA_VAPOR_C, tC));
      } else {
        const wob = 0.6 * Math.sin(ux * 7 + uy * 3) * Math.cos(uz * 5 - uy * 4)
                  + 0.3 * Math.sin(uz * 11 + ux * 6) * Math.cos(uy * 9 + ux * 2)
                  + 0.15 * Math.sin(ux * 17 - uz * 14);
        const tIce = tC + wob * SEA_ICE_NOISE_C;
        if (tIce <= SEA_ICE_C) {
          c = ice; glow = SEA_ICE_GLOW;
        } else if (tIce < SEA_THAW_C) {
          const t = (SEA_THAW_C - tIce) / (SEA_THAW_C - SEA_ICE_C);
          c = base.clone().lerp(ice, t); glow = SEA_ICE_GLOW * t;
        } else {
          c = base;
        }
      }
      colA.setXYZ(i, c.r, c.g, c.b);
      glowA.setX(i, glow); evapA.setX(i, evap);
    }
  }
  colA.needsUpdate = true; glowA.needsUpdate = true; evapA.needsUpdate = true;
}

// Map a temperature to a HUD color: frozen blue → temperate green → amber →
// scorching red → white-hot. Drives the climate swatch so the panel reads at
// a glance. Stops are in °C.
const TEMP_COLOR_STOPS = [
  [-150, [120, 170, 255]],
  [ -30, [ 90, 200, 230]],
  [  12, [ 80, 210, 120]],
  [  45, [240, 200,  70]],
  [ 150, [240,  90,  50]],
  [ 600, [255, 240, 220]],
];
export function tempColor(k) {
  const c = k - KELVIN_ZERO_C;
  const s = TEMP_COLOR_STOPS;
  if (c <= s[0][0]) return `rgb(${s[0][1].join(',')})`;
  if (c >= s[s.length - 1][0]) return `rgb(${s[s.length - 1][1].join(',')})`;
  for (let i = 0; i < s.length - 1; i++) {
    const [t0, c0] = s[i], [t1, c1] = s[i + 1];
    if (c >= t0 && c <= t1) {
      const f = (c - t0) / (t1 - t0);
      const r = Math.round(c0[0] + (c1[0] - c0[0]) * f);
      const g = Math.round(c0[1] + (c1[1] - c0[1]) * f);
      const b = Math.round(c0[2] + (c1[2] - c0[2]) * f);
      return `rgb(${r},${g},${b})`;
    }
  }
  return `rgb(${s[0][1].join(',')})`;
}

// ====== Surface gravity model ======
// A toy gravity model in the same not-to-scale spirit as the climate model.
// Surface gravity scales as g = (4/3)·πG·ρ·R — i.e. density × radius. We
// don't track mass, so we read the body's *rendered* radius and pair it with
// a per-archetype relative density, then anchor a reference Earth-size
// terrestrial world at 1 g. The radius term is softened (^0.6) so small
// moons stay playfully floaty without collapsing to near-zero, and giants
// don't blow far past a few g. Drives both the telemetry readout and the
// surface-walk feel (jump arc height + walk pace).
const GRAVITY_REF_RADIUS = BASE_RADIUS * 0.27;  // Earth's rendered radius (spec size 0.27)
const ARCHETYPE_DENSITY = {
  terrestrial: 1.00, ocean: 0.95, desert: 0.95, lava: 1.10, ice_planet: 0.55,
  ice_giant: 0.30, gas_giant: 0.22, jungle: 0.95, swamp: 0.90, toxic: 1.00,
  venusian: 0.95, metal: 2.00, carbon: 1.30, moon_like: 0.85, storm: 0.55,
  living: 0.90, rogue: 0.90,
};
// Relative surface gravity (Earth = 1 g) for any planet or moon.
export function surfaceGravityG(body) {
  const arch = body.archetype || (body.kind === 'moon' ? 'moon_like' : 'terrestrial');
  const density = ARCHETYPE_DENSITY[arch] ?? 1.0;
  const worldRadius = body.baseRadius * (body.group ? body.group.scale.x : 1);
  const g = density * Math.pow(worldRadius / GRAVITY_REF_RADIUS, 0.6);
  return Math.max(0.05, Math.min(3.5, g));
}
