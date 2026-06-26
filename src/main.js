import * as THREE from 'three';

// Build marker — bump on each change so a hard-refresh can be confirmed in the
// console (window.__BUILD). If this number doesn't update after reloading, the
// browser is serving stale cached ES modules — hard-refresh (Ctrl+Shift+R).
window.__BUILD = 'clouds-all-morph-1';
console.log('[planet-tiles] build', window.__BUILD);

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
import { beginPerfFrame, updatePerfHud } from './ui/perf-hud.js';
import './ui/controls.js';
import './ui/atmo-rings.js';
import './ui/left-panel.js';
import './ui/orbit-sliders.js';
import './ui/roster.js';
import './ui/nav.js';
import './ui/hud-toggle.js';
import './modes/surface/core.js';
import './modes/surface/avatar.js';
import './modes/surface/mode.js';
import { updateSurfaceSkyEffects, updateSkyBodies, SURFACE_STAR_OPACITY } from './modes/surface/sky.js';
import { updateSurfaceOrigin, updateSurfaceCamera } from './modes/surface/camera.js';
import { updateAstronaut } from './modes/surface/swim.js';
import { updateGrass } from './modes/surface/grass.js';
import { updateRocks } from './modes/surface/rocks.js';
import { updateSlabs } from './modes/surface/slabs.js';
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
import { debugCamActive, updateDebugCam } from './modes/debug-cam.js';
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

// ====== Boot loader dismissal ======
// The #bootLoader overlay (index.html) covers the page from first paint. We
// drive its progress counter + status line while the scene warms up, then
// remove it on the first rendered frame — but never before BOOT_MIN_MS, so the
// loader always stays up long enough to read (and never flashes by).
const BOOT_MIN_MS = 3000;
const _bootStart = performance.now();
let _bootDone = false;
{
  const statusEl = document.getElementById('bootStatus');
  const pctEl    = document.getElementById('bootPercent');
  const barEl    = document.getElementById('bootBarFill');
  const msgs = [
    'Igniting stellar core',
    'Seeding planetary crust',
    'Calibrating orbital mechanics',
    'Painting biomes',
    'Charting the star map',
  ];
  // Ease the bar toward ~92% over the warm-up; dismissal snaps it to 100%.
  // The displayed status follows the progress, not a separate timer.
  let pct = 0;
  const tick = setInterval(() => {
    pct += Math.max(0.6, (92 - pct) * 0.06);
    if (pct > 92) pct = 92;
    const shown = Math.floor(pct);
    if (pctEl)    pctEl.textContent = shown;
    if (barEl)    barEl.style.width = pct + '%';
    if (statusEl) statusEl.textContent = msgs[Math.min(msgs.length - 1, Math.floor((shown / 100) * msgs.length))];
  }, 80);
  dismissBootLoader._finish = () => {
    clearInterval(tick);
    if (pctEl) pctEl.textContent = '100';
    if (barEl) barEl.style.width = '100%';
  };
}
function dismissBootLoader() {
  if (_bootDone) return;
  _bootDone = true;
  const wait = Math.max(0, BOOT_MIN_MS - (performance.now() - _bootStart));
  setTimeout(() => {
    if (dismissBootLoader._finish) dismissBootLoader._finish();
    const el = document.getElementById('bootLoader');
    if (!el) return;
    // Let 100% paint for one frame, then cut straight to the scene (no fade).
    requestAnimationFrame(() => el.remove());
  }, wait);
}

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
  // Reset the renderer's per-frame draw counters before anything renders, so
  // the perf HUD tallies the true total across every pass this frame.
  beginPerfFrame();
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
          // Variance scales BOTH the swing amplitude and how fast it drifts —
          // a high "Cloud Coverage Drift" makes the deck thicken/thin rapidly.
          const speed  = 0.04 + 0.22 * variance;
          const drift  = Math.sin(gasTime * speed + phase) * 0.35 * variance;
          u.uCoverage.value = Math.max(0, Math.min(1, base + drift));
        } else {
          u.uCoverage.value = b.gasCoverage ?? 0.35;
        }
        // Cloud Type "All" (3): morph through the three types over time. The
        // Cloud Coverage Drift slider sets the morph speed too — high drift
        // cycles cumulus→stratus→cirrus rapidly, low drift drifts slowly.
        if ((b.cloudType ?? 0) === 3) {
          const variance = b.coverageVariance ?? 0;
          const phase    = b.coveragePhase ?? 0;
          const speed    = 0.04 + 0.20 * variance;
          u.uCloudBlend.value = (((gasTime * speed + phase) % 3) + 3) % 3;
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

  // DEBUG free-fly camera (press F): the camera detaches from the focus rig /
  // surface walker and the user flies it around. We skip the normal camera
  // drivers (focus tracking, OrbitControls) so nothing fights it for the
  // transform; the rest of the world keeps advancing.
  if (debugCamActive()) {
    // On a surface, keep the avatar glued to its body even as we fly away:
    // updateSurfaceOrigin re-pins the floating origin and updateAstronaut
    // replants the feet (a moon underfoot keeps orbiting even while paused, so
    // a frozen avatar would drift off it). updateSurfaceCamera runs only to
    // refresh the world vectors updateAstronaut reads — the debug camera
    // overwrites its transform immediately after, below.
    if (viewMode === 'surface' && surfaceState.body) {
      updateSurfaceOrigin();
      updateSurfaceCamera();
      updateAstronaut(dt);
    }
    updateDebugCam(dt);
    updateOrbitInteraction();
    milkyway.position.copy(camera.position).sub(scene.position);
    milkyMat.uniforms.uBrightness.value = starMat.opacity / SURFACE_STAR_OPACITY;
    liveInfoAccum += dt;
    if (liveInfoAccum >= 0.1) { liveInfoAccum = 0; updateLiveInfo(); }
    renderer.render(scene, camera);
    updatePerfHud(dt);
    if (!_bootDone) dismissBootLoader();
    return;
  }

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
    updateSlabs(dt);
    updateWaterPatch(dt);
    updateGroundPatch(dt);
    updateFootprints(dt);
    updateProps(dt);
    updateSeabed(dt);
    updateBubbles(dt);
    updateMinimap(dt);
    updateSurfaceSkyEffects();
    // Make the Moon / other solid planets in the sky read as lit globes
    // (broad albedo patches + night-side floor) rather than flat grey discs.
    updateSkyBodies();
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
  // Refresh the dev perf HUD AFTER rendering, so renderer.info holds the
  // triangle / draw-call counts for the frame just drawn.
  updatePerfHud(dt);
  // First frame is on screen — the scene is interactive, so retire the loader.
  if (!_bootDone) dismissBootLoader();
})();
