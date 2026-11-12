const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('./engine.js');
const R = require('./dotlands-room.js');
const copy = v => JSON.parse(JSON.stringify(v));
const tick = () => new Promise(resolve => setImmediate(resolve));
function room() { return new R.HostRoom({ engine: E, code: 'ABC234', peerId: 'host', name: 'Host', seed: 'room-check' }); }
function setup() {
  const r = room(), h = r.members[0];
  const g = r.invoke('guest', 'join', { name: 'Guest' });
  r.invoke('host', 'start', { expectedRevision: r.revision, fillBots: false }, h.token);
  return { r, h, g };
}
function legal(state) {
  for (const from of state.tiles) for (const to of E.neighbors(state, from.id)) {
    const n = E.maxSend(state, from.id, to.id);
    if (n > 1 && E.previewMove(state, from.id, to.id, n).ok) return { from: from.id, to: to.id, amount: n };
  }
  throw new Error('No test move');
}
test('Only the host starts; seat input cannot override authenticated connection identity', () => {
  const r = room(); const guest = r.invoke('guest', 'join', { name: 'Guest' });
  assert.throws(() => r.invoke('guest', 'start', { seat: 0, expectedRevision: r.revision, fillBots: true }, guest.token), { status: 403 });
  assert.throws(() => r.invoke('guest', 'snapshot', {}, r.members[0].token), { status: 401 });
  assert.equal(r.state, null);
});
test('Maximum army is host-derived and illegal/stale actions leave the board unchanged', () => {
  const { r, h, g } = setup(); const before = copy(r.state), action = legal(before);
  assert.throws(() => r.invoke('guest', 'action', { type: 'move', ...action, expectedRevision: r.revision, seat: 0 }, g.token), { status: 403 });
  assert.throws(() => r.invoke('host', 'action', { type: 'move', from: '999,999', to: '0,0', expectedRevision: r.revision }, h.token), { status: 400 });
  assert.deepEqual(r.state, before);
  const expected = copy(before); E.applyMove(expected, action.from, action.to, action.amount);
  const revision = r.revision;
  r.invoke('host', 'action', { type: 'move', ...action, amount: 1, expectedRevision: revision }, h.token);
  assert.deepEqual(r.state, expected);
  assert.throws(() => r.invoke('host', 'action', { type: 'endTurn', expectedRevision: revision }, h.token), { status: 409 });
  assert.deepEqual(r.state, expected);
});
test('Reconnecting retains the private seat and revokes its previous connection', () => {
  const { r, g } = setup();
  const resumed = r.invoke('new-guest-connection', 'join', {}, g.token);
  assert.equal(resumed.seat, 1); assert.equal(resumed.token, g.token); assert.equal(r.members.length, 2);
  assert.throws(() => r.invoke('guest', 'snapshot', {}, g.token), { status: 401 });
  assert.throws(() => r.invoke('stranger', 'join', { name: 'Intruder' }), { status: 409 });
  assert.throws(() => r.invoke('stranger', 'join', {}, '0'.repeat(48)), { status: 401 });
  assert.throws(() => r.invoke('host', 'join', {}, g.token), { status: 403 });
});
test('Room capacity and duplicate peer joins are enforced before assigning seats', () => {
  const r = room(); r.invoke('a', 'join', { name: 'A' });
  assert.throws(() => r.invoke('a', 'join', { name: 'A again' }), { status: 401 });
  r.invoke('b', 'join', { name: 'B' }); r.invoke('c', 'join', { name: 'C' });
  assert.throws(() => r.invoke('d', 'join', { name: 'D' }), { status: 409 });
  assert.equal(r.members.length, 4);
});
test('Only private welcome includes a token; normal snapshots contain no credentials', () => {
  const r = room(); const welcome = r.invoke('guest', 'join', { name: 'Guest' });
  assert.match(welcome.token, /^[a-f0-9]{48}$/);
  const snapshot = r.invoke('guest', 'snapshot', {}, welcome.token);
  assert.equal(snapshot.token, undefined);
  assert.ok(snapshot.players.every(p => !('token' in p) && !('peerId' in p)));
  snapshot.players[0].name = 'Changed'; assert.equal(r.members[0].name, 'Host');
});
test('Snapshot validation rejects seat changes, credentials, invalid countries and invalid state', () => {
  const { r, g } = setup(); const good = r.snapshot(r.members[1]);
  assert.equal(R.validateSnapshot(good, E, { code: r.code, seat: g.seat }), good);
  for (const mutate of [
    s => { s.seat = 0; }, s => { s.players[0].token = 'secret'; },
    s => { s.players[1].seat = 0; }, s => { s.state.players[1].name = 'Other'; },
    s => { s.state.tiles[0].units = 10; }, s => { s.revision = 0; },
    s => { s.code = 'OTHER'; }, s => { s.state.version = 1; },
  ]) { const bad = copy(good); mutate(bad); assert.throws(() => R.validateSnapshot(bad, E, { code: r.code, seat: g.seat })); }
});
test('Host executes computer turns and leaves a valid human turn', () => {
  const r = room(), h = r.members[0];
  r.invoke('host', 'start', { expectedRevision: r.revision, fillBots: true }, h.token);
  assert.equal(r.state.players.filter(p => p.controller === 'ai').length, 3);
  r.invoke('host', 'action', { type: 'endTurn', expectedRevision: r.revision }, h.token);
  assert.equal(E.validateState(r.state).ok, true);
  if (r.state.winner === null) assert.equal(r.state.currentPlayer, 0);
});
test('Remaining computers continue in bounded batches after every human is eliminated', () => {
  const r = room(), h = r.members[0];
  r.invoke('host', 'start', { expectedRevision: r.revision, fillBots: true }, h.token);
  for (const tile of r.state.tiles) if (tile.owner === 0) { tile.owner = 1; tile.ready = 0; }
  r.state.currentPlayer = 1;
  for (const tile of r.state.tiles) tile.ready = tile.owner === 1 ? tile.units - 1 : 0;
  assert.equal(E.validateState(r.state).ok, true);
  for (let batch = 0; batch < 300 && r.state.winner === null; batch++) assert.equal(r.advanceBots(), true);
  assert.notEqual(r.state.winner, null); assert.equal(E.validateState(r.state).ok, true);
});

