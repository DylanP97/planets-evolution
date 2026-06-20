// onBeforeCompile patches for the body and ocean materials: ice self-glow,
// surface-walk ground detail, ocean waves, shoreline foam, moon eclipse shadow.
import * as THREE from 'three';
import { ICE_GLOW_COLOR } from '../core/constants.js';

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
// (≈ [-1.25, 1.25]) that the shader multiplies by uSurface·uWaveAmp for the
// radial displacement. KEEP IN SYNC with the GLSL `oceanWave()` string in
// setupOceanMaterial — the swimmer's buoyancy (walk.js) and the underwater fog
// boundary must ride the exact same crests as the rendered mesh.
export function oceanWaveJS(x, z, t) {
  return Math.sin(x * 3.3 + z * 1.8 + t * 1.3) * 0.60
       + Math.sin(z * 4.6 - x * 1.3 + t * 1.6) * 0.40
       + Math.sin((x + z) * 6.9 + t * 2.2) * 0.25;
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

export function setupOceanMaterial(oceanMat, baseRadius) {
  oceanMat.onBeforeCompile = (shader) => {
    shader.uniforms.uGlowColor = { value: ICE_GLOW_COLOR };
    shader.uniforms.uClearA  = { value: 0.42 };
    shader.uniforms.uOpaqueA = { value: 0.92 };
    shader.uniforms.uBodyR   = { value: baseRadius };
    shader.uniforms.uSurface = { value: 0 };
    shader.uniforms.uWaveTime = { value: 0 };
    // Swell height. Kept low on purpose: the shore can be near-flat, where the
    // waterline excursion ≈ waveAmp ÷ slope, so a tall swell sweeps the coast a
    // long way in/out. 0.0022 keeps the tide creep modest on flat beaches.
    shader.uniforms.uWaveAmp  = { value: baseRadius * 0.0022 };
    addEclipseUniforms(shader);
    oceanMat.userData.shader = shader;
    
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aGlow;\nattribute float aEvap;\nattribute float aShore;\nvarying float vGlow;\nvarying float vEvap;\nvarying float vShore;\nvarying vec3 vLocalPos;\nvarying vec3 vWNormal;\nvarying vec3 vWPos;\nuniform float uWaveTime;\nuniform float uWaveAmp;\nuniform float uSurface;\nfloat oceanWave(vec3 p){\n  float t = uWaveTime;\n  float h = 0.0;\n  h += sin(p.x * 3.3 + p.z * 1.8 + t * 1.3) * 0.60;\n  h += sin(p.z * 4.6 - p.x * 1.3 + t * 1.6) * 0.40;\n  h += sin((p.x + p.z) * 6.9 + t * 2.2) * 0.25;\n  return h;\n}')
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n  vec3 _wp = position;\n  float _wh = oceanWave(_wp) * uSurface;\n  vec3 _gnrm = normalize(objectNormal);\n  vec3 _wup = abs(_gnrm.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);\n  vec3 _t1 = normalize(cross(_gnrm, _wup));\n  vec3 _t2 = cross(_gnrm, _t1);\n  float _e = 0.12;\n  float _gx = (oceanWave(_wp + _t1 * _e) * uSurface - _wh) / _e;\n  float _gy = (oceanWave(_wp + _t2 * _e) * uSurface - _wh) / _e;\n  objectNormal = normalize(_gnrm - (_t1 * _gx + _t2 * _gy) * uWaveAmp * 6.0);')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vGlow = aGlow;\n  vEvap = aEvap;\n  vShore = aShore;\n  vLocalPos = position;\n  transformed += normalize(position) * (_wh * uWaveAmp);\n  vec4 _owp = modelMatrix * vec4(transformed, 1.0);\n  vWPos = _owp.xyz;\n  vWNormal = normalize(mat3(modelMatrix) * _gnrm);');
      
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uGlowColor;\nuniform float uClearA;\nuniform float uOpaqueA;\nuniform float uBodyR;\nuniform float uSurface;\nvarying float vGlow;\nvarying float vEvap;\nvarying float vShore;\nvarying vec3 vLocalPos;\nvarying vec3 vWNormal;\nvarying vec3 vWPos;\n' + ECLIPSE_GLSL)
      .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\n  if (vEvap > 0.5) discard;')
      .replace('#include <color_fragment>', '#include <color_fragment>\n  float _facing = abs(dot(normalize(vWNormal), normalize(cameraPosition - vWPos)));\n  float _clearA = mix(uOpaqueA, uClearA, _facing);\n  float _prox = uSurface * (1.0 - smoothstep(uBodyR * 0.6, uBodyR * 1.6, distance(cameraPosition, vWPos)));\n  diffuseColor.a = mix(uOpaqueA, _clearA, _prox);')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance += uGlowColor * vGlow;')
      .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n  { float _ecl = eclipseShadow(vWPos);\n    reflectedLight.directDiffuse *= _ecl;\n    reflectedLight.directSpecular *= _ecl; }');
  };
  oceanMat.customProgramCacheKey = () => 'oceanClimate';
}
