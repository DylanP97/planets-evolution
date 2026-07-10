// Seeded terrain noise: string hash, mulberry32 PRNG, and the ridged,
// domain-warped FBM basis built per regenerate and sampled per vertex.
import { TERRAIN_WARP_STRENGTH, TERRAIN_RIDGE_MIX } from '../core/constants.js';

export function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  }
  return h >>> 0;
}

export function makeRNG(seed) {
  let s = (seed | 0) || 1;
  return function () {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildTerrainBasis(seedNum, count) {
  const rng = makeRNG(seedNum);
  const octaves = [];
  let ampSum = 0;
  for (let k = 0; k < count; k++) {
    const a = rng() * Math.PI * 2;
    const z = rng() * 2 - 1;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    const freq = 0.6 + k * 0.35 + rng() * 0.25;
    const amp = 1 / (0.5 + freq * 0.8);
    ampSum += amp;
    octaves.push({
      dx: r * Math.cos(a),
      dy: r * Math.sin(a),
      dz: z,
      freq,
      amp,
      phase: rng() * Math.PI * 2,
    });
  }
  for (const b of octaves) b.amp /= ampSum;

  // Low-frequency warp field: 3 independent cosine terms perturb the sample
  // direction before the main octave sum below, breaking up the old
  // perfectly-regular "sum of plane waves" look into organic, eroded-looking
  // terrain instead of a smooth geometric dome.
  const warp = [];
  for (let k = 0; k < 3; k++) {
    const a = rng() * Math.PI * 2;
    const z = rng() * 2 - 1;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    warp.push({
      dx: r * Math.cos(a),
      dy: r * Math.sin(a),
      dz: z,
      freq: 0.5 + rng() * 0.4,
      phase: rng() * Math.PI * 2,
    });
  }

  // Higher-frequency half of the octaves gets ridged-multifractal shaping
  // (sharp ridgelines/valleys) blended in via TERRAIN_RIDGE_MIX; the lower
  // half stays plain cosine FBM, still defining the broad continents/basins.
  const ridgeStart = Math.floor(count * 0.5);

  return { octaves, warp, ridgeStart };
}

export function sampleTerrainNoise(basis, ux, uy, uz) {
  const { octaves, warp, ridgeStart } = basis;

  let wx = 0, wy = 0, wz = 0;
  for (let i = 0; i < warp.length; i++) {
    const w = warp[i];
    const v = Math.cos((w.dx * ux + w.dy * uy + w.dz * uz) * w.freq * Math.PI + w.phase);
    wx += v * w.dx; wy += v * w.dy; wz += v * w.dz;
  }
  const wLen = Math.hypot(wx, wy, wz) || 1;
  let px = ux + (wx / wLen) * TERRAIN_WARP_STRENGTH;
  let py = uy + (wy / wLen) * TERRAIN_WARP_STRENGTH;
  let pz = uz + (wz / wLen) * TERRAIN_WARP_STRENGTH;
  const pLen = Math.hypot(px, py, pz) || 1;
  px /= pLen; py /= pLen; pz /= pLen;

  let sum = 0;
  for (let i = 0; i < octaves.length; i++) {
    const b = octaves[i];
    const c = Math.cos((b.dx * px + b.dy * py + b.dz * pz) * b.freq * Math.PI + b.phase);
    if (i >= ridgeStart) {
      const ridged = 1 - Math.abs(c);           // sharp valley/ridge fold
      const ridgedSigned = ridged * ridged * 2 - 1; // recenter to ~[-1,1] to match cosine scale
      sum += (c * (1 - TERRAIN_RIDGE_MIX) + ridgedSigned * TERRAIN_RIDGE_MIX) * b.amp;
    } else {
      sum += c * b.amp;
    }
  }
  return sum;
}
