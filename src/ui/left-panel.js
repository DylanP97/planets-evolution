// Context-aware left panel: which tabs/sections are visible per focus kind,
// plus slider range setup and sync from the focused body.
import { setCurrentArchetype } from '../framework/state.js';

import { systemName } from '../core/names.js';
import { DEFAULT_MOON_SPEED, updateMoonPosition } from '../entities/moons.js';
import { DEFAULT_PROBE_SPEED, updateProbePosition } from '../entities/probes.js';
import { currentArchetype, focusedBody, moons, planets } from '../framework/state.js';
import { focusedCity, focusedProbe } from '../modes/focus.js';
import { ORBIT_DEG, applySatelliteOrbitPlane } from '../system/orbits.js';
import { DEFAULT_SPIN } from '../system/planets.js';
import {
  atmoCloudDriftInput, atmoCloudDriftValEl, atmoComplexWindsInput, atmoCoverageInput, atmoCoverageValEl, atmoDensityInput, atmoDensityValEl, atmoHintEl, atmoThickInput, atmoThickValEl, ringsEnabledInput, ringsHintEl, ringsIntensityInput, ringsIntensityValEl, syncGenLabels
} from './atmo-rings.js';
import {
  archetypeSelect, genAmpInput, genSeaInput, refreshActiveTool, refreshGasBiomeOptions, regenBtn, satellitesContext, seedInput, tabBtns
} from './controls.js';
import { planetCurrentSeed } from './info-panel.js';
import { renderPlanetList } from './roster.js';

// ====== 28. Context-aware left panel ======
// Each tab points at the focused entity; sliders, regen, deploy buttons all
// operate on the focused body. When focus changes we (1) refresh the slider
// values from the focused entity's state and (2) disable sections that can't
// act on the current focus (e.g. archetype select when a moon is focused).

export const classifyContextEl  = document.getElementById('classifyContext');
export const systemContextEl    = document.getElementById('systemContext');
export const archetypeHeaderEl  = document.getElementById('archetypeHeader');
// Direct DOM lookups (not the consts imported from controls.js): this module
// evaluates before controls.js finishes its import cycle, so those bindings
// are still TDZ here.
export const classifyArchSection = document.getElementById('archetypeSelect').closest('label');
export const classifyGenLabels  = [document.getElementById('genAmp').closest('label'), document.getElementById('genSea').closest('label')];
export const rosterHintEl       = document.getElementById('rosterHint');
export const rosterSectionEl    = document.getElementById('rosterSection');
export const planetListEl       = document.getElementById('planetList');
export const deployPlanetBtn    = document.getElementById('deployPlanetBtn');
export const bodyOrbitSectionEl = document.getElementById('bodyOrbitSection');
export const bodyOrbitHeaderEl  = document.getElementById('bodyOrbitHeader');
export const bodyDistInput      = document.getElementById('bodyDistInput');
export const bodyDistVal        = document.getElementById('bodyDistVal');
export const bodySpeedRow       = document.getElementById('bodySpeedRow');
export const bodySpeedInput     = document.getElementById('bodySpeedInput');
export const bodySpeedVal       = document.getElementById('bodySpeedVal');
export const bodySpinRow        = document.getElementById('bodySpinRow');
export const bodySpinInput      = document.getElementById('bodySpinInput');
export const bodySpinVal        = document.getElementById('bodySpinVal');
export const bodyMoonSpeedRow   = document.getElementById('bodyMoonSpeedRow');
export const bodyMoonSpeedInput = document.getElementById('bodyMoonSpeedInput');
export const bodyMoonSpeedVal   = document.getElementById('bodyMoonSpeedVal');
export const bodySizeInput      = document.getElementById('bodySizeInput');
export const bodySizeVal        = document.getElementById('bodySizeVal');
export const satelliteOrbitPlaneSection = document.getElementById('satelliteOrbitPlaneSection');
export const bodyInclInput      = document.getElementById('bodyInclInput');
export const bodyInclVal        = document.getElementById('bodyInclVal');
export const bodyNodeInput      = document.getElementById('bodyNodeInput');
export const bodyNodeVal        = document.getElementById('bodyNodeVal');
export const bodyRetrogradeInput= document.getElementById('bodyRetrogradeInput');
export const showSatelliteOrbitsInput = document.getElementById('showSatelliteOrbits');
export const showSatelliteOrbitsRow   = document.getElementById('showSatelliteOrbitsRow');
export const satellitesSectionEl= document.getElementById('satellitesSection');
export const atmoSectionEl      = document.getElementById('atmoSection');
export const ringsSectionEl     = document.getElementById('ringsSection');

