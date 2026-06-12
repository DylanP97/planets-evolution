// Atmosphere sliders, ring controls, the Generate World button handler, and
// slider→value conversions.
import { setPlanetCurrentSeed } from './info-panel.js';

import { setBrushStrength } from '../framework/state.js';

import {
  applyGasShell, applyRingsToBody, refreshClimateColoring, regenerateBody
} from '../framework/body.js';
import { brushStrength, currentArchetype, focusedBody, moons, planet } from '../framework/state.js';
import {
  brushRadiusInput, brushStrengthInput, brushStrengthVal, genAmpInput, genAmpVal, genSeaInput, genSeaVal, regenBtn, seedInput, syncBrushRadius
} from './controls.js';
import { planetCurrentSeed, renderClimateSection, updateInfoPanel } from './info-panel.js';
import { applyFocusToLeftPanel, syncAtmoSlidersToFocus, syncRingsToFocus } from './left-panel.js';

// ====== 26. Atmosphere sliders ======
export const atmoThickInput      = document.getElementById('atmoThick');
export const atmoThickValEl      = document.getElementById('atmoThickVal');
export const atmoDensityInput    = document.getElementById('atmoDensity');
export const atmoDensityValEl    = document.getElementById('atmoDensityVal');
export const atmoCoverageInput   = document.getElementById('atmoCoverage');
export const atmoCoverageValEl   = document.getElementById('atmoCoverageVal');
export const atmoComplexWindsInput = document.getElementById('atmoComplexWinds');
export const atmoCloudDriftInput   = document.getElementById('atmoCloudDrift');
export const atmoCloudDriftValEl   = document.getElementById('atmoCloudDriftVal');
export const atmoHintEl          = document.getElementById('atmoHint');

// Whoever is in focus when the slider moves is the body that gets edited.
// No focus, or focus on a body without gas, means the change is a no-op.
export function applyAtmoSliderToFocus() {
  const b = focusedBody;
  if (!b || !b.gasMesh || !b.matter || !b.matter.gas) return;
  b.gasThickness = parseInt(atmoThickInput.value, 10) / 100;       // 1.00..1.40
  b.gasDensity   = parseInt(atmoDensityInput.value, 10) / 100;     // 0.00..1.00
  b.gasCoverage  = parseInt(atmoCoverageInput.value, 10) / 100;    // 0.00..1.00
  applyGasShell(b);
  atmoThickValEl.textContent    = b.gasThickness.toFixed(2);
  atmoDensityValEl.textContent  = b.gasDensity.toFixed(2);
  atmoCoverageValEl.textContent = b.gasCoverage.toFixed(2);
  // A denser/thicker atmosphere warms the surface and evens out the poles —
  // reflect that in the climate readout as the sliders move.
  renderClimateSection(b);
}
atmoThickInput.oninput    = applyAtmoSliderToFocus;
atmoDensityInput.oninput  = applyAtmoSliderToFocus;
atmoCoverageInput.oninput = applyAtmoSliderToFocus;
// Size/density change the greenhouse warming and pole-to-equator evening, so
// repaint the ice on release. (Coverage is cloud cover only — no climate
// effect — but recoloring on its release too is harmless and keeps it simple.)
atmoThickInput.onchange   = () => { refreshClimateColoring(focusedBody); updateInfoPanel(); };
atmoDensityInput.onchange = () => { refreshClimateColoring(focusedBody); updateInfoPanel(); };

