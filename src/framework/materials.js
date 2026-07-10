// onBeforeCompile patches for the body and ocean materials: ice self-glow,
// surface-walk ground detail, ocean waves, shoreline foam, moon eclipse shadow.
import * as THREE from 'three';
import { FOAM_COLOR, ICE_GLOW_COLOR } from '../core/constants.js';

// ── Moon eclipse shadow ───────────────────────────────────────────────────
// A crisp, shader-based replacement for the (disabled) system-scale shadow
// map: each moon darkens the sunlit planet fragments whose line of sight to
// the Sun passes through it. The Sun is treated as a point at uSunPos, so the
// umbra converges correctly and stays sharp at any zoom (unlike a 1024² map
// stretched across a whole solar system). Uniforms are refreshed per frame in
// system/lighting.js → updateEclipseShadows(). EC_MAX matches MAX_MOONS.
export const ECLIPSE_MAX = 4;
const ECLIPSE_GLSL =
    'const int EC_MAX = 4;\n'
  + 'uniform vec3 uSunPos;\n'
  + 'uniform int uEclipseCount;\n'
  + 'uniform vec3 uEclipsePos[EC_MAX];\n'
  + 'uniform float uEclipseRad[EC_MAX];\n'
  + 'float eclipseShadow(vec3 P){\n'
  + '  float occl = 0.0;\n'
  + '  vec3 S = normalize(uSunPos - P);\n'
  + '  for (int i = 0; i < EC_MAX; i++) {\n'
  + '    if (i >= uEclipseCount) break;\n'
  + '    vec3 toM = uEclipsePos[i] - P;\n'
  + '    float t = dot(toM, S);\n'                       // moon must be sunward
  + '    if (t <= 0.0) continue;\n'
  + '    float d = length(toM - t * S);\n'               // miss distance to ray
  + '    occl = max(occl, 1.0 - smoothstep(uEclipseRad[i] * 0.55, uEclipseRad[i] * 1.25, d));\n'
  + '  }\n'
  + '  return 1.0 - 0.9 * occl;\n'                        // leave a little fill in the umbra
  + '}\n';

function addEclipseUniforms(shader) {
  shader.uniforms.uSunPos       = { value: new THREE.Vector3() };
  shader.uniforms.uEclipseCount = { value: 0 };
  shader.uniforms.uEclipsePos   = { value: Array.from({ length: ECLIPSE_MAX }, () => new THREE.Vector3()) };
  shader.uniforms.uEclipseRad   = { value: new Float32Array(ECLIPSE_MAX) };
}

