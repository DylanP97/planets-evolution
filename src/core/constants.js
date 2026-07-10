// Planet-wide tuning constants: biome height bands, sea ice/steam thresholds,
// shared colors, the BIOME enum, terrain octaves, and water-foam parameters.
import * as THREE from 'three';

export const BASE_RADIUS = 12;
export const SEA_LEVEL   = 0.0;
export const ICO_DETAIL  = 7;

// Measured on a real "earth" seed: over half of all LAND sat below the old
// 0.25, reading as generic tan "Coast" instead of its own zone's color/biome
// (23% of the whole planet) — most terrain here sits close to the sea-level
// threshold, so a beach band this tall swallowed far more than an actual
// shoreline fringe. Lowered so the beach reads as a real thin shore.
export const SAND_TOP    = 0.10;
export const GRASS_TOP   = 1.2;
export const ROCK_TOP    = 2.4;
export const SNOW_FADE   = 0.4;

export const KELVIN_ZERO_C   = 273.15;
export const CLIMATE_LAPSE_C = 14;

export const SEA_ICE_C       = -24;
export const SEA_THAW_C      = -14;
export const SEA_ICE_NOISE_C = 6;
export const SEA_BOIL_C      = 75;
export const SEA_VAPOR_C     = 110;
export const SEA_ICE_GLOW    = 0.4;
export const SEA_ICE_COLOR   = 0xcfe6f0;
export const SEA_STEAM_COLOR = 0xb7c4c0;
export const SEABED_COLOR    = 0xcabfa3;

export const ICE_GLOW_COLOR = new THREE.Color(0xcdeeff);

export const COL = {
  water:     0x3FA1DC,
  deep:      0x12243a,
  shore:     0x8fb4c8,
  sand:      0xEDDFB8,
  grass:     0x4FAE4F,
  grassDark: 0x2f7a36,
  rock:      0x7d6a5a,
  snow:      0xf0f4f8,
  forest:    0x1a4d1a,
  desert:    0xd2b48c,
};

export const BIOME = {
  AUTO: 0,
  FOREST: 1,
  DESERT: 2,
  GRASSLAND: 3,
  TUNDRA: 4,
  JUNGLE: 43,
  ICE: 44,
  COAST: 45,
  MARE: 40,
  REGOLITH: 41,
  FROST: 42,
  // Generic "natural band" paints. Unlike the biomes above (which carry a fixed
  // color), these reproduce one of the body's auto terrain bands using its own
  // palette slot, so painting "Rock" on a lava world paints Basalt, on Earth
  // paints rock-brown, etc. Named per-archetype via ARCHETYPE_BAND_LABELS. The
  // five planet elevation bands plus the three moon-only bands (rock is shared).
  BAND_WATER: 46,
  BAND_SAND: 47,
  BAND_GRASS: 48,
  BAND_ROCK: 49,
  BAND_SNOW: 50,
  BAND_CRATER: 51,
  BAND_DUST: 52,
  BAND_HIGHLIGHT: 53,
};

// Each generic band paint → the composition key it reproduces (so the rollup,
// minimap and hover tooltip tally/name it as that natural band) and the body
// palette slot colorBodyVertex paints it from (so it matches the archetype).
export const BAND_BIOME_KEY = {
  [BIOME.BAND_WATER]:     'water',
  [BIOME.BAND_SAND]:      'sand',
  [BIOME.BAND_GRASS]:     'grass',
  [BIOME.BAND_ROCK]:      'rock',
  [BIOME.BAND_SNOW]:      'snow',
  [BIOME.BAND_CRATER]:    'crater',
  [BIOME.BAND_DUST]:      'dust',
  [BIOME.BAND_HIGHLIGHT]: 'highlight',
};
export const BAND_BIOME_SLOT = {
  [BIOME.BAND_WATER]:     'deep',
  [BIOME.BAND_SAND]:      'sand',
  [BIOME.BAND_GRASS]:     'grass',
  [BIOME.BAND_ROCK]:      'rock',
  [BIOME.BAND_SNOW]:      'snow',
  [BIOME.BAND_CRATER]:    'crater',
  [BIOME.BAND_DUST]:      'dust',
  [BIOME.BAND_HIGHLIGHT]: 'highlight',
};

export const MOON_BIOME_OPTIONS = [
  { v: BIOME.MARE,     n: 'Mare' },
  { v: BIOME.REGOLITH, n: 'Regolith' },
  { v: BIOME.FROST,    n: 'Frost' },
];

