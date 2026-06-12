import * as THREE from 'three';

export const PLASMA_VERT = /* glsl */ `
  varying vec3 vLocalDir;
  varying vec3 vWorldNormal;
  varying vec3 vViewDir;
  varying vec3 vWorldPos;
  varying vec3 vCenter;
  void main() {
    vLocalDir = normalize(position);
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    vCenter = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    vViewDir = normalize(cameraPosition - wp.xyz);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

export const PLASMA_FRAG = /* glsl */ `
  precision highp float;
  varying vec3 vLocalDir;
  varying vec3 vWorldNormal;
  varying vec3 vViewDir;
  varying vec3 vWorldPos;
  varying vec3 vCenter;
  uniform float uTime;
  uniform float uScale;
  uniform float uSpeed;
  uniform float uBright;
  uniform float uFlares;
  uniform float uWhiten;
  uniform float uWhitenNear;
  uniform float uWhitenFar;
  uniform vec3  uColorDeep;
  uniform vec3  uColorLow;
  uniform vec3  uColorMid;
  uniform vec3  uColorHot;

  #define NFLARES 6

  float hash1(float n) { return fract(sin(n) * 43758.5453123); }

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
    for (int i = 0; i < 5; i++) {
      v += a * vnoise(x);
      x *= 2.07;
      a *= 0.5;
    }
    return v;
  }

  float plasmaField(vec3 p, float t) {
    vec3 q = vec3(
      fbm(p + vec3(0.0, 0.0, t * 0.06)),
      fbm(p + vec3(5.2, 1.3, t * 0.05)),
      fbm(p + vec3(1.7, 9.2, t * 0.07))
    );
    vec3 warped = p + 2.0 * q;
    float flow = fbm(warped + vec3(t * 0.04, 0.0, 0.0));
    float bubble = fbm(p * 2.6 + vec3(-t * 0.16, t * 0.13, t * 0.11));
    return flow * 0.68 + bubble * 0.32;
  }

  float flares(vec3 dir, float t) {
    float total = 0.0;
    for (int i = 0; i < NFLARES; i++) {
      float fi = float(i);
      float period = 3.5 + hash1(fi * 1.31) * 4.0;
      float tt   = t / period + hash1(fi * 2.17);
      float cyc  = floor(tt);
      float life = fract(tt);
      float h1 = hash1(fi * 3.7 + cyc * 7.13);
      float h2 = hash1(fi * 5.3 + cyc * 3.91);
      float z  = h1 * 2.0 - 1.0;
      float aa = h2 * 6.2831853;
      float rr = sqrt(max(0.0, 1.0 - z * z));
      vec3  fdir = vec3(rr * cos(aa), z, rr * sin(aa));
      float ang  = acos(clamp(dot(dir, fdir), -1.0, 1.0));
      float swell  = smoothstep(0.0, 0.40, life);
      float fade   = 1.0 - smoothstep(0.62, 1.0, life);
      float pop    = smoothstep(0.50, 0.66, life);
      float bright = swell * fade;
      float sigma  = mix(0.05, 0.10, swell) + pop * 0.06;
      float core   = exp(-(ang * ang) / (2.0 * sigma * sigma)) * bright;
      float ringR  = pop * 0.20;
      float ring   = exp(-pow((ang - ringR) / 0.035, 2.0)) * pop * fade;
      total += core + ring * 0.7;
    }
    return total;
  }

  void main() {
    vec3  dir = normalize(vLocalDir);
    float t   = uTime * uSpeed;
    float f   = plasmaField(dir * uScale, t);
    float pulse   = 0.5 + 0.5 * sin(t * 0.6 + f * 6.2831);
    float hotZone = smoothstep(0.52, 0.86, f + pulse * 0.14);
    vec3 col = mix(uColorDeep, uColorLow, smoothstep(0.12, 0.42, f));
    col = mix(col, uColorMid, smoothstep(0.42, 0.68, f));
    col = mix(col, uColorHot, hotZone);
    float lane = smoothstep(0.14, 0.0, f);
    col = mix(col, uColorDeep * 0.35, lane * 0.7);
    float fl = flares(dir, t) * uFlares;
    col = mix(col, uColorHot, clamp(fl, 0.0, 1.0));
    col += uColorHot * fl * 0.4;
    col *= uBright;
    float NdotV = clamp(abs(dot(normalize(vWorldNormal), normalize(vViewDir))), 0.0, 1.0);
    float rim = pow(1.0 - NdotV, 3.2);
    col += uColorHot * rim * 0.25;
    col *= 0.94 + 0.06 * sin(t * 0.9);
    if (uWhiten > 0.0) {
      float camDist = distance(cameraPosition, vCenter);
      float w = uWhiten * smoothstep(uWhitenNear, uWhitenFar, camDist);
      col = mix(col, vec3(1.0, 0.98, 0.94) * max(1.0, uBright), w * 0.75);
    }
    gl_FragColor = vec4(col, 1.0);
  }
`;

export function makePlasmaMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader: PLASMA_VERT,
    fragmentShader: PLASMA_FRAG,
    uniforms: {
      uTime:      { value: 0.0 },
      uScale:     { value: 3.6 },
      uSpeed:     { value: 1.0 },
      uBright:    { value: 1.28 },
      uFlares:    { value: 0.9 },
      uWhiten:    { value: 0.0 },
      uWhitenNear:{ value: 100.0 },
      uWhitenFar: { value: 600.0 },
      uColorDeep: { value: new THREE.Color(0x5a0e00) },
      uColorLow:  { value: new THREE.Color(0xc73a00) },
      uColorMid:  { value: new THREE.Color(0xff9b1e) },
      uColorHot:  { value: new THREE.Color(0xfff4d0) },
    },
    side: THREE.FrontSide,
    transparent: false,
    depthWrite: true,
    fog: false,
  });
}
