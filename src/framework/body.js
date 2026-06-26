// The body factory and everything that paints/reshapes a body: per-vertex
// terrain writes, height/biome/climate coloring (incl. the venusian branch),
// matter/gas/ring appliers, regeneration, the sculpt brush, ocean shore bake.
import * as THREE from 'three';
import { 
  BODY_HEIGHT_SCALE, MAX_LAND_HEIGHT, MIN_LAND_HEIGHT, 
  SAND_TOP, GRASS_FLOOR, GRASS_TOP, ROCK_TOP, SNOW_FADE,
  KELVIN_ZERO_C, CLIMATE_LAPSE_C, SEA_LEVEL, SEABED_COLOR,
  SEA_BOIL_C, SEA_VAPOR_C, SEA_ICE_C, COL, BIOME, BIOME_LABELS,
  COMP_DISPLAY, ARCHETYPE_BAND_LABELS, BAND_KEY_TO_PALETTE,
  BAND_BIOME_KEY, BAND_BIOME_SLOT,
  OCEAN_DEPTH_BOOST, TERRAIN_OCTAVES
} from '../core/constants.js';
import { RING_INNER_FACTOR, RING_OUTER_FACTOR } from '../shaders/ring.js';
import { PLANET_PALETTE, MOON_PALETTE } from '../core/palettes.js';
import { smoothstep } from '../core/utils.js';
import { 
  makeGasMaterial, ensureGasPaint, updateGasFeatureUniforms, 
  randomizeGasBands, applyGasPaintBrush, growGasVortex,
  DEFAULT_BAND_TEX
} from '../shaders/gas.js';
import { makePlasmaMaterial } from '../shaders/plasma.js';
import { makeRingMaterial } from '../shaders/ring.js';
import { setupBodyMaterial, setupOceanMaterial } from './materials.js';
import { 
  currentTool, brushRadius, brushStrength, brushRaise, 
  selectedBiome, activeVortex, gasPaintColor, selectedGasBiomeId,
  currentArchetype, climateReady
} from './state.js';
import { colorOceanByClimate, computeClimate } from './climate.js';
import { buildTerrainBasis, hashSeed, sampleTerrainNoise } from './terrain.js';
import { ARCHETYPES, ARCHETYPE_MATTER } from './archetypes.js';

export function createBody({ kind, name, baseRadius, detail, palette, hasOcean, initialHeight = -0.5 }) {
  const geo = new THREE.IcosahedronGeometry(baseRadius, detail);
  const posAttr = geo.attributes.position;
  const N = posAttr.count;
  const unitDirs = new Float32Array(N * 3);
  const heights  = new Float32Array(N);
  const biomes   = new Uint8Array(N);
  
  for (let i = 0; i < N; i++) {
    const x = posAttr.array[3 * i];
    const y = posAttr.array[3 * i + 1];
    const z = posAttr.array[3 * i + 2];
    const inv = 1 / Math.hypot(x, y, z);
    unitDirs[3 * i]     = x * inv;
    unitDirs[3 * i + 1] = y * inv;
    unitDirs[3 * i + 2] = z * inv;
    heights[i] = initialHeight;
  }
  
  const colorArr = new Float32Array(N * 3);
  geo.setAttribute('color', new THREE.BufferAttribute(colorArr, 3));

  const glowArr = new Float32Array(N);
  geo.setAttribute('aGlow', new THREE.BufferAttribute(glowArr, 1));

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.92,
    metalness: 0.0,
    flatShading: false,
  });
  
  setupBodyMaterial(mat);
  
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  const group = new THREE.Group();
  group.add(mesh);

  const oceanGeo = new THREE.SphereGeometry(baseRadius, 160, 96);
  const oceanVerts = oceanGeo.attributes.position.count;
  oceanGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(oceanVerts * 3).fill(1), 3));
  oceanGeo.setAttribute('aGlow', new THREE.BufferAttribute(new Float32Array(oceanVerts), 1));
  oceanGeo.setAttribute('aEvap', new THREE.BufferAttribute(new Float32Array(oceanVerts), 1));
  oceanGeo.setAttribute('aShore', new THREE.BufferAttribute(new Float32Array(oceanVerts), 1));
  
  const oceanMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.18,
    metalness: 0.05,
    transparent: true,
    opacity: 1.0,
    side: THREE.DoubleSide,
  });
  
  setupOceanMaterial(oceanMat, baseRadius);
  
  const oceanMesh = new THREE.Mesh(oceanGeo, oceanMat);
  oceanMesh.receiveShadow = true;
  oceanMesh.visible = !!hasOcean;
  group.add(oceanMesh);

  const gasMesh = new THREE.Mesh(
    new THREE.SphereGeometry(baseRadius, 64, 48),
    makeGasMaterial()
  );
  gasMesh.visible = false;
  gasMesh.renderOrder = 1;
  group.add(gasMesh);

  const plasmaMesh = new THREE.Mesh(
    new THREE.SphereGeometry(baseRadius, 96, 64),
    makePlasmaMaterial()
  );
  plasmaMesh.visible = false;
  plasmaMesh.castShadow = false;
  plasmaMesh.receiveShadow = false;
  group.add(plasmaMesh);

  const ringInner = baseRadius * RING_INNER_FACTOR;
  const ringOuter = baseRadius * RING_OUTER_FACTOR;
  const ringMesh = new THREE.Mesh(
    new THREE.RingGeometry(ringInner, ringOuter, 192, 4),
    makeRingMaterial()
  );
  ringMesh.rotation.x = -Math.PI / 2;
  ringMesh.material.uniforms.uInner.value = ringInner;
  ringMesh.material.uniforms.uOuter.value = ringOuter;
  ringMesh.material.uniforms.uBodyRadius.value = baseRadius;
  ringMesh.visible = false;
  ringMesh.renderOrder = 2;
  group.add(ringMesh);

  const body = {
    kind, name, baseRadius, detail,
    palette: palette || (kind === 'planet' ? PLANET_PALETTE : MOON_PALETTE),
    group, mesh, geo, posAttr, N, unitDirs, heights, biomes, colorArr, glowArr,
    oceanMesh, gasMesh, plasmaMesh, ringMesh,
    matter: { solid: true, liquid: !!hasOcean, gas: false, plasma: false },
    gasMode: 'none',
    gasThickness: 1.10,
    gasDensity: 0.18,
    gasCoverage: 0.35,
    gasPaint: null,
    rings: { enabled: false, intensity: 0.65 },
  };

  for (let i = 0; i < N; i++) {
    writeBodyVertex(body, i);
    colorBodyVertex(body, i);
  }
  commitBodyChanges(body);
  return body;
}