export function setupBodyMaterial(mat) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uGlowColor     = { value: ICE_GLOW_COLOR };
    shader.uniforms.uSurfaceDetail = { value: 0 };
    shader.uniforms.uDetailFreq    = { value: 55.0 };
    shader.uniforms.uDetailAmp     = { value: 0.18 };
    shader.uniforms.uDetailMottle  = { value: 0.05 };
    shader.uniforms.uBodyToView    = { value: new THREE.Matrix3() };
    // Night-side colour floor for bodies seen as distant discs in the surface
    // sky (the Moon, other planets). 0 in orbit and on the body underfoot; set
    // per-frame by modes/surface/sky.js → updateSkyBodies so the unlit limb of
    // a far moon reads as a dim version of its own colour instead of black —
    // the solid-body analogue of the gas shader's day/night floor.
    shader.uniforms.uSkyBodyFill   = { value: 0 };
    addEclipseUniforms(shader);
    mat.userData.detailShader = shader;

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aGlow;\nvarying float vGlow;\nvarying vec3 vBodyPos;\nvarying vec3 vBodyNrm;\nvarying vec3 vWorldPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vGlow = aGlow;\n  vBodyPos = position;\n  vBodyNrm = normalize(normal);\n  vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>',
        '#include <common>\n'
      + 'uniform vec3 uGlowColor;\n'
      + 'uniform float uSurfaceDetail;\nuniform float uDetailFreq;\nuniform float uDetailAmp;\nuniform float uDetailMottle;\nuniform mat3 uBodyToView;\nuniform float uSkyBodyFill;\n'
      + 'varying float vGlow;\nvarying vec3 vBodyPos;\nvarying vec3 vBodyNrm;\nvarying vec3 vWorldPos;\n'
      + ECLIPSE_GLSL
      + 'float dHash(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }\n'
      + 'float dNoise(vec3 x){ vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);\n'
      + '  return mix(mix(mix(dHash(i), dHash(i + vec3(1.0,0.0,0.0)), f.x), mix(dHash(i + vec3(0.0,1.0,0.0)), dHash(i + vec3(1.0,1.0,0.0)), f.x), f.y),\n'
      + '             mix(mix(dHash(i + vec3(0.0,0.0,1.0)), dHash(i + vec3(1.0,0.0,1.0)), f.x), mix(dHash(i + vec3(0.0,1.0,1.0)), dHash(i + vec3(1.0,1.0,1.0)), f.x), f.y), f.z); }\n'
      + 'float dFbm(vec3 p){ float a = 0.5; float s = 0.0; for(int k = 0; k < 4; k++){ s += a * dNoise(p); p *= 2.02; a *= 0.5; } return s; }')
      .replace('#include <normal_fragment_maps>',
        '#include <normal_fragment_maps>\n'
      + '  if (uSurfaceDetail > 0.001) {\n'
      + '    vec3 _dn = normalize(vBodyNrm);\n'
      + '    vec3 _dref = abs(_dn.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);\n'
      + '    vec3 _dt1 = normalize(cross(_dn, _dref));\n'
      + '    vec3 _dt2 = cross(_dn, _dt1);\n'
      + '    vec3 _dp = vBodyPos * uDetailFreq;\n'
      + '    float _dh = dFbm(_dp);\n'
      + '    float _de = 0.6;\n'
      + '    float _dgx = (dFbm(_dp + _dt1 * _de) - _dh) / _de;\n'
      + '    float _dgy = (dFbm(_dp + _dt2 * _de) - _dh) / _de;\n'
      + '    vec3 _dpn = normalize(_dn - (_dt1 * _dgx + _dt2 * _dgy) * uDetailAmp);\n'
      + '    normal = normalize(uBodyToView * mix(_dn, _dpn, uSurfaceDetail));\n'
      + '  }')
      .replace('#include <color_fragment>',
        '#include <color_fragment>\n'
      + '  if (uSurfaceDetail > 0.001) { diffuseColor.rgb *= 1.0 - uDetailMottle * uSurfaceDetail * (dFbm(vBodyPos * uDetailFreq * 0.5) - 0.5); }\n'
      // Sky-disc maria: a gentle broad albedo variation so a body seen as a far
      // disc in the surface sky (the Moon, Mars) reads as a real world with
      // subtle light/dark regions rather than a flat coin. Kept soft on purpose
      // — the body still shows mostly its own generated terrain colour. Gated to
      // sky discs only by uSkyBodyFill; normalize(vBodyPos) keeps the basin
      // scale the same on any-sized body.
      + '  if (uSkyBodyFill > 0.0001) {\n'
      + '    vec3 _skd = normalize(vBodyPos);\n'
      + '    float _skMaria = smoothstep(0.40, 0.60, dFbm(_skd * 3.0 + 4.0));\n'
      + '    diffuseColor.rgb *= mix(1.06, 0.66, _skMaria);\n'
      + '  }')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance += uGlowColor * vGlow;')
      .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n  { float _ecl = eclipseShadow(vWorldPos);\n    reflectedLight.directDiffuse *= _ecl;\n    reflectedLight.directSpecular *= _ecl; }')
      // Lift the unlit limb of a distant sky body to a dim floor of its own
      // albedo (max, so the sunlit side is untouched) — like the gas shell's
      // night floor. uSkyBodyFill is 0 everywhere but for sky discs.
      .replace('#include <opaque_fragment>', '  outgoingLight = max(outgoingLight, diffuseColor.rgb * uSkyBodyFill);\n#include <opaque_fragment>');
  };
  mat.customProgramCacheKey = () => 'bodyGlowDetail';
}

// JS mirror of the ocean shader's GLSL `oceanWave(p)` below. p = object-space
// position on the sea sphere (|p| ≈ baseRadius); returns the raw wave height
// (≈ [-1.17, 1.17]) that the shader multiplies by uSurface·uWaveAmp for the
// radial displacement. Five terms spread across five near-evenly-spaced
// directions (rather than three) so the wavefronts don't read as parallel
// straight lines when seen from near-overhead — a real chop has no single
// dominant direction. KEEP IN SYNC with the GLSL `oceanWave()` string in
// setupOceanMaterial — the swimmer's buoyancy (walk.js) and the underwater fog
// boundary must ride the exact same crests as the rendered mesh.
export function oceanWaveJS(x, z, t) {
  return Math.sin((x * 0.990 + z * 0.139) * 2.0 + t * 1.0) * 0.42
       + Math.sin((x * 0.719 + z * 0.695) * 2.7 + t * 1.3) * 0.30
       + Math.sin((x * 0.174 + z * 0.985) * 3.6 + t * 1.7) * 0.20
       + Math.sin((x * -0.438 + z * 0.899) * 4.6 + t * 2.1) * 0.15
       + Math.sin((x * -0.883 + z * 0.469) * 5.8 + t * 2.6) * 0.10;
}

