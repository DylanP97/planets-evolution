// Galaxy + constellation map overlays: render, drag, create/delete systems,
// travel transitions.
import { setViewLevel, setViewedConstellationId } from '../system/starsystems.js';

import { SOLAR_SYSTEM_SPEC } from '../system/planets.js';
import {
  createStarSystem, currentSystemId, deleteStarSystem, findConstellation, findStarSystem, galaxy, loadStarSystem, viewLevel, viewedConstellationId
} from '../system/starsystems.js';
import { renderNavBodies } from './nav.js';

// ====== 34b. Star-map overlays ======
// The galaxy/constellation levels are 2D HTML overlays (not 3D scenes). The
// bottom transport panel stays visible and drives them: ▲ climbs (system →
// constellation → galaxy), ▼ descends. Picking a star runs an "Entering…"
// fade while loadStarSystem() swaps the scene underneath. viewLevel /
// viewedConstellationId are declared up in section 34 (the bottom-nav render
// needs them during the first boot, before this runs).
export const mapOverlay          = document.getElementById('mapOverlay');
export const mapGalaxyArt        = document.getElementById('mapGalaxyArt');
export const mapField            = document.getElementById('mapField');
export const mapTitleEl          = document.getElementById('mapTitle');
export const mapEyebrowEl        = document.getElementById('mapEyebrow');
export const mapNewBtn           = document.getElementById('mapNewBtn');
export const mapHintEl           = document.getElementById('mapHint');
export const systemTransitionTxt = document.getElementById('systemTransitionText');

// The constellation that holds the currently-loaded system (fallback: the
// first, Helios Sector — should never be needed once a system is loaded).
export function currentConstellation() {
  const sys = findStarSystem(currentSystemId);
  return (sys && findConstellation(sys.constellationId)) || galaxy.constellations[0];
}

// Build the spiral-galaxy art once (lazily, on first galaxy-map open): a
// spinning wrapper carrying star particles laid along two logarithmic arms,
// warm (pink/white) near the core fading to cool (violet/blue) at the rim,
// plus a scattering of faint field stars. Left in the DOM after building.
export function buildGalaxyArt() {
  if (!mapGalaxyArt || mapGalaxyArt.dataset.built) return;
  mapGalaxyArt.dataset.built = '1';
  const spin = document.createElement('div');
  spin.className = 'galaxy-spin';
  const frag = document.createDocumentFragment();
  const ramp = [ // warm-core → cool-rim colour stops, lerped by t
    [255, 236, 240], [255, 188, 214], [226, 130, 214], [150, 110, 240], [110, 150, 255],
  ];
  const lerpColor = (t) => {
    const s = Math.max(0, Math.min(0.999, t)) * (ramp.length - 1);
    const i = s | 0, f = s - i, a = ramp[i], b = ramp[i + 1] || a;
    return `rgb(${Math.round(a[0] + (b[0] - a[0]) * f)},${Math.round(a[1] + (b[1] - a[1]) * f)},${Math.round(a[2] + (b[2] - a[2]) * f)})`;
  };
  const addStar = (x, y, size, color, opacity, glow) => {
    const star = document.createElement('span');
    star.className = 'galaxy-star';
    star.style.left = x + '%';
    star.style.top = y + '%';
    star.style.width = size + 'px';
    star.style.height = size + 'px';
    star.style.background = color;
    star.style.opacity = opacity;
    if (glow) star.style.boxShadow = `0 0 ${(size * 1.7).toFixed(1)}px ${color}`;
    frag.appendChild(star);
  };
  const arms = 2, perArm = 180, turns = 2.6;
  for (let arm = 0; arm < arms; arm++) {
    const base = (arm / arms) * Math.PI * 2;
    for (let i = 0; i < perArm; i++) {
      const t = i / perArm;
      const r = Math.pow(t, 0.6) * 46;                  // % radius, tight near core
      const theta = base + t * turns * Math.PI * 2;
      const spread = 0.7 + t * 6;                       // arms thicken outward
      const x = 50 + Math.cos(theta) * r + (Math.random() - 0.5) * spread;
      const y = 50 + Math.sin(theta) * r + (Math.random() - 0.5) * spread;
      const size = (1 - t) * 2.4 + 0.7 + Math.random() * 1.6;
      addStar(x, y, size, lerpColor(t * 1.05), (0.3 + (1 - t) * 0.55).toFixed(2), true);
    }
  }
  for (let i = 0; i < 130; i++) {                        // faint field stars for density
    const ang = Math.random() * Math.PI * 2;
    const rr = Math.pow(Math.random(), 0.5) * 47;
    addStar(50 + Math.cos(ang) * rr, 50 + Math.sin(ang) * rr,
      0.5 + Math.random() * 1.2, 'rgba(220,222,255,0.85)', (0.12 + Math.random() * 0.4).toFixed(2), false);
  }
  spin.appendChild(frag);
  mapGalaxyArt.appendChild(spin);
}

