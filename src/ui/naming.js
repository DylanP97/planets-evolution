// Inline renaming of bodies / the system, with the re-render fan-out.
import { setSystemNameValue } from '../core/names.js';

import { generateName, systemName } from '../core/names.js';
import { renderCityList } from '../entities/cities.js';
import { focusedBody, focusedCity, focusedProbe } from '../framework/state.js';
import { updateBiomeTools } from './controls.js';
import { focusNameEl, navNameEl, navRandomBtn } from './dom.js';
import { updateInfoPanel } from './info-panel.js';
import { applyFocusToLeftPanel } from './left-panel.js';
import { renderNavBodies } from './nav.js';
import { renderMoonsList, renderProbesList } from './roster.js';

// ====== 34. Renaming ======
// Inline edit (click the focused name in the nav) + a 🎲 button that
// pulls from generateName(). Renaming touches a lot of surfaces — moon
// cards, city list, info panel, nav, biome hint — so setBodyName is the
// single fan-out point that re-renders all of them.
export function setBodyName(body, newName) {
  if (!body || !newName) return;
  body.name = newName;
  if (focusedBody === body) {
    focusNameEl.textContent = focusedCity ? `${focusedCity.name} · ${body.name}` : body.name;
  }
  renderNavBodies();
  renderMoonsList();
  renderProbesList();
  renderCityList();
  updateInfoPanel();
  updateBiomeTools();
  applyFocusToLeftPanel();
}

export function setSystemName(newName) {
  if (!newName) return;
  setSystemNameValue(newName);
  renderNavBodies();
  updateInfoPanel();
}

export function commitFocusName(newName) {
  const cleaned = newName.replace(/\s+/g, ' ').trim();
  if (!cleaned) { renderNavBodies(); return; }
  if (focusedProbe) {
    focusedProbe.name = cleaned;
    if (focusedProbe.mesh) focusedProbe.mesh.name = cleaned;
    focusNameEl.textContent = cleaned;
    renderNavBodies();
    renderProbesList();
    updateInfoPanel();
  } else if (focusedCity) {
    focusedCity.name = cleaned;
    focusNameEl.textContent = `${cleaned} · ${focusedCity.body.name}`;
    renderNavBodies();
    renderCityList();
  } else if (focusedBody) {
    setBodyName(focusedBody, cleaned);
  } else {
    setSystemName(cleaned);
  }
}

navNameEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); navNameEl.blur(); }
  else if (e.key === 'Escape') { e.preventDefault(); renderNavBodies(); navNameEl.blur(); }
});
navNameEl.addEventListener('focus', () => {
  // Select-all on focus so typing replaces the current name.
  requestAnimationFrame(() => {
    const range = document.createRange();
    range.selectNodeContents(navNameEl);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  });
});
navNameEl.addEventListener('blur', () => {
  commitFocusName(navNameEl.textContent);
});

navRandomBtn.addEventListener('click', () => {
  if (focusedProbe) {
    focusedProbe.name = generateName('moon');
    if (focusedProbe.mesh) focusedProbe.mesh.name = focusedProbe.name;
    focusNameEl.textContent = focusedProbe.name;
    renderNavBodies();
    renderProbesList();
    updateInfoPanel();
  } else if (focusedCity) {
    focusedCity.name = generateName('moon');
    focusNameEl.textContent = `${focusedCity.name} · ${focusedCity.body.name}`;
    renderNavBodies();
    renderCityList();
  } else if (focusedBody) {
    const kind = focusedBody.kind === 'moon' ? 'moon' : 'planet';
    setBodyName(focusedBody, generateName(kind));
  } else {
    setSystemName(generateName('system'));
  }
});