// Live radial swell displacement (object/body-local units) at an object-space
// point (px,pz) on the body's sea sphere — reads the body's compiled ocean
// shader uniforms so it tracks the exact same crest the mesh is drawing this
// frame. 0 before the shader compiles or off a non-wave ocean. Used by the
// swimmer's buoyancy and the underwater fog's "am I submerged" test.
export function oceanSwellDisp(body, px, pz) {
  const sh = body && body.oceanMesh && body.oceanMesh.material.userData.shader;
  if (!sh) return 0;
  return oceanWaveJS(px, pz, sh.uniforms.uWaveTime.value)
       * sh.uniforms.uSurface.value * sh.uniforms.uWaveAmp.value;
}

// ── Tiling water normal map ─────────────────────────────────────────────────
// Two copies of this texture scroll across each other in the ocean fragment
// shader (surface mode only) — the standard game-dev way to make water read as
// living ripples. A real mip-mapped TEXTURE, not per-pixel procedural noise:
// minification averages the mips toward a flat normal in the distance, so the
// horizon stays calm instead of aliasing into a shimmering band (the failure
// mode of every procedural attempt here). Built once, seamless (periodic
// value-noise fbm → Sobel normals), shared by every ocean.
let _waterNormalTex = null;
function getWaterNormalTex() {
  if (_waterNormalTex) return _waterNormalTex;
  const S = 256;
  let seed = 987654321 >>> 0;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const octs = [];
  for (let o = 0, f = 4; o < 4; o++, f *= 2) {
    const g = new Float32Array(f * f);
    for (let i = 0; i < g.length; i++) g[i] = rand();
    octs.push({ f, g });
  }
  const smooth = (t) => t * t * (3 - 2 * t);
  const h = new Float32Array(S * S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let v = 0, amp = 0.5;
      for (const { f, g } of octs) {
        const u = (x / S) * f, w = (y / S) * f;
        const x0 = Math.floor(u) % f, y0 = Math.floor(w) % f;
        const x1 = (x0 + 1) % f, y1 = (y0 + 1) % f;
        const tx = smooth(u - Math.floor(u)), ty = smooth(w - Math.floor(w));
        const top = g[y0 * f + x0] + (g[y0 * f + x1] - g[y0 * f + x0]) * tx;
        const bot = g[y1 * f + x0] + (g[y1 * f + x1] - g[y1 * f + x0]) * tx;
        v += (top + (bot - top) * ty - 0.5) * amp;
        amp *= 0.5;
      }
      h[y * S + x] = v;
    }
  }
  const data = new Uint8Array(S * S * 4);
  const H = (x, y) => h[((y + S) % S) * S + ((x + S) % S)];
  const STR = 2.2;                       // bump strength baked into the map
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = (H(x + 1, y) - H(x - 1, y)) * STR;
      const dy = (H(x, y + 1) - H(x, y - 1)) * STR;
      const inv = 1 / Math.hypot(dx, dy, 1);
      const i = (y * S + x) * 4;
      data[i]     = ((-dx * inv) * 0.5 + 0.5) * 255;
      data[i + 1] = ((-dy * inv) * 0.5 + 0.5) * 255;
      data[i + 2] = ((inv) * 0.5 + 0.5) * 255;
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  _waterNormalTex = tex;
  return tex;
}

