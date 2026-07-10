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
// Wave field = the global ocean's own long swell (oceanWave, same phase/clock,
// so the two surfaces agree) PLUS a short-wavelength chop only this fine grid
// can resolve — that chop is what reads as actual rolling waves at avatar
// scale. Both are evaluated in OBJECT space (like the sphere's shader), so the
// water is world-fixed with no drift bookkeeping. KEEP chopWave IN SYNC across
// its three copies: the GLSL here, waterChopDispAtAvatar() below (buoyancy /
// submerged test), and the murk-boundary GLSL in underwater-pass.js.
export const WATER_PATCH_N = 192;          // grid resolution (verts per side)
export let waterPatch = null;
export let waterUniforms = null;

// Walking-ocean swell height as a fraction of the avatar's eye height (applied
// to the ocean shader's uWaveAmp each frame by main.js's surface-mode loop).
// ~0.26 -> crests ride about a quarter of the walker tall. Mutable so the dev
// panel (ui/dev-panel.js) can retune it live — same pattern as
// surface-lighting.js's lightingTuning; main.js reads this object fresh each
// frame rather than a hardcoded constant, so the panel's edit actually sticks
// instead of being clobbered by the next frame's recompute.
export const waterTuning = { waveAmpMul: 0.26 };

// Per-body water params captured by attachWaterPatch. The material compiles
// lazily on its first render — which happens AFTER the first attach — so on a
// cold first visit `waterUniforms` is still null and the values can't be
// pushed yet. We stash them here and replay them via applyWaterParams() both
// from attach (when the shader is already live) and from onBeforeCompile (the
// instant the uniforms come into existence), so the first visit no longer runs
// on the hardcoded defaults (null seabed tex → white-foam sheet everywhere).
let pendingWaterParams = null;

