'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createServer } = require('./server.cjs');
const peerId = n => n.toString(16).padStart(32, '0');

async function fixture(t, overrides = {}) {
  let clock = Date.now();
  const server = createServer({ now: () => clock, doodletick: { requestLimit: 20000, ...overrides } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function api(route, body, token, status = 200) {
    const res = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json(); assert.equal(res.status, status, JSON.stringify(data)); return data;
  }
  async function room() {
    const host = await api('/doodletick/rooms', { peerId: peerId(1), game: 'dotlands-v1', maxPeers: 4 }, null, 201);
    const path = '/doodletick/rooms/' + host.room;
    const guest = await api(path + '/join', { peerId: peerId(2) }, null, 201);
    return { host, guest, path };
  }
  return { api, room, advance: ms => { clock += ms; } };
}

test('Doodletick routes messages in order with private peer credentials and idempotent retries', async t => {
  const { api, room } = await fixture(t); const { host, guest, path } = await room();
  assert.equal((await api('/api/health')).doodletick, 1);
  assert.deepEqual(await api('/doodletick/health'), { ok: true, service: 'Doodletick', protocol: 1 });
  assert.match(host.room, /^[A-Z2-9]{6}$/); assert.match(host.token, /^[a-f0-9]{48}$/);
  assert.equal(guest.hostId, host.peerId); assert.notEqual(host.token, guest.token);
  const first = { id: 'first', to: guest.peerId, kind: 'signal', payload: { type: 'offer', sdp: 'example' }, from: 'spoofed' };
  const accepted = await api(path + '/send', first, host.token);
  const replay = await api(path + '/send', first, host.token);
  assert.equal(replay.seq, accepted.seq); assert.equal(replay.duplicate, true);
  await api(path + '/send', { ...first, payload: 'different' }, host.token, 409);
  await api(path + '/send', { id: 'second', to: guest.peerId, kind: 'data', payload: { action: 'move' } }, host.token);
  const events = await api(path + '/events?after=0', undefined, guest.token);
  assert.deepEqual(events.events.map(e => e.kind), ['signal', 'data']);
  assert.ok(events.events[0].seq < events.events[1].seq);
  assert.equal(events.events[0].from, host.peerId, 'authenticated sender overrides caller supplied from');
  assert.equal(JSON.stringify(events).includes(host.token), false); assert.equal(JSON.stringify(events).includes(guest.token), false);
  assert.deepEqual((await api(path + '/events?after=' + events.cursor, undefined, guest.token)).events, []);
  assert.deepEqual((await api(path + '/events?after=0', undefined, host.token)).events, []);
});

test('Doodletick rejects spoofed identities, cross-room tokens, malformed messages, and full rooms', async t => {
  const { api, room } = await fixture(t); const { host, guest, path } = await room();
  await api(path + '/join', { peerId: peerId(6), game: 'different-game' }, null, 409);
  await api(path + '/events', undefined, undefined, 401);
  await api(path + '/events', undefined, 'a'.repeat(48), 401);
  const other = await api('/doodletick/rooms', { peerId: peerId(8), game: 'other-game' }, null, 201);
  await api(path + '/events', undefined, other.token, 401);
  await api(path + '/join', { peerId: host.peerId }, null, 401);
  await api(path + '/join', { peerId: guest.peerId, token: host.token }, null, 401);
  await api(path + '/join', { peerId: peerId(7), token: host.token }, null, 401);
  await api(path + '/send', { id: 'bad', to: other.peerId, kind: 'data', payload: {} }, host.token, 400);
  await api(path + '/send', { id: 'bad', to: guest.peerId, kind: 'arbitrary', payload: {} }, host.token, 400);
  await api(path + '/send', { id: 'bad', to: guest.peerId, kind: 'data' }, host.token, 400);
  await api(path + '/events?after=-1', undefined, host.token, 400);
  await api(path + '/events?after=99', undefined, host.token, 400);
  await api(path + '/join', { peerId: peerId(3) }, null, 201);
  await api(path + '/join', { peerId: peerId(4) }, null, 201);
  await api(path + '/join', { peerId: peerId(5) }, null, 409);
  const again = await api(path + '/join', { peerId: guest.peerId, token: guest.token });
  assert.equal(again.token, guest.token, 'existing guest resumes even when all seats are occupied');
});

test('Doodletick heartbeat and guest resume preserve identity while host leave closes the room', async t => {
  const { api, room, advance } = await fixture(t); const { host, guest, path } = await room();
  advance(31000);
  const roster = await api(path + '/events?after=0', undefined, host.token);
  assert.equal(roster.peers.find(p => p.peerId === guest.peerId).connected, false);
  assert.equal(roster.peers.find(p => p.peerId === host.peerId).connected, true);
  await api(path + '/join', { peerId: guest.peerId, token: guest.token });
  assert.equal((await api(path + '/events', undefined, host.token)).peers.every(p => p.connected), true);
  await api(path + '/leave', {}, guest.token);
  await api(path + '/events', undefined, guest.token, 401);
  await api(path + '/join', { peerId: guest.peerId, token: guest.token });
  await api(path + '/events', undefined, guest.token);
  await api(path + '/leave', {}, host.token);
  await api(path + '/events', undefined, guest.token, 410);
  await api(path + '/join', { peerId: guest.peerId, token: guest.token }, null, 410);
});

test('Doodletick bounds replay queues and lets reconnect skip a lost backlog', async t => {
  const { api, room } = await fixture(t); const { host, guest, path } = await room();
  for (let i = 0; i < 257; i++) await api(path + '/send', { id: 'frame-' + i, to: guest.peerId, kind: 'data', payload: i }, host.token);
  await api(path + '/events?after=0', undefined, guest.token, 410);
  const retained = await api(path + '/events?after=1', undefined, guest.token);
  assert.equal(retained.events.length, 256);
  const resumed = await api(path + '/join', { peerId: guest.peerId, token: guest.token });
  assert.equal(resumed.cursor, 257);
  assert.deepEqual((await api(path + '/events?after=' + resumed.cursor, undefined, guest.token)).events, []);
  await api(path + '/send', { id: 'oversized', to: guest.peerId, kind: 'data', payload: 'a'.repeat(65536) }, host.token, 413);
});

test('Doodletick replay expires, service capacity is bounded, and inactive rooms expire', async t => {
  const { api, room, advance } = await fixture(t, { maxRooms: 1 }); const { host, guest, path } = await room();
  await api('/doodletick/rooms', { peerId: peerId(9), game: 'dotlands-v1' }, null, 503);
  await api(path + '/send', { id: 'old', to: guest.peerId, kind: 'data', payload: 1 }, host.token);
  advance(300001);
  await api(path + '/events', undefined, guest.token, 410);
  advance(86400001);
  await api(path + '/events', undefined, guest.token, 404);
  await api('/doodletick/rooms', { peerId: peerId(9), game: 'dotlands-v1' }, null, 201);
});

test('Doodletick authenticated peers have independent traffic budgets', async t => {
  const { api, room } = await fixture(t, { requestLimit: 2 }); const { host, guest, path } = await room();
  await api(path + '/events', undefined, host.token);
  await api(path + '/events', undefined, host.token);
  await api(path + '/events', undefined, host.token, 429);
  await api(path + '/events', undefined, guest.token);
});