export function setupOceanMaterial(oceanMat, baseRadius) {
  oceanMat.onBeforeCompile = (shader) => {
    shader.uniforms.uGlowColor = { value: ICE_GLOW_COLOR };
    // uOpaqueA is the alpha far from the camera — maxed so distant water
    // reads as a solid, deep blue. uClearA is the alpha within uNearR of the
    // camera — kept low so the water right around the character is
    // see-through. Purely distance-based (no view-angle term): scaled off
    // baseRadius so uNearR stays a small fraction of the horizon distance
    // on any size body, rather than swallowing the whole visible ocean.
    shader.uniforms.uClearA  = { value: 0.15 };
    shader.uniforms.uOpaqueA = { value: 1.0 };
    shader.uniforms.uBodyR   = { value: baseRadius };
    shader.uniforms.uSurface = { value: 0 };
    shader.uniforms.uNearR   = { value: baseRadius * 0.0035 };
    shader.uniforms.uWaveTime = { value: 0 };
    // Swell height. Kept low on purpose: the shore can be near-flat, where the
    // waterline excursion ≈ waveAmp ÷ slope, so a tall swell sweeps the coast a
    // long way in/out. 0.0022 keeps the tide creep modest on flat beaches.
    shader.uniforms.uWaveAmp  = { value: baseRadius * 0.0022 };
    // Shoreline crash foam — surface-walk only (the _foam term below is
    // multiplied by uSurface, which is 0 in orbit view, so this is a no-op
    // there). uShoreW is in the same signed-height units as vShore.
    shader.uniforms.uShoreFoam = { value: 0.85 };
    shader.uniforms.uShoreW    = { value: 0.14 };
    shader.uniforms.uFoamColor = { value: FOAM_COLOR };
    // Gerstner steepness — 0 keeps the old symmetric sine bumps, 1 uses the
    // horizontal-displacement coefficients baked into oceanChop() below
    // (peaked crests, flatter troughs, the classic ocean-wave silhouette).
    // Height field (oceanWave/oceanWaveJS) is untouched by this, so buoyancy,
    // the underwater-fog boundary and the JS mirror all stay exactly in sync
    // with the mesh — only the visible XZ displacement changes.
    shader.uniforms.uGerstner  = { value: 1.0 };
    // Whitecap foam on tall open-water crests, independent of the shoreline
    // band above (that one keys off vShore/depth; this one keys off wave
    // height, so it also lights up mid-ocean swell peaks).
    shader.uniforms.uCrestFoam = { value: 0.35 };
    // Foam look/falloff tuning — exposed so the dev panel can tune them live.
    shader.uniforms.uFoamPow    = { value: 2.0 };   // edge sharpness: 1=gradual fade, higher=snaps to the waterline
    shader.uniforms.uFoamScale  = { value: 130.0 }; // bubble-texture noise frequency
    shader.uniforms.uFoamSpeed  = { value: 0.9 };   // crossfade animation rate (bubbling)
    shader.uniforms.uFoamLo     = { value: 0.25 };  // texture threshold: patch coverage low edge
    shader.uniforms.uFoamHi     = { value: 0.8 };   // texture threshold: patch coverage high edge
    // Scrolling normal-map ripples — surface-walk only (uSurface-gated).
    shader.uniforms.uNormTex   = { value: getWaterNormalTex() };
    shader.uniforms.uNormScale = { value: 0.5 };   // ripple strength
    shader.uniforms.uNormTile  = { value: 10.0 };  // tiles per body unit
    addEclipseUniforms(shader);
    oceanMat.userData.shader = shader;
    
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aGlow;\nattribute float aEvap;\nattribute float aShore;\nvarying float vGlow;\nvarying float vEvap;\nvarying float vShore;\nvarying float vCrestH;\nvarying vec3 vLocalPos;\nvarying vec3 vWNormal;\nvarying vec3 vWPos;\nuniform float uWaveTime;\nuniform float uWaveAmp;\nuniform float uSurface;\nuniform float uGerstner;\nfloat oceanWave(vec3 p){\n  float t = uWaveTime;\n  float h = 0.0;\n  h += sin(dot(p.xz, vec2(0.990, 0.139)) * 2.0 + t * 1.0) * 0.42;\n  h += sin(dot(p.xz, vec2(0.719, 0.695)) * 2.7 + t * 1.3) * 0.30;\n  h += sin(dot(p.xz, vec2(0.174, 0.985)) * 3.6 + t * 1.7) * 0.20;\n  h += sin(dot(p.xz, vec2(-0.438, 0.899)) * 4.6 + t * 2.1) * 0.15;\n  h += sin(dot(p.xz, vec2(-0.883, 0.469)) * 5.8 + t * 2.6) * 0.10;\n  return h;\n}\nvec2 oceanChop(vec3 p){\n  float t = uWaveTime;\n  vec2 c = vec2(0.0);\n  vec2 d; float ph;\n  d = vec2(0.990, 0.139); ph = dot(p.xz, d) * 2.0 + t * 1.0; c += d * (0.50 * 0.42) * cos(ph);\n  d = vec2(0.719, 0.695); ph = dot(p.xz, d) * 2.7 + t * 1.3; c += d * (0.40 * 0.30) * cos(ph);\n  d = vec2(0.174, 0.985); ph = dot(p.xz, d) * 3.6 + t * 1.7; c += d * (0.30 * 0.20) * cos(ph);\n  d = vec2(-0.438, 0.899); ph = dot(p.xz, d) * 4.6 + t * 2.1; c += d * (0.22 * 0.15) * cos(ph);\n  d = vec2(-0.883, 0.469); ph = dot(p.xz, d) * 5.8 + t * 2.6; c += d * (0.16 * 0.10) * cos(ph);\n  return c;\n}')
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n  vec3 _wp = position;\n  float _wh = oceanWave(_wp) * uSurface;\n  vec3 _gnrm = normalize(objectNormal);\n  vec3 _wup = abs(_gnrm.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);\n  vec3 _t1 = normalize(cross(_gnrm, _wup));\n  vec3 _t2 = cross(_gnrm, _t1);\n  float _e = 0.12;\n  float _gx = (oceanWave(_wp + _t1 * _e) * uSurface - _wh) / _e;\n  float _gy = (oceanWave(_wp + _t2 * _e) * uSurface - _wh) / _e;\n  objectNormal = normalize(_gnrm - (_t1 * _gx + _t2 * _gy) * uWaveAmp * 6.0);')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vGlow = aGlow;\n  vEvap = aEvap;\n  vShore = aShore;\n  vCrestH = _wh;\n  vLocalPos = position;\n  vec2 _chop = oceanChop(_wp) * uSurface * uGerstner;\n  transformed += (_t1 * _chop.x + _t2 * _chop.y) * uWaveAmp;\n  transformed += normalize(position) * (_wh * uWaveAmp);\n  vec4 _owp = modelMatrix * vec4(transformed, 1.0);\n  vWPos = _owp.xyz;\n  vWNormal = normalize(mat3(modelMatrix) * _gnrm);');
      
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uGlowColor;\nuniform float uClearA;\nuniform float uOpaqueA;\nuniform float uBodyR;\nuniform float uNearR;\nuniform float uSurface;\nuniform float uWaveTime;\nuniform float uShoreFoam;\nuniform float uShoreW;\nuniform vec3 uFoamColor;\nuniform float uFoamPow;\nuniform float uFoamScale;\nuniform float uFoamSpeed;\nuniform float uFoamLo;\nuniform float uFoamHi;\nuniform float uCrestFoam;\nuniform sampler2D uNormTex;\nuniform float uNormScale;\nuniform float uNormTile;\nvarying float vGlow;\nvarying float vEvap;\nvarying float vShore;\nvarying float vCrestH;\nvarying vec3 vLocalPos;\nvarying vec3 vWNormal;\nvarying vec3 vWPos;\nfloat oHash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }\nfloat oNoise(vec2 x){ vec2 i = floor(x); vec2 f = fract(x); f = f * f * (3.0 - 2.0 * f); return mix(mix(oHash(i), oHash(i + vec2(1.0, 0.0)), f.x), mix(oHash(i + vec2(0.0, 1.0)), oHash(i + vec2(1.0, 1.0)), f.x), f.y); }\nfloat oFbm(vec2 p){ float a = 0.5; float s = 0.0; for(int k = 0; k < 3; k++){ s += a * oNoise(p); p *= 2.03; a *= 0.5; } return s; }\n' + ECLIPSE_GLSL)
      .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\n  if (vEvap > 0.5) discard;')
      .replace('#include <color_fragment>', '#include <color_fragment>\n  float _prox = uSurface * (1.0 - smoothstep(uNearR * 0.5, uNearR, distance(cameraPosition, vWPos)));\n  diffuseColor.a = mix(uOpaqueA, uClearA, _prox);\n'
      // Shoreline foam — every term here is multiplied by uSurface (0 in
      // orbit view), so diffuseColor is bit-identical to the original above
      // whenever uSurface is 0.
      + '  float _depth = max(0.0, -vShore);\n'
      // Depth wins back opacity: the facing-based "clear" alpha above is right
      // for wading shallows, but open DEEP water reads as a solid sea even
      // looking straight down — otherwise the seabed shows through to its
      // horizon from the beach.
      + '  diffuseColor.a = mix(diffuseColor.a, max(diffuseColor.a, uOpaqueA), smoothstep(0.05, 0.9, _depth) * uSurface);\n'
      + '  float _washPhase = oNoise(vLocalPos.xz * 0.6) * 6.2832;\n'
      + '  float _wash = 0.6 + 0.4 * sin(uWaveTime * 2.2 + _washPhase);\n'
      // Foam strength: hugs the waterline and drops off quickly with depth.
      // smoothstep(edge0, edge1, x) is only well-defined for edge0 < edge1 —
      // the previous version passed (uShoreW*_wash, 0.0, _depth), i.e.
      // edge0 > edge1, which is undefined behaviour in GLSL and on at least
      // some GPUs failed to fade out at all past the edge. Written the safe
      // way round and squared for a sharper falloff so most of the visible
      // foam sits right at the shore, not spread across the open water.
      // max(..., 1e-4) guards against a divide-by-zero NaN when uShoreW is
      // dragged to 0 in the dev panel — smoothstep(0.0, 0.0, x) is 0/0, and a
      // NaN diffuseColor.a reads as fully transparent instead of clamping.
      + '  float _edge = 1.0 - smoothstep(0.0, max(uShoreW * _wash, 1e-4), _depth);\n'
      + '  float _band = pow(_edge, uFoamPow);\n'
      // Plain isotropic bubble noise: no linear scroll/stretch direction, so
      // it never streaks across the shore no matter which way the coast
      // runs — the along-shore parallel look comes entirely from _band above
      // (an isocontour of _depth, which already follows the coastline).
      + '  float _texA = oFbm(vLocalPos.xz * uFoamScale);\n'
      + '  float _texB = oFbm(vLocalPos.xz * uFoamScale + vec2(41.7, 17.3));\n'
      + '  float _stex = mix(_texA, _texB, 0.5 + 0.5 * sin(uWaveTime * uFoamSpeed));\n'
      + '  float _foam = uShoreFoam * _band * smoothstep(uFoamLo, uFoamHi, _stex) * uSurface;\n'
      // Whitecap foam: independent of the shoreline band, keyed off the wave
      // HEIGHT (vCrestH, same field the mesh geometry rides) so tall swell
      // crests out in open water pick up foam too, not just the coastline.
      + '  float _crestN = clamp(vCrestH / 1.17, -1.0, 1.0);\n'
      + '  float _crestBand = smoothstep(0.55, 0.95, _crestN);\n'
      + '  float _crestTex = oFbm(vLocalPos.xz * uFoamScale * 0.6 + vec2(uWaveTime * 0.4, -uWaveTime * 0.3));\n'
      + '  float _crestFoam = uCrestFoam * _crestBand * smoothstep(0.3, 0.75, _crestTex) * uSurface;\n'
      + '  float _foamAll = max(_foam, _crestFoam);\n'
      + '  diffuseColor.rgb = mix(diffuseColor.rgb, uFoamColor, _foamAll);\n'
      + '  diffuseColor.a = max(diffuseColor.a, _foamAll * 0.9);')
      // Scrolling normal-map ripples (surface mode only): two copies of one
      // seamless water normal map slide across each other and bend the shading
      // normal, so sun/sky light moves across the surface like real wavelets.
      // Mip-mapped minification flattens it with distance — the horizon stays
      // calm by construction. World-space tangents mapped into view space.
      .replace('#include <normal_fragment_begin>',
        '#include <normal_fragment_begin>\n'
      + '  if (uSurface > 0.001) {\n'
      + '    vec3 _rup = abs(vWNormal.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);\n'
      + '    vec3 _rt1 = normalize(cross(vWNormal, _rup));\n'
      + '    vec3 _rt2 = cross(vWNormal, _rt1);\n'
      + '    vec2 _nuv = vLocalPos.xz * uNormTile;\n'
      + '    vec3 _n1 = texture2D(uNormTex, _nuv + uWaveTime * vec2(0.030, 0.021)).xyz * 2.0 - 1.0;\n'
      + '    vec3 _n2 = texture2D(uNormTex, _nuv * 1.63 - uWaveTime * vec2(0.019, 0.027)).xyz * 2.0 - 1.0;\n'
      + '    vec2 _np = (_n1.xy + _n2.xy * 0.75) * uNormScale * uSurface;\n'
      + '    normal = normalize(normal + mat3(viewMatrix) * (_rt1 * _np.x + _rt2 * _np.y));\n'
      + '  }\n')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance += uGlowColor * vGlow;')
      .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n  { float _ecl = eclipseShadow(vWPos);\n    reflectedLight.directDiffuse *= _ecl;\n    reflectedLight.directSpecular *= _ecl; }');
  };
  oceanMat.customProgramCacheKey = () => 'oceanClimate';
}
