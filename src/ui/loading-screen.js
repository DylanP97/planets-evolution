// "Planets Exploration" loading transition — the curtain shown between the
// home screen and the live game. Reuses the #bootLoader markup/CSS that used
// to cover the page while the JS/CDN modules parsed on first paint; that job
// now belongs to the home screen (plain HTML/CSS, visible instantly, no JS
// required), so this element is repurposed as a deliberate, user-triggered
// transition instead — hidden by default (index.html gives it the `is-done`
// class up front) and only shown between "picked a menu action" and
// "world is ready."
const el = document.getElementById('bootLoader');
const statusEl = document.getElementById('bootStatus');
const pctEl = document.getElementById('bootPercent');
const barEl = document.getElementById('bootBarFill');

const MSGS = [
  'Igniting stellar core',
  'Seeding planetary crust',
  'Calibrating orbital mechanics',
  'Painting biomes',
  'Charting the star map',
];

let tickHandle = null;
let pct = 0;

export function showLoadingScreen() {
  if (!el) return;
  el.classList.remove('is-done');
  pct = 0;
  if (tickHandle) clearInterval(tickHandle);
  tickHandle = setInterval(() => {
    pct += Math.max(0.8, (96 - pct) * 0.08);
    if (pct > 96) pct = 96;
    const shown = Math.floor(pct);
    if (pctEl) pctEl.textContent = shown;
    if (barEl) barEl.style.width = pct + '%';
    if (statusEl) statusEl.textContent = MSGS[Math.min(MSGS.length - 1, Math.floor((shown / 100) * MSGS.length))];
  }, 80);
}

export function hideLoadingScreen() {
  if (!el) return;
  if (tickHandle) { clearInterval(tickHandle); tickHandle = null; }
  if (pctEl) pctEl.textContent = '100';
  if (barEl) barEl.style.width = '100%';
  requestAnimationFrame(() => el.classList.add('is-done'));
}

// Convenience for the common case: show the curtain, run a synchronous (or
// fire-and-forget) load, then hold for a minimum readable duration before
// revealing the game — `fn` runs immediately so the world is already fully
// built by the time the curtain lifts, never a half-built flash.
const MIN_MS = 1400;
export function runLoadingTransition(fn) {
  showLoadingScreen();
  fn();
  setTimeout(hideLoadingScreen, MIN_MS);
}
