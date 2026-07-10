// Orbit-view menu: Esc (in orbit mode) toggles this instead of doing nothing,
// giving a Save affordance without a permanent on-screen button. Same
// overlay/.show pattern as the surface pause menu; only ever emits
// 'menu:save-game' (handled in wire-up.js) rather than importing system/
// save.js itself. Controls sub-panel mirrors the surface pause menu's
// Controls page (modes/surface/controls-page.js) — same KEY_ACTIONS
// renderer over the shared modes/surface/keybinds.js source of truth.
import { emit } from '../core/bus.js';
import { KEY_ACTIONS, keybinds, setKeybind, resetKeybinds, keyLabel } from '../modes/surface/keybinds.js';

const menuEl = document.getElementById('orbitMenu');
const resumeBtn = document.getElementById('orbitMenuResumeBtn');
const saveBtn = document.getElementById('orbitMenuSaveBtn');
const homeBtn = document.getElementById('orbitMenuHomeBtn');
const controlsBtn = document.getElementById('orbitMenuControlsBtn');
const controlsMenuEl = document.getElementById('orbitControlsMenu');
const controlsListEl = document.getElementById('orbitControlsList');
const controlsResetBtn = document.getElementById('orbitControlsResetBtn');
const controlsBackBtn = document.getElementById('orbitControlsBackBtn');

export function openOrbitMenu() {
  if (menuEl) menuEl.classList.add('show');
}

export function closeOrbitMenu() {
  if (menuEl) menuEl.classList.remove('show');
}

export function toggleOrbitMenu() {
  if (controlsMenuEl && controlsMenuEl.classList.contains('show')) { closeOrbitControls(); return; }
  if (menuEl && menuEl.classList.contains('show')) closeOrbitMenu();
  else openOrbitMenu();
}

if (resumeBtn) resumeBtn.onclick = closeOrbitMenu;
if (saveBtn) saveBtn.onclick = () => emit('menu:save-game');
if (homeBtn) homeBtn.onclick = () => { closeOrbitMenu(); emit('menu:return-home'); };

// ---- Controls sub-panel --------------------------------------------------
let rebindTarget = null;

function renderControlsRows() {
  if (!controlsListEl) return;
  controlsListEl.innerHTML = '';
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
    keyBtn.onclick = () => { rebindTarget = action; renderControlsRows(); };

    row.appendChild(nameEl);
    row.appendChild(keyBtn);
    controlsListEl.appendChild(row);
  }
}

// Capture phase so an armed rebind always intercepts the next key, same as
// controls-page.js / start-menu.js's Controls rebind listeners.
document.addEventListener('keydown', (e) => {
  if (!rebindTarget) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.key !== 'Escape') setKeybind(rebindTarget, e.key.toLowerCase());
  rebindTarget = null;
  renderControlsRows();
}, true);

function openOrbitControls() {
  rebindTarget = null;
  renderControlsRows();
  if (menuEl) menuEl.classList.remove('show');
  if (controlsMenuEl) controlsMenuEl.classList.add('show');
}

function closeOrbitControls() {
  rebindTarget = null;
  if (controlsMenuEl) controlsMenuEl.classList.remove('show');
  if (menuEl) menuEl.classList.add('show');
}

if (controlsBtn) controlsBtn.onclick = openOrbitControls;
if (controlsResetBtn) controlsResetBtn.onclick = () => { resetKeybinds(); renderControlsRows(); };
if (controlsBackBtn) controlsBackBtn.onclick = closeOrbitControls;