export function writeBodyVertex(body, i) {
  const r = body.baseRadius * (1 + body.heights[i] * BODY_HEIGHT_SCALE);
  body.posAttr.array[3 * i]     = body.unitDirs[3 * i]     * r;
  body.posAttr.array[3 * i + 1] = body.unitDirs[3 * i + 1] * r;
  body.posAttr.array[3 * i + 2] = body.unitDirs[3 * i + 2] * r;
}

// Surface temperature (°C) at vertex i: the body's climate gives a pole→
// equator gradient (cos(lat)^1.6, latitude = asin(unitDir.y)), then elevation
// cools it via the lapse rate so peaks run colder than lowlands at the same
// latitude. Assumes body.climate is set (callers gate on it).
export function vertexTempC(body, i) {
  const clim = body.climate;
  const uy = body.unitDirs[3 * i + 1];
  const cosLat = Math.sqrt(Math.max(0, 1 - uy * uy));
  const warmth = Math.pow(cosLat, 1.6);
  const tK = clim.poleK + (clim.equatorK - clim.poleK) * warmth;
  return (tK - KELVIN_ZERO_C) - Math.max(0, body.heights[i]) * CLIMATE_LAPSE_C;
}

export function pickLandZone(zones, tempC) {
  for (const z of zones) if (tempC >= z.minTempC) return z;
  return zones[zones.length - 1];
}

const VENUS_SLAB_A   = new THREE.Color(0x232120);
const VENUS_SLAB_B   = new THREE.Color(0x2e2a26);
const VENUS_REGOLITH = new THREE.Color(0x332c24);
const VENUS_SOIL     = new THREE.Color(0x3e352c);
const VENUS_GRAVEL   = new THREE.Color(0x4c453d);
const VENUS_GRIT     = new THREE.Color(0x5b5349);
const VENUS_TESSERA  = new THREE.Color(0x7e766b);
const _venusCol      = new THREE.Color();

export function venusianLandColor(body, i, h) {
  const ux = body.unitDirs[3 * i], uy = body.unitDirs[3 * i + 1], uz = body.unitDirs[3 * i + 2];
  const t = (Math.sin(ux * 37.0) + Math.sin(uy * 41.3 + 1.7) + Math.sin(uz * 43.7 + 3.1)) / 3;
  const plate = Math.floor((t * 0.5 + 0.5) * 3.999) / 3;
  const grit  = (((i * 1103515245 + 12345) >>> 8) % 1000) / 999;
  const c = _venusCol;
  if (h < SAND_TOP) {
    c.copy(VENUS_SLAB_A).lerp(VENUS_SLAB_B, plate);
    if (grit > 0.93) c.lerp(VENUS_GRAVEL, 0.35);
  } else if (h < GRASS_TOP) {
    c.copy(VENUS_REGOLITH).lerp(VENUS_SOIL, smoothstep(SAND_TOP, GRASS_TOP, h));
    c.lerp(VENUS_SLAB_B, plate * 0.25);
    if (grit > 0.85) c.lerp(VENUS_GRAVEL, 0.45);
  } else if (h < ROCK_TOP) {
    c.copy(VENUS_GRAVEL).lerp(VENUS_GRIT, smoothstep(GRASS_TOP, ROCK_TOP, h));
    if (grit > 0.7) c.lerp(VENUS_SOIL, 0.5);
  } else {
    c.copy(VENUS_GRIT).lerp(VENUS_TESSERA, smoothstep(ROCK_TOP, ROCK_TOP + SNOW_FADE, h));
  }
  return c;
}

