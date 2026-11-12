'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createServer } = require('./server.cjs');
const engine = require('./engine.js');

test('private-room HTTP workflow and authority checks', async t => {
  let clock = Date.now();
  const server = createServer({ now: () => clock, requestLimit: 2000 });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  async function api(route, body, token, expectedStatus = 200, extraHeaders = {}) {
    const response = await fetch(base + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json();
    assert.equal(response.status, expectedStatus, JSON.stringify(data));
    return data;
  }
  try {
    await t.test('health and validation', async () => {
      assert.equal((await api('/api/health')).ok, true);
      await api('/api/rooms', { name: '', maxPlayers: 2 }, null, 400);
      await api('/api/rooms', { name: 'A', maxPlayers: 8 }, null, 400);
      await api('/api/rooms/ABCDEF', undefined, null, 404);
    });
    const host = await api('/api/rooms', { name: 'Host', maxPlayers: 2, seed: 'http-tests' }, null, 201);
    const roomRoute = '/api/rooms/' + host.code;
    let guest;
    await t.test('room secrets and joining', async () => {
      assert.match(host.code, /^[A-Z2-9]{6}$/);
      assert.match(host.token, /^[a-f0-9]{48}$/);
      assert.equal(host.seat, 0);
      await api(roomRoute, undefined, null, 401);
      await api(roomRoute, undefined, 'a'.repeat(48), 401);
      const view = await api(roomRoute, undefined, host.token);
      assert.equal('token' in view, false);
      assert.equal('token' in view.players[0], false);
      guest = await api(roomRoute.toLowerCase() + '/join', { name: 'Guest' }, null, 201);
      assert.equal(guest.seat, 1);
      assert.notEqual(guest.token, host.token);
      await api(roomRoute + '/join', { name: 'Third' }, null, 409);
    });
    let started;
    await t.test('host authority and revision checks', async () => {
      await api(roomRoute + '/start', { expectedRevision: guest.revision }, guest.token, 403);
      await api(roomRoute + '/start', { expectedRevision: host.revision }, host.token, 409);
      started = await api(roomRoute + '/start', { expectedRevision: guest.revision, fillBots: false }, host.token);
      assert.equal(started.phase, 'playing');
      assert.equal(started.state.players.length, 2);
      assert.equal(started.state.currentPlayer, 0);
      assert.equal(engine.validateState(started.state).ok, true);
      await api(roomRoute + '/join', { name: 'Late' }, null, 409);
      await api(roomRoute + '/start', { expectedRevision: started.revision }, host.token, 409);
    });
    await t.test('only current player can submit legal, current actions', async () => {
      const revision = started.revision;
      await api(roomRoute + '/action', { expectedRevision: revision, type: 'endTurn' }, guest.token, 403);
      await api(roomRoute + '/action', { expectedRevision: revision - 1, type: 'endTurn' }, host.token, 409);
      await api(roomRoute + '/action', { expectedRevision: revision, type: 'move', from: 'bad', to: 'bad', amount: 1 }, host.token, 400);
      const owned = started.state.tiles.find(tile => tile.owner === 0);
      await api(roomRoute + '/action', { expectedRevision: revision, type: 'move', from: owned.id, to: owned.id }, host.token, 400);
      const before = await api(roomRoute, undefined, host.token);
      assert.equal(before.revision, revision, 'rejected moves must not advance revisions');
      assert.deepEqual(before.state, started.state, 'rejected moves must not change state');
      const choice = engine.chooseAIMove(before.state);
      assert.ok(choice, 'opening has a legal move');
      const expected = structuredClone(before.state);
      const sent = engine.maxSend(expected, choice.from, choice.to);
      assert.ok(sent > 0);
      assert.equal(engine.applyMove(expected, choice.from, choice.to, sent).ok, true);
      const after = await api(roomRoute + '/action', { expectedRevision: revision, type: 'move', from: choice.from, to: choice.to, amount: -999 }, host.token);
      assert.equal(after.revision, revision + 1);
      assert.deepEqual(after.state, expected, 'server computes the maximum army independently of client amount');
      assert.equal(engine.validateState(after.state).ok, true);
      await api(roomRoute + '/action', { expectedRevision: revision, type: 'move', ...choice }, host.token, 409);
      const next = await api(roomRoute + '/action', { expectedRevision: after.revision, type: 'endTurn' }, host.token);
      assert.equal(next.state.currentPlayer, 1);
      const reconnect = await api(roomRoute, undefined, guest.token);
      assert.equal(reconnect.seat, 1);
      assert.deepEqual(reconnect.state, next.state);
    });
    await t.test('empty seats become authoritative computer opponents', async () => {
      const solo = await api('/api/rooms', { name: 'Solo', maxPlayers: 4 }, null, 201);
      const route = '/api/rooms/' + solo.code;
      await api(route + '/start', { expectedRevision: solo.revision, fillBots: false }, solo.token, 409);
      const begun = await api(route + '/start', { expectedRevision: solo.revision, fillBots: true }, solo.token);
      assert.equal(begun.state.players.filter(p => p.controller === 'ai').length, 3);
      const next = await api(route + '/action', { expectedRevision: begun.revision, type: 'endTurn' }, solo.token);
      assert.ok(next.state.currentPlayer === 0 || next.state.winner != null);
      assert.equal(engine.validateState(next.state).ok, true);
    });
    await t.test('two separate seats share legal moves, turns, and two computer opponents', async () => {
      const first = await api('/api/rooms', { name: 'Ada', maxPlayers: 4, seed: 'mixed-integration' }, null, 201);
      const route = '/api/rooms/' + first.code;
      const second = await api(route + '/join', { name: 'Ben' }, null, 201);
      let view = await api(route + '/start', { expectedRevision: second.revision, fillBots: true }, first.token);
      assert.equal(view.players.length, 2);
      assert.equal(view.state.players.length, 4);
      assert.deepEqual(view.state.players.map(p => p.color), ['#78aa8b', '#dc917d', '#d5b45d', '#afa1c7']);
      assert.deepEqual(view.state.players.slice(2).map(p => p.name), ['Honey Bot', 'Iris Bot']);
      for (const [seat, token] of [[0, first.token], [1, second.token]]) {
        view = await api(route, undefined, token);
        assert.equal(view.seat, seat);
        assert.equal(view.state.currentPlayer, seat);
        const move = engine.chooseAIMove(view.state);
        assert.ok(move, 'human country has a legal opening move');
        const sourceBefore = engine.getTile(view.state, move.from).units;
        const sent = engine.maxSend(view.state, move.from, move.to);
        view = await api(route + '/action', { expectedRevision: view.revision, type: 'move', from: move.from, to: move.to }, token);
        assert.equal(engine.getTile(view.state, move.from).units, sourceBefore - sent, 'omitted amount sends the maximum legal army');
        assert.equal(engine.validateState(view.state).ok, true);
        view = await api(route + '/action', { expectedRevision: view.revision, type: 'endTurn' }, token);
      }
      assert.equal(view.state.currentPlayer, 0, 'computer seats finish and return control to the first human');
      assert.ok(view.state.turn >= 5, 'both computer countries took turns');
      const hostView = await api(route, undefined, first.token);
      const guestView = await api(route, undefined, second.token);
      assert.deepEqual(hostView.state, guestView.state, 'both phones see exactly the same authoritative board');
      assert.equal(hostView.revision, guestView.revision);
      assert.equal(engine.validateState(hostView.state).ok, true);
    });
    await t.test('idle rooms expire cleanly', async () => {
      clock += 24 * 60 * 60 * 1000 + 1;
      await api(roomRoute, undefined, host.token, 404);
    });
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('authenticated seats keep separate rate budgets behind one hosting proxy', async () => {
  const server = createServer({ requestLimit: 4 });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (route, token, body) => fetch(base + route, {
    method: body ? 'POST' : 'GET',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  try {
    const host = await (await request('/api/rooms', null, { name: 'Host' })).json();
    const route = '/api/rooms/' + host.code;
    const guest = await (await request(route + '/join', null, { name: 'Guest' })).json();
    for (let i = 0; i < 4; i++) {
      assert.equal((await request(route, host.token)).status, 200);
      assert.equal((await request(route, guest.token)).status, 200);
    }
    assert.equal((await request(route, host.token)).status, 429);
    assert.equal((await request('/api/health')).status, 200, 'player request limits do not fail hosting health checks');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('configured browser origins and request body limits', async () => {
  const server = createServer({ allowedOrigins: ['https://game.example'] });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const denied = await fetch(base + '/api/health', { headers: { Origin: 'https://other.example' } });
    assert.equal(denied.status, 403);
    const allowed = await fetch(base + '/api/health', { headers: { Origin: 'https://game.example' } });
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://game.example');
    const preflight = await fetch(base + '/api/rooms', { method: 'OPTIONS', headers: { Origin: 'https://game.example' } });
    assert.equal(preflight.status, 204);
    const large = await fetch(base + '/api/rooms', { method: 'POST', body: JSON.stringify({ name: 'x'.repeat(9000) }) });
    assert.equal(large.status, 413);
    const invalid = await fetch(base + '/api/rooms', { method: 'POST', body: '{oops' });
    assert.equal(invalid.status, 400);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
