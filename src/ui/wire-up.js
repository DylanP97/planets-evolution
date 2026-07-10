// Deferred UI wiring + the bus subscription registry. main.js imports this
// module last, after every other module has fully evaluated, so it is the
// one place that may freely import from every ui/ module at once.
//
// Bus events (emitted by lower layers via core/bus.js so they never import
// ui/): every subscription is registered HERE, in source order, so the
// handler call order is deterministic and easy to audit — it mirrors the
// direct call sequences the emits replaced.
import { on } from '../core/bus.js';
import { brushStrength, setBrushStrength } from '../framework/state.js';
import { focusedBody, focusedProbe } from '../framework/state.js';
import { setFocus, setProbeFocus } from '../modes/focus.js';
import { onRegenClick } from './atmo-rings.js';
import { renderLocationList } from '../entities/locations.js';
import {
  brushRadiusInput, brushStrengthInput, brushStrengthVal,
  genAmpInput, genSeaInput, refreshActiveTool, regenBtn,
  sliderToBrushStrength, syncBrushRadius, syncGenLabels, updateBiomeTools,
} from './controls.js';
import { deployPlanetBtn, focusPlanetBtn } from './dom.js';
import { updateInfoPanel } from './info-panel.js';
import { applyFocusToLeftPanel, syncRingsToFocus } from './left-panel.js';
import { renderNavBodies, setSystemFocus } from './nav.js';
import {
  deployNewPlanet, renderFocusBadges, renderMoonsList, renderPlanetList, renderProbesList
} from './roster.js';
import { loadStarSystem, findStarSystem, unloadStarSystem } from '../system/starsystems.js';
import {
  saveToSlot, loadFromSlot, deleteSlot, listSaveSlots, hasAnySave, lastSlotId, restoreGame,
} from '../system/save.js';
import {
  openStartMenu, closeStartMenu, openLoadPanel, renderSaveSlotList, setContinueLoadEnabled,
  showRoomCode, hideRoomCode, setJoinStatus, setHostStatus,
} from './start-menu.js';
import { toggleOrbitMenu } from './orbit-menu.js';
import { hostRoom, joinRoom, disconnectRoom } from '../net/connection.js';
import { onPeerJoined, onPeerLeft, onAvatarState, clearRemoteAvatars } from '../net/remote-avatars.js';
import { addJoinRequest } from './join-requests.js';
import { runLoadingTransition } from './loading-screen.js';
import { startTutorial, stopTutorial } from './tutorial.js';

// ---- Home screen / save-load -------------------------------------------
// Every path that actually enters the game hides the home screen, then runs
// the "Planets Exploration" loading curtain around the (fast, synchronous)
// world-build call — home screen → loading transition → app, never a popup
// over an already-running scene.
on('menu:opened', () => setContinueLoadEnabled(hasAnySave()));
// Free World = the sandbox: full editing, orbit view.
on('menu:free-world', () => {
  closeStartMenu();
  runLoadingTransition(() => {
    loadStarSystem(findStarSystem('sol'));
  });
});
// Explore Tutorial = the same sandbox, plus the narrator + step-checklist
// overlay (ui/tutorial.js) guiding a first-time tour of the app.
on('menu:start-tutorial', () => {
  closeStartMenu();
  runLoadingTransition(() => {
    loadStarSystem(findStarSystem('sol'));
    startTutorial();
  });
});
on('menu:continue-game', () => {
  closeStartMenu();
  const id = lastSlotId();
  runLoadingTransition(() => {
    if (!id || !loadFromSlot(id)) loadStarSystem(findStarSystem('sol'));
  });
});
on('menu:open-load-panel', () => { renderSaveSlotList(listSaveSlots()); openLoadPanel(); });
on('menu:load-game', (slotId) => {
  closeStartMenu();
  runLoadingTransition(() => loadFromSlot(slotId));
});
on('menu:delete-save', (slotId) => { deleteSlot(slotId); renderSaveSlotList(listSaveSlots()); setContinueLoadEnabled(hasAnySave()); });
on('menu:save-game', () => saveToSlot());
on('menu:toggle-orbit-menu', toggleOrbitMenu);
// Orbit-view Esc menu's 🏠 MAIN MENU: tear down the current system/room and
// go back to the home screen, mirroring the boot-time entry point exactly.
on('menu:return-home', () => {
  disconnectRoom();
  clearRemoteAvatars();
  hideRoomCode();
  unloadStarSystem();
  stopTutorial();
  openStartMenu();
});

