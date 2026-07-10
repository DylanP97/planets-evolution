// build-ice-cube.mjs — procedural generator for ../ice-cube.glb
//
// Standalone tool (built-in Node modules only — no three.js, no npm). Writes a
// glTF-binary by hand: geometry math in JS, then a JSON chunk + a BIN chunk.
//
//   node assets/dev/build-ice-cube.mjs
//
// What makes it read as ICE rather than smooth glass:
//   • SHELL  — a chamfered cube (crisp-ish edges, small bevel), clear refractive
//              PBR (KHR_materials_transmission/volume/ior + clearcoat) with the
//              Ice001 CC0 cracked-ice normal + roughness maps for surface frost.
//   • CORE   — a lumpy, opaque, frosted-white blob in the middle = the cloudy
//              frozen core of a real freezer ice cube. Opaque on purpose so the
//              transmissive shell actually shows it (three.js's transmission pass
//              can't see other transmissive objects, only opaque ones).
//
// Re-run after tweaking; the dev scene picks up the new GLB on reload.

import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ---- seeded RNG so the core's lumps are stable between builds ---------------
let _seed = 20260626;
const rnd = () => { _seed = (_seed * 1664525 + 1013904223) >>> 0; return _seed / 4294967296; };
const rng = (a, b) => a + (b - a) * rnd();

// ---- geometry accumulator ---------------------------------------------------
const prims = []; // { pos, nrm, idx, uv|null, material }
const addPrim = (pos, nrm, idx, material, uv = null) => prims.push({ pos, nrm, idx, uv, material });

// ---- chamfered cube ---------------------------------------------------------
// Minkowski-style corner rounding of a subdivided box: pull each base vertex to
// the nearest inner-core point, push out by the bevel radius. Small radius =
// crisp ice edges. crossSign fixes the per-axis winding so all 6 faces point
// outward (else FrontSide culls the Y faces and the top/bottom vanish).
function chamferedCube(half, radius, seg, material, uvTile = 1.3) {
  const inner = half - radius;
  const pos = [], nrm = [], uv = [], idx = [];
  const clamp = (v) => Math.max(-inner, Math.min(inner, v));
  const ease = (t) => { const s = 2 * t - 1; return 0.5 + 0.5 * Math.sign(s) * Math.abs(s) ** 0.6; };
  const crossSign = [1, -1, 1];

  function face(axis, sign) {
    const base = pos.length / 3;
    for (let i = 0; i <= seg; i++) {
      for (let j = 0; j <= seg; j++) {
        const ti = ease(i / seg), tj = ease(j / seg);
        const u = ti * 2 * half - half, v = tj * 2 * half - half;
        let p;
        if (axis === 0) p = [sign * half, u, v];
        else if (axis === 1) p = [u, sign * half, v];
        else p = [u, v, sign * half];
        const c = [clamp(p[0]), clamp(p[1]), clamp(p[2])];
        let dx = p[0] - c[0], dy = p[1] - c[1], dz = p[2] - c[2];
        const len = Math.hypot(dx, dy, dz) || 1; dx /= len; dy /= len; dz /= len;
        pos.push(c[0] + dx * radius, c[1] + dy * radius, c[2] + dz * radius);
        nrm.push(dx, dy, dz);
        uv.push(ti * uvTile + axis * 0.37, tj * uvTile + sign * 0.19);
      }
    }
    const row = seg + 1;
    const front = sign === crossSign[axis];
    for (let i = 0; i < seg; i++) {
      for (let j = 0; j < seg; j++) {
        const a = base + i * row + j, b = a + 1, c2 = a + row, d = c2 + 1;
        if (front) idx.push(a, c2, b, b, c2, d);
        else idx.push(a, b, c2, b, d, c2);
      }
    }
  }
  for (let s = 0; s < 3; s++) { face(s, +1); face(s, -1); }
  addPrim(pos, nrm, idx, material, uv);
}

