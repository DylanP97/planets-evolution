// Character page: reached from the pause menu (surfaceCharacterBtn), lists
// the CHARACTERS registry from avatar.js. Clicking an entry swaps the
// controlled avatar in-place (setCharacter handles teardown + reload) and the
// pick persists via localStorage. The active entry is highlighted; the one
// being fetched shows a loading state until its GLB resolves.
import { CHARACTERS, characterId, setCharacter } from './avatar.js';
import { surfaceState } from './core.js';
import { createCharacterPreview } from './character-preview.js';

const preview = createCharacterPreview('surfaceCharacterPreview');

const pauseBoxEl    = document.getElementById('surfacePauseMenu');
const characterEl   = document.getElementById('surfaceCharacterMenu');
const listEl        = document.getElementById('surfaceCharacterList');
const backBtn       = document.getElementById('surfaceCharacterBackBtn');

let loadingId = null;   // character id currently being fetched, or null

function renderRows() {
  if (!listEl) return;
  listEl.innerHTML = '';
  for (const character of CHARACTERS) {
    const { id, label } = character;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'char-row'
      + (id === characterId ? ' active' : '')
      + (id === loadingId ? ' loading' : '');
    btn.textContent = id === loadingId ? `${label} — LOADING…`
      : id === characterId ? `${label} ✓` : label;
    btn.onclick = () => pickCharacter(id);
    btn.onmouseenter = () => preview.show(character);
    listEl.appendChild(btn);
  }
}

function pickCharacter(id) {
  preview.show(CHARACTERS.find(c => c.id === id));
  if (id === characterId || loadingId) return;
  loadingId = id;
  renderRows();
  setCharacter(id)
    .catch(() => { console.warn('[surface] character swap failed:', id); })
    .finally(() => { loadingId = null; renderRows(); });
}

export function openCharacterMenu() {
  loadingId = null;
  surfaceState.pauseView = 'character';
  renderRows();
  if (pauseBoxEl) pauseBoxEl.classList.remove('show');
  if (characterEl) characterEl.classList.add('show');
  preview.start();
  preview.show(CHARACTERS.find(c => c.id === characterId));
}

// Back to the pause box — still paused, just switching which panel shows.
export function backFromCharacterMenu() {
  surfaceState.pauseView = 'pause';
  if (characterEl) characterEl.classList.remove('show');
  if (pauseBoxEl) pauseBoxEl.classList.add('show');
  preview.stop();
}

if (backBtn) backBtn.onclick = backFromCharacterMenu;
