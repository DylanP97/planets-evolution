// Per-pixel underwater depth fog as a post-process pass (surface-walk only).
//
// WHY a pass and not scene.fog: three's fog (and any material-shader fog) can
// only decide "fogged or not" from the CAMERA's position — a per-frame boolean
// for the whole view. That can't separate sky-above-the-waterline from
// murk-below-it in the same frame, can't follow the wave boundary, and pops as
// the camera crosses the surface. The correct effect is PER-PIXEL: each pixel
// is fogged by how much of the view ray from the camera to that pixel travels
// BELOW the water surface — independent of where the camera is.
//
// HOW: render the surface scene into an offscreen target (colour + depth),
// then run one fullscreen shader that, for every pixel, reconstructs its world
// position from depth, intersects the camera→pixel ray with the sea-level
// SPHERE, and measures the chord that lies inside the water. That underwater
// path length drives a layered near/mid/far fog plus blue-green absorption.
//   • Sky / background pixels (depth at the far plane) work too: the ray is
//     just very long, so its in-sphere chord is measured the same way — a sky
//     pixel whose ray runs under the surface fogs to murk, one that exits above
//     it stays clear. No water geometry needed to hide the horizon.
//   • Camera position only sets the fog DENSITY (visibility shrinks as you dive
//     deeper); it never gates the effect. Straddling the waterline gives sky on
//     top and murk on the bottom in one frame, for free.
//
// The pass runs only while walking a liquid WATER world; main.js falls back to
// a plain renderer.render() everywhere else.
import * as THREE from 'three';
import { COL } from '../../core/constants.js';
import { camera, renderer, scene } from '../../core/scene.js';
import { oceanSwellDisp } from '../../framework/materials.js';
import { surfaceState } from './core.js';

let rt = null;          // scene render target (colour + depthTexture)
let quad = null;        // fullscreen triangle/quad carrying the fog shader
let quadScene = null;
let quadCam = null;
const _center   = new THREE.Vector3();
const _fogColor = new THREE.Color();
const _size     = new THREE.Vector2();
const _w2o      = new THREE.Matrix4();   // world → ocean-object space (for the wave field)
let _diagLast = 0;                        // auto-diagnostic throttle (perf.now ms)

// Tuning knobs (exposed for live console tweaking via window.uwFog — see below).
export const uwFogTuning = {
  // Layered band breakpoints as fractions of the visibility scale V (= the
  // "all gone" underwater distance). near→mid is the moderate band, mid→far
  // the dense band that swallows everything.
  // Band starts pushed OUT so the near field (incl. the 3rd-person character,
  // ~3.2 eye-heights from the camera) stays clear; the dense band still hits
  // full opacity well before the horizon (hundreds of eye-heights away).
  nearF: 0.30, midF: 0.65, farF: 1.25,
  midStrength: 0.50, deepStrength: 1.0,   // deep band fully opaque so the horizon can't bleed through
  // Per-channel absorption (× 1/V): red is eaten ~3× faster than blue, so
  // distant geometry drifts blue-green before it dissolves.
  absorb: new THREE.Vector3(2.2, 1.1, 0.7),
  // Visibility envelope (in body-eye-heights): the clear-to-opaque ramp length.
  // Kept generous so close geometry reads sharp while the far field still fully
  // fogs (full occlusion = deepStrength at farF·V, and the horizon sits far
  // past that). visFloor≈visSurface ⇒ roughly constant clarity at any depth, so
  // the trailing character never sinks into murk no matter how deep you dive.
  visSurface: 16.0, visFloor: 16.0, visPerDepth: 5.0,
  // Fog-colour darkening from the body's water tint: surface vs. deep multiplier.
  tintSurface: 0.42, tintDeep: 0.10, deepOverHeights: 18.0,
  // How much the murk colour follows the LOCAL surface colour (0 = fixed blue
  // fog, 1 = fully the sea's own tint). Makes the underwater haze read white
  // over sea-ice and blue over open water, matching the waves above it. Kept
  // high so white sea-ice isn't tinted blue by the fog bleeding over it.
  tintFollow: 0.7,
};