export const CLIMATE_LAND_ZONES = {
  terrestrial: [
    { key: 'desert', label: 'Desert', color: 0xd2b48c, minTempC:  40, beach: true, relief: true },
    { key: 'jungle', label: 'Jungle', color: 0x15702a, minTempC:  22, beach: true, relief: true },
    { key: 'grass',  label: 'Grass',  color: 0x4FAE4F, minTempC:   7, beach: true, relief: true },
    { key: 'tundra', label: 'Tundra', color: 0x8f9e76, minTempC:  -8 },
    { key: 'ice',    label: 'Ice',    color: 0xdaf2ff, minTempC: -Infinity, glow: 0.55 },
  ],
};

// ── Canonical surface-biome classifier ─────────────────────────────────────
// FACE_BIOME + groundBiomeOfFace are the SINGLE source of truth for "what biome
// is this terrain face". The whole surface-detail layer keys off it (grass
// variants in grass.js, which GLB props scatter where in props.js), the minimap
// names the ground from it, and the orbit-mode hover tooltip does too — so all
// of them always agree. It lives here in the framework layer (not in a surface
// module) precisely so lower-layer consumers like interaction/ can import it
// without an import cycle.
//
// Rules: hand-painted biomes win outright (explicit intent, on any archetype);
// an unpainted face only carries a natural biome on terrestrial worlds, read
// from beach/peak height bands + the climate zone. Moons and other archetypes'
// unpainted ground return BARE. (Below-sea-level water is named by
// biomeNameOfFace, which layers ocean depth on top of this.)
export const FACE_BIOME = {
  BARE: 0, GRASS: 1, FOREST: 2, JUNGLE: 3, TUNDRA: 4, ICE: 5, COAST: 6, DESERT: 7,
};

export function groundBiomeOfFace(body, f) {
  if (body.kind !== 'planet') return FACE_BIOME.BARE;
  switch (body.biomes[f.a]) {
    case BIOME.FOREST:    return FACE_BIOME.FOREST;
    case BIOME.GRASSLAND: return FACE_BIOME.GRASS;
    case BIOME.JUNGLE:    return FACE_BIOME.JUNGLE;
    case BIOME.TUNDRA:    return FACE_BIOME.TUNDRA;
    case BIOME.ICE:       return FACE_BIOME.ICE;
    case BIOME.COAST:     return FACE_BIOME.COAST;
    case BIOME.DESERT:    return FACE_BIOME.DESERT;
    case BIOME.BAND_GRASS: return FACE_BIOME.GRASS;           // grass band grows grass/props
    case BIOME.BAND_SAND:  return FACE_BIOME.COAST;           // sand band reads as sandy coast
    case BIOME.AUTO:      break;                              // natural ground: classify below
    default:              return FACE_BIOME.BARE;             // exotic painted biomes grow nothing
  }
  if (body.archetype !== 'terrestrial') return FACE_BIOME.BARE;
  const h = (body.heights[f.a] + body.heights[f.b] + body.heights[f.c]) / 3;
  if (h >= ROCK_TOP)     return FACE_BIOME.BARE;              // rock / snow peaks
  if (h < GRASS_FLOOR)   return FACE_BIOME.COAST;             // sandy beach near the sea
  const zoned = body.climate && body.climate.spread > 0.5 && CLIMATE_LAND_ZONES[body.archetype];
  if (zoned) {
    switch (pickLandZone(CLIMATE_LAND_ZONES[body.archetype], vertexTempC(body, f.a)).key) {
      case 'jungle': return FACE_BIOME.JUNGLE;
      case 'grass':  return FACE_BIOME.GRASS;
      case 'tundra': return FACE_BIOME.TUNDRA;
      case 'ice':    return FACE_BIOME.ICE;
      case 'desert': return FACE_BIOME.DESERT;
      default:       return FACE_BIOME.BARE;
    }
  }
  return h < GRASS_TOP ? FACE_BIOME.GRASS : FACE_BIOME.BARE;  // unzoned plain grass band
}

