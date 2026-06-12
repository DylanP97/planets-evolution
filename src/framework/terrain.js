// Seeded terrain noise: string hash, mulberry32 PRNG, and the sum-of-sines
// FBM basis built per regenerate and sampled per vertex.
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
  const basis = [];
  let ampSum = 0;
  for (let k = 0; k < count; k++) {
    const a = rng() * Math.PI * 2;
    const z = rng() * 2 - 1;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    const freq = 0.6 + k * 0.35 + rng() * 0.25;
    const amp = 1 / (0.5 + freq * 0.8);
    ampSum += amp;
    basis.push({
      dx: r * Math.cos(a),
      dy: r * Math.sin(a),
      dz: z,
      freq,
      amp,
      phase: rng() * Math.PI * 2,
    });
  }
  for (const b of basis) b.amp /= ampSum;
  return basis;
}

export function sampleTerrainNoise(basis, ux, uy, uz) {
  let sum = 0;
  for (let i = 0; i < basis.length; i++) {
    const b = basis[i];
    sum += Math.cos((b.dx * ux + b.dy * uy + b.dz * uz) * b.freq * Math.PI + b.phase) * b.amp;
  }
  return sum;
}