// Range mapping. Different ranges for planets vs moons so the slider feels
// sensible at either scale.
export const PLANET_DIST = { sliderMin: 120, sliderMax: 900, scale: 1 };
export const MOON_DIST   = { sliderMin: 5,   sliderMax: 60,  scale: 1 };
export const PLANET_SIZE = { sliderMin: 3,   sliderMax: 30,  div: 10 };  // scale 0.3..3.0
export const MOON_SIZE   = { sliderMin: 2,   sliderMax: 40,  div: 10 };  // scale 0.2..4.0
export const PLANET_SPEED= { sliderMin: 1,   sliderMax: 40,  div: 100 }; // 0.01..0.40 rad/s
// Spin slider 0..100 maps linearly: w = (v / 3000) * 2π → 0..~0.21 rad/s.
export const PLANET_SPIN = { sliderMin: 0,   sliderMax: 100, div: 3000 };
export const spinSliderToRad = v => (v / PLANET_SPIN.div) * Math.PI * 2;
export const spinRadToSlider = w => Math.round((w / (Math.PI * 2)) * PLANET_SPIN.div);
// Moon-speed slider uses the same mapping that used to drive the global
// moon-speed knob, only now per-moon.
export const MOON_SPEED_DIV = 3000;
export const moonSliderToSpeed = v => (v / MOON_SPEED_DIV) * Math.PI * 2;
export const moonSpeedToSlider = s => Math.round((s / (Math.PI * 2)) * MOON_SPEED_DIV);

export function setRange(input, min, max) {
  input.min = String(min); input.max = String(max);
}

export function normDeg(rad) {
  return ((rad * 180 / Math.PI) % 360 + 360) % 360;
}

export function getFocusedSatellite() {
  if (focusedProbe) return focusedProbe;
  if (focusedBody?.kind === 'moon') {
    return moons.find(mn => mn.body === focusedBody) || null;
  }
  return null;
}

export function syncSatelliteOrbitPlaneUI(sat) {
  if (!sat || !bodyInclInput) return;
  bodyInclInput.value = String(Math.round(Math.abs(sat.inclination) / ORBIT_DEG));
  bodyInclVal.textContent = `${bodyInclInput.value}°`;
  bodyNodeInput.value = String(Math.round(normDeg(sat.node)));
  bodyNodeVal.textContent = `${bodyNodeInput.value}°`;
  if (bodyRetrogradeInput) bodyRetrogradeInput.checked = (sat.speedSign ?? 1) < 0;
}

export function applyFocusedSatelliteOrbitPlane() {
  const sat = getFocusedSatellite();
  if (!sat || !bodyInclInput) return;
  applySatelliteOrbitPlane(
    sat,
    parseInt(bodyInclInput.value, 10) * ORBIT_DEG,
    parseInt(bodyNodeInput.value, 10) * ORBIT_DEG,
    bodyRetrogradeInput?.checked ? -1 : 1,
  );
  if (sat.body) updateMoonPosition(sat);
  else updateProbePosition(sat);
}

