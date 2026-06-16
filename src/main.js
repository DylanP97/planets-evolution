import * as THREE from 'three';

// Module evaluation order mirrors the original script.js section order:
// scene/shaders → framework → system → interaction → entities → background
// → modes → ui. Imports are depth-first, so a module's own dependencies are
// always evaluated before its module-scope side effects run.
import { scene, camera, renderer, controls } from './core/scene.js';
import { plasmaTickUniforms } from './core/sun.js';
import {
  bodies, paused, viewMode, isPainting, lastHitLocal, activeBrushBody,
} from './framework/state.js';
import { applyBrushToBody } from './framework/body.js';
import './system/orbits.js';
import { updatePlanetOrbits, updatePlanetRotation } from './system/planets.js';
import { isBrushTool } from './interaction/brush.js';
import { updateOrbitInteraction } from './interaction/pointer.js';
import { updateMoons } from './entities/moons.js';
import { updateSatellites } from './entities/probes.js';
import { updateCityMarkers } from './entities/cities.js';
import { starMat } from './background/starfield.js';
import { milkyway, milkyMat } from './background/galaxy.js';
import { updateEruptions } from './background/eruptions.js';
import { updateSunLightForFocus, updateMoonLight, updateEclipseShadows } from './system/lighting.js';
import { updateFocusTracking } from './modes/focus.js';
import { updateLiveInfo } from './ui/info-panel.js';
import './ui/controls.js';
import './ui/atmo-rings.js';
import './ui/left-panel.js';
import './ui/orbit-sliders.js';
import './ui/roster.js';
import './ui/nav.js';
import './modes/surface/core.js';
import './modes/surface/avatar.js';
import './modes/surface/mode.js';
import { updateSurfaceSkyEffects, SURFACE_STAR_OPACITY } from './modes/surface/sky.js';
import { updateSurfaceOrigin, updateSurfaceCamera } from './modes/surface/camera.js';
import { updateAstronaut } from './modes/surface/swim.js';
import { updateGrass } from './modes/surface/grass.js';
import { updateRocks } from './modes/surface/rocks.js';
import { updateWaterPatch } from './modes/surface/water.js';
import { updateGroundPatch } from './modes/surface/ground.js';
import { updateFootprints } from './modes/surface/footprints.js';
import { updateProps } from './modes/surface/props.js';
import { updateSeabed } from './modes/surface/seabed.js';
import { updateBubbles } from './modes/surface/bubbles.js';
import { updateMinimap } from './modes/surface/minimap.js';
import { renderUnderwater, underwaterPassActive } from './modes/surface/underwater-pass.js';
import { stepSurfaceWalk } from './modes/surface/walk.js';
import { surfaceState } from './modes/surface/core.js';
import './modes/surface/input.js';
import './ui/naming.js';
import { loadStarSystem, findStarSystem } from './system/starsystems.js';
import './ui/star-map.js';
// Must stay last: wires UI handlers that touch consts across the ui/ import
// cycles, which are only safe once every module above has fully evaluated.
import './ui/wire-up.js';

// Walking-ocean swell height as a fraction of the avatar's eye height (set on
// the ocean shader's uWaveAmp each frame in surface mode). ~0.26 → crests ride
// about a quarter of the walker tall: a visible but gentle swell, not a tsunami.
const SURFACE_WAVE_AMP = 0.26;

// Initial boot: load Sol from the catalog (unload is a no-op on an empty
// scene) so currentSystemId is set through the same path as every later swap.
// Runs after all imports above, so every module's DOM refs are wired.
loadStarSystem(findStarSystem('sol'));