export function colorBodyVertex(body, i) {
  const h = body.heights[i];
  const b = body.biomes[i];
  const p = body.palette;
  let c;
  if (body.glowArr) body.glowArr[i] = 0;

  // Generic "natural band" paints reproduce an auto terrain band from the body's
  // own palette slot, so they match whatever the archetype's natural ground looks
  // like (Rock→basalt on lava, rock-brown on Earth, …). Handled before the
  // fixed-color biomes below.
  const bandSlot = BAND_BIOME_SLOT[b];
  if (bandSlot !== undefined) {
    c = new THREE.Color((p && p[bandSlot]) ?? COL.rock);
    body.colorArr[3 * i]     = c.r;
    body.colorArr[3 * i + 1] = c.g;
    body.colorArr[3 * i + 2] = c.b;
    return;
  }

  if (b === BIOME.FOREST) {
    c = new THREE.Color(COL.forest);
    const mix = smoothstep(GRASS_TOP, ROCK_TOP, h);
    c.lerp(new THREE.Color(COL.grassDark), mix * 0.3);
  } else if (b === BIOME.GRASSLAND) {
    c = new THREE.Color(COL.grass);
    const mix = smoothstep(GRASS_TOP, ROCK_TOP, h);   // greens grade toward rock on slopes
    c.lerp(new THREE.Color(p.rock), mix * 0.5);
  } else if (b === BIOME.DESERT) {
    c = new THREE.Color(COL.desert);
    const mix = smoothstep(SEA_LEVEL, SAND_TOP, h);
    c.lerp(new THREE.Color(COL.sand), mix * 0.2);
  } else if (b === BIOME.TUNDRA) {
    c = new THREE.Color(COL.snow);
    c.lerp(new THREE.Color(COL.shore), 0.1);
  } else if (b === BIOME.JUNGLE) {
    c = new THREE.Color(0x15702a);                    // deep tropical green
    const mix = smoothstep(GRASS_TOP, ROCK_TOP, h);   // grade toward rock on slopes
    c.lerp(new THREE.Color(p.rock), mix * 0.5);
  } else if (b === BIOME.ICE) {
    c = new THREE.Color(0xdaf2ff);                     // pale glacial blue
    if (body.glowArr) body.glowArr[i] = 0.55;
  } else if (b === BIOME.COAST) {
    c = new THREE.Color(COL.sand);                     // sandy beach
    const wet = smoothstep(SAND_TOP, SEA_LEVEL, h);   // damp/darker toward the waterline
    c.lerp(new THREE.Color(COL.shore), wet * 0.5);
  } else if (b === 5) { // Obsidian
    c = new THREE.Color(0x1a1a1a);
  } else if (b === 6) { // Magma Flow
    c = new THREE.Color(0xff4500);
    if ((i * 7) % 10 > 5) c.lerp(new THREE.Color(0xff8c00), 0.5);
  } else if (b === 7) { // Circuitry
    c = new THREE.Color(0x00f2ff);
    if ((i * 13) % 10 > 3) c = new THREE.Color(0x0a0a0a);
  } else if (b === 8) { // Plating
    c = new THREE.Color(0x444444);
    if ((i * 3) % 10 > 7) c = new THREE.Color(0x666666);
  } else if (b === 11) { // Coral Reef
    c = new THREE.Color(0xff7f50);
    if ((i * 3) % 10 > 5) c = new THREE.Color(0xff69b4);
  } else if (b === 12) { // Kelp Forest
    c = new THREE.Color(0x2e8b57);
  } else if (b === 13) { // Abyssal Trench
    c = new THREE.Color(0x000033);
  } else if (b === 14) { // Sulfur Vent
    c = new THREE.Color(0xffff00);
  } else if (b === 15) { // Oasis
    c = new THREE.Color(0x228b22);
  } else if (b === 17) { // Red Sand
    c = new THREE.Color(0x8b0000);
  } else if (b === 18) { // Glacier
    c = new THREE.Color(0xe0ffff);
  } else if (b === 19) { // Cryo-Volcano
    c = new THREE.Color(0xadd8e6);
    if ((i * 5) % 10 > 8) c = new THREE.Color(0xffffff);
  } else if (b === 21) { // Exotic Bloom
    c = new THREE.Color(0xff00ff);
  } else if (b === 24) { // Data Hub
    c = new THREE.Color(0x00f2ff);
  } else if (b === 26) { // Rust
    c = new THREE.Color(0x8b4513);
  } else if (b === 27) { // Gold
    c = new THREE.Color(0xffd700);
  } else if (b === 29) { // Neural
    c = new THREE.Color(0xff69b4);
    if ((i * 2) % 10 > 8) c = new THREE.Color(0xffffff);
  } else if (b === 32) { // Lightning
    c = new THREE.Color(0xffffff);
    if ((i * 17) % 10 > 2) c = new THREE.Color(0x4b0082);
  } else if (b === BIOME.MARE) {
    c = new THREE.Color(0x2a2a30);
    if ((i * 7) % 10 > 8) c = new THREE.Color(0x3a3a42);
  } else if (b === BIOME.REGOLITH) {
    c = new THREE.Color(0xc4b8a0);
    if ((i * 3) % 10 > 6) c = new THREE.Color(0xd6cdb6);
  } else if (b === BIOME.FROST) {
    c = new THREE.Color(0xd8e8f0);
    if ((i * 5) % 10 > 7) c = new THREE.Color(0xffffff);
  } else if (body.kind === 'planet') {
    const zoned = body.climate && body.climate.spread > 0.5;
    const zones = zoned ? CLIMATE_LAND_ZONES[body.archetype] : null;
    if (h < SEA_LEVEL) {
      if (h < -0.4) c = new THREE.Color(p.deep);
      else {
        const t = (h + 0.4) / (SEA_LEVEL + 0.4);
        c = new THREE.Color(p.deep).lerp(new THREE.Color(p.shore), t);
      }
      if (zoned && body.oceanIsWater) {
        const dry = smoothstep(SEA_BOIL_C, SEA_VAPOR_C, vertexTempC(body, i));
        if (dry > 0) c.lerp(new THREE.Color(SEABED_COLOR), dry);
      }
    } else if (zones) {
      const z = pickLandZone(zones, vertexTempC(body, i));
      if (h >= ROCK_TOP) {
        const t = smoothstep(ROCK_TOP, ROCK_TOP + SNOW_FADE, h);
        c = new THREE.Color(p.rock).lerp(new THREE.Color(p.snow), t);
      } else if (z.beach && h < SAND_TOP) {
        const t = smoothstep(SEA_LEVEL, SAND_TOP, h);
        c = new THREE.Color(p.sand).lerp(new THREE.Color(z.color), t);
      } else {
        c = new THREE.Color(z.color);
        if (z.relief && h >= GRASS_TOP) {
          const t = smoothstep(GRASS_TOP, ROCK_TOP, h);
          c.lerp(new THREE.Color(p.rock), t * 0.6);
        }
        if (z.glow && body.glowArr) body.glowArr[i] = z.glow;
      }
    } else if (body.archetype === 'venusian') {
      c = new THREE.Color().copy(venusianLandColor(body, i, h));
    } else if (h < SAND_TOP) c = new THREE.Color(p.sand);
    else if (h < GRASS_TOP) {
      const t = smoothstep(SAND_TOP, SAND_TOP + 0.15, h);
      c = new THREE.Color(p.sand).lerp(new THREE.Color(p.grass), t);
    } else if (h < ROCK_TOP) {
      const t = smoothstep(GRASS_TOP, GRASS_TOP + 0.4, h);
      c = new THREE.Color(p.grass).lerp(new THREE.Color(p.rock), t);
    } else {
      const t = smoothstep(ROCK_TOP, ROCK_TOP + SNOW_FADE, h);
      c = new THREE.Color(p.rock).lerp(new THREE.Color(p.snow), t);
    }
  } else {
    if (h < -0.6) c = new THREE.Color(p.crater);
    else if (h < 0) {
      const t = (h + 0.6) / 0.6;
      c = new THREE.Color(p.crater).lerp(new THREE.Color(p.dust), t);
    } else if (h < GRASS_TOP) {
      const t = smoothstep(0, GRASS_TOP, h);
      c = new THREE.Color(p.dust).lerp(new THREE.Color(p.rock), t);
    } else {
      const t = smoothstep(ROCK_TOP, ROCK_TOP + SNOW_FADE, h);
      c = new THREE.Color(p.rock).lerp(new THREE.Color(p.highlight), t);
    }
  }
  body.colorArr[3 * i]     = c.r;
  body.colorArr[3 * i + 1] = c.g;
  body.colorArr[3 * i + 2] = c.b;
}

