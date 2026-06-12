// Procedural Milky Way band — a camera-riding skybox mesh.
import * as THREE from 'three';
import { scene } from '../core/scene.js';

// ====== 19a. Galactic band (procedural Milky Way) ======
// An inward-facing sphere recentred on the camera every frame (a skybox, so
// it surrounds the eye at any zoom) painted by a shader that builds the
// Milky Way from noise: a tilted bright band, clumpy star clouds, dark dust
// lanes hugging the mid-plane, fine grain, and a faintly warm galactic core.
// ADDITIVE over scene.background so it only *adds* light (lanes read as gaps
// in the glow). uBrightness is driven per-frame off the starfield's daylight
// fade, so the band blazes on the night side / in space and washes out
// behind a planet's daytime atmosphere — see the render loop.
export const milkyMat = new THREE.ShaderMaterial({
  uniforms: { uBrightness: { value: 1.0 } },
  side: THREE.BackSide,
  blending: THREE.AdditiveBlending,
  // Opaque (not `transparent`) on purpose: three.js draws transparent
  // objects in a later pass, which let this additively paint OVER planet
  // night sides. As an opaque draw with renderOrder -1 it lands first, and
  // depthWrite:false lets the planets paint over it — so it stays a backdrop.
  transparent: false,
  depthWrite: false,
  depthTest: false,
  fog: false,
  vertexShader: /* glsl */`
    varying vec3 vDir;
    void main() {
      // The mesh is only translated (to the camera), never rotated, so the
      // local vertex position doubles as a world-space view direction.
      vDir = normalize(position);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    precision highp float;
    varying vec3 vDir;
    uniform float uBrightness;

    // --- Ashima 3D simplex noise (public domain) ---
    vec4 permute(vec4 x){ return mod(((x*34.0)+1.0)*x, 289.0); }
    vec4 taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }
    float snoise(vec3 v){
      const vec2 C = vec2(1.0/6.0, 1.0/3.0);
      const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
      vec3 i  = floor(v + dot(v, C.yyy));
      vec3 x0 = v - i + dot(i, C.xxx);
      vec3 g = step(x0.yzx, x0.xyz);
      vec3 l = 1.0 - g;
      vec3 i1 = min(g.xyz, l.zxy);
      vec3 i2 = max(g.xyz, l.zxy);
      vec3 x1 = x0 - i1 + C.xxx;
      vec3 x2 = x0 - i2 + C.yyy;
      vec3 x3 = x0 - D.yyy;
      i = mod(i, 289.0);
      vec4 p = permute(permute(permute(
                 i.z + vec4(0.0, i1.z, i2.z, 1.0))
               + i.y + vec4(0.0, i1.y, i2.y, 1.0))
               + i.x + vec4(0.0, i1.x, i2.x, 1.0));
      float n_ = 1.0/7.0;
      vec3 ns = n_ * D.wyz - D.xzx;
      vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
      vec4 x_ = floor(j * ns.z);
      vec4 y_ = floor(j - 7.0 * x_);
      vec4 x = x_ * ns.x + ns.yyyy;
      vec4 y = y_ * ns.x + ns.yyyy;
      vec4 h = 1.0 - abs(x) - abs(y);
      vec4 b0 = vec4(x.xy, y.xy);
      vec4 b1 = vec4(x.zw, y.zw);
      vec4 s0 = floor(b0)*2.0 + 1.0;
      vec4 s1 = floor(b1)*2.0 + 1.0;
      vec4 sh = -step(h, vec4(0.0));
      vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy;
      vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;
      vec3 p0 = vec3(a0.xy, h.x);
      vec3 p1 = vec3(a0.zw, h.y);
      vec3 p2 = vec3(a1.xy, h.z);
      vec3 p3 = vec3(a1.zw, h.w);
      vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
      p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
      vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
      m = m * m;
      return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
    }
    float fbm(vec3 p){
      float s = 0.0, a = 0.5;
      for (int i = 0; i < 5; i++){ s += a * snoise(p); p *= 2.0; a *= 0.5; }
      return s; // ~[-1, 1]
    }

    void main(){
      vec3 dir = normalize(vDir);

      // Galactic plane: a tilted normal so the band crosses the sky diagonally.
      vec3 N = normalize(vec3(0.32, 0.90, -0.28));
      float d = dot(dir, N);                       // signed distance from plane

      // Core band: a soft Gaussian stripe about the mid-plane.
      float band = exp(-(d*d) / (2.0 * 0.16 * 0.16));

      // Large-scale clumping so the band has structure, not a flat smear.
      float clump = 0.55 + 0.55 * fbm(dir * 2.2);
      band *= clamp(clump, 0.0, 1.3);

      // Bright star-cloud knots, concentrated tight to the mid-plane.
      float knots = fbm(dir * 4.5 + 7.3);
      band += smoothstep(0.45, 0.95, knots) * exp(-(d*d) / (2.0 * 0.10 * 0.10)) * 0.6;

      // Dust lanes: dark filaments carved out of the densest part of the band.
      float dust     = fbm(dir * 3.0 + 19.0);
      float laneMask = smoothstep(0.10, 0.45, dust);
      float nearMid  = exp(-(d*d) / (2.0 * 0.09 * 0.09));
      band *= 1.0 - 0.75 * laneMask * nearMid;

      // Fine grain so the glow has texture at small scales.
      band *= 0.85 + 0.25 * fbm(dir * 22.0);
      band  = max(band, 0.0);

      // Galactic centre: a faintly warmer, brighter region toward one heading.
      vec3  C        = normalize(vec3(0.85, 0.10, 0.52));
      float toCenter = smoothstep(0.55, 1.0, dot(dir, C));

      // Subtle, low-saturation palette (blue-white edges → faint warm core).
      vec3 coolCol = vec3(0.62, 0.70, 0.92);
      vec3 warmCol = vec3(0.95, 0.86, 0.70);
      vec3 col     = mix(coolCol, warmCol, toCenter * 0.8);

      float intensity = 0.34;          // overall restraint — keep it understated
      vec3 outc = col * band * intensity * (1.0 + 0.8 * toCenter) * uBrightness;
      gl_FragColor = vec4(outc, 1.0);  // additive: only adds light to the sky
    }
  `,
});
export const milkyway = new THREE.Mesh(new THREE.SphereGeometry(100, 64, 32), milkyMat);
milkyway.renderOrder = -1;       // paint first, behind stars / planets / sun
milkyway.frustumCulled = false;  // always recentred on the camera each frame
scene.add(milkyway);

