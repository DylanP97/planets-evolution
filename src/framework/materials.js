// onBeforeCompile patches for the body and ocean materials: ice self-glow,
// surface-walk ground detail, ocean waves, shoreline foam.
import * as THREE from 'three';
import { ICE_GLOW_COLOR } from '../core/constants.js';

export function setupBodyMaterial(mat) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uGlowColor     = { value: ICE_GLOW_COLOR };
    shader.uniforms.uSurfaceDetail = { value: 0 };
    shader.uniforms.uDetailFreq    = { value: 55.0 };
    shader.uniforms.uDetailAmp     = { value: 0.18 };
    shader.uniforms.uDetailMottle  = { value: 0.05 };
    shader.uniforms.uBodyToView    = { value: new THREE.Matrix3() };
    mat.userData.detailShader = shader;
    
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aGlow;\nvarying float vGlow;\nvarying vec3 vBodyPos;\nvarying vec3 vBodyNrm;')      
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vGlow = aGlow;\n  vBodyPos = position;\n  vBodyNrm = normalize(normal);');
      
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>',
        '#include <common>\n'
      + 'uniform vec3 uGlowColor;\n'
      + 'uniform float uSurfaceDetail;\nuniform float uDetailFreq;\nuniform float uDetailAmp;\nuniform float uDetailMottle;\nuniform mat3 uBodyToView;\n'   
      + 'varying float vGlow;\nvarying vec3 vBodyPos;\nvarying vec3 vBodyNrm;\n'
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
      + '  if (uSurfaceDetail > 0.001) { diffuseColor.rgb *= 1.0 - uDetailMottle * uSurfaceDetail * (dFbm(vBodyPos * uDetailFreq * 0.5) - 0.5); }')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance += uGlowColor * vGlow;');
  };
  mat.customProgramCacheKey = () => 'bodyGlowDetail';
}

export function setupOceanMaterial(oceanMat, baseRadius) {
  oceanMat.onBeforeCompile = (shader) => {
    shader.uniforms.uGlowColor = { value: ICE_GLOW_COLOR };
    shader.uniforms.uClearA  = { value: 0.42 };
    shader.uniforms.uOpaqueA = { value: 0.92 };
    shader.uniforms.uBodyR   = { value: baseRadius };
    shader.uniforms.uSurface = { value: 0 };
    shader.uniforms.uWaveTime = { value: 0 };
    shader.uniforms.uWaveAmp  = { value: baseRadius * 0.0016 };
    oceanMat.userData.shader = shader;
    
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aGlow;\nattribute float aEvap;\nattribute float aShore;\nvarying float vGlow;\nvarying float vEvap;\nvarying float vShore;\nvarying vec3 vLocalPos;\nvarying vec3 vWNormal;\nvarying vec3 vWPos;\nuniform float uWaveTime;\nuniform float uWaveAmp;\nuniform float uSurface;\nfloat oceanWave(vec3 p){\n  float t = uWaveTime;\n  float h = 0.0;\n  h += sin(p.x * 1.3 + p.z * 0.7 + t * 1.1) * 0.60;\n  h += sin(p.z * 1.8 - p.x * 0.5 + t * 1.4) * 0.40;\n  h += sin((p.x + p.z) * 2.7 + t * 1.9) * 0.25;\n  return h;\n}')
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n  vec3 _wp = position;\n  float _wh = oceanWave(_wp) * uSurface;\n  vec3 _gnrm = normalize(objectNormal);\n  vec3 _wup = abs(_gnrm.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);\n  vec3 _t1 = normalize(cross(_gnrm, _wup));\n  vec3 _t2 = cross(_gnrm, _t1);\n  float _e = 0.25;\n  float _gx = (oceanWave(_wp + _t1 * _e) * uSurface - _wh) / _e;\n  float _gy = (oceanWave(_wp + _t2 * _e) * uSurface - _wh) / _e;\n  objectNormal = normalize(_gnrm - (_t1 * _gx + _t2 * _gy) * uWaveAmp * 6.0);')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vGlow = aGlow;\n  vEvap = aEvap;\n  vShore = aShore;\n  vLocalPos = position;\n  transformed += normalize(position) * (_wh * uWaveAmp);\n  vec4 _owp = modelMatrix * vec4(transformed, 1.0);\n  vWPos = _owp.xyz;\n  vWNormal = normalize(mat3(modelMatrix) * _gnrm);');
      
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uGlowColor;\nuniform float uClearA;\nuniform float uOpaqueA;\nuniform float uBodyR;\nuniform float uSurface;\nvarying float vGlow;\nvarying float vEvap;\nvarying float vShore;\nvarying vec3 vLocalPos;\nvarying vec3 vWNormal;\nvarying vec3 vWPos;')
      .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\n  if (vEvap > 0.5) discard;')
      .replace('#include <color_fragment>', '#include <color_fragment>\n  float _facing = abs(dot(normalize(vWNormal), normalize(cameraPosition - vWPos)));\n  float _clearA = mix(uOpaqueA, uClearA, _facing);\n  float _prox = uSurface * (1.0 - smoothstep(uBodyR * 0.6, uBodyR * 1.6, distance(cameraPosition, vWPos)));\n  diffuseColor.a = mix(uOpaqueA, _clearA, _prox);')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance += uGlowColor * vGlow;');
  };
  oceanMat.customProgramCacheKey = () => 'oceanClimate';
}
