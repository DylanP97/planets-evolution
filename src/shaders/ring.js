import * as THREE from 'three';

export const RING_VERT = /* glsl */ `
  varying vec3 vLocalPos;
  varying vec3 vWorldPos;
  varying vec3 vWorldNormal;
  void main() {
    vLocalPos = position;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

export const RING_FRAG = /* glsl */ `
  precision highp float;
  varying vec3 vLocalPos;
  varying vec3 vWorldPos;
  varying vec3 vWorldNormal;
  uniform float uInner;
  uniform float uOuter;
  uniform float uIntensity;
  uniform vec3  uColorA;
  uniform vec3  uColorB;
  uniform vec3  uSunDir;
  uniform vec3  uBodyCenter;
  uniform float uBodyRadius;
  uniform float uGasRadius;
  uniform float uGasOpacity;

  float hash11(float n) { return fract(sin(n * 127.1) * 43758.5453); }
  float noise1(float x) {
    float i = floor(x);
    float f = fract(x);
    float u = f * f * (3.0 - 2.0 * f);
    return mix(hash11(i), hash11(i + 1.0), u);
  }
  float fbm1(float x) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 4; i++) {
      v += a * noise1(x);
      x *= 2.0;
      a *= 0.5;
    }
    return v;
  }

  void main() {
    float r = length(vLocalPos);
    float t = (r - uInner) / max(1e-4, uOuter - uInner);
    if (t < 0.0 || t > 1.0) discard;

    float bands = fbm1(t * 18.0);
    bands = mix(bands, 0.5 + 0.5 * sin(t * 120.0), 0.15);

    float gapMask = 1.0;
    gapMask *= 1.0 - (smoothstep(0.40, 0.42, t) - smoothstep(0.44, 0.46, t));
    gapMask *= 1.0 - (smoothstep(0.72, 0.74, t) - smoothstep(0.76, 0.78, t));

    vec3 col = mix(uColorA, uColorB, clamp(bands, 0.0, 1.0));
    float edge = smoothstep(0.0, 0.04, t) * (1.0 - smoothstep(0.94, 1.0, t));
    float light = max(0.25, abs(dot(normalize(vWorldNormal), normalize(uSunDir))));

    vec3 rel = vWorldPos - uBodyCenter;
    vec3 sd = normalize(uSunDir);
    float along = dot(rel, sd);
    float shadow = 1.0;
    if (along < 0.0) {
      vec3 perp = rel - along * sd;
      float d = length(perp);
      shadow = smoothstep(uBodyRadius * 0.95, uBodyRadius * 1.10, d);
    }

    float alpha = uIntensity * (0.28 + 0.72 * bands) * gapMask * edge;

    if (uGasOpacity > 0.0 && uGasRadius > 0.0) {
      vec3 toFrag = vWorldPos - cameraPosition;
      float distToFrag = length(toFrag);
      vec3 rayDir = toFrag / max(distToFrag, 1e-4);
      vec3 toBody = uBodyCenter - cameraPosition;
      float tBody = dot(toBody, rayDir);
      if (tBody > 0.0 && tBody < distToFrag) {
        float perp2 = dot(toBody, toBody) - tBody * tBody;
        float gasR2 = uGasRadius * uGasRadius;
        if (perp2 < gasR2) {
          float depthFactor = sqrt(max(0.0, 1.0 - perp2 / gasR2));
          alpha *= 1.0 - clamp(depthFactor * uGasOpacity, 0.0, 1.0);
        }
      }
    }

    gl_FragColor = vec4(col * light * mix(0.30, 1.0, shadow), clamp(alpha, 0.0, 1.0));
  }
`;

export const RING_INNER_FACTOR = 1.40;
export const RING_OUTER_FACTOR = 2.30;

export function makeRingMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader: RING_VERT,
    fragmentShader: RING_FRAG,
    uniforms: {
      uInner:      { value: 1.0 },
      uOuter:      { value: 2.0 },
      uIntensity:  { value: 0.65 },
      uColorA:     { value: new THREE.Color(0x8a6b3a) },
      uColorB:     { value: new THREE.Color(0xe8d2a0) },
      uSunDir:     { value: new THREE.Vector3(1, 0, 0) },
      uBodyCenter: { value: new THREE.Vector3() },
      uBodyRadius: { value: 1.0 },
      uGasRadius:  { value: 0.0 },
      uGasOpacity: { value: 0.0 },
    },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}
