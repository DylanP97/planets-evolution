// Bottom-nav hierarchy navigation: up/down/sibling across system → planet →
// moon/city, breadcrumb rendering, setSystemFocus.
import { setFocusedBody, setFocusedCity, setFocusedProbe } from '../framework/state.js';

import { systemName } from '../core/names.js';
import { camera, controls } from '../core/scene.js';
import { ARCHETYPES } from '../framework/archetypes.js';
import {
  cities, focusedBody, focusedCity, focusedProbe, moons, planets, probes
} from '../framework/state.js';
import { setCityFocus, setFocus, setProbeFocus } from '../modes/focus.js';
import { updateVisitButtonState } from '../modes/surface/core.js';
import {
  findConstellation, galaxy, viewLevel, viewedConstellationId
} from '../system/starsystems.js';
import { focusNameEl, navNameEl } from './dom.js';
import { updateInfoPanel } from './info-panel.js';
import { applyFocusToLeftPanel } from './left-panel.js';
import { renderFocusBadges } from './roster.js';
import { closeMap, currentConstellation, openConstellationMap, openGalaxyMap } from './star-map.js';

// ====== 31. Hierarchy navigation ======
// Levels: System (no body focused) → Planet → satellite ring (moons +
// probes, same level) / City. Arrows: ↑ zoom out, ↓ zoom in to first child,
// ←/→ cycle siblings (moons and probes share one ring under their planet).
export const navLevelEl = document.getElementById('navFocusLevel');
export const navSubEl   = document.getElementById('navFocusSub');
export const navUpBtn   = document.getElementById('navUp');
export const navDownBtn = document.getElementById('navDown');
export const navLeftBtn = document.getElementById('navLeft');
export const navRightBtn= document.getElementById('navRight');
export const navBreadcrumbEl = document.getElementById('navBreadcrumb');

// navNameEl is contenteditable. While the user has it focused for typing,
// skip programmatic updates so renders don't clobber their unsaved input.
export function setNavNameText(text) {
  if (document.activeElement === navNameEl) return;
  navNameEl.textContent = text;
}

export function setSystemFocus() {
  setFocusedBody(null);
  setFocusedCity(null);
  setFocusedProbe(null);
  focusNameEl.textContent = 'System View';
  const maxOrbit = planets.reduce((acc, p) => Math.max(acc, p.orbit.distance), 40);
  const dist = Math.max(220, maxOrbit * 3.0 + 60);
  let dir = camera.position.clone().sub(controls.target);
  if (dir.lengthSq() < 1e-6) dir.set(0, 0.4, 1);
  dir.normalize();
  controls.target.set(0, 0, 0);
  camera.position.copy(controls.target).addScaledVector(dir, dist);
  renderFocusBadges();
  updateInfoPanel();
  applyFocusToLeftPanel();
}

// The satellite level of a planet holds both its moons and its probes, in
// that order. Returned as a uniform list of nav targets so the arrows can
// cycle through them as one ring and zoom into the first of either kind.
export function satelliteRing(parent) {
  const ring = [];
  for (const m of moons) if (m.parent === parent) ring.push({ kind: 'moon', body: m.body });
  for (const p of probes) if (p.parent === parent) ring.push({ kind: 'probe', probe: p });
  return ring;
}
export function focusSatellite(target) {
  if (target.kind === 'probe') setProbeFocus(target.probe);
  else setFocus(target.body);
}

export function navUp() {
  // On the star maps, ▲ climbs the cosmic hierarchy.
  if (viewLevel === 'constellation') { openGalaxyMap(); return; }
  if (viewLevel === 'galaxy') return;                 // already at the top
  // --- system level (the 3D scene) ---
  if (focusedProbe) { setFocus(focusedProbe.parent); return; }
  if (focusedCity) { setFocus(focusedBody); return; }
  if (focusedBody?.kind === 'moon') {
    const m = moons.find(mn => mn.body === focusedBody);
    if (m?.parent) { setFocus(m.parent); return; }
  }
  // Planet → system view; already at system → up into the constellation map.
  if (focusedBody) { setSystemFocus(); return; }
  openConstellationMap();
}

