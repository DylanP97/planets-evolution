// Planet archetype catalog: ARCHETYPES (palette/amplitude/sea per type) and
// ARCHETYPE_MATTER (solid/liquid/gas/plasma composition + atmosphere tuning).
import { PLANET_PALETTE, MOON_PALETTE } from '../core/palettes.js';

export const ARCHETYPES = {
  terrestrial: { name: 'Terrestrial', palette: PLANET_PALETTE, hasOcean: true, amp: 2.0, sea: 0.55 },
  ocean: { name: 'Ocean World', palette: { deep: 0x001a33, shore: 0x004d99, sand: 0x0066cc, grass: 0x0080ff, rock: 0x3399ff, snow: 0x66b2ff }, hasOcean: true, amp: 1.5, sea: 0.9 },
  gas_giant: { name: 'Gas Giant', palette: { deep: 0x331a00, shore: 0x663300, sand: 0x996633, grass: 0xcc9966, rock: 0xffcc99, snow: 0xffffff }, hasOcean: false, amp: 0.8, sea: 0.0 },
  ice_giant: { name: 'Ice Giant', palette: { deep: 0x003366, shore: 0x006699, sand: 0x3399ff, grass: 0x66b2ff, rock: 0x99ccff, snow: 0xffffff }, hasOcean: false, amp: 1.2, sea: 0.0 },
  desert: { name: 'Martian Planet', palette: { deep: 0x4a2412, shore: 0x7d3a1f, sand: 0xcf7d4d, grass: 0xb96138, rock: 0x8a4424, snow: 0xe2b48f }, hasOcean: false, amp: 2.5, sea: 0.0 },
  lava: { name: 'Lava Planet', palette: { deep: 0x330000, shore: 0x660000, sand: 0xff3300, grass: 0xff6600, rock: 0x331a00, snow: 0x663300 }, hasOcean: true, oceanCol: 0xff4500, amp: 3.0, sea: 0.4 },
  ice_planet: { name: 'Ice Planet', palette: { deep: 0x003366, shore: 0x006699, sand: 0x99ccff, grass: 0xccf2ff, rock: 0x6699cc, snow: 0xffffff }, hasOcean: false, amp: 1.8, sea: 0.0 },
  jungle: { name: 'Jungle Planet', palette: { deep: 0x002200, shore: 0x004400, sand: 0x1a3300, grass: 0x006400, rock: 0x2d5a27, snow: 0x4d994d }, hasOcean: true, oceanCol: 0x1a3300, amp: 2.5, sea: 0.4 },
  swamp: { name: 'Swamp Planet', palette: { deep: 0x1a1a00, shore: 0x333300, sand: 0x4d4d00, grass: 0x2d5a27, rock: 0x1a3300, snow: 0x4d994d }, hasOcean: true, oceanCol: 0x2d5a27, amp: 1.5, sea: 0.7 },
  toxic: { name: 'Toxic Planet', palette: { deep: 0x1a0033, shore: 0x330066, sand: 0xadff2f, grass: 0x32cd32, rock: 0x4b0082, snow: 0x7fff00 }, hasOcean: true, oceanCol: 0xadff2f, amp: 2.2, sea: 0.6 },
  venusian: { name: 'Venusian Planet', palette: { deep: 0x161412, shore: 0x1d1a17, sand: 0x242019, grass: 0x363028, rock: 0x4c463e, snow: 0x7a7268 }, hasOcean: false, amp: 1.5, sea: 0.0 },
  metal: { name: 'Metal-Rich', palette: { deep: 0x1a1a1a, shore: 0x333333, sand: 0x4d4d4d, grass: 0x666666, rock: 0x1a1a1a, snow: 0xffd700 }, hasOcean: false, amp: 3.5, sea: 0.0 },
  carbon: { name: 'Carbon Planet', palette: { deep: 0x050505, shore: 0x101010, sand: 0x1a1a1a, grass: 0x252525, rock: 0x0a0a0a, snow: 0x333333 }, hasOcean: false, amp: 2.2, sea: 0.0 },
  moon_like: { name: 'Moon-Like Rocky Planet', palette: { deep: 0x322e29, shore: 0x4a4238, sand: 0x6f6357, grass: 0x8a8174, rock: 0xa49a8b, snow: 0xe2dccf }, hasOcean: false, amp: 1.8, sea: 0.0 },
  storm: { name: 'Storm Planet', palette: { deep: 0x1a1a33, shore: 0x333366, sand: 0x4d4d99, grass: 0x6666cc, rock: 0x1a1a4d, snow: 0x9999ff }, hasOcean: true, oceanCol: 0x1a1a33, amp: 3.5, sea: 0.5 },
  living: { name: 'Living Planet', palette: { deep: 0x33001a, shore: 0x660033, sand: 0x99004d, grass: 0xcc0066, rock: 0x33001a, snow: 0xff0080 }, hasOcean: true, oceanCol: 0x4d0026, amp: 1.8, sea: 0.3 },
  rogue: { name: 'Rogue Planet', palette: { deep: 0x020205, shore: 0x050510, sand: 0x0a0a1a, grass: 0x101025, rock: 0x020208, snow: 0x1a1a33 }, hasOcean: false, amp: 2.0, sea: 0.0 },
  star: { name: 'Star', palette: { deep: 0x3a0a00, shore: 0x7a1500, sand: 0xff6a00, grass: 0xffaa00, rock: 0xffd24d, snow: 0xfff4d0 }, hasOcean: false, amp: 1.0, sea: 0.0 },
};

