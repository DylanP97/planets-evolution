// Deploy planets and the roster, moons, probes list renderers. (Cascade
// planet teardown lives in system/teardown.js.)
import { setCurrentArchetype } from '../framework/state.js';

import { emit } from '../core/bus.js';
import { BASE_RADIUS, ICO_DETAIL } from '../core/constants.js';
import { ROMAN } from '../core/names.js';
import { scene } from '../core/scene.js';
import {
  MAX_MOONS, removeMoonAt, setMoonDistance, setMoonSize
} from '../entities/moons.js';
import { addPolarLocations } from '../entities/locations.js';
import {
  MAX_PROBES, removeSatelliteAt, setSatelliteDistance, setSatelliteSize
} from '../entities/probes.js';
import { ARCHETYPES } from '../framework/archetypes.js';
import { createBody, refreshClimateColoring, regenerateBody } from '../framework/body.js';
import {
  bodies, currentArchetype, focusedBody, focusedProbe, moons, planets, probes
} from '../framework/state.js';
import { setFocus, setProbeFocus } from '../modes/focus.js';
import { registerPlanet } from '../system/planets.js';
import { removePlanetBody } from '../system/teardown.js';
import { addMoonBtn, addProbeBtn, moonsListEl, planetListEl, probesListEl } from './dom.js';

// ====== 30. Add / Remove planet ======
export function nextPlanetName() {
  // Find lowest unused roman so removed slots get reused first.
  const used = new Set(planets.map(p => p.body.name));
  for (let i = 0; i < ROMAN.length; i++) {
    const n = `Planet ${ROMAN[i]}`;
    if (!used.has(n)) return n;
  }
  return `Planet ${planets.length + 1}`;
}

export function deployNewPlanet() {
  if (planets.length >= 8) return null;
  // Place beyond the outermost existing orbit so it doesn't intersect.
  const maxDist = planets.reduce((m, p) => Math.max(m, p.orbit.distance), 120);
  const dist = maxDist + 160;
  // Pick an archetype that isn't on every planet already, for variety.
  const archKeys = Object.keys(ARCHETYPES);
  const used = planets.map(p => p.body.archetype);
  const arch = archKeys.find(a => !used.includes(a)) || 'terrestrial';
  const archSpec = ARCHETYPES[arch];
  const idx = planets.length;
  const name = nextPlanetName();
  const seed = `planet-${idx + 1}-${Math.floor(Math.random() * 1e4).toString(36)}`;

  const body = createBody({
    kind: 'planet',
    name,
    baseRadius: BASE_RADIUS,
    detail: ICO_DETAIL,
    hasOcean: archSpec.hasOcean,
  });
  bodies.push(body);
  addPolarLocations(body);
  scene.add(body.group);

  const prev = currentArchetype;
  setCurrentArchetype(arch);
  regenerateBody(body, seed, archSpec.amp, archSpec.sea);
  setCurrentArchetype(prev);
  body.currentAmp = archSpec.amp;
  body.currentSea = archSpec.sea;

  registerPlanet(body, arch, seed, {
    angle: Math.random() * Math.PI * 2,
    distance: dist,
    // Outer planets are slower (loose Kepler-ish feel without real physics).
    speed: 0.06 / (1 + idx * 0.35),
    inclination: (Math.random() - 0.5) * 0.3,
  });
  // regenerateBody ran before the planet was registered, so its climate was
  // computed at the default distance. Now that the real orbit is set, refresh
  // climate + ice for the planet's actual (far, cold) distance.
  refreshClimateColoring(body);
  return body;
}

// The deployPlanetBtn / focusPlanetBtn click wiring lives in ui/wire-up.js
// alongside the rest of the one-shot button wiring.

export function renderPlanetList() {
  if (!planetListEl) return;
  if (planets.length === 0) {
    planetListEl.innerHTML = `<div class="empty-state">No planets · deploy one to begin</div>`;
    return;
  }
  const canRemove = planets.length > 1;
  planetListEl.innerHTML = planets.map((p, i) => {
    const arch = ARCHETYPES[p.body.archetype || 'terrestrial']?.name || 'Planet';
    const focusedCls = focusedBody === p.body ? ' is-focused' : '';
    return `
      <div class="planet-row${focusedCls}" data-index="${i}">
        <span class="planet-row-name">${p.body.name}</span>
        <span class="planet-row-arch">${arch}</span>
        <button class="planet-focus" type="button" title="Focus">◎</button>
        <button class="planet-remove" type="button" aria-label="Remove planet" title="Remove" ${canRemove ? '' : 'disabled'}>×</button>
      </div>`;
  }).join('');
  planetListEl.querySelectorAll('.planet-row').forEach(row => {
    const idx = parseInt(row.dataset.index, 10);
    const entry = planets[idx];
    if (!entry) return;
    row.querySelector('.planet-focus').onclick = () => setFocus(entry.body);
    row.querySelector('.planet-remove').onclick = () => removePlanetBody(entry.body);
  });
}

