// Additive corona glow dome around stars (impact-parameter falloff).
import * as THREE from 'three';
import { PLASMA_VERT } from './plasma.js';

export const CORONA_FRAG = /* glsl */ `
  precision highp float;
  varying vec3 vWorldPos;
  uniform float uTime;
  uniform vec3  uColor;
  uniform vec3  uCenter;
  uniform float uRsun;
  uniform float uRc;
  void main() {
    vec3  OC   = uCenter - cameraPosition;
    vec3  rayD = normalize(vWorldPos - cameraPosition);
    float tca  = dot(OC, rayD);
    float b    = sqrt(max(0.0, dot(OC, OC) - tca * tca));
    float halo = clamp((uRc - b) / max(1e-3, uRc - uRsun), 0.0, 1.0);
    halo = pow(halo, 2.4);
    vec3  nd = normalize(vWorldPos - uCenter);
    float ph = nd.x * 2.3 + nd.y * 1.7 + nd.z * 1.9;
    float flicker = 0.55
                  + 0.30 * sin(uTime * 1.8 + ph * 3.0)
                  + 0.18 * sin(uTime * 3.3 + ph * 5.7)
                  + 0.12 * sin(uTime * 0.7 - ph * 2.1);
    flicker = clamp(flicker, 0.1, 1.4);
    gl_FragColor = vec4(uColor, halo * 0.85 * flicker);
  }
`;

export function makeCoronaMaterial(colorHex, rSun, rC) {
  return new THREE.ShaderMaterial({
    vertexShader: PLASMA_VERT,
    fragmentShader: CORONA_FRAG,
    uniforms: {
      uTime:   { value: 0.0 },
      uColor:  { value: new THREE.Color(colorHex) },
      uCenter: { value: new THREE.Vector3(0, 0, 0) },
      uRsun:   { value: rSun },
      uRc:     { value: rC },
    },
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
}
