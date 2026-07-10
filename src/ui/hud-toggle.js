// HUD visibility toggle for the solar-system (orbit) view.
// Press H to hide/show the left panel, info panel and bottom nav so the
// scene fills the screen unobstructed. Only acts in orbit/system view —
// surface mode runs its own overlay (and owns its own key handling), and
// while typing in a field the key falls through to the input.
import { viewMode } from '../framework/state.js';

function isTyping() {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
}

addEventListener('keydown', (e) => {
  if (e.key !== 'h' && e.key !== 'H') return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (viewMode !== 'orbit') return;
  if (isTyping()) return;
  document.body.classList.toggle('hud-hidden');
});