// Per-body realism toggles for the cloud layer.
//   atmoComplexWinds → flips the shader's uWindMode, swapping uniform
//     zonal drift for latitude-banded flow (Hadley/Ferrel/Polar).
//   atmoCloudDrift   → body.coverageVariance (0..1). The animation
//     loop modulates uCoverage around the slider's base value at this
//     amplitude, so total cloud cover slowly waxes and wanes.
atmoComplexWindsInput.onchange = () => {
  const b = focusedBody;
  if (!b || !b.gasMesh || !b.matter || !b.matter.gas) return;
  b.windMode = !!atmoComplexWindsInput.checked;
  b.gasMesh.material.uniforms.uWindMode.value = b.windMode ? 1.0 : 0.0;
};
atmoCloudDriftInput.oninput = () => {
  const b = focusedBody;
  const v = parseInt(atmoCloudDriftInput.value, 10) / 100; // 0..1
  atmoCloudDriftValEl.textContent = v.toFixed(2);
  if (!b || !b.gasMesh || !b.matter || !b.matter.gas) return;
  b.coverageVariance = v;
  // If drift just turned off, snap the uniform back to the base value
  // so the cloud field stops mid-cycle instead of freezing wherever
  // it happened to be in its sine wave.
  if (v === 0) b.gasMesh.material.uniforms.uCoverage.value = b.gasCoverage ?? 0.35;
};

// ====== 27. Ring controls ======
export const ringsEnabledInput   = document.getElementById('ringsEnabled');
export const ringsIntensityInput = document.getElementById('ringsIntensity');
export const ringsIntensityValEl = document.getElementById('ringsIntensityVal');
export const ringsHintEl         = document.getElementById('ringsHint');

export function applyRingsSliderToFocus() {
  const b = focusedBody;
  if (!b || !b.ringMesh || b.kind !== 'planet') return;
  b.rings.enabled   = !!ringsEnabledInput.checked;
  b.rings.intensity = parseInt(ringsIntensityInput.value, 10) / 100;
  ringsIntensityValEl.textContent = b.rings.intensity.toFixed(2);
  applyRingsToBody(b);
  // Toggling enable flips whether the intensity row is greyed; re-sync.
  syncRingsToFocus();
}
ringsEnabledInput.onchange   = applyRingsSliderToFocus;
ringsIntensityInput.oninput  = applyRingsSliderToFocus;

// Bound to regenBtn.onclick in ui/wire-up.js — this module is evaluated
// before controls.js finishes (import cycle), so regenBtn would be TDZ here.
export function onRegenClick() {
  // Regenerate operates on the focused body (planet or moon). The archetype
  // global only changes palette for planets — moons keep MOON_PALETTE.
  const target = focusedBody && (focusedBody.kind === 'planet' || focusedBody.kind === 'moon')
    ? focusedBody : planet;
  const seed = seedInput.value || 'planet';
  const amp = sliderToAmplitude(parseInt(genAmpInput.value, 10));
  const sea = sliderToSeaCoverage(parseInt(genSeaInput.value, 10));
  regenerateBody(target, seed, amp, sea);
  target.currentSeed = seed;
  target.currentAmp = amp;
  target.currentSea = sea;
  if (target.kind === 'planet') target.archetype = currentArchetype;
  if (target === planet) setPlanetCurrentSeed(seed);
  const moonEntry = moons.find(m => m.body === target);
  if (moonEntry) moonEntry.seed = seed;
  // Matter may have changed (e.g. desert→terrestrial gained an ocean and
  // atmosphere; or terrestrial→gas_giant dropped the solid surface) —
  // re-sync the atmo sliders and the panel layout so the Sculpt tab and
  // biome / band-color rows match the new state.
  if (typeof syncAtmoSlidersToFocus === 'function') syncAtmoSlidersToFocus();
  if (typeof applyFocusToLeftPanel === 'function') applyFocusToLeftPanel();
  updateInfoPanel();
}

// Initial brush slider sync also lives in ui/wire-up.js (controls.js consts
// are TDZ while this module evaluates).

export function sliderToBrushRadius(v) { return v / 100; }
export function sliderToBrushStrength(v) { return v / 10; }
export function sliderToAmplitude(v) { return v / 10; }
export function sliderToSeaCoverage(v) { return v / 100; }

export function syncGenLabels() {
  genAmpVal.textContent = sliderToAmplitude(parseInt(genAmpInput.value, 10)).toFixed(1);
  genSeaVal.textContent = genSeaInput.value + '%';
}
// genAmp/genSea label wiring + the initial syncGenLabels() call are in
// ui/wire-up.js for the same import-cycle reason.

