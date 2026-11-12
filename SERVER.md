# Dotlands private online rooms

Same-phone multiplayer works entirely in the HTML game. Separate-phone private rooms use this small Node.js server to keep all players on the same board. The server applies the rules; a client cannot submit its own replacement game state.

## Run locally

Install Node.js 20 or newer. Keep the source files together in one folder. From that folder run:

```sh
npm run build
npm start
```

Open `http://localhost:8787`. For another phone on the same Wi-Fi, open `http://YOUR-COMPUTER-LAN-IP:8787`; the computer must allow the connection through its firewall. `localhost` on a phone refers to that phone, not the computer running the server.

## Use with itch.io

1. Upload the separate HTML5 game ZIP to itch.io.
2. Deploy this source folder at the root of a Git repository as a Node web service with a public **HTTPS** address. Use `node build.mjs .` as the build command, `node server.cjs` as the start command, and `/api/health` as the health-check path. No package installation is required. The build writes the finished game beside the server. It listens on the host's `PORT` environment variable, defaulting to `8787` for local use.
3. Enter that server address in the game's online setup. Everyone joining the room must use the same server address.
4. Create a room, share its six-character code, and wait for the other players. The host starts the match and can fill unused seats with computer opponents.

The included `render.yaml` is a Render Blueprint for the source folder at the root of a Git repository. It requests the free web-service plan, builds the game from source, and checks `/api/health`. Include `build.mjs`, `index.template.html`, `style.css`, `app.js`, and `engine.js` alongside `server.cjs`; the build needs them. Check the deployment result and current plan limits before relying on it for persistent games. Schema reference: [Render Blueprint YAML reference](https://render.com/docs/blueprint-spec).

**Hosting limits:** rooms live in memory. A server restart, redeploy, or suspension that ends the process loses its rooms. Idle rooms expire after 24 hours. Run a single server instance; multiple independent instances do not share rooms. This first version supports friendly private games, not accounts, matchmaking, rankings, or durable saved online matches.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8787` | Port assigned by your web host or used locally. |
| `ALLOWED_ORIGINS` | `*` | Comma-separated browser origins permitted to use the room API. |

The default allows game pages hosted on itch.io or elsewhere to call the API without cookies. Room actions still need the player's random secret token. For a public deployment, you can limit `ALLOWED_ORIGINS` to the actual origin of the embedded game iframe and the server's own origin. An itch.io project page's origin may differ from the iframe serving its game. Do not expose players' tokens in invite links, screenshots, or logs.

Refresh reconnects when the game still has the saved room code and player token. Closing a browser does not remove its seat. To restart or change the lineup after a match has started, create a new room. There is no host migration or kick command in this version.

## HTTP contract

The configured server address is the origin, such as `https://your-room-server.example`, without an `/api` suffix. Requests and responses use JSON. Authenticated endpoints need `Authorization: Bearer TOKEN`.

| Method and route | Body | Result |
| --- | --- | --- |
| `GET /api/health` | — | `{ok:true,game:"Dotlands",protocol:1}` |
| `POST /api/rooms` | `{name,maxPlayers:2..4,seed?,radius?:3\|4}` | New lobby snapshot, including `token` and `seat:0`. |
| `POST /api/rooms/CODE/join` | `{name}` | Lobby snapshot, including that player's `token` and `seat`. |
| `GET /api/rooms/CODE` | — | Authenticated current snapshot; use for polling and reconnection. |
| `POST /api/rooms/CODE/start` | `{expectedRevision,fillBots:boolean}` | Host-only start; empty seats become bots when requested. |
| `POST /api/rooms/CODE/action` | `{expectedRevision,type:"move",from,to}` | Current player's legal move. The server sends the maximum available dots, leaving one behind and respecting friendly-tile capacity. Any legacy `amount` field is ignored. Tile IDs are axial-coordinate strings, such as `"-2,1"`. |
| `POST /api/rooms/CODE/action` | `{expectedRevision,type:"endTurn"}` | End current player's turn and run computer turns. |

Every room snapshot has:

```json
{
  "code": "ABC234",
  "phase": "lobby",
  "revision": 1,
  "players": [{"name": "Player 1", "seat": 0}],
  "hostSeat": 0,
  "maxPlayers": 4,
  "state": null,
  "seat": 0
}
```

`state` contains the authoritative engine state after a match starts. `players` lists joined humans; `state.players` also includes computer opponents. `phase` stays `playing` for a finished match, with the winner in `state.winner`. Never render names through `innerHTML`.

Tokens are returned only on creation and joining, never in later snapshots. Preserve the token separately. Poll approximately every two seconds and pause polling while a request is already pending. If an action returns `409`, fetch the current snapshot before retrying; do not blindly replay a move. `401` means the room credentials were missing or invalid; `404` means the room may have expired. Errors have a friendly `{error:"..."}` body. Stale-revision errors also include the latest `revision`.

The server limits JSON bodies to 8 KiB, room names to 22 characters, room count to 200, and room creation to 12 per IP per hour. Authenticated seats each get 240 requests per minute; anonymous or invalid-token requests share an IP budget. This keeps normal room polling separate behind hosting proxies without trusting arbitrary forwarded headers. Health checks are independent of player request limits. Creation can still share a limit behind a proxy, so tune deliberately for larger public use.

## Verification

With the test files included, run:

```sh
npm test
```

`engine.test.mjs` checks rules, random continents, and simulations. `server.test.cjs` starts temporary local HTTP servers and checks room creation, private tokens, joining, host authority, stale actions, maximum-size moves, computer turns, expiry, separate player request budgets, origin controls, and malformed requests. The HTTP tests need permission to make loopback network connections.
