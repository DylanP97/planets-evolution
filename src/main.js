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
import './interaction/pointer.js';
import { updateMoons } from './entities/moons.js';
import { updateSatellites } from './entities/probes.js';
import { updateCityMarkers } from './entities/cities.js';
import { starMat } from './background/starfield.js';
import { milkyway, milkyMat } from './background/galaxy.js';
import { updateEruptions } from './background/eruptions.js';
import { updateSunLightForFocus, updateMoonLight } from './system/lighting.js';
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
import { updateProps } from './modes/surface/props.js';
import { stepSurfaceWalk } from './modes/surface/walk.js';
import './modes/surface/input.js';
import './ui/naming.js';
import { loadStarSystem, findStarSystem } from './system/starsystems.js';
import './ui/star-map.js';
// Must stay last: wires UI handlers that touch consts across the ui/ import
// cycles, which are only safe once every module above has fully evaluated.
import './ui/wire-up.js';

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
    updateProps(dt);
    updateSurfaceSkyEffects();
  }
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
  renderer.render(scene, camera);
})();