// ====== 35. Init + Resize ======
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ====== 36. Animate ======
const clock = new THREE.Clock();
// Light updates (clock + orbit values) refresh several times per second; we
// throttle so we're not writing DOM every single frame.
let liveInfoAccum = 0;
// Cloud-drift clock. Advances only when unpaused so wind freezes when the
// sim is paused, matching how orbital motion behaves.
let gasTime = 0;
// Plasma clock. Unlike gasTime this advances every frame, paused or not — a
// star's surface keeps churning even when the orbital sim is frozen.
let plasmaTime = 0;
(function loop() {
  requestAnimationFrame(loop);
  const dt = clock.getDelta();
  // Drive the Sun's photosphere + corona and every star body's plasma.
  plasmaTime += dt;
  for (const u of plasmaTickUniforms) u.uTime.value = plasmaTime;
  for (const b of bodies) {
    if (b.plasmaMesh && b.plasmaMesh.visible) {
      b.plasmaMesh.material.uniforms.uTime.value = plasmaTime;
    }
  }
  if (!paused) {
    updatePlanetOrbits(dt);
    updatePlanetRotation(dt);
    gasTime += dt;
    for (const b of bodies) {
      if (!b.gasMesh) continue;
      const u = b.gasMesh.material.uniforms;
      u.uTime.value = gasTime;
      // Time-varying coverage: when coverageVariance > 0, slowly modulate
      // the cloud-pattern threshold so coverage drifts between sparser
      // and denser overcast. Atmosphere mode only (full-gas has no
      // cloud layer). Slider sets the BASE coverage; this oscillates
      // around it with amplitude scaled by variance.
      if (b.matter && b.matter.gas === 'atmosphere') {
        const variance = b.coverageVariance ?? 0;
        if (variance > 0) {
          const base   = b.gasCoverage ?? 0.35;
          const phase  = b.coveragePhase ?? 0;
          const drift  = Math.sin(gasTime * 0.08 + phase) * 0.35 * variance;
          u.uCoverage.value = Math.max(0, Math.min(1, base + drift));
        } else {
          u.uCoverage.value = b.gasCoverage ?? 0.35;
        }
      }
    }
    // Ocean waves drift on the same clock as clouds (frozen while paused).
    // The uniforms live on the compiled shader, captured in userData.shader.
    for (const b of bodies) {
      if (!b.oceanMesh || !b.oceanMesh.visible) continue;
      const os = b.oceanMesh.material.userData.shader;
      if (os) os.uniforms.uWaveTime.value = gasTime;
    }
  }
  updateMoons(dt);
  updateSatellites(dt);
  updateEruptions(dt);
  updateCityMarkers();
  updateSunLightForFocus();
  updateEclipseShadows();
  updateMoonLight();
  updateFocusTracking();

  controls.update();
  // In surface mode the camera rides the focused body — recompute its
  // transform from the body's current world matrix every frame so spin
  // and orbit naturally wheel the sky overhead. Cheap no-op otherwise.
  if (viewMode === 'surface') {
    updateSurfaceOrigin();
    stepSurfaceWalk(dt);
    updateSurfaceCamera();
    updateAstronaut(dt);
    updateGrass(dt);
    updateRocks(dt);
    updateWaterPatch(dt);
    updateGroundPatch(dt);
    updateFootprints(dt);
    updateProps(dt);
    updateSeabed(dt);
    updateBubbles(dt);
    updateMinimap(dt);
    updateSurfaceSkyEffects();
    // Keep the visited water world's ocean sphere in wave mode every frame.
    // The one-time set in enterSurfaceMode is a no-op on a cold first visit
    // (the ocean material compiles lazily, so userData.shader is still null
    // when it runs) — re-applying here guarantees uSurface=1 the moment the
    // shader exists, and advances the wave clock itself so the swell rolls
    // even if the global bodies loop skipped this ocean.
    const _ob = surfaceState.body;
    if (_ob && _ob.oceanMesh && _ob.oceanMesh.visible
        && _ob.matter && _ob.matter.liquid && _ob.oceanIsWater) {
      const _os = _ob.oceanMesh.material.userData.shader;
      if (_os) {
        _os.uniforms.uSurface.value = 1;
        // Scale the swell to the CHARACTER, not the planet. The baked default
        // (baseRadius·0.0022) is ~2× the avatar's eye height on a small body —
        // a 2-storey wave for an ankle-high robot. Tie it to eyeHeight so crests
        // stay a gentle fraction of the walker on any sized world. The fog
        // boundary + buoyancy read uWaveAmp live, so they follow automatically.
        _os.uniforms.uWaveAmp.value = surfaceState.eyeHeight * SURFACE_WAVE_AMP;
        if (!paused) _os.uniforms.uWaveTime.value += dt;
      }
    }
  }
  // Re-anchor the orbit-mode cursor markers (brush ring, hover dot + biome
  // tooltip) to the surface under the pointer every frame, so planet rotation
  // can't drift them. Also refreshes lastHitLocal for an active paint stroke,
  // so the brush below paints the spot the cursor currently points at.
  updateOrbitInteraction();
  if (isPainting && isBrushTool() && lastHitLocal && activeBrushBody) {
    applyBrushToBody(activeBrushBody, lastHitLocal, dt);
  }
  // Galactic band rides with the camera (skybox) and inherits the
  // starfield's daylight fade so it washes out under a daytime atmosphere
  // and blazes on the night side / in space. SURFACE_STAR_OPACITY is the
  // full-brightness reference, so this is 1.0 everywhere but surface-daytime.
  // (minus scene.position: the skybox is a scene child, so the surface-mode
  // floating-origin shift would otherwise displace it off the camera.)
  milkyway.position.copy(camera.position).sub(scene.position);
  milkyMat.uniforms.uBrightness.value = starMat.opacity / SURFACE_STAR_OPACITY;
  liveInfoAccum += dt;
  if (liveInfoAccum >= 0.1) { liveInfoAccum = 0; updateLiveInfo(); }
  // Walking a liquid-water world routes through the per-pixel underwater fog
  // pass so the submerged horizon fogs to the body's blue water tint instead of
  // the white aerial haze; everywhere else renders straight to the canvas.
  if (underwaterPassActive()) renderUnderwater();
  else renderer.render(scene, camera);
})();