export function navDown() {
  // On the star maps, ▼ descends: galaxy → home constellation, constellation
  // → into the loaded 3D system.
  if (viewLevel === 'galaxy') { openConstellationMap(); return; }
  if (viewLevel === 'constellation') { closeMap(); return; }
  if (focusedCity || focusedProbe) return; // leaf nodes — nothing below
  if (!focusedBody) {
    if (planets.length) setFocus(planets[0].body);
    return;
  }
  if (focusedBody.kind === 'planet') {
    const ring = satelliteRing(focusedBody);
    if (ring.length) { focusSatellite(ring[0]); return; }
    const myCities = cities.filter(c => c.body === focusedBody);
    if (myCities.length) setCityFocus(myCities[0]);
    return;
  }
  // moon
  const myCities = cities.filter(c => c.body === focusedBody);
  if (myCities.length) setCityFocus(myCities[0]);
}

// Cycle the focused entity to its next/previous sibling. Siblings are: other
// cities on the same body (when a city is focused), other planets at the
// system level, or the host planet's satellite ring — moons and probes
// together (when a moon or probe is focused). Wraps both directions.
export function navSibling(dir) {
  if (focusedCity) {
    const sibs = cities.filter(c => c.body === focusedCity.body);
    if (sibs.length < 2) return;
    const idx = sibs.indexOf(focusedCity);
    setCityFocus(sibs[(idx + dir + sibs.length) % sibs.length]);
    return;
  }
  if (focusedProbe) {
    const ring = satelliteRing(focusedProbe.parent);
    if (ring.length < 2) return;
    const idx = ring.findIndex(t => t.kind === 'probe' && t.probe === focusedProbe);
    focusSatellite(ring[(idx + dir + ring.length) % ring.length]);
    return;
  }
  if (!focusedBody) {
    if (planets.length) setFocus(planets[0].body);
    return;
  }
  if (focusedBody.kind === 'planet') {
    const sibs = planets.map(p => p.body);
    if (sibs.length < 2) return;
    const idx = sibs.indexOf(focusedBody);
    setFocus(sibs[(idx + dir + sibs.length) % sibs.length]);
    return;
  }
  // moon — cycle within its parent's satellite ring (moons + probes)
  const m = moons.find(mn => mn.body === focusedBody);
  const ring = satelliteRing(m?.parent);
  if (ring.length < 2) return;
  const idx = ring.findIndex(t => t.kind === 'moon' && t.body === focusedBody);
  focusSatellite(ring[(idx + dir + ring.length) % ring.length]);
}

