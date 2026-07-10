// enterSurfaceMode / exitSurfaceMode: camera snap + restore, atmosphere
// reconfiguration, sun-disc handling, and attaching/detaching every surface
// field (grass, rocks, water, ground patch, props).
import { setSurfaceVisitBody, setViewMode } from '../../framework/state.js';
import { setPickTargetBody } from './core.js';

import * as THREE from 'three';
import { starMat } from '../../background/starfield.js';
import { camera, controls, renderer, scene, surfaceSkyLight } from '../../core/scene.js';
import { coronaMesh, sunMesh } from '../../core/sun.js';
import { surfaceGravityG } from '../../framework/climate.js';
import { viewMode } from '../../framework/state.js';
import { astronaut, attachAstronaut, loadAstronaut } from './avatar.js';
import { updateSurfaceCamera } from './camera.js';
import {
  buildLocalFrame, pickTargetBody, surfaceLocationEl, surfaceOverlay, surfaceState, updateVisitButtonState
} from './core.js';
import { attachBubbles, detachBubbles } from './bubbles.js';
import { attachFootLayer, detachFootLayer } from './footprints.js';
import { attachGlobeMarkers, detachGlobeMarkers } from './globe-markers.js';
import { attachGrass, detachGrass, grassField } from './grass.js';
import { attachGroundPatch, detachGroundPatch, groundPatch } from './ground.js';
import { attachAurora, detachAurora } from './aurora.js';
import { attachMeteors, detachMeteors } from './meteors.js';
import { attachProps, detachProps, propField } from './props.js';
import { attachRocks, detachRocks } from './rocks.js';
import { attachSlabs, detachSlabs } from './slabs.js';
import { restoreOrbitLighting } from './surface-lighting.js';
import { attachSeabed, detachSeabed } from './seabed.js';
import { SURFACE_STAR_OPACITY, clearSkyBodies, setUnderwaterOverlay } from './sky.js';
import { clearSurfaceKeys } from './walk.js';
import { detachWaterPatch } from './water.js';

