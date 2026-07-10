// Explore Tutorial overlay: a centered narrator dialogue box (one line at a
// time, advanced explicitly by click/Space — never a timer, so a line stays
// up until the player is done reading it) plus a persistent bottom-right
// step checklist that stays visible in both orbit and surface view. Self-
// contained like pause-menu.js/start-menu.js — owns its own DOM refs, only
// reads shared state (never imports another ui/ module). startTutorial()/
// stopTutorial() are called from wire-up.js; updateTutorial() is polled
// every frame from main.js regardless of view mode, since steps can
// complete in either.
import { focusedBody, isPainting, viewMode } from '../framework/state.js';
import { surfaceState } from '../modes/surface/core.js';
import { showSatelliteOrbits } from '../system/orbits.js';

const checklistEl     = document.getElementById('tutorialChecklist');
const checklistListEl = document.getElementById('tutorialChecklistList');
const checklistCloseBtn = document.getElementById('tutorialChecklistCloseBtn');
const narrationBoxEl  = document.getElementById('tutorialNarrationBox');
const narrationTextEl = document.getElementById('tutorialNarrationText');

// Each step's `check` is polled every frame and fires once the condition is
// true; `lines` are the narrator lines queued (in order) the moment the step
// becomes current. Multi-line steps read as one beat before the objective.
const STEPS = [
  {
    title: 'Show orbits',
    lines: [
      "Use the 'O' key to show orbits.",
      'Planet orbits are cyan-blue, moon orbits are light blue, and probe orbits are orange.',
    ],
    check: () => showSatelliteOrbits,
  },
  {
    title: 'Focus on Earth',
    lines: [
      'You can see on the left the System tab, where all the planets in this solar system are listed.',
      'Now click the ◎ Focus icon next to Earth, in the System tab of the Planet Roster.',
    ],
    check: () => focusedBody?.currentSeed === 'earth',
  },
  {
    title: 'Land on Earth',
    lines: [
      'Earth is a terrestrial and has many biomes.',
      'You can see on the telemetry display on the right, its composition, climate, and more information.',
      "Try to land on Earth by first clicking the 'Visit Surface' button (and don't land on the ocean).",
    ],
    check: () => viewMode === 'surface' && surfaceState.body?.currentSeed === 'earth',
  },
  {
    title: 'Return to orbit',
    lines: ['Return to orbit.'],
    check: () => viewMode === 'orbit',
  },
  {
    title: 'Reshape a planet',
    lines: ['Right-click drag on a planet to reshape its terrain.'],
    check: () => finishedPaintStroke,
  },
  {
    title: "Visit another planet's surface",
    lines: ['Land on a planet other than Earth.'],
    check: () => viewMode === 'surface' && surfaceState.body && surfaceState.body.currentSeed !== 'earth',
  },
  {
    title: 'Open the Star Map',
    lines: ['Open the Star Map.'],
    check: () => document.body.classList.contains('map-mode'),
  },
];

// How long a just-completed row stays crossed-out and readable before it
// fades away, and how long the fade itself takes — must match the CSS
// transition duration on `.leaving` in styles/tutorial.css.
const CROSSOUT_HOLD_MS = 700;
const FADE_OUT_MS = 500;

let tutorialActive = false;
let stepIndex = 0;
let wasPainting = false;
let finishedPaintStroke = false;
// Lines wait here until the player clicks/presses Space — narrator never
// auto-advances or auto-hides on a timer.
let lineQueue = [];
// Live <li> elements for steps currently shown in the checklist, keyed by
// step index — kept as real DOM nodes (not rebuilt via innerHTML) so the
// done→leaving class change animates instead of popping in pre-finished.
const checklistRows = new Map();

function revealStep(i) {
  if (!checklistListEl || checklistRows.has(i)) return;
  const li = document.createElement('li');
  li.textContent = STEPS[i].title;
  checklistListEl.appendChild(li);
  checklistRows.set(i, li);
}

function completeStep(i) {
  const li = checklistRows.get(i);
  if (!li) return;
  li.classList.add('done'); // strike-through, read for a beat…
  setTimeout(() => {
    li.classList.add('leaving'); // …then fade + collapse away
    setTimeout(() => {
      li.remove();
      checklistRows.delete(i);
    }, FADE_OUT_MS);
  }, CROSSOUT_HOLD_MS);
}

function clearChecklist() {
  if (checklistListEl) checklistListEl.innerHTML = '';
  checklistRows.clear();
}

function showNarratorLine(text) {
  if (!narrationTextEl || !narrationBoxEl) return;
  narrationTextEl.textContent = text;
  narrationBoxEl.classList.add('show');
}

function hideNarrator() {
  if (narrationBoxEl) narrationBoxEl.classList.remove('show');
}

// Queues a line; if the narrator is idle it's shown right away, otherwise
// it waits behind whatever the player hasn't dismissed yet.
function enqueueLine(text) {
  lineQueue.push(text);
  if (!narrationBoxEl || !narrationBoxEl.classList.contains('show')) advanceNarrator();
}

function advanceNarrator() {
  if (lineQueue.length === 0) { hideNarrator(); return; }
  showNarratorLine(lineQueue.shift());
}

export function startTutorial() {
  tutorialActive = true;
  stepIndex = 0;
  wasPainting = false;
  finishedPaintStroke = false;
  lineQueue = [];
  hideNarrator();
  if (checklistEl) checklistEl.classList.add('show');
  clearChecklist();
  revealStep(0);
  enqueueLine('Hello, welcome to this tutorial.');
  for (const line of STEPS[0].lines) enqueueLine(line);
}

export function stopTutorial() {
  tutorialActive = false;
  lineQueue = [];
  if (checklistEl) checklistEl.classList.remove('show');
  hideNarrator();
  clearChecklist();
}

export function updateTutorial() {
  if (!tutorialActive) return;

  // Edge-detect "a paint stroke just finished" for the reshape-terrain step.
  finishedPaintStroke = wasPainting && !isPainting;
  wasPainting = isPainting;

  if (stepIndex >= STEPS.length) return;
  if (!STEPS[stepIndex].check()) return;

  completeStep(stepIndex);
  stepIndex += 1;
  if (stepIndex < STEPS.length) {
    revealStep(stepIndex);
    for (const line of STEPS[stepIndex].lines) enqueueLine(line);
  } else {
    enqueueLine('Tutorial complete! Enjoy exploring.');
  }
}

if (narrationBoxEl) narrationBoxEl.onclick = advanceNarrator;
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && narrationBoxEl && narrationBoxEl.classList.contains('show')) {
    e.preventDefault(); // Space also scrolls/toggles other controls — this box owns it while shown.
    advanceNarrator();
  }
});
if (checklistCloseBtn) checklistCloseBtn.onclick = stopTutorial;
