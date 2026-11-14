# Doodletick game rooms

A reusable connection layer for small browser games. Dotlands is its first integrated game.

The host browser owns the match. Guests send actions; the host checks the seat, turn, revision, and rules before broadcasting a new snapshot. Ordered WebRTC data channels carry game messages directly. If direct connectivity is unavailable or interrupted, the same messages use a bounded HTTPS mailbox. The page displays Direct peer connection or Connection assist to identify the active path.

The host must keep the game open and awake. Closing or reloading it ends the match. Guests can reconnect to their saved seat while the host stays open. Host migration and permanent online saves are not implemented. This is friendly private play, not cheat-proof competitive play: the host controls its browser.

## Reusable pieces

- `doodletick-rooms.js`: browser transport. `create` / `join` accept `{url, game, room, onMessage, onPeer, onStatus}`. `game` defaults to `dotlands-v1`; give another game its own protocol namespace. The returned handle exposes `send(peerId, payload)`, `broadcast(payload)`, `close()`, and private serializable `credentials` for guest reconnection.
- `doodletick-server.cjs`: bounded signaling and fallback mailboxes, reusable with another game's adapter.
- `dotlands-room.js`: Dotlands-specific authority, bots, authenticated seats, request deduplication, and snapshot checks.
- `server.cjs`: HTTPS-host-compatible Node server and game page host. No runtime packages are required.

Doodletick Keeper's identity vault and licensed file transfers are separate and unchanged. The game connection layer never reads those files or asks players for a Keeper password.

## Service routes

`POST /doodletick/rooms` creates a namespace-specific room; `POST /doodletick/rooms/CODE/join` joins or resumes a transport identity. They return a private transport token. Authenticated `GET .../events?after=N` reads the mailbox and refreshes presence. `POST .../send` delivers an authenticated sender's signal or game packet to a known peer. `POST .../leave` marks the connection offline; the host closes the room. `GET /doodletick/health` reports the service protocol.

Messages and replay buffers are bounded. Tokens never appear in invitations. Game seat credentials and transport credentials are distinct. The connection service authenticates sender identity; the host adapter still validates every game request. Browser HTTPS is required for public play.

## Network and privacy

### Traffic and idle behavior (1.4.0)

The transport checks its mailbox every 5 seconds during activity, every 15 seconds after 30 quiet seconds, and every 30 seconds while the page is hidden. Browser-reported offline status pauses checks. Returning to the page or regaining connectivity checks immediately and asks the host for a conditional refresh. Browsers may suspend background tabs longer; the host must remain open and able to run. Presence allows 120 seconds between heartbeats.

Direct moves send immediately through the existing WebRTC channel. The channel stays open while idle, so browsers may still exchange their own connection keepalives. Assisted moves are queued immediately and collected at the recipient's next check: normally up to 5 seconds while active, or longer while idle/backgrounded. A full assisted request/response takes two checks. Game requests allow 75 seconds for that round trip.

Dotlands pushes changed boards rather than downloading an unchanged board on a timer. A guest action receives one result; other guests each receive one push. Equal revisions do not redraw the game. Concurrent refreshes share one request, and an unchanged refresh returns only the room, seat, and revision. Every mutation still checks authentication, turn, and expected revision.

Acknowledgements are cumulative and coalesced per received batch. Direct messages without an acknowledgement can retry through the mailbox after 12 seconds; accepted mailbox messages wait at least 65 seconds before retrying, then back off. Retry payloads retain the same stream and sequence so duplicates cannot apply twice. Mailbox outages back off to 30-second checks, and an established healthy direct path continues playing. Only one mailbox read runs at a time; closing removes timers and event listeners.

`netcode.test.cjs` exercises scheduling under virtual time. Comparing the production 1.3.0 and 1.4.0 transports after warmup gives 50 versus 4 mailbox reads per quiet minute (92% fewer), or 2 per hidden minute. This excludes browser keepalives, connection setup, and the removed application snapshot loop; it is not a measured total-bandwidth or battery claim.

WebRTC uses browser encryption and public STUN at `stun:stun.cloudflare.com:3478` to discover a usable connection. Peers can learn each other's network addresses as part of direct connection setup. The connection server sees setup metadata, room membership, and game messages when assisted transport is used. The HTTPS fallback is not described as end-to-end encrypted. No camera or microphone permissions are requested.

The service runs on one free Render instance at https://dotlands-rooms.onrender.com . It can sleep after inactivity and take about a minute to wake. Mailboxes are temporary and expire after 24 idle hours or a server restart. Game state stays in the host browser. Paid hosting or accounts are not required for players.

## Validation

Run `npm test` for engine, client lifecycle, host adapter, transport, and HTTP mailbox checks. Also test a real two-browser room, a move and turn handoff, guest reconnection, and the visible direct/assisted connection status. Device-size browser checks are not a substitute for testing actual phones on different networks.