function ensure() {
  if (rt) return;
  renderer.getDrawingBufferSize(_size);
  rt = new THREE.WebGLRenderTarget(_size.x, _size.y, {
    type: THREE.HalfFloatType,              // smooth fog gradients, no 8-bit banding
    depthBuffer: true,
    stencilBuffer: false,
  });
  rt.depthTexture = new THREE.DepthTexture(_size.x, _size.y);
  rt.depthTexture.type = THREE.UnsignedIntType;

  const mat = new THREE.ShaderMaterial({
    depthTest: false, depthWrite: false,
    uniforms: {
      tColor:    { value: null },
      tDepth:    { value: null },
      uProjInv:  { value: new THREE.Matrix4() },
      uCamWorld: { value: new THREE.Matrix4() },
      uCamPos:   { value: new THREE.Vector3() },
      uCenter:   { value: new THREE.Vector3() },
      uSeaR:     { value: 1 },
      uVis:      { value: 1 },
      uFogColor: { value: new THREE.Color() },
      uAbsorb:   { value: new THREE.Vector3() },
      uBands:    { value: new THREE.Vector3() },   // (nearD, midD, farD) world units
      uStrength: { value: new THREE.Vector2() },   // (midStrength, deepStrength)
      uSubmerged: { value: 0 },                    // 0 above water → 1 under (fades tintFollow off)
      // Wave field shared with the ocean MESH so the murk's surface boundary
      // rides the exact same oceanWave() crests (evaluated in object space).
      uWorldToObj: { value: new THREE.Matrix4() },
      uWaveTime:   { value: 0 },
      uWaveAmp:    { value: 0 },                   // object-space crest amplitude (0 ⇒ flat sphere)
      uSurface:    { value: 0 },                   // ocean wave gate (1 in surface mode)
      uBaseR:      { value: 1 },                   // sea base radius, OBJECT units
      uScale:      { value: 1 },                   // body world scale (object → world)
      uTintFollow: { value: 0 },                   // murk colour → local surface colour blend
    },
    vertexShader: /* glsl */`
      varying vec2 vUv;
      void main() {
        vUv = uv;
        // PlaneGeometry(2,2) spans clip space directly — no camera transform.
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      precision highp float;
      uniform sampler2D tColor;
      uniform sampler2D tDepth;
      uniform mat4 uProjInv;
      uniform mat4 uCamWorld;
      uniform vec3 uCamPos;
      uniform vec3 uCenter;
      uniform float uSeaR;
      uniform float uVis;
      uniform vec3 uFogColor;
      uniform vec3 uAbsorb;
      uniform vec3 uBands;
      uniform vec2 uStrength;
      uniform mat4 uWorldToObj;
      uniform float uWaveTime;
      uniform float uWaveAmp;
      uniform float uSurface;
      uniform float uBaseR;
      uniform float uScale;
      uniform float uTintFollow;
      uniform float uSubmerged;
      varying vec2 vUv;

      // Raw wave height at an OBJECT-space sphere point — MUST stay identical to
      // oceanWaveJS()/the ocean mesh's GLSL oceanWave() (materials.js) so the
      // murk boundary and the visible crests are one surface.
      float oceanWave(vec3 p){
        float t = uWaveTime;
        float h = 0.0;
        h += sin(dot(p.xz, vec2(0.990, 0.139)) * 2.0 + t * 1.0) * 0.42;
        h += sin(dot(p.xz, vec2(0.719, 0.695)) * 2.7 + t * 1.3) * 0.30;
        h += sin(dot(p.xz, vec2(0.174, 0.985)) * 3.6 + t * 1.7) * 0.20;
        h += sin(dot(p.xz, vec2(-0.438, 0.899)) * 4.6 + t * 2.1) * 0.15;
        h += sin(dot(p.xz, vec2(-0.883, 0.469)) * 5.8 + t * 2.6) * 0.10;
        return h;
      }
      // World-space sea radius at a world point P: convert to object space,
      // displace the base radius by the swell there, convert back to world.
      float seaRadiusAt(vec3 P){
        vec3 op = (uWorldToObj * vec4(P, 1.0)).xyz;
        return (uBaseR + oceanWave(op) * uSurface * uWaveAmp) * uScale;
      }
      // Refine a sphere-crossing distance onto the WAVY surface: read the wave
      // radius at the current guess, re-solve, keep the nearest root. Cheap
      // fixed-point — converges fast since the displacement is small vs radius.
      float refineCrossing(float tt, vec3 ro, vec3 rd){
        for (int i = 0; i < 2; i++) {
          float R  = seaRadiusAt(ro + rd * tt);
          vec3  oc = ro - uCenter;
          float b  = dot(rd, oc);
          float dd = b * b - (dot(oc, oc) - R * R);
          if (dd < 0.0) break;
          float ss = sqrt(dd);
          float r1 = -b - ss, r2 = -b + ss;
          tt = abs(r1 - tt) < abs(r2 - tt) ? r1 : r2;
        }
        return tt;
      }
      void main() {
        vec3 col = texture2D(tColor, vUv).rgb;
        float d = texture2D(tDepth, vUv).x;

        // Reconstruct this pixel's world position from depth. For sky/background
        // (d≈1) this lands on the far plane — still a valid point along the ray,
        // so the in-water chord below is measured correctly there too.
        vec4 ndc  = vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
        vec4 view = uProjInv * ndc;
        view /= view.w;
        vec3 worldPos = (uCamWorld * vec4(view.xyz, 1.0)).xyz;

        vec3  toP    = worldPos - uCamPos;
        float segLen = length(toP);
        vec3  dir    = toP / max(segLen, 1e-6);

        // Length of the camera→pixel segment inside the sea-level sphere.
        vec3  oc   = uCamPos - uCenter;
        float b    = dot(dir, oc);
        float c    = dot(oc, oc) - uSeaR * uSeaR;
        float disc = b * b - c;
        float underLen = 0.0;
        if (disc > 0.0) {
          float s  = sqrt(disc);
          // Push both crossings onto the wavy oceanWave surface so the murk's
          // edge undulates with the very crests the mesh draws, not a circle.
          float t0 = refineCrossing(-b - s, uCamPos, dir);
          float t1 = refineCrossing(-b + s, uCamPos, dir);
          float enter = max(t0, 0.0);           // clamp to the camera
          float exit  = min(t1, segLen);        // clamp to the hit point
          underLen = max(0.0, exit - enter);
        }

        // Layered fog + blue-green absorption over the underwater path length.
        float medium = smoothstep(uBands.x, uBands.y, underLen) * uStrength.x;
        float deep   = smoothstep(uBands.y, uBands.z, underLen) * uStrength.y;
        float fog    = clamp(medium + deep, 0.0, 1.0);
        // Murk colour follows the local surface colour (white over sea-ice,
        // blue over open water) ONLY while above water. Once submerged this
        // fades off so the murk becomes solid water fog — otherwise the deep
        // band would take 70% of the bright background and the sky/clouds and
        // distant trees would bleed straight through the horizon.
        float tf  = uTintFollow * (1.0 - uSubmerged);
        vec3 murk = mix(uFogColor, col, tf);
        col *= exp(-underLen * uAbsorb);
        col  = mix(col, murk, fog);

        // Linear → sRGB for the canvas (the scene was rendered to a linear
        // target, so this pass owns the output encoding the renderer would
        // normally apply).
        vec3 lo = col * 12.92;
        vec3 hi = 1.055 * pow(max(col, 0.0), vec3(1.0 / 2.4)) - 0.055;
        gl_FragColor = vec4(mix(lo, hi, step(0.0031308, col)), 1.0);
      }
    `,
  });

  quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  quad.frustumCulled = false;
  quadScene = new THREE.Scene();
  quadScene.add(quad);
  quadCam = new THREE.Camera();
}

