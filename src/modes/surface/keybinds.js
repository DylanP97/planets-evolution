// Surface-mode rebindable keybinds: defaults + localStorage persistence, the
// single source of truth input.js reads every keydown (instead of hardcoded
// literals) so a rebind from the Controls page (controls-page.js) takes
// effect immediately, and for the on-screen hint bar text.
const STORAGE_KEY = 'planetTilesKeybinds';

export const KEY_ACTIONS = [
  { action: 'forward', label: 'Move Forward' },
  { action: 'back',     label: 'Move Back' },
  { action: 'left',     label: 'Move Left' },
  { action: 'right',    label: 'Move Right' },
  { action: 'run',      label: 'Run' },
  { action: 'jump',     label: 'Jump / Rise' },
  { action: 'dive',     label: 'Dive' },
  { action: 'camera',   label: 'Camera Mode' },
  { action: 'orbits',   label: 'Toggle Orbits' },
  { action: 'mapSize',  label: 'Map Size' },
  { action: 'zoomOut',  label: 'Map Zoom Out' },
  { action: 'zoomIn',   label: 'Map Zoom In' },
  { action: 'photo',    label: 'Take Photo' },
  { action: 'pause',    label: 'Pause' },
  { action: 'devPanel', label: 'Dev Panel' },
  { action: 'debugCam', label: 'Debug Camera' },
];

const DEFAULTS = {
  forward: 'w', back: 's', left: 'a', right: 'd',
  run: 'shift', jump: ' ', dive: 'c', camera: 'v',
  orbits: 'o', mapSize: 'm', zoomOut: '[', zoomIn: ']',
  photo: 'h', pause: 'p', devPanel: 'f2', debugCam: 'f',
};

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return { ...DEFAULTS, ...saved };
  } catch (_) {
    return { ...DEFAULTS };
  }
}

// A plain mutable object (not a rebound import) — actions read keybinds.xxx
// live, same pattern as surfaceState.
export const keybinds = load();

function persist() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(keybinds)); } catch (_) {}
}

export function setKeybind(action, key) {
  keybinds[action] = key;
  persist();
  updateHintText();
}

export function resetKeybinds() {
  for (const k in DEFAULTS) keybinds[k] = DEFAULTS[k];
  persist();
  updateHintText();
}

export function keyLabel(k) {
  if (k === ' ') return 'Space';
  if (k.length === 1) return k.toUpperCase();
  return k[0].toUpperCase() + k.slice(1);
}

// The on-screen key hint (#surfaceHint) is derived text, kept live here
// rather than hardcoded in index.html — rebinding a key updates it at once.
const hintEl = document.getElementById('surfaceHint');
function updateHintText() {
  if (!hintEl) return;
  const k = keybinds;
  hintEl.textContent =
    `Move: ${keyLabel(k.forward)}${keyLabel(k.left)}${keyLabel(k.back)}${keyLabel(k.right)} · ` +
    `${keyLabel(k.run)}: Run · ${keyLabel(k.jump)}: Jump / Rise · ${keyLabel(k.dive)}: Dive · ` +
    `${keyLabel(k.camera)}: Camera · ${keyLabel(k.orbits)}: Orbits · ${keyLabel(k.mapSize)}: Map Size · ` +
    `${keyLabel(k.zoomOut)}${keyLabel(k.zoomIn)}: Map Zoom · Drag: Look · Esc: Pause · ${keyLabel(k.devPanel)}: Dev Panel`;
}
updateHintText();
