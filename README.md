# Dotlands

A small HTML5 hex strategy game for phones and desktops. Explore a newly generated continent every match, with dot armies and clear battle outcomes.

Source repository: [moswald14/dotlands](https://github.com/moswald14/dotlands).

## Modes

- **Solo:** one human country against one to three computer opponents.
- **Pass & play:** two to four people share one screen, with computers in spare seats.
- **Online:** a host creates a four-seat private room, friends join by invitation or code, and empty seats become computers at the start.

Solo and shared-screen games run entirely in the single HTML file. Private online rooms use Doodletick: the host browser runs the game, browsers exchange moves over WebRTC, and the included Node.js service provides room discovery and an HTTPS fallback when a direct connection is unavailable. The published client can include its hosted address, so friends only need a room invitation or code. See `SERVER.md` to deploy your own server.

## Rules

Select your hex, then an adjacent destination. The game automatically sends the maximum available dots; there is no army-size control. Review the outcome and confirm. Each hex holds at most nine dots, and at least one stays behind to maintain ownership. Each dot moves once per turn; incoming dots rest until the next turn.

Friendly moves reinforce a tile. Attacks remove the smaller army's size from both armies: six against four captures the hex with two survivors; three against five leaves two defenders. Equal armies clear the tile to neutral with zero dots. Losing attacks are legal, allowing several armies to wear down a full tile.

Ending a turn adds one dot to every held hex, capped at nine. Neutral tiles do not grow. Eliminated countries are skipped. The last country with land wins, even if independent tiles remain.

## Files

| File | Purpose |
| --- | --- |
| `index.template.html` | Page structure and build placeholders. |
| `style.css` | Responsive layout, map styling, and touch controls. |
| `app.js` | UI, local saves, turn handoffs, sound, and online client. |
| `engine.js` | Shared deterministic rules, map generation, and AI. |
| `build.mjs` | Produces a self-contained `index.html` and checks its embedded JavaScript syntax. |
| `engine.test.mjs` | Rules, invariants, seeded maps, and complete AI simulations. |
| `client.test.cjs` | Room navigation, reconnect races, and interrupted computer turns. |
| `server.cjs` | Serves the game, Doodletick routes, and the legacy room API. |
| `doodletick-server.cjs` | Reusable signaling mailbox and assisted transport; no game rules. |
| `doodletick-rooms.js` | Reusable WebRTC data connections with assisted fallback. |
| `dotlands-room.js` | Host-side game rules, seat authentication, snapshots, and bots. |
| `DOODLETICK.md` | Shared room API and network behavior. |
| `server.test.cjs` | HTTP room workflows, authentication, revisions, and limits. |
| `SERVER.md` | Server setup, hosting limits, configuration, and API contract. |
| `render.yaml` | Optional deployment configuration. |

## Build and run

Install Node.js 20 or newer. There are no runtime package dependencies.

From this source folder, build the standalone game into an explicit destination:

```sh
node build.mjs ./dist
```

Open `dist/index.html` in a browser for local play. To build the game beside the room server and run both locally:

```sh
npm run build
npm start
```

Visit `http://localhost:8787`. The server can also find the parent workspace's `outputs/index.html` during development. See `SERVER.md` for same-network phone access and HTTPS hosting.

Run the checks from this folder:

```sh
npm test
```

The HTTP tests use temporary local ports. Network restrictions can block those checks even when the game files are valid. A passing engine test or syntax check does not establish mobile-browser compatibility; also exercise the built page at phone sizes and on the devices you intend to support.

## Release

Zip the generated `index.html` at the archive root as `dotlands-itch.zip`. On itch.io choose HTML Game, upload the archive, and use fullscreen launch. Check the uploaded game on target phones before enabling Mobile Friendly. The official [HTML5 upload guide](https://itch.io/docs/creators/html5) describes the current embed options.

Deploy the complete source folder as one Node.js service with HTTPS. The included Render configuration uses the free plan, builds with `node build.mjs .`, starts with `node server.cjs`, and checks `/api/health`. Keep the template, styles, app, engine, and build script together. Itch.io hosts the HTML client; it does not run the room server.

To include the hosted server address in the itch.io build, pass it as the optional final argument:

```sh
node build.mjs ./dist https://your-room-server.example
```

You can also set the `DOTLANDS_SERVER` environment variable. Replace the example address with the verified deployment URL. Players can enter a different server in Online setup. Invitation links carry the room code and server address, never the player's private seat token.

## Persistence and limits

One local match is saved in browser storage when available. Starting a new local match replaces it. Online seat credentials are saved separately; reconnecting requires that same browser storage and a still-existing room. The host must keep its game open. Closing or reloading the host ends the match; guests can return to the same seat while the host remains open. Connection mailboxes expire after 24 idle hours or a server restart. There is no host migration. Run one connection server instance.

A free Render server sleeps after inactivity and may take about a minute to wake. Wait, then retry if your first connection times out. A restart, redeploy, or shutdown clears the room directory; create a new room if reconnection fails. See [Render's free-service limits](https://render.com/docs/free).

Country names, symbols, and colors identify players. New games generate a connected continent with a random coastline and 33–39 land hexes. All countries begin with three connected hexes and 13 dots. A stored seed reproduces the same map; existing local saves retain their original map. The engine also supports a larger 48–54-hex variant.

Live connection service and standalone game: https://dotlands-rooms.onrender.com

Doodletick does not require players to create an account. This game module does not access the Keeper identity vault or file library. See `DOODLETICK.md`.