function fakeNetwork() {
  const peers = new Map(), packets = []; let count = 0;
  function make(opts, role) {
    const id = opts.peerId || (role === 'host' ? 'host' : 'guest-' + ++count);
    const handle = { room: opts.room || 'ABC234', peerId: id, hostId: 'host', credentials: { url: opts.url, room: opts.room || 'ABC234', peerId: id, token: 'transport-secret', hostId: 'host' },
      async send(to, packet) { packets.push({ from: id, to, packet: copy(packet) }); queueMicrotask(() => peers.get(to)?.opts.onMessage(id, copy(packet))); },
      close() { peers.delete(id); for (const p of peers.values()) p.opts.onPeer({ peerId: id, connected: false }); } };
    peers.set(id, { opts, handle });
    for (const [other, p] of peers) if (other !== id) { queueMicrotask(() => p.opts.onPeer({ peerId: id, connected: true })); queueMicrotask(() => opts.onPeer({ peerId: other, connected: true })); }
    return Promise.resolve(handle);
  }
  return { peers, packets, create: opts => make(opts, 'host'), join: opts => make(opts, 'guest'), inject(from, to, packet) { peers.get(to).opts.onMessage(from, copy(packet)); } };
}
async function sessions(t) {
  const transportAPI = fakeNetwork();
  const common = { engine: E, transportAPI, url: 'https://rooms.example', requestTimeout: 200 };
  const host = await R.create({ ...common, name: 'Host', seed: 'sessions' });
  const guest = await R.join({ ...common, name: 'Guest', room: host.credentials.room });
  t.after(() => { guest.close(); host.close(); });
  await tick(); return { host, guest, transportAPI, common };
}
test('Transport adapter joins, starts, synchronizes actions, and resumes the same guest seat', async t => {
  const { host, guest, common } = await sessions(t);
  assert.equal(guest.initial.seat, 1); assert.equal(guest.initial.token, undefined);
  const saved = guest.credentials; assert.equal(saved.transport.token, 'transport-secret'); assert.notEqual(saved.token, saved.transport.token);
  let board = await host.start({ expectedRevision: (await host.snapshot()).revision, fillBots: false });
  const action = legal(board.state);
  board = await host.action({ type: 'move', ...action, amount: 1, expectedRevision: board.revision });
  await tick(); assert.deepEqual((await guest.snapshot()).state, board.state);
  board = await host.action({ type: 'endTurn', expectedRevision: board.revision });
  await tick(); assert.equal((await guest.snapshot()).state.currentPlayer, 1);
  guest.close();
  const resumed = await R.reconnect({ ...saved, ...common }); t.after(() => resumed.close());
  assert.equal(resumed.credentials.seat, 1); assert.equal(resumed.credentials.token, saved.token);
  assert.deepEqual(resumed.initial.state, board.state);
});
test('Duplicate request IDs do not apply a guest turn twice', async t => {
  const { host, guest, transportAPI } = await sessions(t);
  let board = await host.start({ expectedRevision: (await host.snapshot()).revision, fillBots: false });
  board = await host.action({ type: 'endTurn', expectedRevision: board.revision });
  await tick();
  await guest.action({ type: 'endTurn', expectedRevision: (await guest.snapshot()).revision });
  await tick(); const before = await host.snapshot();
  const request = transportAPI.packets.findLast(p => p.from === guest.credentials.peerId && p.packet.operation === 'action');
  transportAPI.inject(request.from, request.to, request.packet); await tick();
  assert.deepEqual(await host.snapshot(), before);
});
test('Forged peer snapshots and malformed host snapshots cannot replace the current board', async t => {
  const { host, guest, transportAPI } = await sessions(t);
  const board = await host.start({ expectedRevision: (await host.snapshot()).revision, fillBots: false }); await tick();
  const before = await guest.snapshot(), bad = copy(before); bad.revision++; bad.state.tiles[0].units = 10;
  transportAPI.inject('intruder', guest.credentials.peerId, { protocol: R.PROTOCOL, kind: 'snapshot', data: bad });
  transportAPI.inject('host', guest.credentials.peerId, { protocol: R.PROTOCOL, kind: 'snapshot', data: bad });
  assert.deepEqual((await guest.snapshot()).state, board.state);
});
test('A closed adapter rejects pending requests and never silently resumes a host', async t => {
  const { host, guest, common, transportAPI } = await sessions(t);
  const savedHost = host.credentials;
  await assert.rejects(R.reconnect({ ...savedHost, ...common }), /host closed this table/i);
  const original = transportAPI.peers.get('host').opts.onMessage;
  transportAPI.peers.get('host').opts.onMessage = () => {};
  const pending = guest.snapshot(); guest.close(); await assert.rejects(pending, /closed/);
  transportAPI.peers.get('host').opts.onMessage = original;
  await assert.rejects(guest.snapshot(), /closed/);
});
