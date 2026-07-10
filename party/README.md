# Multiplayer relay (PartyKit)

One-time setup to make Host/Join multiplayer work. This is the only part of
the project with its own npm/deploy step — the main game stays a build-free
static site.

```powershell
cd party
npm install
npx partykit login      # opens a browser to create/sign in to a free PartyKit account
npx partykit deploy     # deploys this relay and prints its host, e.g.
                         #   https://planet-tiles-relay.<your-username>.partykit.dev
```

Copy the printed host (without `https://`, e.g.
`planet-tiles-relay.<your-username>.partykit.dev`) into `PARTY_HOST` at the
top of `src/net/connection.js`.

To iterate locally before deploying: `npm run dev` starts a local relay at
`localhost:1999` — point `PARTY_HOST` at `localhost:1999` and use `ws://`
instead of `wss://` for local testing (see the comment in connection.js).

This project defines two parties (`partykit.json`'s `parties` field):
`main` (`server.js`, one instance per game room) and `lobby` (`lobby.js`, a
single always-on room that tracks which game rooms currently exist, so the
Join panel can list them instead of the player typing a code). Both deploy
together with the one `npx partykit deploy` command above.