// ── Composition classifier (the single source of truth for terrain naming) ──
// compKeyAt returns the composition KEY for vertex `i` — exactly the bucket the
// info-panel composition rollup tallies, mirroring colorBodyVertex: painted
// biomes first, then below-sea-level water (incl. frozen sea-ice / boiled-dry
// seabed on water oceans), snow peaks, the climate latitude zone (or, unzoned,
// plain elevation bands), and the moon crater→highland gradient. The panel, the
// surface minimap and the orbit hover tooltip all name ground through this, so
// they can never disagree.
// Painted biomes whose composition folds into a natural elevation/climate band
// (so e.g. hand-painted Forest tallies with the natural forest band). Every
// OTHER painted biome — Oasis, Obsidian, Coral Reef, … — has no
// natural-band equivalent, so compKeyAt buckets it under its own 'biome:<code>'
// key, which the info panel names from BIOME_LABELS and swatches from
// BIOME_SWATCH. Without this, painting those biomes left the rollup unchanged.
const PAINT_TO_BAND = {
  [BIOME.FOREST]:    'forest',
  [BIOME.GRASSLAND]: 'grass',
  [BIOME.DESERT]:    'desert',
  [BIOME.TUNDRA]:    'tundra',
  [BIOME.JUNGLE]:    'jungle',
  [BIOME.ICE]:       'ice',
  [BIOME.COAST]:     'sand',
  [BIOME.MARE]:      'mare',
  [BIOME.REGOLITH]:  'regolith',
  [BIOME.FROST]:     'frost',
  // Generic band paints fold into the natural band they reproduce.
  ...BAND_BIOME_KEY,
};

export function compKeyAt(body, i) {
  const b = body.biomes ? body.biomes[i] : 0;
  if (b !== BIOME.AUTO) return PAINT_TO_BAND[b] || ('biome:' + b);

  const h = body.heights[i];
  if (body.kind === 'planet') {
    const climateZoned = body.climate && body.climate.spread > 0.5;
    const zones = climateZoned ? CLIMATE_LAND_ZONES[body.archetype] : null;
    const seaWater = climateZoned && body.matter && body.matter.liquid && body.oceanIsWater;
    if (h < SEA_LEVEL) {
      if (seaWater) {
        const tC = vertexTempC(body, i);
        return tC >= SEA_VAPOR_C ? 'seabed' : (tC <= SEA_ICE_C ? 'seaice' : 'water');
      }
      return 'water';
    }
    if (h >= ROCK_TOP) return 'snow';
    if (zones) {
      const z = pickLandZone(zones, vertexTempC(body, i));
      return (z.beach && h < SAND_TOP) ? 'sand' : z.key;   // warm zones show a sandy shore
    }
    if (h < SAND_TOP)  return 'sand';
    if (h < GRASS_TOP) return 'grass';
    return 'rock';
  }
  if (h < 0)         return 'crater';
  if (h < GRASS_TOP) return 'dust';
  if (h < ROCK_TOP)  return 'rock';
  return 'highlight';
}