export function enterSurfaceMode(body, hitPoint) {
  // hitPoint comes in as a world-space Vector3 from the raycast result.
  const localHit = body.mesh.worldToLocal(hitPoint.clone());
  // Snap the eye to the local surface normal at the picked point. This
  // matters more than the picked point's exact radius — the icosphere
  // vertices form the visible "ground", and we want the camera to ride
  // their height field, not float over the click coordinate.
  surfaceState.body = body;
  surfaceState.menuOpen = false;   // stale from a previous visit, in case it lingered
  // The global ocean sphere stays visible while walking — it IS the water now.
  // Put it into surface wave mode (uSurface=1) so up close it rolls with the
  // stock swell and goes see-through near the avatar (the light, lively water).
  // The local water patch is NOT attached — tried twice (June + July 2026),
  // both times it read as a second water layer fighting the sphere (wrong
  // lighting, visible seams). Restored to 0 on exit.
  surfaceState.oceanHidden = false;
  // Shrink the character scale on planets so the world feels larger and
  // traversal takes longer without needing slow-motion animations.
  const sizeMult = (body.kind === 'planet') ? 0.4 : 1.0;
  surfaceState.eyeHeight = Math.max(0.012, body.baseRadius * 0.003 * sizeMult);
  if (body.oceanMesh && body.matter && body.matter.liquid && body.oceanIsWater) {
    const osh = body.oceanMesh.material.userData.shader;
    if (osh) osh.uniforms.uSurface.value = 1;
  }
  buildLocalFrame(localHit, surfaceState.localUp, surfaceState.localFwd, surfaceState.localRight);
  surfaceState.faceLocal.copy(surfaceState.localFwd);
  // Place the eye at (vertex height + eyeHeight) along the surface normal.
  // The picked point's local radius is the initial ground level; while
  // walking, stepSurfaceWalk resamples the terrain under each step so the
  // eye rises over mountains and dips into valleys.
  surfaceState.groundRadius = localHit.length();
  // Surface gravity for this body (Earth = 1 g). Low gravity gives a
  // low-traction, bounding feel: short, drifting strides paired with the
  // long, high leaps the reduced fall accel below produces. A heavy world
  // gives more purchase — faster, planted strides and a snappy jump. Clamp
  // the pace factor so the extremes stay playable rather than silly.
  const gFactor = surfaceGravityG(body);
  surfaceState.gravityG = gFactor;
  // Locomotion slows in low gravity for a "moonwalk" slow-motion read.
  // Walking speed scales ~√g (the Froude-number relation for a pendulum
  // stride), so the Moon's ~0.2 g lands near 45% pace — a clear slow-mo —
  // while a heavy world strides a touch faster. This SAME factor is fed to
  // the avatar's animation playback (see updateAstronaut) so the legs cycle
  // in slow motion too and the feet don't slide. Clamped so the extremes
  // stay playable.
  const locoScale = Math.min(1.3, Math.max(0.4, Math.sqrt(gFactor)));
  surfaceState.locoScale = locoScale;
  // Walk pace scales with character size. Because the character is smaller
  // on planets, they cover less absolute distance per step, but move at
  // a natural human cadence — then slowed/sped by gravity.
  surfaceState.moveSpeed = surfaceState.eyeHeight * 9.3 * locoScale;
  // Landing spots are always dry land (pick mode rejects water), so the
  // support radius starts on the ground; stepSurfaceWalk flips it to the
  // waterline if the walker later wades into deep water.
  surfaceState.swimming = false;
  surfaceState.standRadius = surfaceState.groundRadius;
  surfaceState.localEye.copy(surfaceState.localUp).multiplyScalar(surfaceState.groundRadius + surfaceState.eyeHeight);
  surfaceState.yaw = 0;
  surfaceState.pitch = 0;
  surfaceState.fov = 60;

  // Third-person trail distance + jump tuning, all scaled to the avatar's
  // size so jumps and camera framing feel the same on a moon or a giant.
  // Fixed distance (no scroll dolly in third person).
  surfaceState.camDist = surfaceState.eyeHeight * 2.2;
  // Launch velocity is constant across worlds; the per-body gravity below
  // does the work, so a weak-gravity moon yields a much higher, longer leap.
  surfaceState.jumpSpeed = surfaceState.eyeHeight * 9;
  // Fall acceleration scales with the body's gravity. The Earth baseline
  // (gFactor ≈ 1) keeps the ~0.7s, slightly-floaty hang time; the Moon's
  // ~0.2 g makes jumps drift, while a dense world snaps them straight down.
  surfaceState.gravity   = surfaceState.eyeHeight * 26 * gFactor;
  surfaceState.jumpOffset = 0;
  surfaceState.vertVel = 0;
  surfaceState.grounded = true;

  // Kick off (or reuse) the avatar load, then mount it for this visit.
  loadAstronaut().then(() => {
    if (viewMode === 'surface') { attachAstronaut(); attachBubbles(); }
  }).catch(() => { /* avatar optional — surface view still works without it */ });

  // Reset and mount the grass field (gated to green ground by sampleGrassGround).
  // Martian (desert) worlds never grow grass — don't even mount the field, so
  // no painted band can sprout a single blade regardless of grass.js's state.
  surfaceState.grassU = 0;
  surfaceState.grassV = 0;
  if (body.archetype === 'desert') detachGrass(); else attachGrass(body);
  attachRocks(body);
  // Flat flagstone bedrock plates on the Martian Flats (desert only; attachSlabs
  // self-gates and detaches on any other archetype).
  attachSlabs(body);
  // Submerged kelp/algae beds + schooling fish (water worlds only; gated to
  // cells whose floor sits below the waterline).
  attachSeabed(body);
  // (Local water patch intentionally not attached — the wave-mode global
  // ocean sphere above is the water now. See the note at the top of enter.)
  // High-res near-field ground patch (real micro-relief over the coarse mesh).
  attachGroundPatch(body);
  // Footprint decal layer (soft-soil worlds only — venusian/desert/moon_like).
  attachFootLayer(body);
  // Scattered GLB trees + rocks (terrestrial only; loads lazily on first visit).
  attachProps(body);
  // Sky-space meteor shower (every world; frequency follows how dark the sky is).
  attachMeteors();
  // Avatar/waypoint marker meshes the globe widgets (minimap, planet map) render.
  attachGlobeMarkers(body);
  setSurfaceVisitBody(body);
  // Polar aurora (atmosphere worlds only; fades in near the poles at night).
  attachAurora(body);
  // Switch the body material's procedural ground detail on for this visit
  // (perturbed relief normals + albedo mottle); off again on exit. Guarded —
  // the shader is always compiled here since the body has been on screen.
  if (body.mesh.material.userData.detailShader) {
    const du = body.mesh.material.userData.detailShader.uniforms;
    du.uSurfaceDetail.value = 1;
    // Venusian ground is coarse volcanic rubble — crank the procedural
    // relief + albedo mottle well past the soft default so the black soil
    // reads as rocky mud up close. Reset to defaults for everything else
    // (the material is per-body but the archetype can be re-classified).
    const venus = body.archetype === 'venusian';
    du.uDetailFreq.value   = venus ? 80 : 55;
    du.uDetailAmp.value    = venus ? 0.34 : 0.18;
    du.uDetailMottle.value = venus ? 0.22 : 0.05;
  }
  // Diagnostic: confirms the new surface-detail code is live (look for this in
  // the console after landing). If you DON'T see it, the browser is running an
  // old/cached/deployed build, not these edits.
  console.info('[surface-detail v6 · martian-slabs] groundDetail=%s patch=%s — on %s (%s)',
    !!body.mesh.material.userData.detailShader, !!groundPatch || 'pending',
    body.name, body.archetype);
  // Auto-diagnostic 2s after landing: tells us why grass/trees may be absent
  // (wrong archetype, not standing on a grass face, or props still loading).
  setTimeout(() => {
    if (viewMode !== 'surface' || surfaceState.body !== body) return;
    const gf = grassField;
    console.info('[surface-detail] 2s check → archetype=%s | grassReveal=%s onGrassSpot=%s | props=%s | grassWorld=%s',
      body.archetype,
      gf ? gf.reveal.toFixed(2) : 'n/a',
      gf ? !!gf.targetReveal : 'n/a',
      propField ? 'loaded' : 'loading/none',
      (body.kind === 'planet' && body.archetype === 'terrestrial'));
  }, 2000);

  // Save orbit state for clean restore.
  surfaceState.savedFov = camera.fov;
  surfaceState.savedNear = camera.near;
  surfaceState.savedFar = camera.far;
  surfaceState.savedCamPos.copy(camera.position);
  surfaceState.savedTarget.copy(controls.target);

  // A body with a visible atmosphere shell paints its own warm sun disc in
  // the gas shader (uMode 0), so we hide the system-scale Sun mesh to avoid
  // a double sun. An airless body (Mercury, the Moon, bare-rock worlds)
  // paints nothing — keep the real Sun mesh + corona visible so the star
  // still hangs in its black sky. The planet body occludes it naturally
  // once it's below the horizon, so no manual day/night gating is needed.
  surfaceState.paintsSunDisc = !!(body.gasMesh && body.gasMesh.visible
    && body.gasMesh.material.uniforms.uMode.value < 0.5);
  surfaceState.savedSunVisible = { mesh: sunMesh.visible, corona: coronaMesh.visible };
  sunMesh.visible    = !surfaceState.paintsSunDisc;
  coronaMesh.visible = !surfaceState.paintsSunDisc;

  // While walking, the visited body must NOT sample the sun's shadow map:
  // at system scale one shadow texel spans the whole landscape, so at
  // grazing sun angles the terrain self-shadows to pure black while the
  // shadow-free ground patch above it stays lit — a glaring seam. Neither
  // surface can resolve real shadows at walking scale (that's what the
  // avatar's blob shadow is for), so both go shadow-free. Restored on exit.
  surfaceState.savedBodyRecvShadow = body.mesh.receiveShadow;
  body.mesh.receiveShadow = false;
  body.mesh.material.needsUpdate = true;   // receiveShadow flips need a recompile

  // Atmospheric skylight: thick gas shells flood the ground with diffuse,
  // sky-tinted daylight (essential on the near-black venusian basalt, which
  // crushes to pure silhouette under the point sun alone). Base strength
  // follows the LIVE gas density × coverage; updateSurfaceSkyEffects ramps
  // it with sun elevation each frame so the dark side still goes dark.
  surfaceState.skyLightBase = 0;
  if (body.gasMesh && body.gasMesh.visible && body.gasMode === 'atmosphere') {
    // ^1.5 keeps thin shells (Earth: 0.45×0.35 → ~0.08) a subtle fill while a
    // Venus-dense envelope (1×1) reaches full overcast-noon strength — bright
    // enough to read the near-black basalt against the 1.5-intensity sun.
    const envelope = (body.gasDensity ?? 0) * (body.gasCoverage ?? 0);
    surfaceState.skyLightBase = Math.min(1.4, 1.25 * Math.pow(Math.max(0, envelope), 1.5));
    const tint = body.gasMesh.material.uniforms.uSkyTint.value;
    surfaceSkyLight.color.copy(tint).lerp(new THREE.Color(0xffffff), 0.25);
    surfaceSkyLight.groundColor.copy(tint).multiplyScalar(0.45);
  }
  surfaceSkyLight.intensity = 0;

  // Atmosphere from inside — flip the shell to DoubleSide so the inside
  // faces render. We snapshot the prior material state per visit so
  // re-entering can't compound the change; the opaque/alpha-blended queue
  // itself is toggled live, per-frame, by updateGasOpaqueMode (sky.js) —
  // see the note there for why this can't just be decided once here.
  if (body.gasMesh && body.gasMesh.visible) {
    const mat = body.gasMesh.material;
    surfaceState.gasMeshAdjusted = body.gasMesh;
    surfaceState.savedGas = {
      side:            mat.side,
      transparent:     mat.transparent,
      depthWrite:      mat.depthWrite,
      alphaToCoverage: mat.alphaToCoverage,
      opaqueSky:       mat.uniforms.uOpaqueSky.value,
    };
    mat.side = THREE.DoubleSide;

    // Any atmosphere thick enough to paint a visible sky (Earth 0.45
    // included) needs depthWrite-backed occlusion during the day or the far
    // gas planets bleed through — but only eligible for that opaque
    // treatment at all above this density; ice_planet (0.30) stays
    // transparent always so Mars-like atmospheres show stars at noon too.
    surfaceState.gasOpaqueEligible = mat.uniforms.uDensity.value > 0.40;
    surfaceState.gasOpaqueLive = false; // force updateGasOpaqueMode to sync on the next frame
    mat.needsUpdate = true;
  } else {
    surfaceState.gasMeshAdjusted = null;
    surfaceState.savedGas = null;
    surfaceState.gasOpaqueEligible = false;
  }

  camera.fov = surfaceState.fov;
  // The near plane is an absolute world distance, but every surface distance
  // scales with the body's group.scale. A fixed 0.001 is a harmless sliver on
  // normal bodies (Earth ~0.27, Titan ~0.45) but slices off the foreground
  // ground on a microscopic body (the moonlet Pan ~0.06) — the surface reads
  // as a thin slab with space showing "below" it. Shrink near in lockstep with
  // the body so small worlds clip just as little of their ground; bodies at or
  // above ~0.25 scale keep the original 0.001 (no regression).
  const bodyScale = body.group.scale.x || 1;
  camera.near = 0.001 * Math.min(1, bodyScale / 0.25);
  camera.far = surfaceState.savedFar;
  camera.updateProjectionMatrix();

  controls.enabled = false;
  document.body.classList.remove('pick-mode');
  document.body.classList.add('surface-mode');
  surfaceOverlay.setAttribute('aria-hidden', 'false');
  if (surfaceLocationEl) surfaceLocationEl.textContent = body.name;
  setViewMode('surface');
  setPickTargetBody(null);
  updateVisitButtonState();
  updateSurfaceCamera();

  // Request pointer lock for mouse-look.
  try {
    renderer.domElement.requestPointerLock();
  } catch (err) {
    console.warn('Pointer lock request failed:', err);
  }
}