// ---- lumpy frosted core -----------------------------------------------------
// A UV sphere whose radius is perturbed by smooth value-noise so it's an
// irregular icy blob, not a billiard ball. Normals = normalized position (good
// enough for a soft, rough surface).
function frostedCore(baseR, stacks, slices, material) {
  const pos = [], nrm = [], idx = [];
  // a few random gradients summed -> cheap smooth-ish lumpiness
  // Two octaves of cheap directional noise -> a feathery, dendritic-ish lump
  // rather than a smooth ball.
  const oct = (n) => Array.from({ length: n }, () => [rng(-1, 1), rng(-1, 1), rng(-1, 1), rng(0.5, 1)]);
  const lo = oct(5), hi = oct(8);
  const noise = (seeds, f, x, y, z) => {
    let s = 0;
    for (const [sx, sy, sz] of seeds) s += Math.sin(f * (x * sx + y * sy + z * sz) + sx * 5);
    return s / seeds.length;
  };
  const lump = (x, y, z) => 0.7 * noise(lo, 4.0, x, y, z) + 0.3 * noise(hi, 9.0, x, y, z);
  for (let i = 0; i <= stacks; i++) {
    const phi = (i / stacks) * Math.PI;
    for (let j = 0; j <= slices; j++) {
      const theta = (j / slices) * 2 * Math.PI;
      const x = Math.sin(phi) * Math.cos(theta), y = Math.cos(phi), z = Math.sin(phi) * Math.sin(theta);
      const r = baseR * (1 + 0.34 * lump(x, y, z));
      pos.push(x * r, y * r, z * r);
      nrm.push(x, y, z);
    }
  }
  const row = slices + 1;
  for (let i = 0; i < stacks; i++) {
    for (let j = 0; j < slices; j++) {
      const a = i * row + j, b = a + 1, c = a + row, d = c + 1;
      idx.push(a, b, c, b, d, c); // wound so normals (= outward position) face out
    }
  }
  addPrim(pos, nrm, idx, material);
}

// ---- build geometry ---------------------------------------------------------
const HALF = 0.5;
chamferedCube(HALF, 0.055, 7, 0); // shell — crisp-ish edges
frostedCore(0.3, 16, 22, 1);      // cloudy frozen core (feathery, slightly smaller)

// ----------------------------------------------------------------------------
// Pack into a GLB.
// ----------------------------------------------------------------------------
const bin = [];
let binLen = 0;
const bufferViews = [];
const accessors = [];
const align4 = () => { const p = (4 - (binLen % 4)) % 4; if (p) { bin.push(Buffer.alloc(p)); binLen += p; } };

function pushFloat(arr, type, minMax) {
  align4();
  const buf = Buffer.from(Float32Array.from(arr).buffer);
  bufferViews.push({ buffer: 0, byteOffset: binLen, byteLength: buf.length, target: 34962 });
  bin.push(buf); binLen += buf.length;
  const comps = type === 'VEC3' ? 3 : type === 'VEC2' ? 2 : 1;
  const acc = { bufferView: bufferViews.length - 1, componentType: 5126, count: arr.length / comps, type };
  if (minMax) {
    const mn = Array(comps).fill(Infinity), mx = Array(comps).fill(-Infinity);
    for (let i = 0; i < arr.length; i++) { const c = i % comps; if (arr[i] < mn[c]) mn[c] = arr[i]; if (arr[i] > mx[c]) mx[c] = arr[i]; }
    acc.min = mn; acc.max = mx;
  }
  accessors.push(acc);
  return accessors.length - 1;
}
function pushIndex(arr) {
  align4();
  const u32 = arr.some((v) => v > 65535);
  const buf = u32 ? Buffer.from(Uint32Array.from(arr).buffer) : Buffer.from(Uint16Array.from(arr).buffer);
  bufferViews.push({ buffer: 0, byteOffset: binLen, byteLength: buf.length, target: 34963 });
  bin.push(buf); binLen += buf.length;
  accessors.push({ bufferView: bufferViews.length - 1, componentType: u32 ? 5125 : 5123, count: arr.length, type: 'SCALAR' });
  return accessors.length - 1;
}

const meshes = [];
for (const p of prims) {
  const attributes = { POSITION: pushFloat(p.pos, 'VEC3', true), NORMAL: pushFloat(p.nrm, 'VEC3', false) };
  if (p.uv) attributes.TEXCOORD_0 = pushFloat(p.uv, 'VEC2', false);
  meshes.push({ primitives: [{ attributes, indices: pushIndex(p.idx), material: p.material }] });
}

