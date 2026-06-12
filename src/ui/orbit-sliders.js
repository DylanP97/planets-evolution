import { setMoonDistance, setMoonSize } from '../entities/moons.js';
import { setSatelliteDistance, setSatelliteSize } from '../entities/probes.js';
import { refreshClimateColoring } from '../framework/body.js';
import { focusedBody, moons, planets, probes } from '../framework/state.js';
import { focusedProbe } from '../modes/focus.js';
import {
  refreshOrbitLine, setSatelliteOrbitLinesVisible, showSatelliteOrbits
} from '../system/orbits.js';
import { updatePlanetOrbitPosition } from '../system/planets.js';
import { renderClimateSection, updateInfoPanel, updateLiveInfo } from './info-panel.js';
import {
  MOON_SIZE, PLANET_SIZE, PLANET_SPEED, applyFocusedSatelliteOrbitPlane, bodyDistInput, bodyDistVal, bodyInclInput, bodyInclVal, bodyMoonSpeedInput, bodyMoonSpeedVal, bodyNodeInput, bodyNodeVal, bodyRetrogradeInput, bodySizeInput, bodySizeVal, bodySpeedInput, bodySpeedVal, bodySpinInput, bodySpinVal, moonSliderToSpeed, showSatelliteOrbitsInput, spinSliderToRad
} from './left-panel.js';

// ====== 29. Body orbit slider handlers ======
bodyDistInput.oninput = () => {
  const v = parseInt(bodyDistInput.value, 10);
  if (focusedProbe) {
    const idx = probes.indexOf(focusedProbe);
    if (idx >= 0) setSatelliteDistance(idx, v);
  } else if (focusedBody?.kind === 'planet') {
    const entry = planets.find(p => p.body === focusedBody);
    if (entry) {
      entry.orbit.distance = v;
      updatePlanetOrbitPosition(entry);
      refreshOrbitLine(entry);
    }
  } else if (focusedBody?.kind === 'moon') {
    const idx = moons.findIndex(mn => mn.body === focusedBody);
    if (idx >= 0) setMoonDistance(idx, v);
  }
  bodyDistVal.textContent = v.toFixed(0);
  // A planet's distance from the star sets its climate — refresh the readout
  // live as the slider drags (cheap; no full panel re-render needed).
  if (focusedBody && !focusedProbe) renderClimateSection(focusedBody);
};
// On release, repaint the surface so the ice caps grow/shrink with the new
// orbital distance. Done on 'change' (not every drag tick) since a full
// recolor is heavier than the live readout above.
bodyDistInput.onchange = () => {
  if (focusedBody?.kind === 'planet' && !focusedProbe) {
    refreshClimateColoring(focusedBody);
    updateInfoPanel();  // climate shifted the biomes/sea state — re-roll the composition rollup
  }
};

bodySpeedInput.oninput = () => {
  const v = parseInt(bodySpeedInput.value, 10) / PLANET_SPEED.div;
  if (focusedBody?.kind === 'planet' && !focusedProbe) {
    const entry = planets.find(p => p.body === focusedBody);
    if (entry) entry.orbit.speed = v;
    bodySpeedVal.textContent = v.toFixed(2);
  }
};

bodySpinInput.oninput = () => {
  if (focusedBody?.kind !== 'planet' || focusedProbe) return;
  const w = spinSliderToRad(parseInt(bodySpinInput.value, 10));
  focusedBody.rotationSpeed = w;
  bodySpinVal.textContent = w.toFixed(2);
  updateLiveInfo();
};

bodySizeInput.oninput = () => {
  const raw = parseInt(bodySizeInput.value, 10);
  if (focusedProbe) {
    const scale = raw / MOON_SIZE.div;
    const idx = probes.indexOf(focusedProbe);
    if (idx >= 0) setSatelliteSize(idx, scale);
    bodySizeVal.textContent = scale.toFixed(2);
  } else if (focusedBody?.kind === 'planet') {
    const scale = raw / PLANET_SIZE.div;
    focusedBody.group.scale.setScalar(scale);
    bodySizeVal.textContent = scale.toFixed(2);
  } else if (focusedBody?.kind === 'moon') {
    const scale = raw / MOON_SIZE.div;
    const idx = moons.findIndex(mn => mn.body === focusedBody);
    if (idx >= 0) setMoonSize(idx, scale);
    bodySizeVal.textContent = scale.toFixed(2);
  }
};

// Per-moon / per-probe orbital speed around the host planet.
bodyMoonSpeedInput.oninput = () => {
  const v = parseInt(bodyMoonSpeedInput.value, 10);
  if (focusedProbe) {
    focusedProbe.speed = moonSliderToSpeed(v);
  } else if (focusedBody?.kind === 'moon') {
    const m = moons.find(mn => mn.body === focusedBody);
    if (m) m.speed = moonSliderToSpeed(v);
  } else return;
  bodyMoonSpeedVal.textContent = String(v);
  updateLiveInfo();
};

export function onSatelliteOrbitPlaneControl() {
  applyFocusedSatelliteOrbitPlane();
  updateLiveInfo();
}
if (bodyInclInput) {
  bodyInclInput.oninput = () => {
    bodyInclVal.textContent = `${bodyInclInput.value}°`;
    onSatelliteOrbitPlaneControl();
  };
}
if (bodyNodeInput) {
  bodyNodeInput.oninput = () => {
    bodyNodeVal.textContent = `${bodyNodeInput.value}°`;
    onSatelliteOrbitPlaneControl();
  };
}
if (bodyRetrogradeInput) {
  bodyRetrogradeInput.onchange = onSatelliteOrbitPlaneControl;
}

if (showSatelliteOrbitsInput) {
  showSatelliteOrbitsInput.checked = showSatelliteOrbits;
  showSatelliteOrbitsInput.onchange = () => {
    setSatelliteOrbitLinesVisible(showSatelliteOrbitsInput.checked);
  };
}