// Show/hide tabs and sections in the left panel for the current focus.
// Driven by each tab button's `data-focus` attribute in index.html: a tab
// is visible only if its data-focus list includes the current kind
// ('planet' | 'moon' | 'system'). The big function below this one is the
// heart of context-aware UI — every focus change runs it.
export function applyFocusToLeftPanel() {
  const isProbe  = !!focusedProbe;
  const isPlanet = !isProbe && focusedBody && focusedBody.kind === 'planet';
  const isMoon   = !isProbe && focusedBody && focusedBody.kind === 'moon';
  const isSystem = !focusedBody && !focusedCity && !focusedProbe;
  // Full-gas planets have no solid surface, so the Sculpt tab and the
  // biome dropdown both disappear; the Envir tab swaps to atmospheric
  // band painting.
  const isGasFull = !!(isPlanet && focusedBody.matter && focusedBody.matter.gas === 'full');
  // Cities anchor their controls to the host body — re-use the planet/moon
  // layout for the body they belong to.
  const focusKind = isProbe  ? 'probe'
                  : isPlanet ? 'planet'
                  : isMoon   ? 'moon'
                  : focusedCity ? (focusedCity.body.kind === 'moon' ? 'moon' : 'planet')
                  : 'system';

  // --- Tab visibility (driven by data-focus on each tab button) ---
  // Each tab button declares which focus kinds it's relevant to. Hidden
  // tabs are stripped from layout entirely so the menu feels purpose-built
  // for the focused element instead of a static 5-tab grid with dimmed
  // sections. Belt-and-braces: class + inline style + disabled, because a
  // single CSS rule can be defeated by browser cache or theme overrides.
  let firstVisibleTab = null;
  let activeStillVisible = false;
  tabBtns.forEach(btn => {
    const allowed = (btn.dataset.focus || '').split(/\s+/);
    let visible = allowed.includes(focusKind);
    // Sculpt makes no sense on full-gas planets — there's no solid surface
    // to displace. The Envir tab survives because it owns atmosphere + rings
    // and the band-paint controls.
    if (visible && isGasFull && btn.dataset.tab === 'sculpt') visible = false;
    btn.classList.toggle('is-hidden', !visible);
    btn.style.display = visible ? '' : 'none';
    btn.disabled = !visible;
    // Also hide the matching tab-content so an old `.active` from a
    // previous focus can't keep panels showing through.
    const content = document.getElementById(`tab-${btn.dataset.tab}`);
    if (content && !visible) content.classList.remove('active');
    if (visible) {
      if (!firstVisibleTab) firstVisibleTab = btn;
      if (btn.classList.contains('active')) activeStillVisible = true;
    }
  });
  // Envir tab: swap biome row for the gas-paint section on full-gas planets.
  const biomeRowEl = document.getElementById('biomeRow');
  const gasPaintSectionEl = document.getElementById('gasPaintSection');
  if (biomeRowEl)        biomeRowEl.style.display        = isGasFull ? 'none' : '';
  if (gasPaintSectionEl) gasPaintSectionEl.style.display = isGasFull ? '' : 'none';
  // The Composition dropdown is filtered to the focused planet's flavour
  // (gas giant = brown→beige; ice giant = blue→white).
  if (isGasFull && typeof refreshGasBiomeOptions === 'function') {
    refreshGasBiomeOptions(focusedBody.archetype || 'gas_giant');
  }
  // If the active tab got hidden by the new focus, switch to System
  // (always visible) or whichever visible tab comes first.
  if (!activeStillVisible && firstVisibleTab) {
    const systemBtn = Array.from(tabBtns).find(b => b.dataset.tab === 'system' && b.style.display !== 'none');
    (systemBtn || firstVisibleTab).click();
  }

  // --- Classify tab (planet only) ---
  if (isPlanet) {
    classifyContextEl.textContent = `Editing: ${focusedBody.name}`;
    archetypeSelect.value = focusedBody.archetype || 'terrestrial';
    setCurrentArchetype(focusedBody.archetype || 'terrestrial');
    seedInput.value = focusedBody.currentSeed || planetCurrentSeed || '';
    genAmpInput.value = Math.round((focusedBody.currentAmp ?? 2.0) * 10);
    genSeaInput.value = Math.round((focusedBody.currentSea ?? 0.55) * 100);
    syncGenLabels();
    classifyArchSection.classList.remove('is-disabled-section');
    classifyGenLabels.forEach(l => l && l.classList.remove('is-disabled-section'));
    regenBtn.disabled = false;
  }

  // --- Satellites tab ---
  if (isPlanet) {
    satellitesContext.textContent = `Editing: ${focusedBody.name}`;
  } else if (isProbe && focusedProbe.parent) {
    satellitesContext.textContent = `Editing: ${focusedProbe.parent.name}`;
  }

  // --- System tab ---
  // Section visibility:
  //   roster        ↔ system focus
  //   bodyOrbit     ↔ planet | moon focus
  //   bodyMoonSpeed ↔ moon focus
  rosterSectionEl.classList.toggle('is-hidden-section', !isSystem);
  bodyOrbitSectionEl.classList.toggle('is-hidden-section', !(isPlanet || isMoon || isProbe));
  if (satelliteOrbitPlaneSection) {
    satelliteOrbitPlaneSection.style.display = (isMoon || isProbe) ? '' : 'none';
  }

  if (isSystem) {
    systemContextEl.textContent = `Editing: ${systemName} System`;
    rosterHintEl.textContent = `${planets.length} planet${planets.length === 1 ? '' : 's'} in system · keep ≥ 1`;
    renderPlanetList();
  } else if (isPlanet) {
    systemContextEl.textContent = `Editing: ${focusedBody.name}`;
    const entry = planets.find(p => p.body === focusedBody);
    bodyOrbitHeaderEl.textContent = 'Orbit (around star)';
    setRange(bodyDistInput, PLANET_DIST.sliderMin, PLANET_DIST.sliderMax);
    setRange(bodySizeInput, PLANET_SIZE.sliderMin, PLANET_SIZE.sliderMax);
    setRange(bodySpeedInput, PLANET_SPEED.sliderMin, PLANET_SPEED.sliderMax);
    setRange(bodySpinInput, PLANET_SPIN.sliderMin, PLANET_SPIN.sliderMax);
    bodySpeedRow.style.display = '';
    bodySpinRow.style.display = '';
    bodyMoonSpeedRow.style.display = 'none';
    if (entry) {
      bodyDistInput.value = Math.round(entry.orbit.distance);
      bodyDistVal.textContent = entry.orbit.distance.toFixed(0);
      bodySpeedInput.value = Math.max(1, Math.round(entry.orbit.speed * 100));
      bodySpeedVal.textContent = entry.orbit.speed.toFixed(2);
    }
    const spin = focusedBody.rotationSpeed ?? DEFAULT_SPIN;
    bodySpinInput.value = spinRadToSlider(spin);
    bodySpinVal.textContent = spin.toFixed(2);
    bodySizeInput.value = Math.round(focusedBody.group.scale.x * PLANET_SIZE.div);
    bodySizeVal.textContent = focusedBody.group.scale.x.toFixed(2);
    bodyOrbitSectionEl.classList.remove('is-disabled-section');
  } else if (isProbe) {
    systemContextEl.textContent = `Editing: ${focusedProbe.name}`;
    bodyOrbitHeaderEl.textContent = `Orbit (around ${focusedProbe.parent?.name || 'parent'})`;
    setRange(bodyDistInput, MOON_DIST.sliderMin, MOON_DIST.sliderMax);
    setRange(bodySizeInput, MOON_SIZE.sliderMin, MOON_SIZE.sliderMax);
    bodySpeedRow.style.display = 'none';
    bodySpinRow.style.display = 'none';
    bodyMoonSpeedRow.style.display = '';
    bodyDistInput.value = Math.round(focusedProbe.distance);
    bodyDistVal.textContent = focusedProbe.distance.toFixed(0);
    bodySizeInput.value = Math.round(focusedProbe.size * MOON_SIZE.div);
    bodySizeVal.textContent = focusedProbe.size.toFixed(2);
    const pSlider = moonSpeedToSlider(focusedProbe.speed ?? DEFAULT_PROBE_SPEED);
    bodyMoonSpeedInput.value = Math.max(1, Math.min(100, pSlider));
    bodyMoonSpeedVal.textContent = String(bodyMoonSpeedInput.value);
    syncSatelliteOrbitPlaneUI(focusedProbe);
    bodyOrbitSectionEl.classList.remove('is-disabled-section');
  } else if (isMoon) {
    systemContextEl.textContent = `Editing: ${focusedBody.name}`;
    const m = moons.find(mn => mn.body === focusedBody);
    bodyOrbitHeaderEl.textContent = `Orbit (around ${m?.parent?.name || 'parent'})`;
    setRange(bodyDistInput, MOON_DIST.sliderMin, MOON_DIST.sliderMax);
    setRange(bodySizeInput, MOON_SIZE.sliderMin, MOON_SIZE.sliderMax);
    bodySpeedRow.style.display = 'none';
    bodySpinRow.style.display = 'none';
    bodyMoonSpeedRow.style.display = '';
    if (m) {
      bodyDistInput.value = Math.round(m.distance);
      bodyDistVal.textContent = m.distance.toFixed(0);
      bodySizeInput.value = Math.round(m.size * MOON_SIZE.div);
      bodySizeVal.textContent = m.size.toFixed(2);
      const slider = moonSpeedToSlider(m.speed ?? DEFAULT_MOON_SPEED);
      bodyMoonSpeedInput.value = Math.max(1, Math.min(100, slider));
      bodyMoonSpeedVal.textContent = String(bodyMoonSpeedInput.value);
      syncSatelliteOrbitPlaneUI(m);
    }
    bodyOrbitSectionEl.classList.remove('is-disabled-section');
  } else {
    // City focus — show host body controls instead of disabling everything.
    systemContextEl.textContent = focusedCity ? `Editing: ${focusedCity.name} (city)` : 'No body focused';
  }

  // --- Environment tab: hide atmo + rings entirely for moons (not just
  //     disabled), since they're conceptually planet-only.
  atmoSectionEl.classList.toggle('is-hidden-section', !isPlanet);
  ringsSectionEl.classList.toggle('is-hidden-section', !isPlanet);
  syncAtmoSlidersToFocus();
  syncRingsToFocus();
  // On full-gas planets the Envir tab paints atmospheric bands instead of
  // biomes, so the hint and the active tool flip accordingly. updateBiomeTools
  // (called elsewhere on focus changes) rewrites this hint for solid bodies.
  if (isGasFull) {
    const hint = document.getElementById('biomeHint');
    if (hint) hint.textContent = `Atmospheric bands · painting on ${focusedBody.name}`;
  }
  refreshActiveTool();
}
// Mirror focused body's gas state into the atmo sliders + hint. If the
// focused body has no gas (or isn't a planet), gray out the controls and
// explain why so the panel doesn't look broken.
export function syncAtmoSlidersToFocus() {
  const b = focusedBody;
  const hasGas = !!(b && b.matter && b.matter.gas);
  // Coverage controls the cloud-pattern threshold, which only applies to
  // atmosphere mode — gas-giant bodies have no separate cloud layer.
  const coverageApplies = hasGas && b.matter.gas !== 'full';
  const atmoThickRow    = atmoThickInput.closest('label');
  const atmoDensityRow  = atmoDensityInput.closest('label');
  const atmoCoverageRow = atmoCoverageInput.closest('label');
  atmoThickInput.disabled    = !hasGas;
  atmoDensityInput.disabled  = !hasGas;
  atmoCoverageInput.disabled = !coverageApplies;
  // Wind & drift only meaningful on atmosphere-mode bodies — gas-giant
  // mode draws bands directly into the gas color, no separate cloud layer.
  atmoComplexWindsInput.disabled = !coverageApplies;
  atmoCloudDriftInput.disabled   = !coverageApplies;
  const atmoComplexWindsRow = atmoComplexWindsInput.closest('label');
  const atmoCloudDriftRow   = atmoCloudDriftInput.closest('label');
  if (atmoThickRow)    atmoThickRow.classList.toggle('is-disabled-section', !hasGas);
  if (atmoDensityRow)  atmoDensityRow.classList.toggle('is-disabled-section', !hasGas);
  if (atmoCoverageRow) atmoCoverageRow.classList.toggle('is-disabled-section', !coverageApplies);
  if (atmoComplexWindsRow) atmoComplexWindsRow.classList.toggle('is-disabled-section', !coverageApplies);
  if (atmoCloudDriftRow)   atmoCloudDriftRow.classList.toggle('is-disabled-section', !coverageApplies);
  if (hasGas) {
    const t = b.gasThickness ?? 1.10;
    const d = b.gasDensity ?? 0.20;
    const c = b.gasCoverage ?? 0.35;
    const cw = !!b.windMode;
    const cd = b.coverageVariance ?? 0;
    atmoThickInput.value      = Math.round(t * 100);
    atmoDensityInput.value    = Math.round(d * 100);
    atmoCoverageInput.value   = Math.round(c * 100);
    atmoComplexWindsInput.checked = cw;
    atmoCloudDriftInput.value     = Math.round(cd * 100);
    atmoThickValEl.textContent    = t.toFixed(2);
    atmoDensityValEl.textContent  = d.toFixed(2);
    atmoCoverageValEl.textContent = coverageApplies ? c.toFixed(2) : '—';
    atmoCloudDriftValEl.textContent = coverageApplies ? cd.toFixed(2) : '—';
    atmoHintEl.textContent = b.matter.gas === 'full'
      ? `Gaseous body · adjust size and density`
      : `Atmosphere wrapping ${b.name}`;
  } else {
    atmoThickValEl.textContent    = '—';
    atmoDensityValEl.textContent  = '—';
    atmoCoverageValEl.textContent = '—';
    atmoCloudDriftValEl.textContent = '—';
    atmoComplexWindsInput.checked = false;
    atmoHintEl.textContent = (b && b.kind === 'planet')
      ? `${b.name} has no atmosphere`
      : 'No atmosphere on this body';
  }
}

