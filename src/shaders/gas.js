// Atmosphere + full-gas-giant shader (GLSL), the latitudinal band-paint LUT,
// gas biome catalog, and whirlpool/vortex feature stamping.
import * as THREE from 'three';
import { 
  brushRadius, brushStrength, currentArchetype, 
  gasPaintColor, selectedGasBiomeId 
} from '../framework/state.js';
import { makeRNG, hashSeed } from '../framework/terrain.js';

export const GAS_VERT = /* glsl */ `
  varying vec3 vWorldNormal;
  varying vec3 vWorldPos;
  varying vec3 vBodyCenter;
  varying vec3 vViewDir;
  varying vec3 vLocalNormal;
  void main() {
    vLocalNormal = normalize(position);
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    vBodyCenter = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    vViewDir = normalize(cameraPosition - wp.xyz);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

export const GAS_FRAG = /* glsl */ `
  precision highp float;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPos;
  varying vec3 vBodyCenter;
  varying vec3 vViewDir;
  varying vec3 vLocalNormal;
  uniform vec3  uColor;
  uniform vec3  uSkyTint;
  uniform vec3  uSunDir;
  uniform float uDensity;
  uniform float uMode;
  uniform float uCoverage;
  uniform float uOpaqueSky;
  uniform float uShellScale;
  uniform float uTime;
  uniform float uWindSpeed;
  uniform float uWindMode;
  uniform sampler2D uBandTex;
  uniform float uUseBands;

  #define GAS_MAX_FEATURES 8
  uniform int   uFeatureCount;
  uniform vec3  uFeatureCenters[GAS_MAX_FEATURES];
  uniform float uFeatureRadii[GAS_MAX_FEATURES];
  uniform float uFeatureStrengths[GAS_MAX_FEATURES];

  float hash3(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float vnoise(vec3 x) {
    vec3 p = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    float n000 = hash3(p + vec3(0,0,0));
    float n100 = hash3(p + vec3(1,0,0));
    float n010 = hash3(p + vec3(0,1,0));
    float n110 = hash3(p + vec3(1,1,0));
    float n001 = hash3(p + vec3(0,0,1));
    float n101 = hash3(p + vec3(1,0,1));
    float n011 = hash3(p + vec3(0,1,1));
    float n111 = hash3(p + vec3(1,1,1));
    return mix(
      mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
      mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
      f.z);
  }
  float fbm(vec3 x) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 4; i++) {
      v += a * vnoise(x);
      x *= 2.1;
      a *= 0.5;
    }
    return v;
  }

  void main() {
    float NdotV        = clamp(abs(dot(vWorldNormal, vViewDir)), 0.0, 1.0);
    float fr           = 1.0 - NdotV;
    float shellLambert = max(0.0, dot(vWorldNormal, normalize(uSunDir)));

    float shellRad = length(vWorldPos - vBodyCenter);
    float camDist  = length(cameraPosition - vBodyCenter);
    bool  inside   = camDist < shellRad;
    vec3  camDir   = normalize(cameraPosition - vBodyCenter);
    float sunElev  = dot(camDir, normalize(uSunDir));
    float camLamb  = max(0.0, sunElev);
    float dayMix   = inside ? camLamb : shellLambert;
    float skyCover = inside
      ? smoothstep(-0.42, 0.12, sunElev)
      : smoothstep(-0.22, 0.05, sunElev);

    vec3  col = uColor;
    float alpha;
    float cloud = 0.0;

    if (uMode < 0.5) {
      float lat       = vLocalNormal.y;
      float bandRate  = mix(1.0, sin(lat * 3.14159 * 1.5) * 1.8, uWindMode);
      float ang       = uTime * uWindSpeed * bandRate;
      float wc        = cos(ang);
      float ws        = sin(ang);
      vec3  windDir = vec3(
         wc * vLocalNormal.x + ws * vLocalNormal.z,
              vLocalNormal.y,
        -ws * vLocalNormal.x + wc * vLocalNormal.z
      );
      windDir.y += uWindMode * sin(uTime * uWindSpeed * 0.6 + lat * 4.0) * 0.08;
      float n      = fbm(windDir * 3.5);
      float thresh = 0.95 - uCoverage * 0.90;
      cloud = smoothstep(thresh - 0.10, thresh + 0.28, n);

      vec3  viewDir = normalize(-vViewDir);
      float sunDot  = max(0.0, dot(normalize(uSunDir), viewDir));
      float twilightWeight = inside
        ? smoothstep(0.34, -0.04, sunElev) * smoothstep(-0.30, 0.04, sunElev)
        : smoothstep(0.30, 0.0, dayMix);
      vec3  duskTint  = vec3(1.00, 0.42, 0.08);
      vec3  bleachCol = mix(vec3(1.0), duskTint, twilightWeight);
      vec3  skyCol    = mix(uSkyTint, bleachCol, pow(sunDot, 6.0) * 0.72);
      if (inside) {
        float horizonness = pow(1.0 - NdotV, 0.38);
        vec3  horizonWarm = vec3(1.00, 0.34, 0.05);
        float twilightSky = smoothstep(0.48, -0.14, sunElev)
                          * (1.0 - smoothstep(-0.48, -0.14, sunElev));
        skyCol = mix(skyCol, mix(uSkyTint, horizonWarm, horizonness), twilightSky);
      }

      float nightFloor = clamp((uDensity - 0.5) * 2.0, 0.0, 1.0);
      float daySat     = smoothstep(0.0, 0.25, dayMix);
      float sunFactor  = inside
        ? max(mix(nightFloor, 1.00, daySat), skyCover * 0.95)
        : mix(nightFloor, 1.00, daySat);

      float skyAlpha;
      float cloudAlpha;
      if (inside) {
        float fullPath   = 1.0 / max(NdotV, 0.20);
        float pathLift   = max(camLamb, skyCover * 0.72);
        float pathFactor = mix(1.0, fullPath, pathLift);
        skyAlpha   = clamp(uDensity * 3.0 * sunFactor * pathFactor, 0.0, 1.0);
        cloudAlpha = cloud * sunFactor;
      } else {
        vec3  OC   = vBodyCenter - cameraPosition;
        vec3  rayD = normalize(vWorldPos - cameraPosition);
        float tca  = dot(OC, rayD);
        float b    = sqrt(max(0.0, dot(OC, OC) - tca * tca));
        float R    = shellRad / max(1.0001, uShellScale);
        float band = clamp((b - R) / max(1e-4, shellRad - R), 0.0, 1.0);
        float overAir = step(R, b);
        float halo = overAir * pow(1.0 - band, 2.0);
        float nightFade = mix(0.12, 1.0, shellLambert);
        skyAlpha   = uDensity * halo * 1.8 * nightFade;
        cloudAlpha = cloud * uDensity * 1.6;
      }

      col   = mix(skyCol, uColor, cloud);
      alpha = max(skyAlpha, cloudAlpha);

      if (inside) {
        float horizonness = pow(1.0 - NdotV, 0.6);
        float sunSide     = pow(max(0.0, sunDot), 1.5);
        float sunsetBand  = horizonness * sunSide * twilightWeight;
        alpha = max(alpha, sunsetBand * 0.90);
        col   = mix(col, duskTint, sunsetBand * 0.88);
        float domeAlpha = skyCover * mix(0.82, 0.48, pow(NdotV, 0.58));
        alpha = max(alpha, domeAlpha);
        float nightBlend = (1.0 - skyCover) * pow(NdotV, 0.32);
        col   = mix(col, vec3(0.04, 0.05, 0.12), nightBlend * 0.62);
      }

    } else {
      vec3 warped = vLocalNormal;
      for (int i = 0; i < GAS_MAX_FEATURES; i++) {
        if (i >= uFeatureCount) break;
        float fr = uFeatureRadii[i];
        if (fr <= 1e-4) continue;
        vec3  fc = uFeatureCenters[i];
        float cd = clamp(dot(vLocalNormal, fc), -1.0, 1.0);
        float ang = acos(cd);
        if (ang > fr) continue;
        float t = ang / fr;
        float falloff = exp(-3.0 * t * t);
        float rot = uFeatureStrengths[i] * falloff;
        float cs = cos(rot);
        float sn = sin(rot);
        warped = warped * cs
               + cross(fc, warped) * sn
               + fc * dot(fc, warped) * (1.0 - cs);
      }
      float gt = uTime * (uWindSpeed + 0.02) * 1.5;
      vec3  flowQ = vec3(
        fbm(warped * 1.8 + vec3(0.0, gt * 0.5, 0.0)),
        fbm(warped * 1.8 + vec3(3.1, 1.7, gt * 0.4)),
        fbm(warped * 1.8 + vec3(gt * 0.6, 9.2, 5.7))
      );
      warped = normalize(warped + 0.13 * (flowQ - 0.5));
      float n     = fbm(warped * 3.5 + vec3(0.0, 0.0, gt * 0.25));
      float lat   = warped.y * 0.5 + 0.5;
      float latW  = clamp(lat + (n - 0.5) * 0.04, 0.0, 1.0);
      vec3  bandCol = texture2D(uBandTex, vec2(latW, 0.5)).rgb;
      vec3  baseCol = mix(uColor, bandCol, uUseBands);
      float bands = 0.5 + 0.5 * sin(warped.y * 6.0 + n * 2.5);
      col = mix(baseCol * 0.82, baseCol * 1.06, bands);
      float core = smoothstep(0.0, 0.40, NdotV);
      alpha = uDensity * core;
    }

    float light = inside
      ? mix(0.30, 1.10, max(camLamb, skyCover * 0.82))
      : mix(0.30, 1.10, dayMix);
    col *= light;

    if (inside && uMode < 0.5) {
      vec3  viewDir2 = normalize(-vViewDir);
      float sunDot2  = max(0.0, dot(normalize(uSunDir), viewDir2));
      float sunDisc  = smoothstep(0.99988, 0.99998, sunDot2);
      float SUN_DISC_R = 0.032;
      float sunAbove = smoothstep(-SUN_DISC_R - 0.018, -SUN_DISC_R, sunElev);
      float sunWarm    = smoothstep(0.28, 0.0, camLamb);
      vec3  sunCol     = mix(vec3(1.00, 0.96, 0.82), vec3(1.00, 0.90, 0.68), sunWarm);
      float sunVis     = sunDisc * (1.0 - cloud) * sunAbove;
      col   += sunCol * sunVis;
      alpha  = max(alpha, sunDisc * sunAbove);
    }

    float a = clamp(alpha, 0.0, 1.0);
    if (uOpaqueSky > 0.5) {
      if (a < 0.02) discard;
    }
    gl_FragColor = vec4(col, a);
  }
