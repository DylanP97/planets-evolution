import * as THREE from 'three';

export const BASE_RADIUS = 12;
export const SEA_LEVEL   = 0.0;
export const ICO_DETAIL  = 7;

export const SAND_TOP    = 0.25;
export const GRASS_TOP   = 1.2;
export const GRASS_FLOOR = SAND_TOP + 0.15;
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
  city:      0x808080,
  cityLights:0xffd700,
};

export const BIOME = {
  AUTO: 0,
  FOREST: 1,
  DESERT: 2,
  TUNDRA: 4,
  MARE: 40,
  REGOLITH: 41,
  FROST: 42,
};

export const MOON_BIOME_OPTIONS = [
  { v: BIOME.MARE,     n: 'Mare' },
  { v: BIOME.REGOLITH, n: 'Regolith' },
  { v: BIOME.FROST,    n: 'Frost' },
];

export const BODY_HEIGHT_SCALE = 0.025;
export const MAX_LAND_HEIGHT = 2.5;
export const MIN_LAND_HEIGHT = -2.5;
export const OCEAN_DEPTH_BOOST = 2.2;

export const TERRAIN_OCTAVES = 24;

export const FOAM_COLOR  = new THREE.Color(0xeef7ff);
export const FOAM_LINE_W = 0.12;
export const FOAM_SCALE  = 5.0;
export const FOAM_ALPHA  = 0.9;