export function exitSurfaceMode() {
  if (viewMode !== 'surface') return;

  if (document.pointerLockElement === renderer.domElement) {
    document.exitPointerLock();
  }

  // Restore camera projection + transform.
  camera.fov = surfaceState.savedFov;
  camera.near = surfaceState.savedNear;
  camera.far = surfaceState.savedFar;
  camera.updateProjectionMatrix();
  camera.position.copy(surfaceState.savedCamPos);
  controls.target.copy(surfaceState.savedTarget);
  camera.up.set(0, 1, 0);
  // Kill the surface-walk atmospheric skylight (orbit view keeps the stock rig).
  surfaceSkyLight.intensity = 0;
  surfaceState.skyLightBase = 0;
  restoreOrbitLighting();
  // Restore the body's shadow sampling (hidden during the walk — see enter).
  if (surfaceState.body && surfaceState.savedBodyRecvShadow != null) {
    surfaceState.body.mesh.receiveShadow = surfaceState.savedBodyRecvShadow;
    surfaceState.body.mesh.material.needsUpdate = true;
    surfaceState.savedBodyRecvShadow = null;
  }
  // Restore atmo shell material state (side + opaque-sky promotion).
  if (surfaceState.gasMeshAdjusted && surfaceState.savedGas) {
    const mat = surfaceState.gasMeshAdjusted.material;
    const s = surfaceState.savedGas;
    mat.side            = s.side;
    mat.transparent     = s.transparent;
    mat.depthWrite      = s.depthWrite;
    mat.alphaToCoverage = s.alphaToCoverage;
    mat.uniforms.uOpaqueSky.value = s.opaqueSky;
    mat.needsUpdate = true;
    surfaceState.gasMeshAdjusted = null;
    surfaceState.savedGas = null;
    surfaceState.gasOpaqueEligible = false;
    surfaceState.gasOpaqueLive = false;
  }
  if (surfaceState.savedSunVisible) {
    sunMesh.visible = surfaceState.savedSunVisible.mesh;
    coronaMesh.visible = surfaceState.savedSunVisible.corona;
    surfaceState.savedSunVisible = null;
  }
  starMat.opacity = SURFACE_STAR_OPACITY;
  scene.fog = null;            // drop any underwater fog
  setUnderwaterOverlay(0, null);   // and the underwater screen tint
  // Drop the surface-mode floating-origin shift (see updateSurfaceOrigin) so
  // the orbit view — and the just-restored camera transform, which was saved
  // unshifted — runs in plain world coordinates again.
  scene.position.set(0, 0, 0);
  scene.updateMatrixWorld(true);
  // Unmount the avatar (it persists in memory for the next visit).
  if (astronaut && astronaut.root.parent) {
    scene.remove(astronaut.root);
    for (const k in astronaut.actions) astronaut.actions[k].stop();
    surfaceState.animName = 'idle';
  }
  detachGrass();
  detachRocks();
  detachSeabed();
  detachBubbles();
  detachWaterPatch();
  detachSlabs();
  detachGroundPatch();
  detachFootLayer();
  detachProps();
  detachMeteors();
  detachAurora();
  detachGlobeMarkers();
  setSurfaceVisitBody(null);
  // Turn the body's procedural ground detail back off so the orbit view is
  // unchanged (uSurfaceDetail = 0 skips every detail branch in the shader).
  if (surfaceState.body && surfaceState.body.mesh.material.userData.detailShader) {
    surfaceState.body.mesh.material.userData.detailShader.uniforms.uSurfaceDetail.value = 0;
  }
  // Reset the sky-disc treatment on every other body (relief + night floor)
  // so the orbit view renders exactly as before.
  clearSkyBodies();
  // Restore the global ocean sphere we hid for the surface visit (water worlds)
  // and make sure it's back to the plain opaque sphere for the orbit view.
  if (surfaceState.body && surfaceState.body.oceanMesh) {
    const om = surfaceState.body.oceanMesh;
    if (surfaceState.oceanHidden) {
      om.visible = !!(surfaceState.body.matter && surfaceState.body.matter.liquid);
      surfaceState.oceanHidden = false;
    }
    if (om.material.userData.shader) om.material.userData.shader.uniforms.uSurface.value = 0;
  }
  surfaceState.body = null;
  controls.enabled = true;
  document.body.classList.remove('surface-mode');
  surfaceOverlay.setAttribute('aria-hidden', 'true');
  setViewMode('orbit');
  clearSurfaceKeys();
  updateVisitButtonState();
}

// Gate starfield + keep Sun mesh hidden while on a body's surface.
