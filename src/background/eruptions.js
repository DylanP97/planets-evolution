import * as THREE from 'three';
import { SUN_RADIUS, renderer } from '../core/scene.js';
import { sunMesh } from '../core/sun.js';

// ====== 19b. Eruptions (lava bursts off bodies) ======
// A burst of glowing molten DROPLETS ejected from a surface point: each
// particle launches outward along the local normal (with a spread cone),
// arcs back under a fake gravity, shrinks, and cools white-hot → deep red.
// Implemented as one THREE.Points per eruption with a custom shader, so the
// CPU only bumps a `uTime` uniform — the ballistic motion runs on the GPU.
// The Points object is parented to the body's group, so it rides the body's
// spin and orbit. A short, bright vent flash sprite sells the initial blast.
export const eruptions = [];
export const MAX_ERUPTIONS = 14;
export const ERUPT_PARTICLES = 26;
export let eruptionTimer = 0.6;

// Radial flame gradient for the vent flash: white core → orange → clear.
export const flameTex = (() => {
  const s = 64;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0.0, 'rgba(255,255,255,1.0)');
  g.addColorStop(0.25, 'rgba(255,225,140,0.95)');
  g.addColorStop(0.55, 'rgba(255,120,30,0.55)');
  g.addColorStop(1.0, 'rgba(200,40,0,0.0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  return new THREE.CanvasTexture(cv);
})();

// Ballistic particle shader. position = launch point; aVel = initial
// velocity (body-local units/s); the vertex integrates p = p0 + v t − ½g t²
// along the local up so droplets arc. Point size attenuates with depth and
// shrinks with age; the frag draws a soft round droplet, hot→cool by life.
export const ERUPT_VERT = /* glsl */ `
  attribute vec3  aVel;
  attribute float aSize;
  uniform float uTime;
  uniform float uLife;
  uniform vec3  uUp;
  uniform float uGravity;
  uniform float uSizePx;
  varying float vLife;
  void main() {
    float t = uTime;
    vec3 p = position + aVel * t - uUp * (0.5 * uGravity * t * t);
    vLife = clamp(t / uLife, 0.0, 1.0);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    float sz = uSizePx * aSize * (1.0 - vLife * 0.65);
    gl_PointSize = clamp(sz * (1.0 / max(0.001, -mv.z)), 1.0, 180.0);
    gl_Position = projectionMatrix * mv;
  }
`;
export const ERUPT_FRAG = /* glsl */ `
  precision highp float;
  uniform vec3 uHot;
  uniform vec3 uCool;
  varying float vLife;
  void main() {
    vec2 d = gl_PointCoord - vec2(0.5);
    float r = length(d);
    if (r > 0.5) discard;
    float soft = smoothstep(0.5, 0.1, r);   // bright core, soft edge
    vec3  col = mix(uHot, uCool, vLife);     // cool as it falls
    float alpha = soft * (1.0 - vLife * vLife);
    gl_FragColor = vec4(col, alpha);
  }
`;

