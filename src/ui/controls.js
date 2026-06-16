// Left-panel tab switching, sculpt/biome/gas-paint controls, slider→value
// conversions, and most of the left panel’s DOM element refs.
import { setCurrentTool, setPaused } from '../framework/state.js';

import {
  setActiveBrushBody, setActiveVortex, setBrushRadius, setBrushRaise, setBrushStrength, setCurrentArchetype, setGasPaintModeState, setIsPainting, setLastHitLocal, setSelectedGasBiomeId
} from '../framework/state.js';

import { BIOME, MOON_BIOME_OPTIONS, ARCHETYPE_BAND_LABELS } from '../core/constants.js';
import { ARCHETYPES, ARCHETYPE_MATTER } from '../framework/archetypes.js';
import {
  activeBrushBody, activeVortex, brushRadius, brushRaise, brushStrength, currentArchetype, currentTool, focusedBody, gasPaintColor, gasPaintMode, isPainting, lastHitLocal, paused, selectedBiome, selectedGasBiomeId, setSelectedBiome
} from '../framework/state.js';
import { brushRing, isBrushTool } from '../interaction/brush.js';
import {
  GAS_BIOMES, clearGasFeatures, gasBiomeById, gasBiomesForArchetype, randomizeGasBands
} from '../shaders/gas.js';
import { orbitLinesGroup } from '../system/orbits.js';
import { updateInfoPanel } from './info-panel.js';

// ====== 25. UI (tabs + sliders) ======
export const tabBtns = document.querySelectorAll('.tab-btn');
export const tabContents = document.querySelectorAll('.tab-content');

// Resolve currentTool from the active tab plus focus-driven overrides.
// Centralized so focus changes (which can flip Envir between biome painting
// and gas-band painting) and tab clicks share a single source of truth.
export function refreshActiveTool() {
  const active = Array.from(tabBtns).find(b => b.classList.contains('active'));
  const tab = active ? active.dataset.tab : '';
  const gasFull = !!(focusedBody && focusedBody.kind === 'planet'
    && focusedBody.matter && focusedBody.matter.gas === 'full');
  if (tab === 'sculpt') setCurrentTool('land');
  else if (tab === 'environment') setCurrentTool(gasFull ? gasPaintMode : 'biome');
  else if (tab === 'colonies') setCurrentTool('city');
  else if (tab === 'satellites') setCurrentTool('none');
  else setCurrentTool('none');
  if (!isBrushTool()) {
    brushRing.visible = false;
    if (isPainting) {
      setIsPainting(false);
      setLastHitLocal(null);
      setActiveBrushBody(null);
      setActiveVortex(null);
    }
  }
}

tabBtns.forEach(btn => {
  btn.onclick = () => {
    tabBtns.forEach(b => b.classList.remove('active'));
    tabContents.forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    document.getElementById(`tab-${tab}`).classList.add('active');
    refreshActiveTool();
  };
});

export const brushRadiusInput   = document.getElementById('brushRadius');
export const brushRadiusVal     = document.getElementById('brushRadiusVal');
export const brushRadiusInputB  = document.getElementById('brushRadiusB');
export const brushRadiusValB    = document.getElementById('brushRadiusValB');

export const brushStrengthInput = document.getElementById('brushStrength');
export const brushStrengthVal   = document.getElementById('brushStrengthVal');

export const sculptRaiseBtn     = document.getElementById('sculptRaise');
export const sculptLowerBtn     = document.getElementById('sculptLower');

export const pauseRotInput      = document.getElementById('pauseRot');
export const seedInput          = document.getElementById('seedInput');
export const genAmpInput        = document.getElementById('genAmp');
export const genAmpVal          = document.getElementById('genAmpVal');
export const genSeaInput        = document.getElementById('genSea');
export const genSeaVal          = document.getElementById('genSeaVal');
export const regenBtn           = document.getElementById('regenBtn');
export const randomSeedBtn      = document.getElementById('randomSeedBtn');

export const satellitesContext  = document.getElementById('satellitesContext');
export const archetypeSelect    = document.getElementById('archetypeSelect');

// Slider→value conversions shared by the brush, generator, and regen flows.
export function sliderToBrushRadius(v) { return v / 100; }
export function sliderToBrushStrength(v) { return v / 10; }
export function sliderToAmplitude(v) { return v / 10; }
export function sliderToSeaCoverage(v) { return v / 100; }