export function renderMoonsList() {
  emit('nav:render');
  // Only show moons of the focused planet. With multiple planets in the
  // system, mixing them all into one list would be confusing.
  const parent = (focusedBody && focusedBody.kind === 'planet') ? focusedBody : null;
  const own = parent ? moons.filter(m => m.parent === parent) : [];

  if (!parent) {
    moonsListEl.innerHTML = '';
    addMoonBtn.disabled = true;
    return;
  }

  if (own.length === 0) {
    moonsListEl.innerHTML = `<div class="empty-state">No satellites in orbit · deploy one to begin</div>`;
    addMoonBtn.disabled = false;
    return;
  }

  moonsListEl.innerHTML = own.map((m, i) => {
    const sizeSlider = Math.round(m.size * 10);
    const distSlider = Math.round(m.distance);
    const focusedCls = focusedBody === m.body ? ' focused' : '';
    const apparent = (m.size * 2 * m.body.baseRadius).toFixed(2);
    return `
      <div class="moon-card${focusedBody === m.body ? ' is-focused' : ''}" data-local="${i}">
        <div class="moon-card-header">
          <span class="moon-card-title">${m.body.name}</span>
          <div class="moon-card-actions">
            <button class="moon-focus focus-btn small-btn${focusedCls}" type="button">Focus</button>
            <button class="moon-remove small-btn" type="button" aria-label="Remove moon">×</button>
          </div>
        </div>
        <div class="moon-card-body">
          <label>Size <input class="moon-size-input" type="range" min="2" max="40" value="${sizeSlider}"><span class="val moon-size-val">${sizeSlider}</span></label>
          <label>Dist <input class="moon-dist-input" type="range" min="14" max="60" value="${distSlider}"><span class="val moon-dist-val">${distSlider}</span></label>
          <div class="moon-meta">
            <span>Seed · ${m.seed}</span>
            <span>⌀ ${apparent} u</span>
          </div>
        </div>
      </div>
    `;
  }).join('');

  moonsListEl.querySelectorAll('.moon-card').forEach((row) => {
    const localIdx = parseInt(row.dataset.local, 10);
    const moonRef = own[localIdx];
    // Map back to the global moons[] index for the setter helpers.
    const globalIdx = () => moons.indexOf(moonRef);
    const sizeIn = row.querySelector('.moon-size-input');
    const sizeValEl = row.querySelector('.moon-size-val');
    const distIn = row.querySelector('.moon-dist-input');
    const distValEl = row.querySelector('.moon-dist-val');
    const focusBtn = row.querySelector('.moon-focus');
    const rmBtn = row.querySelector('.moon-remove');
    sizeIn.oninput = () => {
      sizeValEl.textContent = sizeIn.value;
      setMoonSize(globalIdx(), parseInt(sizeIn.value, 10) / 10);
    };
    distIn.oninput = () => {
      distValEl.textContent = distIn.value;
      setMoonDistance(globalIdx(), parseInt(distIn.value, 10));
    };
    focusBtn.onclick = () => { if (moonRef) setFocus(moonRef.body); };
    rmBtn.onclick = () => {
      removeMoonAt(globalIdx());
      renderMoonsList();
    };
  });

  addMoonBtn.disabled = own.length >= MAX_MOONS;
}

export function renderProbesList() {
  const parent = focusedProbe?.parent
    || ((focusedBody && focusedBody.kind === 'planet') ? focusedBody : null);
  const own = parent ? probes.filter(p => p.parent === parent) : [];

  if (!parent) {
    probesListEl.innerHTML = '';
    addProbeBtn.disabled = true;
    return;
  }

  if (own.length === 0) {
    probesListEl.innerHTML = `<div class="empty-state">No probes in orbit · deploy one to begin</div>`;
    addProbeBtn.disabled = false;
    return;
  }

  probesListEl.innerHTML = own.map((p, i) => {
    const sizeSlider = Math.round(p.size * 10);
    const distSlider = Math.round(p.distance);
    const focusedCls = focusedProbe === p ? ' focused' : '';
    return `
      <div class="moon-card${focusedProbe === p ? ' is-focused' : ''}" data-local="${i}">
        <div class="moon-card-header">
          <span class="moon-card-title">${p.name}</span>
          <div class="moon-card-actions">
            <button class="probe-focus focus-btn small-btn${focusedCls}" type="button">Focus</button>
            <button class="probe-remove moon-remove small-btn" type="button" aria-label="Remove probe">×</button>
          </div>
        </div>
        <div class="moon-card-body">
          <label>Size <input class="probe-size-input" type="range" min="2" max="40" value="${sizeSlider}"><span class="val probe-size-val">${sizeSlider}</span></label>
          <label>Dist <input class="probe-dist-input" type="range" min="14" max="60" value="${distSlider}"><span class="val probe-dist-val">${distSlider}</span></label>
          <div class="moon-meta">
            <span>Probe · ${p.seed}</span>
            <span>d ${p.distance.toFixed(0)} u</span>
          </div>
        </div>
      </div>
    `;
  }).join('');

  probesListEl.querySelectorAll('.moon-card').forEach((row) => {
    const localIdx = parseInt(row.dataset.local, 10);
    const probeRef = own[localIdx];
    const globalIdx = () => probes.indexOf(probeRef);
    const sizeIn = row.querySelector('.probe-size-input');
    const sizeValEl = row.querySelector('.probe-size-val');
    const distIn = row.querySelector('.probe-dist-input');
    const distValEl = row.querySelector('.probe-dist-val');
    const focusBtn = row.querySelector('.probe-focus');
    const rmBtn = row.querySelector('.probe-remove');
    sizeIn.oninput = () => {
      sizeValEl.textContent = sizeIn.value;
      setSatelliteSize(globalIdx(), parseInt(sizeIn.value, 10) / 10);
    };
    distIn.oninput = () => {
      distValEl.textContent = distIn.value;
      setSatelliteDistance(globalIdx(), parseInt(distIn.value, 10));
    };
    focusBtn.onclick = () => { if (probeRef) setProbeFocus(probeRef); };
    rmBtn.onclick = () => {
      removeSatelliteAt(globalIdx());
      renderProbesList();
    };
  });

  addProbeBtn.disabled = own.length >= MAX_PROBES;
}

export function renderFocusBadges() {
  // "Reset Camera" recenters whatever's currently in focus, so no need for
  // a per-target highlight on the button itself.
  renderMoonsList();
  renderProbesList();
}