export function spawnEruption(body) {
  if (eruptions.length >= MAX_ERUPTIONS) return;
  const R = body.baseRadius;
  // Random surface point + local frame (up = normal, t1/t2 = tangents).
  const z = Math.random() * 2 - 1;
  const aa = Math.random() * Math.PI * 2;
  const rr = Math.sqrt(Math.max(0, 1 - z * z));
  const up = new THREE.Vector3(rr * Math.cos(aa), z, rr * Math.sin(aa));
  const ref = Math.abs(up.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const t1 = new THREE.Vector3().crossVectors(ref, up).normalize();
  const t2 = new THREE.Vector3().crossVectors(up, t1).normalize();
  const base = up.clone().multiplyScalar(R * 1.005);

  const life = 1.0 + Math.random() * 0.7;
  const N = ERUPT_PARTICLES;
  const pos  = new Float32Array(N * 3);
  const vel  = new Float32Array(N * 3);
  const size = new Float32Array(N);
  // Launch speed sized so droplets rise ~0.4–1.0 R before gravity wins.
  const speed = R * (1.6 + Math.random() * 1.2);
  for (let i = 0; i < N; i++) {
    // Tight upward cone: mostly along `up`, with a little lateral spread.
    const spread = 0.18 + Math.random() * 0.32;
    const sa = Math.random() * Math.PI * 2;
    const dir = up.clone()
      .addScaledVector(t1, Math.cos(sa) * spread)
      .addScaledVector(t2, Math.sin(sa) * spread)
      .normalize();
    const sp = speed * (0.45 + Math.random() * 0.75);
    // Tiny jitter around the vent so they don't all start at one point.
    const j = R * 0.02;
    pos[i * 3]     = base.x + (Math.random() - 0.5) * j;
    pos[i * 3 + 1] = base.y + (Math.random() - 0.5) * j;
    pos[i * 3 + 2] = base.z + (Math.random() - 0.5) * j;
    vel[i * 3]     = dir.x * sp;
    vel[i * 3 + 1] = dir.y * sp;
    vel[i * 3 + 2] = dir.z * sp;
    size[i] = 0.5 + Math.random() * 1.3;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aVel', new THREE.BufferAttribute(vel, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  // Droplet pixel size must track the body's *world* size (group.scale can
  // shrink/grow a body) and the drawing-buffer resolution (devicePixelRatio
  // makes gl_PointSize physical pixels). Motion stays in LOCAL units so the
  // arc scales naturally with the body inside its group.
  const worldR = R * (body.group.scale.x || 1);
  const dpr = renderer.getPixelRatio();
  const mat = new THREE.ShaderMaterial({
    vertexShader: ERUPT_VERT,
    fragmentShader: ERUPT_FRAG,
    uniforms: {
      uTime:    { value: 0 },
      uLife:    { value: life },
      uUp:      { value: up.clone() },
      uGravity: { value: R * 4.5 },
      uSizePx:  { value: worldR * 130.0 * dpr },
      uHot:     { value: new THREE.Color(0xfff0c0) },
      uCool:    { value: new THREE.Color(0xb81800) },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false; // particles travel outside the geo bounds
  points.renderOrder = 3;
  body.group.add(points);

  // Bright vent flash at the blast point.
  const flash = new THREE.Sprite(new THREE.SpriteMaterial({
    map: flameTex, color: 0xffffff, transparent: true,
    depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
  }));
  flash.position.copy(base);
  flash.scale.setScalar(R * 0.4);
  flash.renderOrder = 3;
  body.group.add(flash);

  eruptions.push({ body, points, mat, flash, age: 0, life });
}

export function updateEruptions(dt) {
  // Throttled random spawning. Only the Sun erupts (solar prominences);
  // planets and moons do not.
  eruptionTimer -= dt;
  if (eruptionTimer <= 0) {
    eruptionTimer = 0.35 + Math.random() * 1.1;
    // Solar prominences only — the Sun erupts, planets/moons do not. The
    // Sun isn't in `bodies` (it's a standalone mesh), so wrap it in a
    // pseudo-body that satisfies spawnEruption (needs baseRadius + group).
    const sunBody = { baseRadius: SUN_RADIUS, group: sunMesh, matter: { plasma: true } };
    spawnEruption(sunBody);
  }
  for (let i = eruptions.length - 1; i >= 0; i--) {
    const e = eruptions[i];
    e.age += dt;
    if (e.age >= e.life) {
      e.body.group.remove(e.points);
      e.body.group.remove(e.flash);
      e.points.geometry.dispose();
      e.mat.dispose();
      e.flash.material.dispose();
      eruptions.splice(i, 1);
      continue;
    }
    e.mat.uniforms.uTime.value = e.age;
    // Flash: blooms hard in the first ~120ms, then snaps out.
    const ft = e.age / 0.18;
    if (ft < 1) {
      const R = e.body.baseRadius;
      e.flash.scale.setScalar(R * (0.3 + ft * 0.7));
      e.flash.material.opacity = 1 - ft;
      e.flash.visible = true;
    } else {
      e.flash.visible = false;
    }
  }
}