export function syncGenLabels() {
  genAmpVal.textContent = sliderToAmplitude(parseInt(genAmpInput.value, 10)).toFixed(1);
  genSeaVal.textContent = genSeaInput.value + '%';
}
// genAmp/genSea label wiring + the initial syncGenLabels() call live in
// ui/wire-up.js with the rest of the one-shot wiring.

archetypeSelect.onchange = () => {
  setCurrentArchetype(archetypeSelect.value);
  const arch = ARCHETYPES[currentArchetype];
  if (arch) {
    genAmpInput.value = arch.amp * 10;
    genSeaInput.value = arch.sea * 100;
    syncGenLabels();
    regenBtn.click();
    updateBiomeTools();
  }
};

// Rebuild the Environment tab's biome <select> for the focused body. Moons
// and planets have different palettes; archetype also restricts the menu
// (e.g. desert planets get desert + tundra only). Call after any focus change.
// The five planet elevation bands as paint options, named for `archKey` via
// ARCHETYPE_BAND_LABELS (Ocean/Coast/Grass/Rock/Snow on Earth, Magma/Cinder/…
// on a lava world). These paint the generic BAND_* biomes, which reproduce the
// body's own palette so a painted band matches the archetype's natural ground.
const BAND_BIOME_OF_KEY = {
  water: BIOME.BAND_WATER, sand: BIOME.BAND_SAND, grass: BIOME.BAND_GRASS,
  rock:  BIOME.BAND_ROCK,  snow: BIOME.BAND_SNOW,
};
function bandOptionsForArch(archKey) {
  const labels = ARCHETYPE_BAND_LABELS[archKey] || ARCHETYPE_BAND_LABELS.terrestrial;
  return ['water', 'sand', 'grass', 'rock', 'snow'].map(k => ({ v: BAND_BIOME_OF_KEY[k], n: labels[k] }));
}
// Moon natural bands (crater→highland gradient); rock is the shared BAND_ROCK.
const MOON_BAND_OPTIONS = [
  { v: BIOME.BAND_CRATER,    n: 'Crater' },
  { v: BIOME.BAND_DUST,      n: 'Dust' },
  { v: BIOME.BAND_ROCK,      n: 'Rock' },
  { v: BIOME.BAND_HIGHLIGHT, n: 'Highlands' },
];

