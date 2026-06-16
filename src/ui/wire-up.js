// Deferred UI wiring + the bus subscription registry. main.js imports this
// module last, after every other module has fully evaluated, so it is the
// one place that may freely import from every ui/ module at once.
//
// Bus events (emitted by lower layers via core/bus.js so they never import
// ui/): every subscription is registered HERE, in source order, so the
// handler call order is deterministic and easy to audit — it mirrors the
// direct call sequences the emits replaced.
import { on } from '../core/bus.js';
import { brushStrength, setBrushStrength } from '../framework/state.js';
import { focusedBody, focusedCity, focusedProbe } from '../framework/state.js';
import { setCityFocus, setFocus, setProbeFocus } from '../modes/focus.js';
import { onRegenClick } from './atmo-rings.js';
import { renderCityList } from '../entities/cities.js';
import {
  brushRadiusInput, brushStrengthInput, brushStrengthVal,
  genAmpInput, genSeaInput, refreshActiveTool, regenBtn,
  sliderToBrushStrength, syncBrushRadius, syncGenLabels, updateBiomeTools,
} from './controls.js';
import { deployPlanetBtn, focusPlanetBtn } from './dom.js';
import { updateInfoPanel } from './info-panel.js';
import { applyFocusToLeftPanel, syncRingsToFocus } from './left-panel.js';
import { renderNavBodies, setSystemFocus } from './nav.js';
import {
  deployNewPlanet, renderFocusBadges, renderMoonsList, renderPlanetList, renderProbesList
} from './roster.js';

// ---- Bus subscriptions -------------------------------------------------
// 'focus:changed' fires at the end of setFocus / setCityFocus / setProbeFocus;
// the handler order replicates the original tail of those functions.
on('focus:changed', () => {
  renderFocusBadges();
  updateBiomeTools();
  updateInfoPanel();
  applyFocusToLeftPanel();
});
on('focus:system', setSystemFocus);            // probes/teardown/starsystems
on('nav:render', renderNavBodies);             // roster, star-map
on('ui:info', updateInfoPanel);                // moons, atmo sliders
on('ui:render-city-list', renderCityList);     // setCityFocus
on('ui:satellite-lists', () => { renderMoonsList(); renderProbesList(); });
on('ui:biome-tools', updateBiomeTools);        // finalizeSystemLoad
on('ui:active-tool', refreshActiveTool);       // finalizeSystemLoad
on('ui:left-panel', applyFocusToLeftPanel);    // onRegenClick (matter change)
on('ui:sync-rings', syncRingsToFocus);         // rings enable toggle

// ---- generator + brush slider init ----
regenBtn.onclick = onRegenClick;

syncBrushRadius(parseInt(brushRadiusInput.value, 10));
setBrushStrength(sliderToBrushStrength(parseInt(brushStrengthInput.value, 10)));
brushStrengthVal.textContent = brushStrength.toFixed(1);

genAmpInput.oninput = syncGenLabels;
genSeaInput.oninput = syncGenLabels;
syncGenLabels();

// ---- roster buttons ----
deployPlanetBtn.onclick = () => {
  const b = deployNewPlanet();
  if (b) {
    renderPlanetList();
    renderNavBodies();
  }
};

// Reset Camera: recenter on whatever is currently in focus, not always Earth.
focusPlanetBtn.onclick = () => {
  if (focusedProbe) setProbeFocus(focusedProbe);
  else if (focusedCity) setCityFocus(focusedCity);
  else if (focusedBody) setFocus(focusedBody);
  else setSystemFocus();
};
