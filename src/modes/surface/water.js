// The local water patch ridden during surface walks: rolling waves, depth
// shading from the seabed texture, crest/shore foam, fresnel, micro-ripples.
import * as THREE from 'three';
import { COL, FOAM_COLOR } from '../../core/constants.js';
import { bakeOceanShore } from '../../framework/body.js';
import { paused, viewMode } from '../../framework/state.js';
import { surfaceState } from './core.js';

// ── Local water patch (surface-walk only) ──────────────────────────────
// The shared ocean SPHERE is far too coarse to show waves at the walking
// avatar's scale — there are only one or two triangles between the eye and the
// horizon, so sphere-level displacement can only heave slowly. In surface mode
// we instead lay a dedicated, finely-tessellated water mesh tangent to the sea
// under the avatar: a flat grid whose verts are projected onto the sea-level
// sphere (so it hugs the planet's curvature) and displaced by short-wavelength
// travelling waves in the vertex shader. It re-centres on the avatar each frame
// while the waves are sampled in ground-fixed coords (the grass treadmill's
// drift) so the swell reads as world-fixed rather than dragged along. It's only
// attached while walking a water world, so the orbit/system view never sees it.
// STEP 1: waves only (real up/down). Crest + shoreline foam come later.
export const WATER_PATCH_N = 144;          // grid resolution (verts per side)
export let waterPatch = null;
export let waterUniforms = null;

