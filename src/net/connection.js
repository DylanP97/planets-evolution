// Multiplayer connection: a plain WebSocket to a PartyKit room (see
// party/README.md for one-time setup). v1 scope is avatar presence only
// (position/facing/animation) — terrain edits are NOT synced. The server is
// a dumb per-room relay (party/server.js); all game logic here — who's host,
// snapshot handoff on join — lives on the client, matching the project's
// "everything runs in the browser" philosophy.
import { emit } from '../core/bus.js';
import { serializeGame } from '../system/save.js';

// Set this after running `npx partykit deploy` in party/ (see party/README.md),
// e.g. 'planet-tiles-relay.<your-username>.partykit.dev'. Left as a local dev
// placeholder so `npm run dev` inside party/ works out of the box.
export const PARTY_HOST = 'localhost:1999';
const PARTY_SECURE = PARTY_HOST !== 'localhost:1999';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I ambiguity
const SEND_INTERVAL_MS = 100; // ~10Hz avatar-state broadcast

function randomRoomCode(len = 5) {
  let s = '';
  for (let i = 0; i < len; i++) s += CODE_CHARS[(Math.random() * CODE_CHARS.length) | 0];
  return s;
}

let socket = null;
let isHost = false;
let selfId = null;
let lastSendTime = 0;
let currentRoomCode = null;

// ---- Lobby (room browser) ------------------------------------------------
// A second, independent websocket to the singleton lobby room (party/
// lobby.js), separate from the per-game `socket` above. Hosting registers
// this room's code+name there; the Join panel watches it to render a
// clickable list instead of asking the player to type a code.
let lobbySocket = null;
let lobbyListeners = [];
let lastRoomList = [];

function connectLobby() {
  if (lobbySocket) return lobbySocket;
  const proto = PARTY_SECURE ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${PARTY_HOST}/parties/lobby/index`);
  ws.addEventListener('message', (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch (_) { return; }
    if (msg.type === 'lobby:list') {
      lastRoomList = msg.payload;
      lobbyListeners.forEach((fn) => fn(lastRoomList));
    }
  });
  ws.addEventListener('close', () => { if (lobbySocket === ws) lobbySocket = null; });
  lobbySocket = ws;
  return ws;
}

function sendLobby(msg) {
  const ws = connectLobby();
  const fire = () => ws.send(JSON.stringify(msg));
  if (ws.readyState === WebSocket.OPEN) fire();
  else ws.addEventListener('open', fire, { once: true });
}

// Subscribes to the live room list; calls onUpdate(rooms) immediately with
// whatever's cached (so re-opening the panel isn't empty until the next
// broadcast) and again on every change. Returns an unsubscribe function —
// callers (the Join panel) should call it when the panel closes.
export function watchRooms(onUpdate) {
  lobbyListeners.push(onUpdate);
  connectLobby();
  onUpdate(lastRoomList);
  return () => { lobbyListeners = lobbyListeners.filter((fn) => fn !== onUpdate); };
}

const CONNECT_TIMEOUT_MS = 8000;

function connect(roomCode, helloPayload) {
  return new Promise((resolve, reject) => {
    const proto = PARTY_SECURE ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${PARTY_HOST}/parties/main/${roomCode}`);
    // Without this, a relay that's unreachable (wrong PARTY_HOST, dev server
    // not running) never fires 'error' — the socket just sits in CONNECTING
    // forever and hostRoom()/joinRoom() silently never resolve or reject.
    const timeout = setTimeout(() => { ws.close(); reject(new Error('Connection timed out')); }, CONNECT_TIMEOUT_MS);
    ws.addEventListener('open', () => {
      clearTimeout(timeout);
      socket = ws;
      selfId = Math.random().toString(36).slice(2, 10);
      send({ type: 'hello', payload: helloPayload || {} });
      resolve(roomCode);
    });
    ws.addEventListener('message', (e) => handleMessage(e.data));
    ws.addEventListener('close', () => { socket = null; emit('net:disconnected'); });
    ws.addEventListener('error', (err) => { clearTimeout(timeout); reject(err); });
  });
}

function send(msg) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ ...msg, senderId: selfId }));
  }
}

function handleMessage(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch (_) { return; }
  if (!msg || msg.senderId === selfId) return;
  // targetId addresses a message at one specific peer (used by the
  // accept/decline reply below) — everyone else on the broadcast ignores it.
  if (msg.targetId && msg.targetId !== selfId) return;
  if (msg.type === 'hello') {
    // The host doesn't auto-admit a joiner — it surfaces a join request and
    // waits for respondToJoin(); other existing peers just track presence.
    if (isHost) emit('net:join-request', msg.senderId, msg.payload);
    else emit('net:peer-joined', msg.senderId, msg.payload);
  } else if (msg.type === 'state:snapshot') {
    emit('net:snapshot', msg.payload);
    // msg.payload here is the world snapshot, not peer info — 'peer-joined'
    // only needs to register the host's presence for avatar tracking.
    emit('net:peer-joined', msg.senderId, {});
  } else if (msg.type === 'join:decline') {
    emit('net:join-declined');
  } else if (msg.type === 'avatar:state') {
    emit('net:avatar-state', msg.senderId, msg.payload);
  } else if (msg.type === 'player:left') {
    emit('net:peer-left', msg.senderId);
  }
}

// `name` labels the room in other players' lobby list (e.g. the host's
// chosen character) — purely cosmetic, defaults to the room code itself.
export function hostRoom(name) {
  isHost = true;
  const code = randomRoomCode();
  currentRoomCode = code;
  return connect(code).then(() => {
    sendLobby({ type: 'lobby:register', code, name: name || code });
    return code;
  });
}

// `name` is shown to the host in their Accept/Decline prompt.
export function joinRoom(code, name) {
  isHost = false;
  const trimmed = code.trim().toUpperCase();
  currentRoomCode = trimmed;
  return connect(trimmed, { name });
}

// Host-only: answers a pending join request (senderId from 'net:join-request').
// Accepting hands the joiner the full world snapshot, addressed only to them
// via targetId — every other connected peer ignores it (see handleMessage).
export function respondToJoin(senderId, accept) {
  if (accept) {
    send({ type: 'state:snapshot', targetId: senderId, payload: serializeGame() });
    emit('net:peer-joined', senderId, {});
  } else {
    send({ type: 'join:decline', targetId: senderId });
  }
}

export function disconnectRoom() {
  if (isHost && currentRoomCode) sendLobby({ type: 'lobby:unregister', code: currentRoomCode });
  if (socket) socket.close();
  socket = null;
  isHost = false;
  currentRoomCode = null;
}

export function inRoom() {
  return !!socket;
}

export function currentRoom() {
  return currentRoomCode;
}

// Called every frame from main.js while walking a surface; throttled
// internally so it's safe to call unconditionally at frame rate.
export function sendAvatarState(state) {
  if (!socket) return;
  const now = performance.now();
  if (now - lastSendTime < SEND_INTERVAL_MS) return;
  lastSendTime = now;
  send({ type: 'avatar:state', payload: state });
}