// Display label for a composition key on `body` — identical to what the info
// panel shows: the five elevation bands are renamed per archetype (Ocean/Coast
// /Grass… on Earth, Magma/Cinder/Lava Plain… on a lava world), everything else
// uses its fixed COMP_DISPLAY name (Sea Ice, Ice, Tundra, Jungle, Crater, …).
export function bandLabel(body, key) {
  if (body.kind === 'planet' && BAND_KEY_TO_PALETTE[key]) {
    const labels = ARCHETYPE_BAND_LABELS[body.archetype] || ARCHETYPE_BAND_LABELS.terrestrial;
    return labels[key] || (COMP_DISPLAY[key] && COMP_DISPLAY[key].label) || key;
  }
  return (COMP_DISPLAY[key] && COMP_DISPLAY[key].label) || key;
}

// Human-readable biome name for terrain face `f` — the single labelling path
// shared by the surface minimap and the orbit-mode hover tooltip. Hand-painted
// faces report their palette name from BIOME_LABELS (Forest…Obsidian); natural
// ground is named exactly as the composition list does (compKeyAt + bandLabel),
// so the hover/minimap and the right-panel rollup always agree. The face's
// HIGHEST corner is the representative vertex, so a coastal face that straddles
// the waterline is named for its land (Coast), never the water below it.
export function biomeNameOfFace(body, f) {
  const painted = body.biomes[f.a];
  if (painted !== BIOME.AUTO) {
    // Generic band paints carry no fixed label — name them per-archetype, the
    // same way the natural band they reproduce is named.
    if (BAND_BIOME_KEY[painted]) return bandLabel(body, BAND_BIOME_KEY[painted]);
    return BIOME_LABELS[painted] || 'Painted';
  }
  let i = f.a;
  if (body.heights[f.b] > body.heights[i]) i = f.b;
  if (body.heights[f.c] > body.heights[i]) i = f.c;
  return bandLabel(body, compKeyAt(body, i));
}

export function commitBodyChanges(body) {
  body.posAttr.needsUpdate = true;
  body.geo.attributes.color.needsUpdate = true;
  if (body.geo.attributes.aGlow) body.geo.attributes.aGlow.needsUpdate = true;
  body.geo.computeVertexNormals();
}

export function applyMatterToBody(body, matterCfg, oceanCol) {
  body.matter = {
    solid:  !!matterCfg.solid,
    liquid: !!matterCfg.liquid,
    gas:    matterCfg.gas || false,
    plasma: !!matterCfg.plasma,
  };
  body.mesh.visible = !!matterCfg.solid;

  if (body.oceanMesh) {
    body.oceanBaseColor = oceanCol || COL.water;
    body.oceanIsWater   = !oceanCol;
    body.oceanMesh.material.color.setHex(0xffffff);
    body.oceanMesh.visible = !!matterCfg.liquid;
    colorOceanByClimate(body);
  }

  if (body.gasMesh) {
    if (matterCfg.gas) {
      body.gasMode = matterCfg.gas;
      body.gasThickness = matterCfg.gasThickness ?? 1.10;
      body.gasDensity   = matterCfg.gasDensity   ?? 0.20;
      body.gasCoverage  = matterCfg.gasCoverage  ?? 0.35;
      if (body.cloudType == null)        body.cloudType = matterCfg.cloudType ?? 0;
      if (body.coverageVariance == null) body.coverageVariance = matterCfg.coverageVariance ?? 0;
      if (body.coveragePhase == null)    body.coveragePhase = Math.random() * Math.PI * 2;
      const u = body.gasMesh.material.uniforms;
      u.uColor.value.setHex(matterCfg.gasCol || 0xffffff);
      u.uSkyTint.value.setHex(matterCfg.skyTint ?? matterCfg.gasCol ?? 0x87ceeb);
      u.uMode.value = matterCfg.gas === 'full' ? 1.0 : 0.0;
      // Full-gas bodies are an opaque surface, not a translucent shell — let
      // them write depth so they properly occlude what's behind them.
      body.gasMesh.material.depthWrite = matterCfg.gas === 'full';
      u.uWindSpeed.value = matterCfg.windSpeed ?? 0.05;
      u.uCloudType.value = body.cloudType ?? 0;
      if (matterCfg.gas === 'full') {
        const gp = ensureGasPaint(body);
        u.uBandTex.value = gp.tex;
        u.uUseBands.value = 1.0;
        updateGasFeatureUniforms(body);
      } else {
        u.uBandTex.value = DEFAULT_BAND_TEX;
        u.uUseBands.value = 0.0;
        u.uFeatureCount.value = 0;
      }
      applyGasShell(body);
      body.gasMesh.visible = true;
    } else {
      body.gasMode = 'none';
      body.gasMesh.visible = false;
      const u = body.gasMesh.material.uniforms;
      u.uBandTex.value = DEFAULT_BAND_TEX;
      u.uUseBands.value = 0.0;
      u.uFeatureCount.value = 0;
    }
  }

  if (body.plasmaMesh) {
    if (matterCfg.plasma) {
      const pc = matterCfg.plasmaCols || {};
      const pu = body.plasmaMesh.material.uniforms;
      if (pc.deep != null) pu.uColorDeep.value.setHex(pc.deep);
      if (pc.low  != null) pu.uColorLow.value.setHex(pc.low);
      if (pc.mid  != null) pu.uColorMid.value.setHex(pc.mid);
      if (pc.hot  != null) pu.uColorHot.value.setHex(pc.hot);
      body.plasmaMesh.visible = true;
    } else {
      body.plasmaMesh.visible = false;
    }
  }
}