// Display names for every *painted* biome value (body.biomes[i] !== AUTO),
// keyed by the numeric code. Mirrors the option list ui/controls.js builds for
// the paint dropdown — keep the two in sync when adding a biome. Used by
// biomeNameOfFace (framework/body.js) to name painted ground for the minimap +
// orbit hover tooltip; AUTO (natural) terrain is classified procedurally there.
export const BIOME_LABELS = {
  [BIOME.FOREST]:    'Forest',
  [BIOME.DESERT]:    'Desert',
  [BIOME.GRASSLAND]: 'Grassland',
  [BIOME.TUNDRA]:    'Tundra',
  [BIOME.JUNGLE]:    'Jungle',
  [BIOME.ICE]:       'Ice',
  [BIOME.COAST]:     'Coast',
  [BIOME.MARE]:      'Mare',
  [BIOME.REGOLITH]:  'Regolith',
  [BIOME.FROST]:     'Frost',
  5:  'Obsidian',      6:  'Magma Flow',
  9:  'Acid Sludge',   10: 'Mutation Bloom',
  11: 'Coral Reef',    12: 'Kelp Forest',    13: 'Abyssal Trench',  14: 'Sulfur Vent',
  15: 'Oasis',         17: 'Red Sand',
  18: 'Glacier',       19: 'Cryo-Volcano',   20: 'Blue Ice',
  21: 'Exotic Bloom',  22: 'River Path',     23: 'Dense Canopy',    24: 'Data Hub',
  25: 'Gas Vent',      26: 'Rust Belt',      27: 'Gold Vein',       28: 'Chrome Flat',
  29: 'Neural Path',   30: 'Pulsing Organ',  31: 'Tendon',
  32: 'Lightning Scar',33: 'Cyclone Eye',    34: 'Vortex',
  35: 'Sulfur Cloud',  36: 'Volcanic Plain', 37: 'Greenhouse Haze',
};

// Swatch color for each *painted* biome code, used by the composition rollup
// for biomes that don't fold into a natural band (see compKeyAt's
// 'biome:<code>' bucket). Mirrors the primary color colorBodyVertex paints for
// that biome where it has one; the few biomes not yet rendered distinctly get a
// representative themed color so the legend still reads sensibly.
export const BIOME_SWATCH = {
  5:  '#1a1a1a',  6:  '#ff4500',
  9:  '#adff2f',  10: '#32cd32',
  11: '#ff7f50',  12: '#2e8b57',  13: '#000033',  14: '#ffff00',
  15: '#228b22',  17: '#8b0000',
  18: '#e0ffff',  19: '#add8e6',  20: '#6cb4ee',
  21: '#ff00ff',  22: '#3fa1dc',  23: '#0f5a1f',  24: '#00f2ff',
  25: '#b6ff7a',  26: '#8b4513',  27: '#ffd700',  28: '#c0c0c0',
  29: '#ff69b4',  30: '#ff4d6d',  31: '#d98c8c',
  32: '#b9a0ff',  33: '#9999ff',  34: '#6666cc',
  35: '#e6c870',  36: '#4c463e',  37: '#c5d4a8',
};

// ── Composition / band naming ───────────────────────────────────────────────
// These tables name the AUTO (unpainted) terrain bands. They drive the info
// panel's composition rollup AND — via compKeyAt + bandLabel in body.js — the
// surface minimap and orbit hover tooltip, so all three name the ground the
// same way. (Painted faces are named from BIOME_LABELS above instead.)

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
export const PLANET_COMP_ORDER = ['water', 'seaice', 'ice', 'tundra', 'grass', 'jungle', 'forest', 'sand', 'desert', 'seabed', 'rock', 'snow'];
export const MOON_COMP_ORDER   = ['crater', 'dust', 'rock', 'highlight', 'mare', 'regolith', 'frost'];

// Maps the five auto elevation-band keys to a palette slot (for the panel swatch).
export const BAND_KEY_TO_PALETTE = { water: 'deep', sand: 'sand', grass: 'grass', rock: 'rock', snow: 'snow' };

// Per-archetype labels for the auto-painted height bands. Without these, a
// desert planet reports "Grass" for its mid-elevation band even though that
// band is colored desert-tan — confusing because no green is visible.
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

export const BODY_HEIGHT_SCALE = 0.025;
export const MAX_LAND_HEIGHT = 2.5;
export const MIN_LAND_HEIGHT = -2.5;
export const OCEAN_DEPTH_BOOST = 2.2;

export const TERRAIN_OCTAVES = 24;
// Domain-warp strength (how much low-frequency octaves distort the sample
// direction before the main sum) and the ridged-multifractal mix for the
// higher-frequency half of the octaves (0 = plain cosine FBM, 1 = fully
// ridged). Together these break up the old perfectly-smooth "sum of plane
// waves" dome into organic ridgelines/valleys. Tune here without touching
// the noise algorithm in terrain.js.
export const TERRAIN_WARP_STRENGTH = 0.35;
export const TERRAIN_RIDGE_MIX     = 0.6;

export const FOAM_COLOR  = new THREE.Color(0xeef7ff);
export const FOAM_LINE_W = 0.12;
export const FOAM_SCALE  = 5.0;
export const FOAM_ALPHA  = 0.9;
