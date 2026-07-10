// PartyKit relay for multiplayer v1 (avatar presence only — no terrain sync).
// Deliberately dumb: it never inspects message contents, just re-broadcasts
// whatever one client sends to every other client in the same room. All game
// logic (who's the host, snapshot handoff, avatar interpolation) lives in the
// browser client (src/net/connection.js) — this file is the one place in the
// repo with its own npm/deploy step; it never touches the client's
// no-build-step rule.
export default class Server {
  constructor(room) {
    this.room = room;
  }

  onMessage(message, sender) {
    this.room.broadcast(message, [sender.id]);
  }

  onClose(conn) {
    this.room.broadcast(JSON.stringify({ type: 'player:left', senderId: conn.id }));
  }
}
