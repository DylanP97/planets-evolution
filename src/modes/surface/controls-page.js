// Controls page: reached from the pause menu (surfaceControlsBtn), lists
// every rebindable surface-mode action with its current key. Clicking a key
// badge arms a rebind — the very next keydown is captured here (a
// capture-phase listener wins over input.js's bubble-phase one regardless of
// module load order) and assigned, Esc cancels instead of binding to Esc
// (it must stay the universal "back out" key).
import { keybinds, setKeybind, resetKeybinds, keyLabel, KEY_ACTIONS } from './keybinds.js';
import { surfaceState } from './core.js';

const pauseBoxEl    = document.getElementById('surfacePauseMenu');
const controlsBoxEl = document.getElementById('surfaceControlsMenu');
const listEl        = document.getElementById('surfaceControlsList');
const resetBtn      = document.getElementById('surfaceControlsResetBtn');
const backBtn       = document.getElementById('surfaceControlsBackBtn');

let rebindTarget = null;   // action name currently awaiting a key, or null

function renderRows() {
  if (!listEl) return;
  listEl.innerHTML = '';
  for (const { action, label } of KEY_ACTIONS) {
    const row = document.createElement('div');
    row.className = 'ctrl-row';

    const nameEl = document.createElement('span');
    nameEl.className = 'ctrl-name';
    nameEl.textContent = label;

    const keyBtn = document.createElement('button');
    keyBtn.type = 'button';
    keyBtn.className = 'ctrl-key' + (rebindTarget === action ? ' listening' : '');
    keyBtn.textContent = rebindTarget === action ? 'Press a key…' : keyLabel(keybinds[action]);
    keyBtn.onclick = () => { rebindTarget = action; renderRows(); };

    row.appendChild(nameEl);
    row.appendChild(keyBtn);
    listEl.appendChild(row);
  }
}

// Capture phase so an armed rebind always intercepts the next key, ahead of
// input.js's normal handling (which would otherwise also act on it — e.g.
// rebinding "camera" to O would both assign it here AND toggle orbits there).
document.addEventListener('keydown', (e) => {
  if (!rebindTarget) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.key !== 'Escape') setKeybind(rebindTarget, e.key.toLowerCase());
  rebindTarget = null;
  renderRows();
}, true);

export function openControlsMenu() {
  rebindTarget = null;
  surfaceState.pauseView = 'controls';
  renderRows();
  if (pauseBoxEl) pauseBoxEl.classList.remove('show');
  if (controlsBoxEl) controlsBoxEl.classList.add('show');
}

// Back to the pause box — still paused, just switching which panel shows.
export function backToPause() {
  rebindTarget = null;
  surfaceState.pauseView = 'pause';
  if (controlsBoxEl) controlsBoxEl.classList.remove('show');
  if (pauseBoxEl) pauseBoxEl.classList.add('show');
}

if (resetBtn) resetBtn.onclick = () => { resetKeybinds(); renderRows(); };
if (backBtn) backBtn.onclick = backToPause;