`;

export const DEFAULT_BAND_TEX = (() => {
  const tex = new THREE.DataTexture(
    new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat
  );
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
})();

export const GAS_MAX_FEATURES = 8;
// Latitudinal band-paint LUT resolution. The LUT runs south(0) → north
// (GAS_BAND_COUNT-1); the shader does linear filtering so bands blend
// smoothly without visible LUT-cell edges.
export const GAS_BAND_COUNT   = 16;

export const GAS_BIOMES = [
  { id: 'dark_layer',      name: 'Dark Layer',      color: 0x4a3528, archs: ['gas_giant'] },
  { id: 'storm_belt',      name: 'Storm Belt',      color: 0x5e2f1d, archs: ['gas_giant'] },
  { id: 'lower_cloud',     name: 'Lower Cloud',     color: 0x8a5a3a, archs: ['gas_giant'] },
  { id: 'great_spot',      name: 'Great Spot',      color: 0xb5462c, archs: ['gas_giant'] },
  { id: 'ammonia_sulfide', name: 'NH4SH Cloud',     color: 0xc16a4f, archs: ['gas_giant'] },
  { id: 'sulfur',          name: 'Sulfur Layer',    color: 0xd4912d, archs: ['gas_giant'] },
  { id: 'mid_cloud',       name: 'Mid Cloud',       color: 0xc6a378, archs: ['gas_giant'] },
  { id: 'upper_haze',      name: 'Upper Haze',      color: 0xe8d5b0, archs: ['gas_giant'] },
  { id: 'ammonia',         name: 'Ammonia Belt',    color: 0xefe5b8, archs: ['gas_giant'] },
  { id: 'helium_sheath',   name: 'Helium Sheath',   color: 0xf5f0e8, archs: ['gas_giant', 'ice_giant'] },
  { id: 'hydrogen_deep',   name: 'Hydrogen Deep',   color: 0x1f3b6e, archs: ['ice_giant'] },
  { id: 'methane_sea',     name: 'Methane Sea',     color: 0x3a6cb4, archs: ['ice_giant'] },
  { id: 'methane',         name: 'Methane',         color: 0x5e8fc2, archs: ['ice_giant'] },
  { id: 'phosphine',       name: 'Phosphine',       color: 0x6c91c8, archs: ['ice_giant'] },
  { id: 'aurora',          name: 'Aurora Glow',     color: 0x6cdcc1, archs: ['ice_giant'] },
  { id: 'methane_ice',     name: 'Methane Ice',     color: 0x71c6cf, archs: ['ice_giant'] },
  { id: 'polar_cap',       name: 'Polar Cap',       color: 0xc4cfde, archs: ['ice_giant'] },
  { id: 'frost_veil',      name: 'Frost Veil',      color: 0xd8e8f0, archs: ['ice_giant'] },
  { id: 'ice_crystal',     name: 'Ice Crystal',     color: 0xeaf4fb, archs: ['ice_giant'] },
  { id: 'white_ice',       name: 'White Ice',       color: 0xfafdff, archs: ['ice_giant'] },
];

export function gasBiomesForArchetype(arch) {
  const key = arch || 'gas_giant';
  const list = GAS_BIOMES.filter(b => b.archs.includes(key));
  return list.length ? list : GAS_BIOMES.filter(b => b.archs.includes('gas_giant'));
}

export function gasBiomeById(id) {
  return GAS_BIOMES.find(b => b.id === id) || null;
}

export function makeGasMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader: GAS_VERT,
    fragmentShader: GAS_FRAG,
    uniforms: {
      uColor:    { value: new THREE.Color(0xffffff) },
      uSkyTint:  { value: new THREE.Color(0x87ceeb) },
      uSunDir:   { value: new THREE.Vector3(1, 0, 0) },
      uDensity:  { value: 0.18 },
      uMode:     { value: 0.0 },
      uCoverage: { value: 0.35 },
      uOpaqueSky:{ value: 0.0 },
      uShellScale:{ value: 1.10 },
      uTime:     { value: 0.0 },
      uWindSpeed:{ value: 0.05 },
      uWindMode: { value: 0.0 },
      uBandTex:  { value: DEFAULT_BAND_TEX },
      uUseBands: { value: 0.0 },
      uFeatureCount:     { value: 0 },
      uFeatureCenters:   { value: Array.from({ length: GAS_MAX_FEATURES }, () => new THREE.Vector3(0, 1, 0)) },
      uFeatureRadii:     { value: new Float32Array(GAS_MAX_FEATURES) },
      uFeatureStrengths: { value: new Float32Array(GAS_MAX_FEATURES) },
    },
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide,
  });
}

export function ensureGasPaint(body) {
  if (body.gasPaint) return body.gasPaint;
  const bandsRGB = new Float32Array(GAS_BAND_COUNT * 3);
  const data     = new Uint8Array(GAS_BAND_COUNT * 4);
  const base = body.gasMesh.material.uniforms.uColor.value;
  for (let i = 0; i < GAS_BAND_COUNT; i++) {
    const t = (i + 0.5) / GAS_BAND_COUNT;
    const v = 0.85 + 0.18 * Math.sin(t * Math.PI * 6);
    bandsRGB[i * 3]     = Math.min(1, base.r * v);
    bandsRGB[i * 3 + 1] = Math.min(1, base.g * v);
    bandsRGB[i * 3 + 2] = Math.min(1, base.b * v);
  }
  const tex = new THREE.DataTexture(data, GAS_BAND_COUNT, 1, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  const defaultBiome = (gasBiomesForArchetype(currentArchetype)[0] || GAS_BIOMES[0]).id;
  const bandBiomes = new Array(GAS_BAND_COUNT).fill(defaultBiome);
  body.gasPaint = { bandsRGB, data, tex, bandBiomes, features: [] };
  commitGasPaint(body.gasPaint);
  return body.gasPaint;
}

export function commitGasPaint(gp) {
  for (let i = 0; i < GAS_BAND_COUNT; i++) {
    const r = gp.bandsRGB[i * 3];
    const g = gp.bandsRGB[i * 3 + 1];
    const b = gp.bandsRGB[i * 3 + 2];
    gp.data[i * 4]     = r <= 0 ? 0 : r >= 1 ? 255 : Math.round(r * 255);
    gp.data[i * 4 + 1] = g <= 0 ? 0 : g >= 1 ? 255 : Math.round(g * 255);
    gp.data[i * 4 + 2] = b <= 0 ? 0 : b >= 1 ? 255 : Math.round(b * 255);
    gp.data[i * 4 + 3] = 255;
  }
  gp.tex.needsUpdate = true;
}

export function applyGasPaintBrush(body, centerLocal, dt) {
  const gp = ensureGasPaint(body);
  const len = Math.hypot(centerLocal.x, centerLocal.y, centerLocal.z) || 1;
  const ny = centerLocal.y / len;
  const centerLat = ny * 0.5 + 0.5;
  const latRadius = Math.max(1e-3, brushRadius / Math.PI);
  const lerpRate = Math.min(1, brushStrength * 0.5 * dt);
  let changed = false;
  for (let i = 0; i < GAS_BAND_COUNT; i++) {
    const lat = (i + 0.5) / GAS_BAND_COUNT;
    const d = Math.abs(lat - centerLat);
    if (d > latRadius) continue;
    const t = d / latRadius;
    const f = 1 - t * t;
    const k = lerpRate * f * f;
    if (k <= 0) continue;
    const inv = 1 - k;
    gp.bandsRGB[i * 3]     = gp.bandsRGB[i * 3]     * inv + gasPaintColor.r * k;
    gp.bandsRGB[i * 3 + 1] = gp.bandsRGB[i * 3 + 1] * inv + gasPaintColor.g * k;
    gp.bandsRGB[i * 3 + 2] = gp.bandsRGB[i * 3 + 2] * inv + gasPaintColor.b * k;
    if (selectedGasBiomeId) gp.bandBiomes[i] = selectedGasBiomeId;
    changed = true;
  }
  if (changed) commitGasPaint(gp);
}

export function randomizeGasBands(body, seedStr) {
  const gp = ensureGasPaint(body);
  const arch = body.archetype || currentArchetype || 'gas_giant';
  const palette = gasBiomesForArchetype(arch);
  const rng = makeRNG(hashSeed(String(seedStr || body.name || 'gas') + ':gas'));
  const zoneCount = 3 + Math.floor(rng() * 4);
  const edges = [0];
  for (let z = 1; z < zoneCount; z++) edges.push(rng());
  edges.push(1);
  edges.sort((a, b) => a - b);
  const zoneBiomes = [];
  for (let z = 0; z < zoneCount; z++) {
    zoneBiomes.push(palette[Math.floor(rng() * palette.length)]);
  }
  const tmpCol = new THREE.Color();
  for (let i = 0; i < GAS_BAND_COUNT; i++) {
    const lat = (i + 0.5) / GAS_BAND_COUNT;
    let zi = 0;
    for (let z = 0; z < zoneCount; z++) {
      if (lat >= edges[z] && lat < edges[z + 1]) { zi = z; break; }
    }
    const biome = zoneBiomes[zi];
    tmpCol.setHex(biome.color);
    const v = 0.85 + 0.22 * rng();
    gp.bandsRGB[i * 3]     = Math.min(1, tmpCol.r * v);
    gp.bandsRGB[i * 3 + 1] = Math.min(1, tmpCol.g * v);
    gp.bandsRGB[i * 3 + 2] = Math.min(1, tmpCol.b * v);
    gp.bandBiomes[i] = biome.id;
  }
  commitGasPaint(gp);
}

const GAS_VORTEX_MAX_STRENGTH = Math.PI * 2;
// Per-second growth while held — at default ~3 sec to fully wind up.
const GAS_VORTEX_GROWTH_RATE  = (Math.PI * 2) / 3;

export function addGasVortex(body, centerLocal) {
  const gp = ensureGasPaint(body);
  const cx = centerLocal.x, cy = centerLocal.y, cz = centerLocal.z;
  const inv = 1 / (Math.hypot(cx, cy, cz) || 1);
  const vortex = {
    dx: cx * inv, dy: cy * inv, dz: cz * inv,
    radius: brushRadius,
    strength: 0.0,
  };
  gp.features.push(vortex);
  while (gp.features.length > GAS_MAX_FEATURES) gp.features.shift();
  updateGasFeatureUniforms(body);
  return vortex;
}

export function growGasVortex(body, vortex, dt) {
  if (!vortex) return;
  const next = vortex.strength + GAS_VORTEX_GROWTH_RATE * dt;
  vortex.strength = next > GAS_VORTEX_MAX_STRENGTH ? GAS_VORTEX_MAX_STRENGTH : next;
  updateGasFeatureUniforms(body);
}

export function clearGasFeatures(body) {
  if (!body.gasPaint) return;
  body.gasPaint.features.length = 0;
  updateGasFeatureUniforms(body);
}

export function updateGasFeatureUniforms(body) {
  if (!body.gasMesh) return;
  const gp = body.gasPaint;
  const u = body.gasMesh.material.uniforms;
  const feats = (gp && gp.features) || [];
  const n = Math.min(GAS_MAX_FEATURES, feats.length);
  u.uFeatureCount.value = n;
  for (let i = 0; i < GAS_MAX_FEATURES; i++) {
    const f = feats[i];
    const centerVec = u.uFeatureCenters.value[i];
    if (f) {
      centerVec.set(f.dx, f.dy, f.dz);
      u.uFeatureRadii.value[i] = f.radius;
      u.uFeatureStrengths.value[i] = f.strength;
    } else {
      centerVec.set(0, 1, 0);
      u.uFeatureRadii.value[i] = 0;
      u.uFeatureStrengths.value[i] = 0;
    }
  }
}