// Make a map point draggable: live-update its model's mapX/mapY so the layout
// persists for the session, and cancel the navigation click if the press was
// an actual drag (not a tap). onMove redraws dependent art (e.g. lines).
export function enablePointDrag(pt, model, onMove) {
  let down = false, moved = false, sx = 0, sy = 0;
  pt.addEventListener('pointerdown', (e) => {
    if (e.target.classList.contains('map-point-del')) return;
    down = true; moved = false; sx = e.clientX; sy = e.clientY;
    try { pt.setPointerCapture(e.pointerId); } catch (_) {}
  });
  pt.addEventListener('pointermove', (e) => {
    if (!down) return;
    if (!moved && Math.abs(e.clientX - sx) < 4 && Math.abs(e.clientY - sy) < 4) return;
    moved = true;
    pt.classList.add('dragging');
    const rect = mapField.getBoundingClientRect();
    const nx = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const ny = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    model.mapX = nx; model.mapY = ny;
    pt.style.left = (nx * 100) + '%';
    pt.style.top = (ny * 100) + '%';
    if (onMove) onMove();
  });
  const end = (e) => {
    if (!down) return;
    down = false;
    pt.classList.remove('dragging');
    try { pt.releasePointerCapture(e.pointerId); } catch (_) {}
  };
  pt.addEventListener('pointerup', end);
  pt.addEventListener('pointercancel', end);
  // Capture phase: swallow the click so a drag doesn't also navigate/travel.
  pt.addEventListener('click', (e) => {
    if (moved) { e.stopImmediatePropagation(); e.preventDefault(); moved = false; }
  }, true);
}

// Faint star-chart links: connect each system to its two nearest neighbours,
// so the systems read as a constellation figure. Coordinates share the points'
// 0..100 % space (viewBox 100×100, non-uniform scale). Rebuilt on drag.
export function drawConstellationLines(svg, systems) {
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const pts = systems.map(s => ({ x: s.mapX * 100, y: s.mapY * 100 }));
  const NS = 'http://www.w3.org/2000/svg';
  const seen = new Set();
  for (let i = 0; i < pts.length; i++) {
    // Rank the other points by distance and link to the closest two.
    const near = [];
    for (let j = 0; j < pts.length; j++) {
      if (j === i) continue;
      near.push({ j, d: (pts[i].x - pts[j].x) ** 2 + (pts[i].y - pts[j].y) ** 2 });
    }
    near.sort((a, b) => a.d - b.d);
    near.slice(0, 2).forEach(({ j }) => {
      const key = i < j ? `${i}-${j}` : `${j}-${i}`;
      if (seen.has(key)) return;
      seen.add(key);
      const ln = document.createElementNS(NS, 'line');
      ln.setAttribute('x1', pts[i].x); ln.setAttribute('y1', pts[i].y);
      ln.setAttribute('x2', pts[j].x); ln.setAttribute('y2', pts[j].y);
      svg.appendChild(ln);
    });
  }
}

// Open the map overlay if it isn't already up (shared by both levels).
export function showMapOverlay() {
  document.body.classList.add('map-mode');
  mapOverlay.setAttribute('aria-hidden', 'false');
}

// Enter the constellation map for a specific constellation. Defaults to the
// loaded system's home (the level you reach by pressing ▲ from System view).
export function openConstellationMap(constellationId) {
  setViewedConstellationId(constellationId || currentConstellation().id);
  setViewLevel('constellation');
  mapOverlay.classList.remove('is-galaxy');
  showMapOverlay();
  renderConstellationMap();
  renderNavBodies();
}

// Enter the galaxy map: every constellation as a node, over the spiral art.
export function openGalaxyMap() {
  setViewLevel('galaxy');
  mapOverlay.classList.add('is-galaxy');
  buildGalaxyArt();
  showMapOverlay();
  renderGalaxyMap();
  renderNavBodies();
}

export function closeMap() {
  setViewLevel('system');
  mapOverlay.classList.remove('is-galaxy');
  document.body.classList.remove('map-mode');
  mapOverlay.setAttribute('aria-hidden', 'true');
  renderNavBodies();
}

// Adapt the chrome to the level: "+ New System" and the star hint belong to
// the constellation level (galaxy is the top, and systems are created inside
// a constellation). Up/down navigation lives on the bottom transport panel.
export function syncMapButtons() {
  const atConstellation = viewLevel === 'constellation';
  if (mapNewBtn) mapNewBtn.style.display = atConstellation ? '' : 'none';
  if (mapHintEl) {
    mapHintEl.textContent = atConstellation
      ? 'Click a star to travel · hover to inspect · ✕ to delete'
      : 'Click a constellation to explore its systems';
  }
}