export function buildWaterPatch() {
  const N = WATER_PATCH_N;
  // Flat unit grid; after the rotate it lies in the XZ plane with position.xz
  // spanning [-1,1] (the tangent coords the shader scales by the patch radius).
  const geo = new THREE.PlaneGeometry(2, 2, N - 1, N - 1);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshStandardMaterial({
    // Opaque so it reads as a clean blue sea — at 0.92 it revealed the deep,
    // dark OCEAN_DEPTH_BOOST seabed beneath and looked blotchy. (See-through
    // shallows can come back later as a depth-aware effect.) The shader still
    // fades alpha at the rim, which needs transparent:true. Roughness is low
    // so the micro-ripple normals (fragment shader) throw real sun glints.
    color: 0xffffff, roughness: 0.12, metalness: 0.04,
    transparent: true, opacity: 1.0, side: THREE.DoubleSide,
  });
  mat.polygonOffset = true;          // bias against the global ocean sphere it sits on
  mat.polygonOffsetFactor = -1;
  mat.polygonOffsetUnits = -1;
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uPUp    = { value: new THREE.Vector3(0, 1, 0) };
    sh.uniforms.uPRight = { value: new THREE.Vector3(1, 0, 0) };
    sh.uniforms.uPFwd   = { value: new THREE.Vector3(0, 0, 1) };
    sh.uniforms.uPR     = { value: 0.4 };           // patch half-size (body-local units)
    sh.uniforms.uBodyR  = { value: 12 };            // sea-level radius (curvature)
    sh.uniforms.uLift   = { value: 0.004 };         // tiny outward bias over the sphere ocean
    sh.uniforms.uDrift  = { value: new THREE.Vector2(0, 0) };  // ground-fixed wave offset
    sh.uniforms.uWaveTime = { value: 0 };
    sh.uniforms.uWaveAmp  = { value: 0.004 };
    // STEP 2 — crest foam: white foam riding the tops of the waves.
    sh.uniforms.uFoamColor = { value: FOAM_COLOR };
    sh.uniforms.uCrestFoam = { value: 0.85 };       // crest foam strength (0 = off)
    // Depth-based look (clearer shallows → deeper blue) + STEP 3 shoreline foam.
    // uSeabedTex is the equirect seabed-height map (built by bakeOceanShore);
    // the shader reads water depth under each fragment from it.
    sh.uniforms.uSeabedTex  = { value: null };
    sh.uniforms.uShallowCol = { value: new THREE.Color(0x9fe0ee) };  // clear shallow tint
    sh.uniforms.uDeepCol    = { value: new THREE.Color(0x2f7fc0) };  // deeper open-water tint
    sh.uniforms.uShallowA   = { value: 0.72 };      // alpha in the shallows (only slightly see-through)
    sh.uniforms.uDeepA      = { value: 0.95 };      // alpha in deep water (near opaque)
    sh.uniforms.uDepthFade  = { value: 0.65 };      // seabed-height units over which it deepens
    sh.uniforms.uShoreFoam  = { value: 0.9 };       // shoreline crash-foam strength
    sh.uniforms.uShoreW     = { value: 0.16 };      // shoreline foam band width (depth units)
    // Stylized self-illumination floor so the water keeps its clear blue even
    // in dim / colour-tinted surface lighting instead of crushing to near-black.
    sh.uniforms.uWaterGlow  = { value: 0.28 };
    // Micro-ripple normal strength (fragment-level sparkle between the
    // vertex-displaced swells) and the pale sky tint the fresnel term pulls
    // the water toward at grazing view angles.
    sh.uniforms.uRipple     = { value: 0.35 };
    sh.uniforms.uHorizonCol = { value: new THREE.Color(0xcfe9f5) };
    waterUniforms = sh.uniforms;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>',
        '#include <common>\nuniform vec3 uPUp;\nuniform vec3 uPRight;\nuniform vec3 uPFwd;\nuniform float uPR;\nuniform float uBodyR;\nuniform float uLift;\nuniform vec2 uDrift;\nuniform float uWaveTime;\nuniform float uWaveAmp;\nvarying float vEdge;\nvarying float vWaveH;\nvarying vec2 vW;\nvarying vec3 vDir;\nvarying vec3 vTanR;\nvarying vec3 vTanF;\n'
      + 'float wv(vec2 p){\n  float t = uWaveTime;\n  float h = 0.0;\n'
      + '  h += sin(dot(p, vec2(1.0, 0.25)) * 60.0 + t * 1.6) * 0.50;\n'
      + '  h += sin(dot(p, vec2(-0.35, 1.0)) * 85.0 - t * 1.9) * 0.32;\n'
      + '  h += sin(dot(p, vec2(0.80, 0.60)) * 130.0 + t * 2.6) * 0.18;\n'
      + '  return h;\n}')
      // Project the grid point onto the sea sphere, bump the normal from the
      // wave slope (finite differences), then displace radially by wave height.
      .replace('#include <beginnormal_vertex>',
        '#include <beginnormal_vertex>\n'
      + '  vec2 _uv = position.xz;\n'
      + '  float _u = _uv.x * uPR;\n  float _v = _uv.y * uPR;\n'
      + '  vec2 _w = vec2(_u, _v) + uDrift;\n'
      + '  float _h = wv(_w);\n'
      + '  vec3 _dir = normalize(uPUp * uBodyR + uPRight * _u + uPFwd * _v);\n'
      + '  float _e = 0.004;\n'
      + '  float _hR = wv(_w + vec2(_e, 0.0));\n  float _hF = wv(_w + vec2(0.0, _e));\n'
      + '  vec3 _grad = (uPRight * (_hR - _h) + uPFwd * (_hF - _h)) / _e;\n'
      + '  objectNormal = normalize(_dir - _grad * uWaveAmp * 1.2);\n')
      .replace('#include <begin_vertex>',
        '#include <begin_vertex>\n'
      + '  transformed = _dir * (uBodyR + uLift + _h * uWaveAmp);\n'
      + '  vEdge = max(abs(_uv.x), abs(_uv.y));\n'
      + '  vWaveH = _h;\n'      // wave height ∈[-1,1] (crest ≈ +1) → crest foam
      + '  vW = _w;\n'          // ground-fixed coords → foam noise rides the wave
      + '  vDir = _dir;\n'      // unit body-local dir → equirect seabed-depth lookup
      // View-space patch tangents for the fragment micro-ripples (the
      // fragment normal is view-space, so its perturbation axes must be too).
      + '  vTanR = normalize(normalMatrix * uPRight);\n'
      + '  vTanF = normalize(normalMatrix * uPFwd);\n');
    // Soft rim fade so the patch edge melts into the global ocean sphere out
    // past the horizon (where curvature already hides the seam anyway).
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vEdge;\nvarying float vWaveH;\nvarying vec2 vW;\nvarying vec3 vDir;\nvarying vec3 vTanR;\nvarying vec3 vTanF;\nuniform float uWaveTime;\nuniform vec3 uFoamColor;\nuniform float uCrestFoam;\nuniform sampler2D uSeabedTex;\nuniform vec3 uShallowCol;\nuniform vec3 uDeepCol;\nuniform float uShallowA;\nuniform float uDeepA;\nuniform float uDepthFade;\nuniform float uShoreFoam;\nuniform float uShoreW;\nuniform float uWaterGlow;\nuniform float uRipple;\nuniform vec3 uHorizonCol;\nvec3 _waterEmit = vec3(0.0);\nfloat fHash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }\nfloat fNoise(vec2 x){ vec2 i = floor(x); vec2 f = fract(x); f = f * f * (3.0 - 2.0 * f); return mix(mix(fHash(i), fHash(i + vec2(1.0, 0.0)), f.x), mix(fHash(i + vec2(0.0, 1.0)), fHash(i + vec2(1.0, 1.0)), f.x), f.y); }\nfloat fFbm(vec2 p){ float a = 0.5; float s = 0.0; for(int k = 0; k < 3; k++){ s += a * fNoise(p); p *= 2.03; a *= 0.5; } return s; }')
      // Sea floor depth from the equirect seabed map → clearer, more
      // transparent shallows over a deeper, opaque blue; plus a shoreline
      // crash-foam band that surges in and recedes as the waves wash up.
      .replace('#include <color_fragment>',
        '#include <color_fragment>\n'
      + '  vec3 _d = normalize(vDir);\n'
      + '  vec2 _suv = vec2(atan(_d.z, _d.x) / PI2 + 0.5, asin(clamp(_d.y, -1.0, 1.0)) / PI + 0.5);\n'
      + '  float _H = texture2D(uSeabedTex, _suv).r * 9.0 - 6.0;\n'   // decode seabed height
      + '  float _depth = max(0.0, -_H);\n'                          // water depth (height units)
      + '  float _df = smoothstep(0.0, uDepthFade, _depth);\n'
      + '  diffuseColor.rgb = mix(uShallowCol, uDeepCol, _df);\n'     // clearer shallows → deep blue
      + '  float _alpha = mix(uShallowA, uDeepA, _df);\n'
      // Fresnel: real water mirrors at grazing angles — pull the colour
      // toward a pale sky tint and go opaque, so the sea brightens toward
      // the horizon instead of staying one flat blue everywhere. Uses the
      // smooth wave normal (vNormal), not the micro-ripples, so it doesn't
      // shimmer.
      + '  vec3 _Vv = normalize(vViewPosition);\n'
      + '  vec3 _Nv = normalize(vNormal) * (gl_FrontFacing ? 1.0 : -1.0);\n'
      + '  float _fres = pow(1.0 - clamp(dot(_Nv, _Vv), 0.0, 1.0), 3.0);\n'
      + '  diffuseColor.rgb = mix(diffuseColor.rgb, uHorizonCol, _fres * 0.55);\n'
      + '  _alpha = mix(_alpha, 1.0, _fres * 0.85);\n'
      // Rim fade into the far sea — LAST, so the fresnel-opaque horizon (and
      // the foam below) still melt away at the patch edge.
      + '  float _rim = 1.0 - smoothstep(0.86, 1.0, vEdge);\n'
      + '  _alpha *= _rim;\n'
      // Crest foam (Step 2): white caps on the upper part of each wave crest.
      + '  float _crest = smoothstep(0.45, 0.92, vWaveH);\n'
      + '  float _ctex = fFbm(vW * 240.0 + vec2(uWaveTime * 0.5, -uWaveTime * 0.4));\n'
      + '  float _crestFoam = uCrestFoam * _crest * smoothstep(0.30, 0.75, _ctex);\n'
      // Shoreline crash foam (Step 3): a foam band hugging the waterline whose
      // width pulses with time (waves rushing up the sand, then drawing back),
      // broken into lacy streaks. Strongest right at depth 0, gone past uShoreW.
      + '  float _wash = 0.6 + 0.4 * sin(uWaveTime * 2.2 + (vW.x + vW.y) * 26.0);\n'
      + '  float _band = smoothstep(uShoreW * _wash, 0.0, _depth);\n'
      + '  float _stex = fFbm(vW * 170.0 + vec2(-uWaveTime * 0.35, uWaveTime * 0.5));\n'
      + '  float _shoreFoam = uShoreFoam * _band * smoothstep(0.25, 0.8, _stex);\n'
      + '  float _foam = clamp(max(_crestFoam, _shoreFoam), 0.0, 1.0);\n'
      + '  diffuseColor.rgb = mix(diffuseColor.rgb, uFoamColor, _foam);\n'
      + '  diffuseColor.a = max(_alpha, _foam * 0.9 * _rim);\n'
      + '  _waterEmit = diffuseColor.rgb;\n')   // feed the self-illumination floor below
      // Micro-ripples: fine animated noise bends the shading normal between
      // the big vertex swells, so the low roughness throws moving sun
      // glints/sparkle instead of one glassy sheet. View-space perturbation
      // along the patch tangents (vTanR/vTanF) computed in the vertex stage.
      .replace('#include <normal_fragment_begin>',
        '#include <normal_fragment_begin>\n'
      + '  {\n'
      + '    vec2 _rw = vW * 420.0 + vec2(uWaveTime * 0.45, -uWaveTime * 0.35);\n'
      + '    float _re = 0.35;\n'
      + '    float _r0 = fFbm(_rw);\n'
      + '    float _rgx = (fFbm(_rw + vec2(_re, 0.0)) - _r0) / _re;\n'
      + '    float _rgy = (fFbm(_rw + vec2(0.0, _re)) - _r0) / _re;\n'
      + '    normal = normalize(normal + (vTanR * _rgx + vTanF * _rgy) * uRipple);\n'
      + '  }\n')
      // Stylized glow floor: lift the water toward its own colour so it stays a
      // clear blue (and foam stays white) even where the scene light is dim.
      .replace('#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\n  totalEmissiveRadiance += _waterEmit * uWaterGlow;\n');
  };
  mat.customProgramCacheKey = () => 'waterPatch';
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;        // always centred on the camera
  mesh.renderOrder = 2;
  mesh.visible = false;
  waterPatch = { mesh, mat };
}