// ---- Multiplayer (v1: room-code join, avatar presence only) -----------
// Hosting loads a fresh Sol game (through the same loading curtain), then
// opens a room and shows the code so it can be read out to the joining
// player. Joining does NOT go through New/Continue/Load or the loading
// curtain until the host's snapshot actually arrives — the home screen
// stays up (showing "Connected — waiting for host…") until there's a real
// world to reveal, reusing Phase 1's save/restore path verbatim.
on('menu:host-game', (hostName) => {
  hostRoom(hostName).then((code) => {
    setHostStatus('');
    closeStartMenu();
    runLoadingTransition(() => loadStarSystem(findStarSystem('sol')));
    showRoomCode(code);
  }).catch(() => {
    setHostStatus('Could not start hosting — is the relay running? (see party/README.md)');
  });
});
on('menu:join-game', (code, name) => {
  joinRoom(code, name)
    .then((roomCode) => { showRoomCode(roomCode); setJoinStatus('Waiting for host to accept…'); })
    .catch(() => setJoinStatus('Could not connect — check the code and try again.'));
});
on('net:join-request', (senderId, payload) => addJoinRequest(senderId, payload));
on('net:join-declined', () => {
  disconnectRoom();
  hideRoomCode();
  setJoinStatus('Host declined your request.');
});
on('net:snapshot', (data) => {
  closeStartMenu();
  runLoadingTransition(() => restoreGame(data));
});
on('net:peer-joined', (clientId, payload) => onPeerJoined(clientId, payload));
on('net:peer-left', (clientId) => onPeerLeft(clientId));
on('net:avatar-state', (clientId, payload) => onAvatarState(clientId, payload));
on('net:disconnected', () => clearRemoteAvatars());

// ---- Bus subscriptions -------------------------------------------------
// 'focus:changed' fires at the end of setFocus / setProbeFocus; the handler
// order replicates the original tail of those functions.
on('focus:changed', () => {
  renderFocusBadges();
  updateBiomeTools();
  updateInfoPanel();
  applyFocusToLeftPanel();
  renderLocationList();                        // filtered to the new focus
});
on('focus:system', setSystemFocus);            // probes/teardown/starsystems
on('nav:render', renderNavBodies);             // roster, star-map
on('ui:info', updateInfoPanel);                // moons, atmo sliders
on('ui:satellite-lists', () => { renderMoonsList(); renderProbesList(); });
on('ui:biome-tools', updateBiomeTools);        // finalizeSystemLoad
on('ui:active-tool', refreshActiveTool);       // finalizeSystemLoad
on('ui:left-panel', applyFocusToLeftPanel);    // onRegenClick (matter change)
on('ui:sync-rings', syncRingsToFocus);         // rings enable toggle

// ---- generator + brush slider init ----
regenBtn.onclick = onRegenClick;

syncBrushRadius(parseInt(brushRadiusInput.value, 10));
setBrushStrength(sliderToBrushStrength(parseInt(brushStrengthInput.value, 10)));
brushStrengthVal.textContent = brushStrength.toFixed(1);

genAmpInput.oninput = syncGenLabels;
genSeaInput.oninput = syncGenLabels;
syncGenLabels();

// ---- roster buttons ----
deployPlanetBtn.onclick = () => {
  const b = deployNewPlanet();
  if (b) {
    renderPlanetList();
    renderNavBodies();
  }
};

// Reset Camera: recenter on whatever is currently in focus, not always Earth.
focusPlanetBtn.onclick = () => {
  if (focusedProbe) setProbeFocus(focusedProbe);
  else if (focusedBody) setFocus(focusedBody);
  else setSystemFocus();
};