// ---- embed the Ice001 maps (raw JPG bytes -> bufferViews) -------------------
const images = [];
function embedImage(relPath, mimeType) {
  align4();
  const buf = readFileSync(fileURLToPath(new URL(relPath, import.meta.url)));
  bufferViews.push({ buffer: 0, byteOffset: binLen, byteLength: buf.length });
  bin.push(buf); binLen += buf.length;
  images.push({ bufferView: bufferViews.length - 1, mimeType });
  return images.length - 1;
}
const normalImg = embedImage('./ice-src/ice_normal.jpg', 'image/jpeg');
const roughImg = embedImage('./ice-src/ice_roughness.jpg', 'image/jpeg');
const samplers = [{ wrapS: 10497, wrapT: 10497, magFilter: 9729, minFilter: 9987 }];
const textures = [{ source: normalImg, sampler: 0 }, { source: roughImg, sampler: 0 }];

// ---- materials --------------------------------------------------------------
const materials = [
  {
    name: 'IceShell',
    normalTexture: { index: 0, scale: 0.3 },
    pbrMetallicRoughness: {
      baseColorFactor: [0.83, 0.92, 0.99, 1.0],
      metallicFactor: 0.0,
      roughnessFactor: 0.12,
      metallicRoughnessTexture: { index: 1 },
    },
    extensions: {
      KHR_materials_transmission: { transmissionFactor: 0.94 },
      KHR_materials_ior: { ior: 1.31 },
      KHR_materials_volume: { thicknessFactor: 0.5, attenuationDistance: 3.0, attenuationColor: [0.82, 0.91, 0.98] },
      KHR_materials_clearcoat: { clearcoatFactor: 0.35, clearcoatRoughnessFactor: 0.1 },
      KHR_materials_specular: { specularColorFactor: [1.0, 1.0, 1.0] },
    },
  },
  {
    name: 'FrostCore',
    // Opaque so the transmissive shell can see it. Rough near-white + a little
    // self-glow so it reads as a bright frozen cloud rather than a grey stone.
    pbrMetallicRoughness: {
      baseColorFactor: [0.96, 0.98, 1.0, 1.0],
      metallicFactor: 0.0,
      roughnessFactor: 0.9,
    },
    emissiveFactor: [0.10, 0.13, 0.17],
  },
];

const gltf = {
  asset: { version: '2.0', generator: 'planet-tiles build-ice-cube.mjs' },
  extensionsUsed: [
    'KHR_materials_transmission', 'KHR_materials_ior', 'KHR_materials_volume',
    'KHR_materials_clearcoat', 'KHR_materials_specular',
  ],
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [
    { name: 'IceCube', children: [1, 2] },
    { name: 'Shell', mesh: 0 },
    { name: 'Core', mesh: 1 },
  ],
  meshes, materials, images, samplers, textures,
  accessors, bufferViews,
  buffers: [{ byteLength: binLen }],
};

// ---- assemble GLB -----------------------------------------------------------
function chunk(type, data) {
  const pad = (4 - (data.length % 4)) % 4;
  const padded = pad ? Buffer.concat([data, Buffer.alloc(pad, type === 0x4e4f534a ? 0x20 : 0)]) : data;
  const header = Buffer.alloc(8);
  header.writeUInt32LE(padded.length, 0); header.writeUInt32LE(type, 4);
  return Buffer.concat([header, padded]);
}
const jsonChunk = chunk(0x4e4f534a, Buffer.from(JSON.stringify(gltf), 'utf8'));
const binChunk = chunk(0x004e4942, Buffer.concat(bin));
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + jsonChunk.length + binChunk.length, 8);

const out = fileURLToPath(new URL('../ice-cube.glb', import.meta.url));
writeFileSync(out, Buffer.concat([header, jsonChunk, binChunk]));

const tris = prims.reduce((n, p) => n + p.idx.length / 3, 0);
const verts = prims.reduce((n, p) => n + p.pos.length / 3, 0);
console.log(`wrote ${out}`);
console.log(`  ${verts} verts · ${tris} tris · ${prims.length} prims (shell + cloudy core)`);