// Mount the water patch for a fresh surface visit. Only shows on liquid WATER
// worlds (lava/acid seas keep the plain sphere); sized to the body's eye height
// so the swell reads the same on a moon or a giant.
export function attachWaterPatch(body) {
  if (!waterPatch) buildWaterPatch();
  const wp = waterPatch;
  wp.mesh.visible = false;
  if (wp.mesh.parent) wp.mesh.parent.remove(wp.mesh);
  const show = !!(body.matter && body.matter.liquid && body.oceanIsWater);
  if (!show) return;
  // Ensure the seabed-depth texture exists/fresh (depth transparency + shore foam).
  if (!body.seabedTex) bakeOceanShore(body);
  if (waterUniforms) {
    waterUniforms.uPR.value       = surfaceState.eyeHeight * 30;
    waterUniforms.uBodyR.value    = body.baseRadius;
    // uLift MUST be ≥ uWaveAmp so wave TROUGHS never dip below sea level —
    // otherwise the shallow seabed pokes up through the troughs near shore and
    // the water looks blotchy. The whole sea then rides slightly above true sea
    // level (negligible) with troughs ≈ sea level and crests ≈ +2·amp.
    waterUniforms.uWaveAmp.value  = surfaceState.eyeHeight * 0.22;
    waterUniforms.uLift.value     = surfaceState.eyeHeight * 0.27;
    waterUniforms.uWaveTime.value = 0;
    waterUniforms.uDrift.value.set(0, 0);
    waterUniforms.uSeabedTex.value = body.seabedTex || null;
    // Clearer-blue look derived from the body's own water tint: shallows lean
    // bright/pale, open water leans a touch deeper than the base tint.
    const base = new THREE.Color(body.oceanBaseColor || COL.water);
    waterUniforms.uShallowCol.value.copy(base).lerp(new THREE.Color(0xffffff), 0.45);
    waterUniforms.uDeepCol.value.copy(base);   // keep deep water a bright clear blue, not near-black
    // Grazing-angle fresnel tint: the body's water colour pushed well toward
    // white, so the horizon reads as pale sky-mirror on any liquid colour.
    waterUniforms.uHorizonCol.value.copy(base).lerp(new THREE.Color(0xffffff), 0.65);
  }
  body.mesh.add(wp.mesh);
  wp.mesh.visible = true;
}