export function applyGasShell(body) {
  if (!body.gasMesh) return;
  body.gasMesh.scale.setScalar(body.gasThickness || 1.0);
  const u = body.gasMesh.material.uniforms;
  u.uDensity.value  = Math.max(0, Math.min(1, body.gasDensity  ?? 0.2));
  u.uCoverage.value = Math.max(0, Math.min(1, body.gasCoverage ?? 0.35));
  u.uShellScale.value = body.gasThickness || 1.0;
}

export function applyRingsToBody(body) {
  if (!body.ringMesh) return;
  const r = body.rings || (body.rings = { enabled: false, intensity: 0.65 });
  body.ringMesh.visible = !!r.enabled;
  body.ringMesh.material.uniforms.uIntensity.value =
    Math.max(0, Math.min(1, r.intensity ?? 0.65));
}

export function bakeOceanShore(body) {
  const om = body.oceanMesh;
  if (!om || !body.matter || !body.matter.liquid) return;
  const geo = om.geometry;
  let shoreAttr = geo.getAttribute('aShore');
  if (!shoreAttr) {
    shoreAttr = new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count), 1);
    geo.setAttribute('aShore', shoreAttr);
  }
  const GH = Math.min(160, Math.max(8, Math.round(Math.sqrt(body.N / 8))));
  const GW = GH * 2;
  const sum = new Float32Array(GW * GH);
  const cnt = new Float32Array(GW * GH);
  const dirs = body.unitDirs, hs = body.heights, N = body.N;
  const TAU = Math.PI * 2;
  for (let i = 0; i < N; i++) {
    const uy = Math.max(-1, Math.min(1, dirs[3 * i + 1]));
    let row = ((Math.asin(uy) / Math.PI) + 0.5) * GH | 0;
    let col = ((Math.atan2(dirs[3 * i + 2], dirs[3 * i]) / TAU) + 0.5) * GW | 0;
    if (row < 0) row = 0; else if (row >= GH) row = GH - 1;
    if (col < 0) col = 0; else if (col >= GW) col = GW - 1;
    const idx = row * GW + col;
    sum[idx] += hs[i]; cnt[idx] += 1;
  }
  const EMPTY = 1e9;
  const grid = new Float32Array(GW * GH);
  for (let k = 0; k < grid.length; k++) grid[k] = cnt[k] > 0 ? sum[k] / cnt[k] : EMPTY;
  for (let r = 0; r < GH; r++) {
    for (let c = 0; c < GW; c++) {
      const idx = r * GW + c;
      if (grid[idx] !== EMPTY) continue;
      let acc = 0, num = 0;
      for (let dr = -1; dr <= 1; dr++) {
        const rr = r + dr; if (rr < 0 || rr >= GH) continue;
        for (let dc = -1; dc <= 1; dc++) {
          const v = grid[rr * GW + ((c + dc + GW) % GW)];
          if (v !== EMPTY) { acc += v; num++; }
        }
      }
      if (num > 0) grid[idx] = acc / num;
    }
  }
  const pos = geo.attributes.position;
  const out = shoreAttr.array;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const inv = 1 / Math.hypot(x, y, z);
    const uy = Math.max(-1, Math.min(1, y * inv));
    let row = ((Math.asin(uy) / Math.PI) + 0.5) * GH | 0;
    let col = ((Math.atan2(z * inv, x * inv) / TAU) + 0.5) * GW | 0;
    if (row < 0) row = 0; else if (row >= GH) row = GH - 1;
    if (col < 0) col = 0; else if (col >= GW) col = GW - 1;
    let H = grid[row * GW + col];
    if (H === EMPTY) H = MIN_LAND_HEIGHT;       // unknown cell → deep, no foam
    out[i] = H;                                 // signed seabed height: ~0 at the coast
  }
  shoreAttr.needsUpdate = true;

  // Also expose the seabed-height grid as an equirect texture the local water
  // patch samples per-fragment for depth-based transparency (clear shallows →
  // opaque deep) and shoreline crash foam. Encoded into 8-bit over [SB_MIN,
  // SB_MAX] (decoded in the patch shader). The terrain itself is only ~0.5-unit
  // resolution, so this coarse grid loses nothing the geometry didn't already.
  const SB_MIN = -6, SB_SPAN = 9;
  if (!body.seabedTex || body.seabedTex.image.width !== GW || body.seabedTex.image.height !== GH) {
    if (body.seabedTex) body.seabedTex.dispose();
    body.seabedTex = new THREE.DataTexture(new Uint8Array(GW * GH * 4), GW, GH, THREE.RGBAFormat);
    body.seabedTex.wrapS = THREE.RepeatWrapping;      // longitude wraps around
    body.seabedTex.wrapT = THREE.ClampToEdgeWrapping;
    body.seabedTex.minFilter = THREE.LinearFilter;
    body.seabedTex.magFilter = THREE.LinearFilter;
  }
  const td = body.seabedTex.image.data;
  for (let k = 0; k < grid.length; k++) {
    const H = grid[k] === EMPTY ? MIN_LAND_HEIGHT : grid[k];
    let n = (H - SB_MIN) / SB_SPAN;
    n = n < 0 ? 0 : n > 1 ? 1 : n;
    const b = (n * 255) | 0;
    td[4 * k] = b; td[4 * k + 1] = b; td[4 * k + 2] = b; td[4 * k + 3] = 255;
  }
  body.seabedTex.needsUpdate = true;
}