// Each archetype declares its matter composition. `gas` is one of:
//   false        — no gas at all (bare rock world)
//   'atmosphere' — thin shell wrapping the solid/liquid surface
//   'full'       — body IS the gas (no solid, no liquid; e.g. gas giants)
// gasThickness is multiplied with baseRadius (1.0 = surface; 1.20 = +20%).
// gasDensity is the shell's base opacity (0..1).
export const ARCHETYPE_MATTER = {
  terrestrial: { solid: true,  liquid: true,  gas: 'atmosphere', gasCol: 0xffffff, skyTint: 0x87ceeb, gasThickness: 1.10, gasDensity: 0.45, gasCoverage: 0.35, coverageVariance: 0.95, windSpeed: 0.03 },
  ocean:       { solid: true,  liquid: true,  gas: 'atmosphere', gasCol: 0xcce7ff, skyTint: 0x9ad0e6, gasThickness: 1.10, gasDensity: 0.50, gasCoverage: 0.40, windSpeed: 0.04 },
  gas_giant:   { solid: false, liquid: false, gas: 'full',       gasCol: 0xc89060, gasThickness: 1.00, gasDensity: 0.95, gasCoverage: 0.50, windSpeed: 0.12 },
  ice_giant:   { solid: false, liquid: false, gas: 'full',       gasCol: 0x88bbee, gasThickness: 1.00, gasDensity: 0.92, gasCoverage: 0.50, windSpeed: 0.08 },
  desert:      { solid: true,  liquid: false, gas: 'atmosphere', gasCol: 0xe8c4a0, skyTint: 0xd2a07a, gasThickness: 1.10, gasDensity: 0.42, gasCoverage: 0.20, windSpeed: 0.04 },
  lava:        { solid: true,  liquid: true,  gas: 'atmosphere', gasCol: 0xff8844, skyTint: 0xc4441a, gasThickness: 1.08, gasDensity: 0.55, gasCoverage: 0.40, windSpeed: 0.10 },
  ice_planet:  { solid: true,  liquid: false, gas: 'atmosphere', gasCol: 0xccddee, skyTint: 0xb8d8ec, gasThickness: 1.05, gasDensity: 0.30, gasCoverage: 0.25, windSpeed: 0.02 },
  jungle:      { solid: true,  liquid: true,  gas: 'atmosphere', gasCol: 0xe8f5e0, skyTint: 0xb6dba0, gasThickness: 1.12, gasDensity: 0.55, gasCoverage: 0.65, windSpeed: 0.04 },
  swamp:       { solid: true,  liquid: true,  gas: 'atmosphere', gasCol: 0xc5d4a8, skyTint: 0x96a878, gasThickness: 1.10, gasDensity: 0.60, gasCoverage: 0.55, windSpeed: 0.02 },
  toxic:       { solid: true,  liquid: true,  gas: 'atmosphere', gasCol: 0xadff2f, skyTint: 0x70c020, gasThickness: 1.15, gasDensity: 0.70, gasCoverage: 0.70, windSpeed: 0.06 },
  venusian:    { solid: true,  liquid: false, gas: 'atmosphere', gasCol: 0xe6c870, skyTint: 0xe6c870, gasThickness: 1.16, gasDensity: 1.00, gasCoverage: 1.00, cloudType: 1, windSpeed: 0.01 },
  metal:       { solid: true,  liquid: false, gas: false },
  carbon:      { solid: true,  liquid: false, gas: 'atmosphere', gasCol: 0x555555, skyTint: 0x303030, gasThickness: 1.06, gasDensity: 0.45, gasCoverage: 0.40, windSpeed: 0.03 },
  moon_like:   { solid: true,  liquid: false, gas: false },
  storm:       { solid: true,  liquid: true,  gas: 'atmosphere', gasCol: 0xaaaaff, skyTint: 0x6878a0, gasThickness: 1.18, gasDensity: 0.80, gasCoverage: 0.85, windSpeed: 0.18 },
  living:      { solid: true,  liquid: true,  gas: 'atmosphere', gasCol: 0xff99cc, skyTint: 0xe682b5, gasThickness: 1.08, gasDensity: 0.50, gasCoverage: 0.45, windSpeed: 0.05 },
  rogue:       { solid: true,  liquid: false, gas: false },
  // Plasma matter: a star. No solid/liquid/gas — the body IS the photosphere.
  star:        { solid: false, liquid: false, gas: false, plasma: true, plasmaCols: { deep: 0x5a0e00, low: 0xc73a00, mid: 0xff9b1e, hot: 0xfff4d0 } },
};