function applyWaterParams() {
  if (!waterUniforms || !pendingWaterParams) return;
  const p = pendingWaterParams;
  waterUniforms.uPR.value       = p.pr;
  waterUniforms.uBodyR.value    = p.bodyR;
  waterUniforms.uSwellAmp.value = p.swellAmp;
  waterUniforms.uChopAmp.value  = p.chopAmp;
  waterUniforms.uLift.value     = p.lift;
  waterUniforms.uWaveTime.value = 0;
  waterUniforms.uDrift.value.set(0, 0);
  waterUniforms.uSeabedTex.value = p.seabedTex;
  waterUniforms.uShallowCol.value.copy(p.shallowCol);
  waterUniforms.uDeepCol.value.copy(p.deepCol);
  waterUniforms.uHorizonCol.value.copy(p.horizonCol);
}

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
    // fades alpha at the rim, which needs transparent:true. Roughness/metalness
    // MATCH the global ocean sphere (body.js: 0.18 / 0.05) so the patch is lit
    // identically and doesn't read as a glossier, brighter disc on the sea.
    color: 0xffffff, roughness: 0.18, metalness: 0.05,
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
    sh.uniforms.uLift   = { value: 0.004 };         // outward bias ≥ uChopAmp so the patch never dips below the sphere ocean it rides
    sh.uniforms.uDrift  = { value: new THREE.Vector2(0, 0) };  // ground-fixed offset for the fragment foam/ripple NOISE (waves are object-space now)
    sh.uniforms.uWaveTime = { value: 0 };           // synced to the sphere ocean's clock every frame
    sh.uniforms.uSwellAmp = { value: 0.0 };         // long oceanWave swell amp (matches the sphere's uWaveAmp)
    sh.uniforms.uChopAmp  = { value: 0.0 };         // short chop amp — the visible rolling waves
    // Crest foam: white caps riding the chop crests, faded well before the
    // patch rim — at grazing distance the noise aliased into a white horizon
    // band when it ran unfaded.
    sh.uniforms.uFoamColor = { value: FOAM_COLOR };
    sh.uniforms.uCrestFoam = { value: 0.4 };
    // Depth-based look (clearer shallows → deeper blue) + STEP 3 shoreline foam.
    // uSeabedTex is the equirect seabed-height map (built by bakeOceanShore);
    // the shader reads water depth under each fragment from it.
    sh.uniforms.uSeabedTex  = { value: null };
    sh.uniforms.uShallowCol = { value: new THREE.Color(0x9fe0ee) };  // clear shallow tint
    sh.uniforms.uDeepCol    = { value: new THREE.Color(0x2f7fc0) };  // deeper open-water tint
    sh.uniforms.uShallowA   = { value: 0.38 };      // alpha in the shallows — genuinely see-through from above (the fresnel term below still opaques the grazing-angle distance)
    sh.uniforms.uDeepA      = { value: 0.88 };      // alpha in deep water (near opaque)
    sh.uniforms.uDepthFade  = { value: 0.65 };      // seabed-height units over which it deepens
    sh.uniforms.uShoreFoam  = { value: 0.0 };       // shoreline crash-foam strength — OFF: the global seabed map (~44x22) is far coarser than this sub-texel local patch, so depth reads one flat ~0 value near any coast and the foam fills the whole character-centred patch. Proper coast foam belongs on the global ocean's per-vertex aShore data, not here.
    sh.uniforms.uShoreW     = { value: 0.16 };      // shoreline foam band width (depth units)
    // Self-illumination floor — OFF. At 0.28 it lit the patch brighter than the
    // global ocean sphere (which has no water self-illum), so the patch read as
    // a bright disc following the avatar. Keep it lit purely by the scene, like
    // the surrounding sea. (Re-introduce small if night water crushes to black.)
    sh.uniforms.uWaterGlow  = { value: 0.0 };
    // Micro-ripple normal strength (fragment-level sparkle between the
    // vertex-displaced swells) and the pale sky tint the fresnel term pulls
    // the water toward at grazing view angles.
    sh.uniforms.uRipple     = { value: 0.35 };
    sh.uniforms.uHorizonCol = { value: new THREE.Color(0xcfe9f5) };
    waterUniforms = sh.uniforms;
    applyWaterParams();   // replay any params captured before this first compile
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>',
        '#include <common>\nuniform vec3 uPUp;\nuniform vec3 uPRight;\nuniform vec3 uPFwd;\nuniform float uPR;\nuniform float uBodyR;\nuniform float uLift;\nuniform vec2 uDrift;\nuniform float uWaveTime;\nuniform float uSwellAmp;\nuniform float uChopAmp;\nvarying float vEdge;\nvarying float vWaveH;\nvarying vec2 vW;\nvarying vec3 vDir;\nvarying vec3 vTanR;\nvarying vec3 vTanF;\n'
      // Long swell — IDENTICAL to the sphere ocean's oceanWave() (materials.js)
      // and clocked by the same uWaveTime, so patch and sphere are one surface.
      + 'float oceanWave(vec3 p){\n  float t = uWaveTime;\n  float h = 0.0;\n'
      + '  h += sin(dot(p.xz, vec2(0.990, 0.139)) * 2.0 + t * 1.0) * 0.42;\n'
      + '  h += sin(dot(p.xz, vec2(0.719, 0.695)) * 2.7 + t * 1.3) * 0.30;\n'
      + '  h += sin(dot(p.xz, vec2(0.174, 0.985)) * 3.6 + t * 1.7) * 0.20;\n'
      + '  h += sin(dot(p.xz, vec2(-0.438, 0.899)) * 4.6 + t * 2.1) * 0.15;\n'
      + '  h += sin(dot(p.xz, vec2(-0.883, 0.469)) * 5.8 + t * 2.6) * 0.10;\n'
      + '  return h;\n}\n'
      // Short chop — the rolling waves at walking scale. Mirrored in
      // waterChopDispAtAvatar() and underwater-pass.js; keep the three in sync.
      + 'float chopWave(vec3 p){\n  float t = uWaveTime;\n  float h = 0.0;\n'
      + '  h += sin(p.x * 46.0 + p.z * 28.0 + t * 2.0) * 0.55;\n'
      + '  h += sin(p.z * 61.0 - p.x * 21.0 + t * 2.5) * 0.30;\n'
      + '  h += sin((p.x + p.z) * 90.0 - t * 3.1) * 0.15;\n'
      + '  return h;\n}\n'
      + 'float seaDisp(vec3 p){ return oceanWave(p) * uSwellAmp + chopWave(p) * uChopAmp; }')
      // Project the grid point onto the sea sphere, bump the normal from the
      // wave slope (finite differences), then displace radially by wave height.
      .replace('#include <beginnormal_vertex>',
        '#include <beginnormal_vertex>\n'
      + '  vec2 _uv = position.xz;\n'
      + '  float _u = _uv.x * uPR;\n  float _v = _uv.y * uPR;\n'
      + '  vec3 _dir = normalize(uPUp * uBodyR + uPRight * _u + uPFwd * _v);\n'
      + '  vec3 _op = _dir * uBodyR;\n'
      + '  float _h = seaDisp(_op);\n'
      + '  float _e = 0.02;\n'
      + '  vec3 _opR = normalize(uPUp * uBodyR + uPRight * (_u + _e) + uPFwd * _v) * uBodyR;\n'
      + '  vec3 _opF = normalize(uPUp * uBodyR + uPRight * _u + uPFwd * (_v + _e)) * uBodyR;\n'
      + '  vec3 _grad = (uPRight * (seaDisp(_opR) - _h) + uPFwd * (seaDisp(_opF) - _h)) / _e;\n'
      + '  objectNormal = normalize(_dir - _grad);\n')
      .replace('#include <begin_vertex>',
        '#include <begin_vertex>\n'
      + '  transformed = _dir * (uBodyR + uLift + _h);\n'
      + '  vEdge = max(abs(_uv.x), abs(_uv.y));\n'
      + '  vWaveH = chopWave(_op);\n'   // chop height ∈[-1,1] (crest ≈ +1) → crest foam
      + '  vW = vec2(_u, _v) + uDrift;\n'  // ground-fixed coords for the fragment foam/ripple noise
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
      + '  diffuseColor.rgb = mix(diffuseColor.rgb, uHorizonCol, _fres * 0.30);\n'
      + '  _alpha = mix(_alpha, 1.0, _fres * 0.85);\n'
      // Rim fade into the far sea — LAST, so the fresnel-opaque horizon (and
      // the foam below) still melt away at the patch edge.
      + '  float _rim = 1.0 - smoothstep(0.86, 1.0, vEdge);\n'
      + '  _alpha *= _rim;\n'
      // Crest foam: white caps on the tallest chop crests only, faded out
      // toward the rim so the noise can't alias into a white horizon band.
      + '  float _crest = smoothstep(0.55, 0.95, vWaveH);\n'
      + '  float _ctex = fFbm(vW * 240.0 + vec2(uWaveTime * 0.5, -uWaveTime * 0.4));\n'
      + '  float _crestFoam = uCrestFoam * _crest * smoothstep(0.40, 0.85, _ctex) * (1.0 - smoothstep(0.30, 0.55, vEdge));\n'
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
  // Capture this body's water params, then push them. applyWaterParams() is a
  // no-op until the shader has compiled (first render after this attach); the
  // onBeforeCompile hook replays the same stash the moment the uniforms exist,
  // so the cold first visit gets the real seabed tex + colours, not the
  // hardcoded defaults (a null seabed tex reads as shallow everywhere → the
  // whole patch goes pale + full shoreline foam = a white snow-field sheet).
  const base = new THREE.Color(body.oceanBaseColor || COL.water);
  // Patch radius MUST reach past the horizon, or its rim shows as a ring at a
  // fixed distance ahead that tracks the avatar (the dreaded "zone following the
  // character"). The horizon arc for an eye at height h over a sphere of radius
  // R is ≈ √(2·R·h); size the patch to ~1.9× that so the rim (and its fade) sit
  // safely below the visible horizon where curvature hides them.
  const horizon = Math.sqrt(2 * body.baseRadius * Math.max(1e-4, surfaceState.eyeHeight));
  const eh = surfaceState.eyeHeight;
  const chopAmp = eh * 0.30;
  pendingWaterParams = {
    pr:      horizon * 1.9,
    bodyR:   body.baseRadius,
    // Long-swell amp: main.js retunes the sphere's uWaveAmp to eyeHeight·0.26
    // every surface frame, and updateWaterPatch mirrors it live — this is just
    // the matching first-frame value.
    swellAmp: eh * 0.26,
    // The visible rolling waves. uLift MUST be ≥ uChopAmp so chop TROUGHS never
    // dip below the sphere ocean the patch rides on — otherwise the sphere
    // pokes up through the troughs and the water looks blotchy. The whole sea
    // then rides ~a third of an eye height above the sphere's waterline.
    chopAmp,
    lift:    chopAmp * 1.05,
    seabedTex: body.seabedTex || null,
    // Shallow vs deep tint kept nearly equal on purpose: the seabed depth map
    // (~44x22) is coarser than this sub-texel local patch, so `depth` reads one
    // flat value across the whole patch and the shallow→deep gradient can't
    // resolve locally — a strong shallow tint just paints a pale disc that
    // follows the avatar. Only a hint of lightening so the local sea matches
    // the base ocean colour beyond the patch rim.
    shallowCol: base.clone().lerp(new THREE.Color(0xffffff), 0.12),
    deepCol:    base.clone(),   // keep deep water a bright clear blue, not near-black
    // Grazing-angle fresnel tint: the body's water colour pushed well toward
    // white, so the horizon reads as pale sky-mirror on any liquid colour.
    horizonCol: base.clone().lerp(new THREE.Color(0xffffff), 0.40),
  };
  applyWaterParams();
  body.mesh.add(wp.mesh);
  wp.mesh.visible = true;
}

