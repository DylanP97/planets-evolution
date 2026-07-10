// Boot-time start menu: New / Continue / Load, shown before any star system
// is built (main.js calls openStartMenu() instead of loadStarSystem() at
// boot). Follows the same DOM/CSS-class pattern as
// modes/surface/pause-menu.js — elements pre-declared in index.html, shown
// via a `.show` class toggle. Save/load/multiplayer actions only emit bus
// events (never importing system/save.js or starsystems.js directly), so the
// "an event triggers a multi-layer load routine" logic stays centralized in
// wire-up.js. The Character panel is the exception: picking an avatar is
// self-contained (avatar.js owns the registry + persistence), so it calls
// setCharacter directly — same as the surface pause menu's character page.
import { emit } from '../core/bus.js';
import { CHARACTERS, characterId, setCharacter } from '../modes/surface/avatar.js';
import { KEY_ACTIONS, keybinds, setKeybind, resetKeybinds, keyLabel } from '../modes/surface/keybinds.js';
import { watchRooms } from '../net/connection.js';
import { createCharacterPreview } from '../modes/surface/character-preview.js';

const characterPreview = createCharacterPreview('startCharacterPreview');

const menuEl = document.getElementById('startMenu');
const freeWorldBtn = document.getElementById('startFreeWorldBtn');
const tutorialBtn = document.getElementById('startTutorialBtn');
const continueBtn = document.getElementById('startContinueBtn');
const loadBtn = document.getElementById('startLoadBtn');
const loadPanel = document.getElementById('startLoadPanel');
const loadList = document.getElementById('startLoadSlotList');
const loadBackBtn = document.getElementById('startLoadBackBtn');
const characterBtn = document.getElementById('startCharacterBtn');
const characterPanel = document.getElementById('startCharacterPanel');
const characterList = document.getElementById('startCharacterList');
const characterBackBtn = document.getElementById('startCharacterBackBtn');
const controlsBtn = document.getElementById('startControlsBtn');
const controlsPanel = document.getElementById('startControlsPanel');
const controlsList = document.getElementById('startControlsList');
const controlsResetBtn = document.getElementById('startControlsResetBtn');
const controlsBackBtn = document.getElementById('startControlsBackBtn');
const multiplayerBtn = document.getElementById('startMultiplayerBtn');
const multiplayerPanel = document.getElementById('startMultiplayerPanel');
const hostBtn = document.getElementById('startHostBtn');
const hostStatusEl = document.getElementById('startHostStatus');
const roomListEl = document.getElementById('startRoomList');
const joinCodeInput = document.getElementById('startJoinCodeInput');
const joinBtn = document.getElementById('startJoinBtn');
const joinStatusEl = document.getElementById('startJoinStatus');
const multiplayerBackBtn = document.getElementById('startMultiplayerBackBtn');
const roomCodeBadge = document.getElementById('roomCodeBadge');

export function openStartMenu() {
  if (menuEl) menuEl.classList.add('show');
  if (loadPanel) loadPanel.classList.remove('show');
  if (characterPanel) characterPanel.classList.remove('show');
  if (controlsPanel) controlsPanel.classList.remove('show');
  if (multiplayerPanel) multiplayerPanel.classList.remove('show');
  emit('menu:opened');
}

export function closeStartMenu() {
  if (menuEl) menuEl.classList.remove('show');
}

// Populated by wire-up.js (which owns the save module import) each time the
// Load panel opens — keeps this module free of a system/save.js import.
export function renderSaveSlotList(slots) {
  if (!loadList) return;
  if (!slots.length) {
    loadList.innerHTML = '<p class="hint">No saved games yet</p>';
    return;
  }
  loadList.innerHTML = slots.map(s => `
    <div class="save-slot-row" data-slot="${s.slotId}">
      <span class="save-slot-name">${s.name}</span>
      <span class="save-slot-date">${new Date(s.timestamp).toLocaleString()}</span>
      <button class="save-slot-load small-btn" type="button">Load</button>
      <button class="save-slot-delete" type="button" aria-label="Delete save">×</button>
    </div>`).join('');
  loadList.querySelectorAll('.save-slot-row').forEach((row) => {
    const slotId = row.dataset.slot;
    row.querySelector('.save-slot-load').onclick = () => emit('menu:load-game', slotId);
    row.querySelector('.save-slot-delete').onclick = () => emit('menu:delete-save', slotId);
  });
}

export function openLoadPanel() {
  if (loadPanel) loadPanel.classList.add('show');
}

export function setContinueLoadEnabled(hasAnySave) {
  if (continueBtn) continueBtn.disabled = !hasAnySave;
  if (loadBtn) loadBtn.disabled = !hasAnySave;
}

if (freeWorldBtn) freeWorldBtn.onclick = () => emit('menu:free-world');
if (tutorialBtn) tutorialBtn.onclick = () => emit('menu:start-tutorial');
if (continueBtn) continueBtn.onclick = () => emit('menu:continue-game');
if (loadBtn) loadBtn.onclick = () => emit('menu:open-load-panel');
if (loadBackBtn) loadBackBtn.onclick = () => { if (loadPanel) loadPanel.classList.remove('show'); };

// ---- Character panel ---------------------------------------------------
// Renders avatar.js's CHARACTERS registry; the pick persists via
// localStorage, so choosing here decides who lands on the next surface
// visit. setCharacter also starts the GLB download — a free preload.
let characterLoadingId = null;