export function regenerateBody(body, seedStr, amplitude, seaCoverage) {
  const arch = ARCHETYPES[currentArchetype] || ARCHETYPES.terrestrial;
  if (body.kind === 'planet') {
    body.palette = arch.palette;
    const matterCfg = ARCHETYPE_MATTER[currentArchetype] || ARCHETYPE_MATTER.terrestrial;
    applyMatterToBody(body, matterCfg, arch.oceanCol);
  }

  if (climateReady) computeClimate(body);

  const basis = buildTerrainBasis(hashSeed(seedStr), TERRAIN_OCTAVES);
  const samples = new Float32Array(body.N);
  for (let i = 0; i < body.N; i++) {
    samples[i] = sampleTerrainNoise(basis, body.unitDirs[3 * i], body.unitDirs[3 * i + 1], body.unitDirs[3 * i + 2]);
  }
  const sorted = Float32Array.from(samples).sort();
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * seaCoverage)));
  const bias = sorted[idx];
  const oceanBoost = (body.matter && body.matter.liquid) ? OCEAN_DEPTH_BOOST : 1.0;
  for (let i = 0; i < body.N; i++) {
    let h = (samples[i] - bias) * amplitude;
    if (h < 0) h *= oceanBoost;
    body.heights[i] = h < MIN_LAND_HEIGHT ? MIN_LAND_HEIGHT
                    : h > MAX_LAND_HEIGHT ? MAX_LAND_HEIGHT
                    : h;
    body.biomes[i] = BIOME.AUTO;
    writeBodyVertex(body, i);
    colorBodyVertex(body, i);
  }
  commitBodyChanges(body);
  colorOceanByClimate(body);
  bakeOceanShore(body);
  if (body.kind === 'planet' && body.matter && body.matter.gas === 'full') {
    randomizeGasBands(body, seedStr);
  }
}

// Repaint every vertex without touching terrain. Used when something the
// coloring depends on changed but heights didn't — e.g. climate shifting
// (planet moved, atmosphere thickened) which grows or shrinks the polar ice.
export function recolorBody(body) {
  for (let i = 0; i < body.N; i++) colorBodyVertex(body, i);
  colorOceanByClimate(body);  // keep sea ice / dry-basin in step with the land repaint
  commitBodyChanges(body);
}

// Recompute a body's climate and, if it's a solid planet, repaint so its
// ice caps track the new climate. Called from the distance / atmosphere
// slider handlers (which don't otherwise re-run terrain).
export function refreshClimateColoring(body) {
  if (!body) return;
  computeClimate(body);
  if (body.kind === 'planet' && body.matter && body.matter.solid) recolorBody(body);
}

export function applyBrushToBody(body, centerLocal, dt) {
  if (body.matter && body.matter.gas === 'full') {
    if (currentTool === 'gasband') applyGasPaintBrush(body, centerLocal, dt);
    else if (currentTool === 'gaswhirl' && activeVortex) growGasVortex(body, activeVortex, dt);
    return;
  }
  const cx = centerLocal.x, cy = centerLocal.y, cz = centerLocal.z;
  const invLen = 1 / Math.hypot(cx, cy, cz);
  const ux = cx * invLen, uy = cy * invLen, uz = cz * invLen;

  const cosCut = Math.cos(brushRadius);
  const dir = brushRaise ? 1 : -1;
  const delta = dir * brushStrength * dt;

  let touchedAny = false;
  for (let i = 0; i < body.N; i++) {
    const dx = body.unitDirs[3 * i];
    const dy = body.unitDirs[3 * i + 1];
    const dz = body.unitDirs[3 * i + 2];
    const dot = dx * ux + dy * uy + dz * uz;
    if (dot <= cosCut) continue;

    if (currentTool === 'land') {
      const ang = Math.acos(Math.min(1, dot));
      const t = ang / brushRadius;
      const f = 1 - t * t;
      const falloff = f * f;
      const next = body.heights[i] + delta * falloff;
      body.heights[i] = next < MIN_LAND_HEIGHT ? MIN_LAND_HEIGHT
                      : next > MAX_LAND_HEIGHT ? MAX_LAND_HEIGHT
                      : next;
      writeBodyVertex(body, i);
    } else {
      body.biomes[i] = selectedBiome;
    }
    
    colorBodyVertex(body, i);
    touchedAny = true;
  }
  if (touchedAny) commitBodyChanges(body);
}