// Rings are planet-only. Disable the controls otherwise, and grey the
// intensity row when rings are toggled off so it reads as "no effect now".
export function syncRingsToFocus() {
  const b = focusedBody;
  const isPlanet = !!(b && b.kind === 'planet' && b.ringMesh);
  const enabledRow   = ringsEnabledInput.closest('label');
  const intensityRow = ringsIntensityInput.closest('label');
  ringsEnabledInput.disabled   = !isPlanet;
  ringsIntensityInput.disabled = !isPlanet || !(b && b.rings && b.rings.enabled);
  if (enabledRow)   enabledRow.classList.toggle('is-disabled-section', !isPlanet);
  if (intensityRow) intensityRow.classList.toggle('is-disabled-section', !isPlanet || !(b && b.rings && b.rings.enabled));
  if (isPlanet) {
    const r = b.rings;
    ringsEnabledInput.checked   = !!r.enabled;
    ringsIntensityInput.value   = Math.round((r.intensity ?? 0.65) * 100);
    ringsIntensityValEl.textContent = (r.intensity ?? 0.65).toFixed(2);
    ringsHintEl.textContent = r.enabled
      ? `Rings encircle ${b.name}`
      : `Toggle to add rings to ${b.name}`;
  } else {
    ringsEnabledInput.checked = false;
    ringsIntensityValEl.textContent = '—';
    ringsHintEl.textContent = (b && b.kind === 'moon')
      ? 'Satellites cannot have rings'
      : 'Focus a planet to add rings';
  }
}