export function updateBiomeTools() {
  const select = document.getElementById('biomeSelect');
  const hint = document.getElementById('biomeHint');
  select.innerHTML = '<option value="0">Natural State</option>';
  const addOptions = list => list.forEach(opt => {
    const el = document.createElement('option');
    el.value = opt.v;
    el.textContent = opt.n;
    select.appendChild(el);
  });

  // Moons get a deliberately tiny biome palette — focus drives the choice.
  if (focusedBody && focusedBody.kind === 'moon') {
    addOptions(MOON_BAND_OPTIONS);
    addOptions(MOON_BIOME_OPTIONS);
    if (hint) hint.textContent = `Lunar palette · painting on ${focusedBody.name}`;
    select.value = 0;
    setSelectedBiome(0);
    return;
  }

  const options = {
    // Grass + Coast are provided by the natural-band options (Grass/Coast slots),
    // so the terrestrial extras are just the climate/vegetation biomes.
    terrestrial: [
      {v: BIOME.FOREST, n: 'Forest'},   {v: BIOME.JUNGLE, n: 'Jungle'},
      {v: BIOME.TUNDRA, n: 'Tundra'},   {v: BIOME.ICE, n: 'Ice'},
      {v: BIOME.DESERT, n: 'Desert'}
    ],
    ocean: [
      {v: 11, n: 'Coral Reef'}, {v: 12, n: 'Kelp Forest'}, {v: 13, n: 'Abyssal Trench'}
    ],
    lava: [
      {v: 5, n: 'Obsidian'}, {v: 6, n: 'Magma Flow'}, {v: 14, n: 'Sulfur Vent'}
    ],
    desert: [
      {v: 17, n: 'Red Sand'}
    ],
    ice_planet: [
      {v: 18, n: 'Glacier'}, {v: 19, n: 'Cryo-Volcano'}, {v: 20, n: 'Blue Ice'}
    ],
    jungle: [
      {v: 21, n: 'Exotic Bloom'}, {v: 22, n: 'River Path'}, {v: 23, n: 'Dense Canopy'}
    ],
    moon_like: [
      {v: BIOME.MARE, n: 'Mare'}, {v: BIOME.REGOLITH, n: 'Regolith'}, {v: BIOME.FROST, n: 'Frost'}
    ],
    toxic: [
      {v: 9, n: 'Acid Sludge'}, {v: 10, n: 'Mutation Bloom'}, {v: 25, n: 'Gas Vent'}
    ],
    metal: [
      {v: 26, n: 'Rust Belt'}, {v: 27, n: 'Gold Vein'}, {v: 28, n: 'Chrome Flat'}
    ],
    living: [
      {v: 29, n: 'Neural Path'}, {v: 30, n: 'Pulsing Organ'}, {v: 31, n: 'Tendon'}
    ],
    storm: [
      {v: 32, n: 'Lightning Scar'}, {v: 33, n: 'Cyclone Eye'}, {v: 34, n: 'Vortex'}
    ],
    venusian: [
      {v: 35, n: 'Sulfur Cloud'}, {v: 36, n: 'Volcanic Plain'}, {v: 37, n: 'Greenhouse Haze'}
    ]
  };

  // Read archetype from the focused planet, not the global UI state — the
  // user expects the biome list to reflect the body they're painting on
  // (e.g. focusing a desert planet should hide Forest/Tundra entirely).
  const archKey = (focusedBody && focusedBody.kind === 'planet')
    ? (focusedBody.archetype || 'terrestrial')
    : currentArchetype;
  // Solid-surfaced planets get their five natural elevation bands (named for the
  // archetype) on top of the archetype's special biomes; full-gas worlds (gas/ice
  // giants) have no surface to paint, so they fall through to Natural State only.
  const solid = (focusedBody && focusedBody.kind === 'planet' && focusedBody.matter)
    ? focusedBody.matter.solid
    : !!(ARCHETYPE_MATTER[archKey] && ARCHETYPE_MATTER[archKey].solid);
  // No fallback to terrestrial: archetypes without a dedicated biome list still
  // get the natural bands when solid, which is more honest than wrong biomes.
  const bandOptions = solid ? bandOptionsForArch(archKey) : [];
  const archOptions = options[archKey] || [];
  addOptions(bandOptions);
  addOptions(archOptions);

  if (hint) {
    const archName = (ARCHETYPES[archKey] && ARCHETYPES[archKey].name) || 'Surface';
    const bodyName = focusedBody && focusedBody.kind === 'planet' ? focusedBody.name : 'planet';
    hint.textContent = (bandOptions.length + archOptions.length)
      ? `${archName} palette · painting on ${bodyName}`
      : `${archName} · no surface biomes available`;
  }

  select.value = 0;
  setSelectedBiome(0);
}
randomSeedBtn.onclick = () => {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let newSeed = '';
  for(let i=0; i<8; i++) newSeed += chars.charAt(Math.floor(Math.random() * chars.length));
  seedInput.value = newSeed;
  // Automatically trigger regen for better UX
  regenBtn.click();
};

export function syncBrushRadius(val) {
  setBrushRadius(sliderToBrushRadius(val));
  brushRadiusInput.value = val;
  brushRadiusInputB.value = val;
  brushRadiusVal.textContent = brushRadius.toFixed(2);
  brushRadiusValB.textContent = brushRadius.toFixed(2);
}

brushRadiusInput.oninput = () => syncBrushRadius(parseInt(brushRadiusInput.value, 10));
brushRadiusInputB.oninput = () => syncBrushRadius(parseInt(brushRadiusInputB.value, 10));

brushStrengthInput.oninput = () => {
  setBrushStrength(sliderToBrushStrength(parseInt(brushStrengthInput.value, 10)));
  brushStrengthVal.textContent = brushStrength.toFixed(1);
};

sculptRaiseBtn.onclick = () => {
  setBrushRaise(true);
  sculptRaiseBtn.classList.add('active');
  sculptLowerBtn.classList.remove('active');
};
sculptLowerBtn.onclick = () => {
  setBrushRaise(false);
  sculptRaiseBtn.classList.remove('active');
  sculptLowerBtn.classList.add('active');
};