// Keep the offscreen target matched to the canvas after a resize.
export function resizeUnderwaterPass() {
  if (!rt) return;
  renderer.getDrawingBufferSize(_size);
  rt.setSize(_size.x, _size.y);   // resizes the attached depthTexture too
}

// True only while walking a liquid WATER world — the one place underwater fog
// can occur. main.js renders normally otherwise.
export function underwaterPassActive() {
  const b = surfaceState.body;
  return !!(b && b.matter && b.matter.liquid && b.oceanIsWater);
}

// True when the camera is below the sea surface. sky.js uses this to drop the
// white aerial haze while submerged so it can't wash the blue underwater murk.
// Adds the live oceanWave swell at the avatar's spot (same field as the mesh &
// buoyancy) so the test flips as a crest washes over the eye, matching the
// wavy boundary renderUnderwater() now draws.
export function cameraSubmerged() {
  const b = surfaceState.body;
  if (!underwaterPassActive()) return false;
  const scale = b.group.scale.x || 1;
  b.group.getWorldPosition(_center);
  const px = surfaceState.localUp.x * b.baseRadius;
  const pz = surfaceState.localUp.z * b.baseRadius;
  const seaLocal = b.baseRadius + oceanSwellDisp(b, px, pz);
  return camera.position.distanceTo(_center) < seaLocal * scale;
}