// Galaxy map: each constellation is a violet nebula node positioned by its
// mapX/mapY. The node holding the loaded system is ringed (is-active). Click
// descends into that constellation's star map.
export function renderGalaxyMap() {
  syncMapButtons();
  mapEyebrowEl.textContent = 'Galaxy';
  mapTitleEl.textContent = galaxy.name;
  mapField.innerHTML = '';
  const homeConId = currentConstellation().id;
  galaxy.constellations.forEach(con => {
    const isActive = con.id === homeConId;
    const n = con.starSystems.length;
    const pt = document.createElement('button');
    pt.type = 'button';
    pt.className = 'map-point is-constellation' + (isActive ? ' is-active' : '');
    pt.style.left = (con.mapX * 100) + '%';
    pt.style.top  = (con.mapY * 100) + '%';
    pt.title = con.name;
    pt.innerHTML = `
      <span class="map-point-dot"></span>
      <span class="map-point-label">${con.name}
        <span class="map-point-sub">${n} system${n === 1 ? '' : 's'}${isActive ? ' · here' : ''}</span>
      </span>`;
    pt.addEventListener('click', () => openConstellationMap(con.id));
    enablePointDrag(pt, con);
    mapField.appendChild(pt);
  });
}

// Paint a constellation's star systems as glowing points. Sol is the gold
// preset point and can't be deleted; the loaded system is ringed.
export function renderConstellationMap() {
  syncMapButtons();
  const con = findConstellation(viewedConstellationId) || currentConstellation();
  mapEyebrowEl.textContent = 'Constellation';
  mapTitleEl.textContent = con.name;
  mapField.innerHTML = '';
  const systems = con.starSystems;
  // Constellation links go in first so they sit behind the dots.
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.id = 'mapLines';
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('preserveAspectRatio', 'none');
  mapField.appendChild(svg);
  systems.forEach(sys => {
    const isCurrent = sys.id === currentSystemId;
    const planetCount = sys.isPreset ? SOLAR_SYSTEM_SPEC.length : (sys.planetSpecs || []).length;
    const pt = document.createElement('button');
    pt.type = 'button';
    pt.className = 'map-point'
      + (isCurrent ? ' is-current' : '')
      + (sys.isPreset ? ' is-preset' : '');
    pt.style.left = (sys.mapX * 100) + '%';
    pt.style.top  = (sys.mapY * 100) + '%';
    pt.title = sys.name;
    pt.innerHTML = `
      <span class="map-point-dot"></span>
      <span class="map-point-label">${sys.name}
        <span class="map-point-sub">${planetCount} planets${isCurrent ? ' · here' : ''}</span>
      </span>
      ${sys.isPreset ? '' : '<span class="map-point-del" title="Delete system">✕</span>'}`;
    pt.addEventListener('click', (e) => {
      if (e.target.classList.contains('map-point-del')) {
        e.stopPropagation();
        if (deleteStarSystem(sys.id)) renderConstellationMap();
        return;
      }
      travelToSystem(sys);
    });
    enablePointDrag(pt, sys, () => drawConstellationLines(svg, systems));
    mapField.appendChild(pt);
  });
  drawConstellationLines(svg, systems);
}

// Travel to a system: no-op-but-close if it's already loaded, otherwise run
// the fade and swap the 3D scene mid-fade.
function travelToSystem(sys) {
  if (sys.id === currentSystemId) { closeMap(); return; }
  runSystemTransition(sys.name, () => {
    loadStarSystem(sys);
    closeMap();
  });
}

// Full-screen "Entering …" fade: fade to black, swap at the peak, fade back.
let transitionBusy = false;
function runSystemTransition(name, doSwap) {
  if (transitionBusy) { doSwap(); return; }
  transitionBusy = true;
  systemTransitionTxt.textContent = `Entering ${name}…`;
  document.body.classList.add('transitioning');
  setTimeout(() => {
    doSwap();
    setTimeout(() => {
      document.body.classList.remove('transitioning');
      transitionBusy = false;
    }, 450);
  }, 450);
}

if (mapNewBtn) {
  mapNewBtn.onclick = () => {
    // Create into whichever constellation the map is showing. On the galaxy
    // map there's no single target, so fall back to the loaded system's home.
    const conId = (viewLevel === 'constellation')
      ? (viewedConstellationId || currentConstellation().id)
      : currentConstellation().id;
    const created = createStarSystem(conId);
    if (!created) return;
    if (viewLevel === 'galaxy') openConstellationMap(conId);
    else renderConstellationMap();
  };
}
// Up/down between levels is driven by the bottom transport panel (navUp /
// navDown), which stays visible on the maps. Esc is a shortcut for ▼:
// galaxy → home constellation, constellation → the loaded system.
addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (viewLevel === 'galaxy') { e.preventDefault(); openConstellationMap(); }
  else if (viewLevel === 'constellation') { e.preventDefault(); closeMap(); }
});