// Refresh the bottom-nav focus card (level, name, sub) and the breadcrumb
// from the current focus state. Call after any setFocus / setCityFocus /
// rename. Respects the user's caret if they're mid-edit (via setNavNameText).
export function renderNavBodies() {
  if (!navLevelEl) return;

  // Breadcrumb reflects the level being browsed. currentConstellation()
  // reads the live catalog (section 34), defined by the time this runs.
  if (navBreadcrumbEl) {
    if (viewLevel === 'galaxy') {
      navBreadcrumbEl.textContent = 'Milky Way Galaxy';
    } else if (viewLevel === 'constellation') {
      const con = findConstellation(viewedConstellationId) || currentConstellation();
      navBreadcrumbEl.textContent = `Milky Way · ${con.name}`;
    } else {
      navBreadcrumbEl.textContent = `Milky Way · ${currentConstellation().name} · ${systemName}`;
    }
  }

  // On the star maps the focus card shows the cosmic level rather than a
  // body: rename and sibling cycling don't apply, and Visit is off. ▲/▼ are
  // wired to climb/descend levels (see navUp/navDown).
  if (viewLevel !== 'system') {
    navNameEl.contentEditable = 'false';
    if (viewLevel === 'galaxy') {
      navLevelEl.textContent = 'Galaxy';
      setNavNameText(galaxy.name.toUpperCase());
      navSubEl.textContent = `${galaxy.constellations.length} constellations`;
      navUpBtn.disabled = true;          // top of the hierarchy
      navDownBtn.disabled = false;
    } else {
      const con = findConstellation(viewedConstellationId) || currentConstellation();
      const n = con.starSystems.length;
      navLevelEl.textContent = 'Constellation';
      setNavNameText(con.name.toUpperCase());
      navSubEl.textContent = `${n} system${n === 1 ? '' : 's'}`;
      navUpBtn.disabled = false;
      navDownBtn.disabled = false;
    }
    navLeftBtn.disabled = navRightBtn.disabled = true;
    if (typeof updateVisitButtonState === 'function') updateVisitButtonState();
    return;
  }
  navNameEl.contentEditable = 'true';

  // Focus card content
  if (focusedProbe) {
    navLevelEl.textContent = 'Probe';
    setNavNameText(focusedProbe.name.toUpperCase());
    navSubEl.textContent = focusedProbe.parent ? `Orbiting ${focusedProbe.parent.name}` : '';
  } else if (focusedCity) {
    navLevelEl.textContent = 'Settlement';
    setNavNameText(focusedCity.name.toUpperCase());
    navSubEl.textContent = `On ${focusedCity.body.name}`;
  } else if (focusedBody?.kind === 'planet') {
    const idx = planets.findIndex(p => p.body === focusedBody);
    navLevelEl.textContent = `Planet · N° ${idx + 1}`;
    setNavNameText(focusedBody.name.toUpperCase());
    const arch = ARCHETYPES[focusedBody.archetype || 'terrestrial'];
    const moonCount = moons.filter(m => m.parent === focusedBody).length;
    navSubEl.textContent = `${arch?.name || 'Planet'} · ${moonCount} satellite${moonCount === 1 ? '' : 's'}`;
  } else if (focusedBody?.kind === 'moon') {
    const m = moons.find(mn => mn.body === focusedBody);
    navLevelEl.textContent = 'Satellite';
    setNavNameText(focusedBody.name.toUpperCase());
    navSubEl.textContent = m?.parent ? `Orbiting ${m.parent.name}` : '';
  } else {
    navLevelEl.textContent = 'System';
    setNavNameText(systemName.toUpperCase());
    navSubEl.textContent = `${planets.length} planets · ${moons.length} satellites`;
  }

  // Arrow availability. ▲ is always live now: from a body it zooms out a
  // level, and from the system it opens the constellation map.
  navUpBtn.disabled = false;

  if (focusedCity || focusedProbe) navDownBtn.disabled = true;
  else if (focusedBody?.kind === 'planet') {
    navDownBtn.disabled = satelliteRing(focusedBody).length === 0
      && !cities.some(c => c.body === focusedBody);
  } else if (focusedBody?.kind === 'moon') {
    navDownBtn.disabled = !cities.some(c => c.body === focusedBody);
  } else {
    navDownBtn.disabled = planets.length === 0;
  }

  let sibCount = 0;
  if (focusedCity) sibCount = cities.filter(c => c.body === focusedCity.body).length;
  else if (focusedProbe) sibCount = satelliteRing(focusedProbe.parent).length;
  else if (focusedBody?.kind === 'planet') sibCount = planets.length;
  else if (focusedBody?.kind === 'moon') {
    const m = moons.find(mn => mn.body === focusedBody);
    sibCount = satelliteRing(m?.parent).length;
  }
  navLeftBtn.disabled = navRightBtn.disabled = sibCount < 2;

  // Visit availability mirrors the nav state — refresh whenever the focus
  // changes. Defined later in the file; guard for first-call ordering.
  if (typeof updateVisitButtonState === 'function') updateVisitButtonState();
}

if (navUpBtn) {
  navUpBtn.onclick    = navUp;
  navDownBtn.onclick  = navDown;
  navLeftBtn.onclick  = () => navSibling(-1);
  navRightBtn.onclick = () => navSibling(1);
}

