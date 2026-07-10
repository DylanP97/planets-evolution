// Lobby PartyKit room: a singleton registry of currently-hosted game rooms,
// so the Join panel can list rooms to click instead of the player typing a
// code read out by the host. Every client (hosts registering, joiners
// browsing) connects to the same room id ("index"); state lives only in
// this instance's memory (party/server.js's main relay is unrelated — one
// room per game, this is the one room that tracks all of them).
export default class Lobby {
  constructor(room) {
    this.room = room;
    this.rooms = new Map(); // code -> { name, hostConnId }
  }

  onConnect(conn) {
    conn.send(JSON.stringify({ type: 'lobby:list', payload: this.list() }));
  }

  onMessage(message, sender) {
    let msg;
    try { msg = JSON.parse(message); } catch (_) { return; }
    if (msg.type === 'lobby:register') {
      this.rooms.set(msg.code, { name: msg.name || msg.code, hostConnId: sender.id });
      this.broadcastList();
    } else if (msg.type === 'lobby:unregister') {
      this.rooms.delete(msg.code);
      this.broadcastList();
    }
  }

  onClose(conn) {
    for (const [code, info] of this.rooms) {
      if (info.hostConnId === conn.id) this.rooms.delete(code);
    }
    this.broadcastList();
  }

  list() {
    return [...this.rooms.entries()].map(([code, info]) => ({ code, name: info.name }));
  }

  broadcastList() {
    this.room.broadcast(JSON.stringify({ type: 'lobby:list', payload: this.list() }));
  }
}
