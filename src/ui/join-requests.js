// Host-side "so-and-so wants to join" prompt. Requests queue here (usually
// just one) and render as Accept/Decline rows in a persistent overlay —
// wire-up.js owns the 'net:join-request' subscription and calls
// addJoinRequest(); this module never imports core/bus.js itself. If the
// host is mid-walk with pointer lock engaged, the on-screen prompt is
// unreachable, so accepting a request first releases pointer lock (the
// existing pointerlockchange handler in modes/surface/input.js then opens
// the pause menu underneath this overlay, same as hitting Esc).
import { respondToJoin } from '../net/connection.js';

const overlayEl = document.getElementById('joinRequestOverlay');
const listEl = document.getElementById('joinRequestList');

let pending = [];

function render() {
  if (!overlayEl || !listEl) return;
  if (!pending.length) {
    overlayEl.classList.remove('show');
    listEl.innerHTML = '';
    return;
  }
  if (document.pointerLockElement) document.exitPointerLock();
  overlayEl.classList.add('show');
  listEl.innerHTML = pending.map(({ senderId, name }) => `
    <div class="join-request-row" data-sender="${senderId}">
      <span class="join-request-name">${name || 'A player'} wants to join</span>
      <div class="join-request-actions">
        <button class="join-accept" type="button">ACCEPT</button>
        <button class="join-decline" type="button">DECLINE</button>
      </div>
    </div>`).join('');
  listEl.querySelectorAll('.join-request-row').forEach((row) => {
    const senderId = row.dataset.sender;
    row.querySelector('.join-accept').onclick = () => resolveRequest(senderId, true);
    row.querySelector('.join-decline').onclick = () => resolveRequest(senderId, false);
  });
}

function resolveRequest(senderId, accept) {
  respondToJoin(senderId, accept);
  pending = pending.filter((r) => r.senderId !== senderId);
  render();
}

export function addJoinRequest(senderId, payload) {
  if (pending.some((r) => r.senderId === senderId)) return;
  pending.push({ senderId, name: payload && payload.name });
  render();
}