export function detachWaterPatch() {
  if (waterPatch && waterPatch.mesh.parent) waterPatch.mesh.parent.remove(waterPatch.mesh);
}

// Per-frame: re-centre the patch on the avatar (current tangent frame) and
// scroll the wave field by the walker's drift so it stays world-fixed. Waves
// freeze while the sim is paused, matching the sphere ocean's clock.
export function updateWaterPatch(dt) {
  if (!waterPatch || !waterPatch.mesh.visible || viewMode !== 'surface' || !surfaceState.body) return;
  if (!waterUniforms) return;
  waterUniforms.uPUp.value.copy(surfaceState.localUp);
  waterUniforms.uPRight.value.copy(surfaceState.localRight);
  waterUniforms.uPFwd.value.copy(surfaceState.localFwd);
  waterUniforms.uDrift.value.set(surfaceState.grassU, surfaceState.grassV);
  if (!paused) waterUniforms.uWaveTime.value += dt;
}

// JS mirror of the water-patch vertex shader's wv() evaluated at the avatar.
// The avatar sits at the patch centre, so its wave coords are exactly the
// drift (grassU, grassV) — keep the three sine terms in lockstep with the
// shader or the buoyancy bob will detach from the visible swell.
export function waveHeightAtAvatar() {
  if (!waterUniforms) return 0;
  const t = waterUniforms.uWaveTime.value;
  const x = surfaceState.grassU, y = surfaceState.grassV;
  return Math.sin((x + y * 0.25) * 60 + t * 1.6) * 0.50
       + Math.sin((y - x * 0.35) * 85 - t * 1.9) * 0.32
       + Math.sin((x * 0.80 + y * 0.60) * 130 + t * 2.6) * 0.18;
}