export function detachWaterPatch() {
  if (waterPatch && waterPatch.mesh.parent) waterPatch.mesh.parent.remove(waterPatch.mesh);
}

// Per-frame: re-centre the patch on the avatar (current tangent frame), keep
// the fragment noise ground-fixed via the walker's drift, and sync the wave
// clock to the SPHERE ocean's (main.js advances that one and freezes it on
// pause) so patch, sphere, buoyancy and murk boundary all share one time.
export function updateWaterPatch(dt) {
  if (!waterPatch || !waterPatch.mesh.visible || viewMode !== 'surface' || !surfaceState.body) return;
  if (!waterUniforms) return;
  waterUniforms.uPUp.value.copy(surfaceState.localUp);
  waterUniforms.uPRight.value.copy(surfaceState.localRight);
  waterUniforms.uPFwd.value.copy(surfaceState.localFwd);
  waterUniforms.uDrift.value.set(surfaceState.grassU, surfaceState.grassV);
  const osh = surfaceState.body.oceanMesh && surfaceState.body.oceanMesh.material.userData.shader;
  if (osh) {
    waterUniforms.uWaveTime.value = osh.uniforms.uWaveTime.value;
    // main.js retunes the sphere's uWaveAmp to the avatar every frame —
    // mirror it live so the two surfaces never drift apart.
    waterUniforms.uSwellAmp.value = osh.uniforms.uWaveAmp.value;
  } else if (!paused) {
    waterUniforms.uWaveTime.value += dt;
  }
}

// JS mirror of the patch's chopWave() + lift, evaluated at the avatar's spot on
// the sea sphere. Added on top of oceanSwellDisp() (the long swell) by the
// swimmer's buoyancy (walk.js) and the submerged test (underwater-pass.js) so
// they ride the SAME crests the patch draws. 0 whenever the patch is off.
// KEEP the three sine terms in lockstep with the chopWave GLSL above.
export function waterChopDispAtAvatar() {
  if (!waterUniforms || !waterPatch || !waterPatch.mesh.visible) return 0;
  const b = surfaceState.body;
  if (!b) return 0;
  const t = waterUniforms.uWaveTime.value;
  const x = surfaceState.localUp.x * b.baseRadius;
  const z = surfaceState.localUp.z * b.baseRadius;
  const chop = Math.sin(x * 46.0 + z * 28.0 + t * 2.0) * 0.55
             + Math.sin(z * 61.0 - x * 21.0 + t * 2.5) * 0.30
             + Math.sin((x + z) * 90.0 - t * 3.1) * 0.15;
  return waterUniforms.uLift.value + chop * waterUniforms.uChopAmp.value;
}