function renderCharacterRows() {
  if (!characterList) return;
  characterList.innerHTML = '';
  for (const character of CHARACTERS) {
    const { id, label } = character;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'char-row'
      + (id === characterId ? ' active' : '')
      + (id === characterLoadingId ? ' loading' : '');
    btn.textContent = id === characterLoadingId ? `${label} — LOADING…`
      : id === characterId ? `${label} ✓` : label;
    btn.onclick = () => {
      characterPreview.show(character);
      if (id === characterId || characterLoadingId) return;
      characterLoadingId = id;
      renderCharacterRows();
      setCharacter(id)
        .catch(() => { console.warn('[start-menu] character swap failed:', id); })
        .finally(() => { characterLoadingId = null; renderCharacterRows(); });
    };
    btn.onmouseenter = () => characterPreview.show(character);
    characterList.appendChild(btn);
  }
}

if (characterBtn) {
  characterBtn.onclick = () => {
    renderCharacterRows();
    if (characterPanel) characterPanel.classList.add('show');
    characterPreview.start();
    characterPreview.show(CHARACTERS.find(c => c.id === characterId));
  };
}
if (characterBackBtn) {
  characterBackBtn.onclick = () => {
    if (characterPanel) characterPanel.classList.remove('show');
    characterPreview.stop();
  };
}

// ---- Controls panel ------------------------------------------------------
// Full-page rebind screen (not a popup) — same rebind mechanics as
// modes/surface/keybinds.js + controls-page.js (the in-game Controls page),
// a second renderer over the same stored keybinds, so a rebind here is
// already live in a surface visit.
let controlsRebindTarget = null;

function renderControlsRows() {
  if (!controlsList) return;
  controlsList.innerHTML = '';
  for (const { action, label } of KEY_ACTIONS) {
    const row = document.createElement('div');
    row.className = 'ctrl-row';

    const nameEl = document.createElement('span');
    nameEl.className = 'ctrl-name';
    nameEl.textContent = label;

    const keyBtn = document.createElement('button');
    keyBtn.type = 'button';
    keyBtn.className = 'ctrl-key' + (controlsRebindTarget === action ? ' listening' : '');
    keyBtn.textContent = controlsRebindTarget === action ? 'Press a key…' : keyLabel(keybinds[action]);
    keyBtn.onclick = () => { controlsRebindTarget = action; renderControlsRows(); };

    row.appendChild(nameEl);
    row.appendChild(keyBtn);
    controlsList.appendChild(row);
  }
}

document.addEventListener('keydown', (e) => {
  if (!controlsRebindTarget) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.key !== 'Escape') setKeybind(controlsRebindTarget, e.key.toLowerCase());
  controlsRebindTarget = null;
  renderControlsRows();
}, true);

if (controlsBtn) {
  controlsBtn.onclick = () => {
    controlsRebindTarget = null;
    renderControlsRows();
    if (controlsPanel) controlsPanel.classList.add('show');
  };
}
if (controlsResetBtn) controlsResetBtn.onclick = () => { resetKeybinds(); renderControlsRows(); };
if (controlsBackBtn) controlsBackBtn.onclick = () => { if (controlsPanel) controlsPanel.classList.remove('show'); };

// ---- Multiplayer (Host / Join) ----------------------------------------
// The Join panel browses the lobby's live room list (party/lobby.js) rather
// than asking for a typed code — watchRooms() only stays subscribed while
// this panel is open, so it's unsubscribed on Back/close.
let stopWatchingRooms = null;

function currentCharacterLabel() {
  return CHARACTERS.find(c => c.id === characterId)?.label;
}

function renderRoomList(rooms) {
  if (!roomListEl) return;
  if (!rooms.length) {
    roomListEl.innerHTML = '<p class="hint">No games hosted right now</p>';
    return;
  }
  roomListEl.innerHTML = rooms.map(r => `
    <div class="room-row" data-code="${r.code}">
      <span class="room-name">${r.name}</span>
      <button class="room-join small-btn" type="button">JOIN</button>
    </div>`).join('');
  roomListEl.querySelectorAll('.room-row').forEach((row) => {
    row.querySelector('.room-join').onclick = () => {
      setJoinStatus('Requesting to join…');
      emit('menu:join-game', row.dataset.code, currentCharacterLabel());
    };
  });
}

if (multiplayerBtn) {
  multiplayerBtn.onclick = () => {
    if (multiplayerPanel) multiplayerPanel.classList.add('show');
    setJoinStatus('');
    setHostStatus('');
    if (!stopWatchingRooms) stopWatchingRooms = watchRooms(renderRoomList);
  };
}
if (multiplayerBackBtn) {
  multiplayerBackBtn.onclick = () => {
    if (multiplayerPanel) multiplayerPanel.classList.remove('show');
    if (stopWatchingRooms) { stopWatchingRooms(); stopWatchingRooms = null; }
  };
}
if (hostBtn) {
  hostBtn.onclick = () => {
    const label = currentCharacterLabel();
    setHostStatus('Starting room…');
    emit('menu:host-game', label ? `${label}'s Game` : undefined);
  };
}
if (joinBtn) {
  joinBtn.onclick = () => {
    const code = joinCodeInput ? joinCodeInput.value : '';
    if (!code) return;
    setJoinStatus('Requesting to join…');
    emit('menu:join-game', code, currentCharacterLabel());
  };
}

export function setJoinStatus(text) {
  if (joinStatusEl) joinStatusEl.textContent = text || '';
}

export function setHostStatus(text) {
  if (hostStatusEl) hostStatusEl.textContent = text || '';
}

// Shown once hosting/joined; stays up until Main Menu is used to leave
// (orbit-view Esc menu → 🏠 MAIN MENU) or the page reloads.
export function showRoomCode(code) {
  if (!roomCodeBadge) return;
  roomCodeBadge.textContent = `ROOM: ${code}`;
  roomCodeBadge.classList.add('show');
}

export function hideRoomCode() {
  if (roomCodeBadge) roomCodeBadge.classList.remove('show');
}