pauseRotInput.onchange = () => { setPaused(pauseRotInput.checked); };

export const showOrbitsInput = document.getElementById('showOrbits');
orbitLinesGroup.visible = showOrbitsInput.checked;
showOrbitsInput.onchange = () => {
  orbitLinesGroup.visible = showOrbitsInput.checked;
};
// (script.js relied on the implicit `window.biomeSelect` element-id global;
// the lookup is explicit here.)
const biomeSelect = document.getElementById('biomeSelect');
biomeSelect.onchange = () => {
  setSelectedBiome(parseInt(biomeSelect.value, 10));
};

// Composition dropdown: drives gasPaintColor for the Bands brush and the
// biome tag written into bandBiomes during a stroke. The options are
// filtered to the focused planet's archetype palette by
// refreshGasBiomeOptions, called from applyFocusToLeftPanel.
export const gasBiomeSelectEl = document.getElementById('gasBiomeSelect');
export function applyGasBiome() {
  if (!gasBiomeSelectEl) return;
  const biome = gasBiomeById(gasBiomeSelectEl.value) || GAS_BIOMES[0];
  gasPaintColor.setHex(biome.color);
  setSelectedGasBiomeId(biome.id);
}
export function refreshGasBiomeOptions(arch) {
  if (!gasBiomeSelectEl) return;
  const palette = gasBiomesForArchetype(arch);
  const prev = gasBiomeSelectEl.value;
  gasBiomeSelectEl.innerHTML = '';
  palette.forEach((biome) => {
    const opt = document.createElement('option');
    opt.value = biome.id;
    opt.textContent = biome.name;
    gasBiomeSelectEl.appendChild(opt);
  });
  // Preserve the previous selection if the new palette still contains it
  // (switching between two gas giants shouldn't reset the dropdown).
  if (palette.some(b => b.id === prev)) gasBiomeSelectEl.value = prev;
  applyGasBiome();
}
if (gasBiomeSelectEl) {
  gasBiomeSelectEl.onchange = applyGasBiome;
  // Seed with gas_giant palette so gasPaintColor / selectedGasBiomeId have
  // sensible defaults before any focus change has fired.
  refreshGasBiomeOptions('gas_giant');
}

// Bands vs. Whirlpool mode toggle. Bands = drag-paint band LUT;
// Whirlpool = press-and-hold to wrap surrounding bands into a vortex.
// refreshActiveTool resolves the actual tool name from this state + the
// focused body. The Composition (biome) row only applies to Bands, so we
// hide it in Whirlpool mode.
export const gasModeBandsBtn = document.getElementById('gasModeBands');
export const gasModeStampBtn = document.getElementById('gasModeStamp');
export const gasBiomeRowEl   = document.getElementById('gasBiomeRow');
export function setGasPaintMode(mode) {
  setGasPaintModeState(mode);
  if (gasModeBandsBtn) gasModeBandsBtn.classList.toggle('active', mode === 'gasband');
  if (gasModeStampBtn) gasModeStampBtn.classList.toggle('active', mode === 'gaswhirl');
  if (gasBiomeRowEl)   gasBiomeRowEl.style.display = mode === 'gasband' ? '' : 'none';
  refreshActiveTool();
}
if (gasModeBandsBtn) gasModeBandsBtn.onclick = () => setGasPaintMode('gasband');
if (gasModeStampBtn) gasModeStampBtn.onclick = () => setGasPaintMode('gaswhirl');

// Randomize: clear whirlpools + re-roll the band LUT with a fresh salt.
// Different result every click; the user can keep rerolling until a
// composition they like comes up.
export const gasRandomizeBtn = document.getElementById('gasRandomize');
if (gasRandomizeBtn) gasRandomizeBtn.onclick = () => {
  if (!focusedBody || !focusedBody.matter || focusedBody.matter.gas !== 'full') return;
  clearGasFeatures(focusedBody);
  const salt = Math.random().toString(36).slice(2, 8);
  randomizeGasBands(focusedBody, (focusedBody.currentSeed || focusedBody.name || 'gas') + ':' + salt);
  updateInfoPanel();
};

