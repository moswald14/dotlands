# Dotlands

A small HTML5 hex strategy game for phones and desktops. Explore a newly generated continent every match, with dot armies and clear battle outcomes.

Source repository: [moswald14/dotlands](https://github.com/moswald14/dotlands).

Version 1.5.0 adds saved online rooms through **Doodleverse Keeper 0.18b or newer**. The persistent service is maintained in [Doodle Tick](https://github.com/moswald14/doodletick), documented in `keeper/DOTLANDS.md`.

## Modes

- **Solo:** one human country against one to three computer opponents.
- **Pass & play:** two to four people share one screen, with computers in spare seats.
- **Saved online rooms:** open your Doodleverse Keeper, unlock your usual vault, and create or return to a saved continent. Each human pays one private garden Doodle Coin per room, including the creator. Returning is free. Friends use the same Keeper and enter the room code.
- **Quick online rooms:** a host creates a temporary four-seat room, friends join by invitation or code, and empty seats become computers at the start. The host must keep the game open.

Solo offers **Your head start**: none, one extra dot on each of your starting
hexes (the default), or two extra dots per starting hex. The bonus is applied
once to your country when a new solo game starts, with the nine-dot tile limit
still enforced. Computer countries, turn growth, pass-and-play, and online
matches keep their normal rules. Continuing a saved game does not add it again.

Solo and shared-screen games run entirely in the single HTML file. Saved rooms use the authenticated room service in Doodleverse Keeper; this game only remembers your chosen Keeper address and opens it in another tab. The public game never receives a vault key or charges a garden balance. Use an HTTPS Keeper address (HTTP is allowed for localhost development).

Quick rooms use Doodletick: the host browser runs the game, browsers exchange moves over WebRTC, and the included Node.js service provides room discovery and an HTTPS fallback when a direct connection is unavailable. The published client can include its hosted address, so friends only need a quick-room invitation or code. See `SERVER.md` to deploy the temporary-room server.

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
| `solo-head-start.test.cjs` | Solo bonuses, limits, mode isolation, and saved-game continuation. |
| `netcode.test.cjs` | Five-second checks, idle/offline scheduling, batched acknowledgements, and retry timing. |
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

Version 1.5.0 adds a saved-room launcher. Each human pays one existing private garden Doodle Coin per room; returning with the same vault is free. Keeper saves the board, seats and turn so every player can close the game. Two-browser tests covered paid entry, capture, turn changes, closing both browsers and restoring the identical board. The layout was checked at 390 × 844; this does not replace a physical-phone test.

Version 1.4.0 reduces network traffic: five-second active checks, slower idle/background checks, offline pause, event-driven board updates, compact refreshes, batched acknowledgements, and bounded retry backoff. Healthy direct games continue through temporary mailbox outages. See `DOODLETICK.md` for timing and recovery limits.

Version 1.3.0 added the solo head start and fixed online recovery: temporary hosting loading pages are retried
before room creation, and a recovered room connection unlocks play even when
the same players are still present. The initial connection can wait up to two
minutes for a sleeping host. Room creation itself is never automatically repeated.

Zip the generated `index.html` at the archive root as `dotlands-itch.zip`. On itch.io choose HTML Game, upload the archive, and use fullscreen launch. Check the uploaded game on target phones before enabling Mobile Friendly. The official [HTML5 upload guide](https://itch.io/docs/creators/html5) describes the current embed options.

Deploy the complete source folder as one Node.js service with HTTPS. The included Render configuration uses the free plan, builds with `node build.mjs .`, starts with `node server.cjs`, and checks `/api/health`. Keep the template, styles, app, engine, and build script together. Itch.io hosts the HTML client; it does not run the room server.

To include the hosted server address in the itch.io build, pass it as the optional final argument:

```sh
node build.mjs ./dist https://your-room-server.example
```

You can also set the `DOTLANDS_SERVER` environment variable. Replace the example address with the verified deployment URL. Players can enter a different server in Online setup. Invitation links carry the room code and server address, never the player's private seat token.

## Persistence and limits

One local match is saved in browser storage when available. Starting a new local match replaces it.

**Saved rooms:** use the same Keeper address and unlock the same vault to return. Rooms survive browser closure and Keeper restarts. Keeper must be running when someone plays. Keep a backup of Keeper's data and your encrypted vault; the public itch.io game does not store either. Saved rooms use five-second revision checks while active and pause checks when hidden or offline. Existing temporary rooms are not converted into saved rooms.

**Quick rooms:** seat credentials are saved separately in browser storage. The host must keep its game open. Closing or reloading the host ends the match; guests can return to the same seat while the host remains open. Connection mailboxes expire after 24 idle hours or a server restart. There is no host migration. Run one connection server instance.

A free Render server sleeps after inactivity and may take about a minute to wake. Wait, then retry if your first connection times out. A restart, redeploy, or shutdown clears the room directory; create a new room if reconnection fails. See [Render's free-service limits](https://render.com/docs/free).

Country names, symbols, and colors identify players. New games generate a connected continent with a random coastline and 33–39 land hexes. Countries normally begin with three connected hexes and 13 dots; the solo head start adds three or six dots to the human country. A stored seed reproduces the same map; existing local saves retain their original map. The engine also supports a larger 48–54-hex variant.

Live connection service and standalone game: https://dotlands-rooms.onrender.com

Quick rooms need no account. Saved rooms require each player to unlock their own Keeper vault and have one available private garden Doodle Coin when first joining. The public game launcher does not access the Keeper vault or file library. See `DOODLETICK.md`.