// Render the surface scene through the underwater fog pass. Assumes the caller
// has already verified underwaterPassActive().
export function renderUnderwater() {
  ensure();
  const b = surfaceState.body;
  const u = quad.material.uniforms;
  const t = uwFogTuning;

  // Sea surface as a sphere in WORLD units (the camera matrices live in world
  // space; with the floating origin the body centre is shifted the same way as
  // camera.position, so the two stay consistent).
  const scale = b.group.scale.x || 1;
  b.group.getWorldPosition(_center);
  const seaR = b.baseRadius * scale;   // resting (mean) sea sphere; the shader adds the swell

  const camR     = camera.position.distanceTo(_center);
  const camDepth = seaR - camR;                       // > 0 when the camera is underwater
  const ehW      = surfaceState.eyeHeight * scale;     // world-unit body height

  // Visibility scale V (world units): clear-ish at the surface, collapsing as
  // the camera dives. Above water (camDepth ≤ 0) it stays at the shallow value
  // so looking down INTO the water still reads clear near the surface.
  const vis = Math.max(ehW * t.visFloor, ehW * t.visSurface - Math.max(0, camDepth) * t.visPerDepth);
  const deepF = Math.min(1, Math.max(0, camDepth) / (ehW * t.deepOverHeights));
  _fogColor.setHex(b.oceanBaseColor || COL.water)
    .multiplyScalar(t.tintSurface * (1 - deepF) + t.tintDeep * deepF);

  u.tColor.value = rt.texture;
  u.tDepth.value = rt.depthTexture;
  u.uProjInv.value.copy(camera.projectionMatrix).invert();
  camera.updateMatrixWorld();
  u.uCamWorld.value.copy(camera.matrixWorld);
  u.uCamPos.value.copy(camera.position);
  u.uCenter.value.copy(_center);
  u.uSeaR.value = seaR;
  u.uVis.value = vis;
  u.uFogColor.value.copy(_fogColor);
  u.uAbsorb.value.set(t.absorb.x / vis, t.absorb.y / vis, t.absorb.z / vis);
  u.uBands.value.set(vis * t.nearF, vis * t.midF, vis * t.farF);
  u.uStrength.value.set(t.midStrength, t.deepStrength);
  u.uTintFollow.value = t.tintFollow;
  // Ramp 0→1 as the camera sinks below the surface (over half an eye height) so
  // the colour-follow fades off and the murk turns solidly occluding underwater.
  u.uSubmerged.value = Math.max(0, Math.min(1, camDepth / (ehW * 0.5)));

  // Wave field for the murk boundary: the ocean MESH's own oceanWave(), in its
  // object space, so the two are one surface. Off (amp 0) until the ocean
  // shader has compiled — then the boundary is a smooth static sphere.
  const osh = b.oceanMesh && b.oceanMesh.material.userData.shader;
  if (osh) {
    b.oceanMesh.updateMatrixWorld();
    _w2o.copy(b.oceanMesh.matrixWorld).invert();
    u.uWorldToObj.value.copy(_w2o);
    u.uWaveTime.value = osh.uniforms.uWaveTime.value;
    u.uWaveAmp.value  = osh.uniforms.uWaveAmp.value;
    u.uSurface.value  = osh.uniforms.uSurface.value;
    u.uBaseR.value    = b.baseRadius;
    u.uScale.value    = scale;
  } else {
    u.uWaveAmp.value = 0;
  }

  renderer.setRenderTarget(rt);
  renderer.render(scene, camera);     // clears to scene.background automatically
  renderer.setRenderTarget(null);
  renderer.render(quadScene, quadCam);

  // Opt-in auto-diagnostic: set window.uwAutoDiag = true to log the wave-
  // unification state ~1×/s (handy because opening dev-tools drops out of the
  // surface view). Off by default.
  if (typeof window !== 'undefined' && window.uwAutoDiag) {
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (now - _diagLast > 1000) {
      _diagLast = now;
      console.log('[uwDiag]', JSON.stringify(window.uwDiag()));
    }
  }
}

// In-app diagnostics / live tuning: tweak window.uwFog.* in the console.
// window.uwDiag() dumps the live wave-unification state so we can tell cache
// vs logic vs values apart in one shot.
if (typeof window !== 'undefined') {
  window.uwFog = uwFogTuning;
  window.uwAutoDiag = false;   // set true to auto-log uwDiag() ~1×/s while on a water world
  window.uwDiag = () => {
    const b = surfaceState.body;
    const osh = b && b.oceanMesh && b.oceanMesh.material.userData.shader;
    const px = b ? surfaceState.localUp.x * b.baseRadius : 0;
    const pz = b ? surfaceState.localUp.z * b.baseRadius : 0;
    return {
      active: underwaterPassActive(),
      body: b && (b.name || '(unnamed)'),
      hasOceanMesh: !!(b && b.oceanMesh),
      hasOceanShader: !!osh,
      uSurface: osh ? osh.uniforms.uSurface.value : null,
      uWaveAmp: osh ? osh.uniforms.uWaveAmp.value : null,
      baseRadius: b ? b.baseRadius : null,
      eyeHeight: surfaceState.eyeHeight,
      swellDispAtAvatar: b ? oceanSwellDisp(b, px, pz) : null,
      swimming: surfaceState.swimming,
      submerged: cameraSubmerged(),
    };
  };
}
