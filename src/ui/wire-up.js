// Deferred UI wiring. The ui/ modules form import cycles (controls ↔
// atmo-rings ↔ left-panel ↔ roster …), so a module evaluated mid-cycle
// cannot touch another module's consts at its own module scope — they are
// still in their temporal dead zone. Everything here only needs to run once
// before the first user interaction, so it lives in this leaf module, which
// main.js imports after every other module has fully evaluated.
import { brushStrength } from '../framework/state.js';
import { setBrushStrength } from '../framework/state.js';
import {
  brushRadiusInput, brushStrengthInput, brushStrengthVal,
  genAmpInput, genSeaInput, regenBtn,
  focusPlanetBtn, syncBrushRadius,
} from './controls.js';
import { onRegenClick, sliderToBrushStrength, syncGenLabels } from './atmo-rings.js';
import { deployPlanetBtn } from './left-panel.js';
import { deployNewPlanet, renderPlanetList } from './roster.js';
import { renderNavBodies, setSystemFocus } from './nav.js';
import { focusedBody } from '../framework/state.js';
import { focusedCity, focusedProbe, setCityFocus, setFocus, setProbeFocus } from '../modes/focus.js';

// ---- section 26/27 tail: generator + brush slider init ----
regenBtn.onclick = onRegenClick;

syncBrushRadius(parseInt(brushRadiusInput.value, 10));
setBrushStrength(sliderToBrushStrength(parseInt(brushStrengthInput.value, 10)));
brushStrengthVal.textContent = brushStrength.toFixed(1);

genAmpInput.oninput = syncGenLabels;
genSeaInput.oninput = syncGenLabels;
syncGenLabels();

// ---- section 30 tail: roster buttons ----
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
