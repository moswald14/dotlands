/* Dotlands game adapter for Doodle Tick rooms. The host browser owns the rules. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DotlandsRoom = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const PROTOCOL = 'dotlands-room-v1';
  const COLORS = ['#78aa8b', '#dc917d', '#d5b45d', '#afa1c7'];
  const NAMES = ['Moss', 'Ember', 'Honey', 'Iris'];
  const MAX_PACKET = 64000;
  const clone = value => JSON.parse(JSON.stringify(value));
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  function fail(status, message) { const e = new Error(message); e.status = status; throw e; }
  function networkError(error) { if (Number.isInteger(error?.code) && !error.status) error.status = error.code; return error; }
  function randomToken(bytes = 24) {
    if (!globalThis.crypto?.getRandomValues) fail(503, 'This browser needs a secure connection for online play.');
    return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), n => n.toString(16).padStart(2, '0')).join('');
  }
  function nameOf(value) {
    if (typeof value !== 'string') fail(400, 'Enter your player name.');
    const name = value.trim().replace(/\s+/g, ' ');
    if (!name || name.length > 22 || /[\u0000-\u001f\u007f]/.test(name)) fail(400, 'Use a name between 1 and 22 characters.');
    return name;
  }
  function boundedPacket(value) {
    try { return object(value) && JSON.stringify(value).length <= MAX_PACKET; } catch { return false; }
  }
  function validateSnapshot(data, engine, expected = {}) {
    if (!boundedPacket(data) || typeof data.code !== 'string' || !data.code || data.code.length > 200 ||
        !Number.isSafeInteger(data.revision) || data.revision < 1 || data.hostSeat !== 0 ||
        !Number.isInteger(data.maxPlayers) || data.maxPlayers < 2 || data.maxPlayers > 4 ||
        !Array.isArray(data.players) || data.players.length < 1 || data.players.length > data.maxPlayers ||
        !Number.isInteger(data.seat) || !['lobby', 'playing'].includes(data.phase)) fail(400, 'The host sent an invalid room.');
    if (expected.code && data.code !== expected.code) fail(400, 'That update belongs to another room.');
    if (expected.seat !== undefined && data.seat !== expected.seat) fail(400, 'The host changed your seat unexpectedly.');
    const seats = new Set();
    for (const p of data.players) {
      if (!object(p) || !Number.isInteger(p.seat) || p.seat < 0 || p.seat >= data.maxPlayers || seats.has(p.seat) ||
          typeof p.name !== 'string' || nameOf(p.name) !== p.name || (p.connected !== undefined && typeof p.connected !== 'boolean') ||
          p.token !== undefined || p.peerId !== undefined) fail(400, 'The host sent invalid player details.');
      seats.add(p.seat);
    }
    if (!seats.has(0) || !seats.has(data.seat) || data.players.some((p, i) => p.seat !== i)) fail(400, 'The host sent invalid seats.');
    if (data.phase === 'lobby') {
      if (data.state !== null) fail(400, 'The waiting room contains an unexpected game.');
    } else {
      if (!object(data.state) || data.state.version !== engine.VERSION || !engine.validateState(data.state).ok ||
          data.state.players.length < data.players.length || data.state.players.length > data.maxPlayers) fail(400, 'The host sent an invalid game.');
      data.state.players.forEach((p, i) => {
        const member = data.players[i];
        if (p.color !== COLORS[i] || (member ? p.name !== member.name || p.controller !== 'human' : p.controller !== 'ai')) fail(400, 'The game countries do not match the room.');
      });
    }
    return data;
  }

  class HostRoom {
    constructor({ engine, code, peerId, name, maxPlayers = 4, radius = 3, seed }) {
      if (!engine || typeof code !== 'string' || !code || code.length > 200 || typeof peerId !== 'string' || !peerId) fail(400, 'Invalid room settings.');
      if (!Number.isInteger(maxPlayers) || maxPlayers < 2 || maxPlayers > 4 || ![3, 4].includes(radius)) fail(400, 'A room needs two to four seats.');
      if (seed !== undefined && (typeof seed !== 'string' || seed.length > 64)) fail(400, 'Invalid continent seed.');
      this.engine = engine; this.code = code; this.maxPlayers = maxPlayers; this.radius = radius;
      this.seed = seed || randomToken(8); this.revision = 1; this.state = null;
      this.members = [{ name: nameOf(name), peerId, seat: 0, token: randomToken(), connected: true }];
    }
    snapshot(member, includeToken = false) {
      const data = { code: this.code, phase: this.state ? 'playing' : 'lobby', revision: this.revision,
        players: this.members.map(({ name, seat, connected }) => ({ name, seat, connected })),
        hostSeat: 0, maxPlayers: this.maxPlayers, state: this.state, seat: member.seat };
      if (includeToken) data.token = member.token;
      return clone(data);
    }
    authenticate(peerId, token) {
      const member = this.members.find(m => m.peerId === peerId && m.token === token);
      if (!member) fail(401, 'Your room key is missing or no longer valid.');
      return member;
    }
    checkRevision(body) {
      if (!Number.isSafeInteger(body.expectedRevision)) fail(400, 'Refresh the room before playing.');
      if (body.expectedRevision !== this.revision) fail(409, 'The table changed. Your map has been refreshed.');
    }
    bots(state) {
      for (let turn = 0; turn < 4 && state.winner === null; turn++) {
        if (state.players[state.currentPlayer].controller !== 'ai') break;
        for (let move = 0; move < 64 && state.winner === null; move++) {
          const choice = this.engine.chooseAIMove(state);
          if (!choice) break;
          const result = this.engine.applyMove(state, choice.from, choice.to, this.engine.maxSend(state, choice.from, choice.to));
          if (!result?.ok) break;
        }
        if (state.winner === null) this.engine.endTurn(state);
      }
    }
    commit(state) {
      if (!this.engine.validateState(state).ok) fail(500, 'The move did not produce a valid game.');
      this.state = state; this.revision++;
    }
    advanceBots() {
      if (!this.state || this.state.winner !== null || this.state.players[this.state.currentPlayer].controller !== 'ai') return false;
      const state = clone(this.state); this.bots(state); this.commit(state); return true;
    }
    connected(peerId, connected) {
      const member = this.members.find(m => m.peerId === peerId);
      if (member && member.connected !== connected) { member.connected = connected; this.revision++; return true; }
      return false;
    }
    invoke(peerId, operation, body = {}, token) {
      if (!object(body) || JSON.stringify(body).length > 8192) fail(400, 'Invalid room request.');
      if (operation === 'join') {
        if (token !== undefined) {
          const member = this.members.find(m => m.token === token && m.seat !== 0);
          if (!member) fail(401, 'Your saved seat no longer belongs to this room.');
          if (this.members.some(m => m.peerId === peerId && m !== member)) fail(403, 'This connection already belongs to another player.');
          if (member.peerId !== peerId || !member.connected) { member.peerId = peerId; member.connected = true; this.revision++; }
          return this.snapshot(member, true);
        }
        if (this.members.some(m => m.peerId === peerId)) fail(401, 'Use your saved room key to reconnect.');
        if (this.state) fail(409, 'This game has started. Ask the host for a new room.');
        if (this.members.length >= this.maxPlayers) fail(409, 'This room is full.');
        const member = { name: nameOf(body.name), peerId, seat: this.members.length, token: randomToken(), connected: true };
        this.members.push(member); this.revision++;
        return this.snapshot(member, true);
      }
      const member = this.authenticate(peerId, token);
      if (operation === 'snapshot') return this.snapshot(member);
      if (operation === 'start') {
        if (member.seat !== 0) fail(403, 'Only the host can start the game.');
        if (this.state) fail(409, 'This game has already started.');
        this.checkRevision(body);
        if (body.fillBots !== undefined && typeof body.fillBots !== 'boolean') fail(400, 'Invalid computer-player option.');
        if (this.members.length < 2 && !body.fillBots) fail(409, 'Invite another player or fill the empty seats with computers.');
        const players = this.members.map(m => ({ name: m.name, color: COLORS[m.seat], controller: 'human' }));
        if (body.fillBots) while (players.length < this.maxPlayers) players.push({ name: NAMES[players.length] + ' Bot', color: COLORS[players.length], controller: 'ai' });
        const state = this.engine.createGame({ seed: this.seed, radius: this.radius, players });
        this.bots(state); this.commit(state);
        return this.snapshot(member);
      }
      if (operation !== 'action') fail(400, 'Unknown room request.');
      if (!this.state) fail(409, 'Wait for the host to start the game.');
      if (this.state.winner !== null) fail(409, 'This game is finished. Create a room for a rematch.');
      if (this.state.currentPlayer !== member.seat) fail(403, 'It is another player’s turn.');
      this.checkRevision(body);
      const state = clone(this.state);
      if (body.type === 'move') {
        if (typeof body.from !== 'string' || typeof body.to !== 'string' || body.from.length > 16 || body.to.length > 16) fail(400, 'Choose your hex and a neighbor.');
        const result = this.engine.applyMove(state, body.from, body.to, this.engine.maxSend(state, body.from, body.to));
        if (!result?.ok) fail(400, result?.error || 'That move is not allowed.');
      } else if (body.type === 'endTurn') { this.engine.endTurn(state); this.bots(state); }
      else fail(400, 'Unknown game action.');
      this.commit(state);
      return this.snapshot(member);
    }
  }

  async function connect(config, role) {
    const engine = config.engine || globalThis.DotlandsEngine;
    const transport = config.transportAPI || globalThis.DoodletickRooms;
    if (!engine || !transport) fail(503, 'Online play could not load. Refresh the game.');
    if (role === 'guest' && config.role === 'host') fail(409, 'The host closed this table. Create a new room; host games cannot resume after a reload.');
    const name = nameOf(config.name || 'Player');
    let handle, authority, botTimer = null, closed = false, ready = false, current = null, seat, gameToken = config.token;
    const pending = new Map(), cache = new Map(), traffic = new Map(), queued = [];
    const onStatus = status => { if (!closed) config.onStatus?.(status); };
    const update = data => {
      validateSnapshot(data, engine, { code: handle.room, ...(seat === undefined ? {} : { seat }) });
      if (current && data.revision < current.revision) return false;
      const clean = clone(data); delete clean.token;
      if (current && data.revision === current.revision && JSON.stringify(clean) !== JSON.stringify(current)) fail(400, 'The host sent conflicting updates.');
      current = clean; seat = data.seat;
      if (ready) config.onSnapshot?.(clone(clean));
      return true;
    };
    // A single guest disappearing must not freeze the host or the other guests.
    // The transport reports an overall connection loss separately.
    const deliver = (peerId, value) => Promise.resolve(handle.send(peerId, value)).catch(error => onStatus({ state: 'peer-waiting', peerId, reason: 'A guest is reconnecting. ' + error.message }));
    const broadcast = () => {
      if (closed || !authority) return;
      update(authority.snapshot(authority.members[0]));
      for (const member of authority.members.slice(1)) if (member.connected) deliver(member.peerId, { protocol: PROTOCOL, kind: 'snapshot', data: authority.snapshot(member) });
      if (!botTimer && authority.state?.winner === null && authority.state.players[authority.state.currentPlayer].controller === 'ai') {
        botTimer = setTimeout(() => {
          botTimer = null;
          if (!closed && authority.advanceBots()) broadcast();
        }, 150);
      }
    };
    const receive = (peerId, packet) => {
      if (closed) return;
      if (!handle || (role === 'host' && !authority)) { if (queued.length < 32) queued.push([peerId, packet]); return; }
      if (!boundedPacket(packet) || packet.protocol !== PROTOCOL) return;
      if (role === 'host') {
        if (packet.kind !== 'request' || typeof packet.id !== 'string' || !/^[a-f0-9]{32}$/.test(packet.id)) return;
        let bucket = traffic.get(peerId); const now = Date.now();
        if (!bucket || now - bucket.at >= 60000) { bucket = { at: now, count: 0 }; traffic.set(peerId, bucket); }
        if (++bucket.count > 240) return;
        const key = peerId + ':' + packet.id;
        if (cache.has(key)) { deliver(peerId, cache.get(key)); return; }
        let response, changed = false;
        try {
          const before = authority.revision;
          const data = authority.invoke(peerId, packet.operation, packet.body || {}, packet.token);
          response = { protocol: PROTOCOL, kind: 'response', id: packet.id, ok: true, data };
          changed = before !== authority.revision;
        } catch (e) { response = { protocol: PROTOCOL, kind: 'response', id: packet.id, ok: false, status: e.status || 500, error: e.status ? e.message : 'The host could not complete that action.' }; }
        cache.set(key, response); if (cache.size > 512) cache.delete(cache.keys().next().value);
        deliver(peerId, response).then(() => { if (changed) broadcast(); });
      } else {
        if (peerId !== handle.hostId) return;
        if (packet.kind === 'response') {
          const waiting = pending.get(packet.id); if (!waiting) return;
          pending.delete(packet.id); clearTimeout(waiting.timer);
          if (!packet.ok) { const e = new Error(typeof packet.error === 'string' ? packet.error.slice(0, 250) : 'The host declined that request.'); e.status = Number.isInteger(packet.status) ? packet.status : 400; waiting.reject(e); return; }
          try {
            if (waiting.operation === 'join') {
              if (typeof packet.data?.token !== 'string' || !/^[a-f0-9]{48}$/.test(packet.data.token)) fail(400, 'The host sent an invalid room key.');
              update(packet.data); gameToken = packet.data.token;
            } else update(packet.data);
            waiting.resolve(clone(current));
          } catch (e) { waiting.reject(e); }
        } else if (packet.kind === 'snapshot' && seat !== undefined) {
          try { update(packet.data); } catch (e) { onStatus({ state: 'error', reason: e.message }); }
        }
      }
    };
    const peerChange = event => {
      if (closed || !handle) return;
      if (role === 'host' && authority && authority.connected(event.peerId, Boolean(event.connected))) broadcast();
      else if (role === 'guest' && event.peerId === handle.hostId) onStatus({ state: event.connected ? 'connected' : 'disconnected', reason: event.connected ? '' : 'The host is disconnected. Keep this page open to reconnect.' });
    };
    const transportOptions = { ...(config.transport || {}), url: config.url || config.transport?.url,
      room: config.room || config.code || config.transport?.room, onMessage: receive, onPeer: peerChange, onStatus };
    try { handle = await transport[role === 'host' ? 'create' : 'join'](transportOptions); }
    catch (error) { throw networkError(error); }
    if (!handle || typeof handle.room !== 'string' || !handle.peerId || !handle.hostId || typeof handle.send !== 'function') { handle?.close?.(); fail(503, 'The room connection is incomplete.'); }
    if (role === 'host') {
      authority = new HostRoom({ engine, code: handle.room, peerId: handle.peerId, name, maxPlayers: config.maxPlayers || 4, radius: config.radius || 3, seed: config.seed });
      gameToken = authority.members[0].token; seat = 0; update(authority.snapshot(authority.members[0]));
    }
    const rpc = (operation, body = {}) => {
      if (closed) return Promise.reject(new Error('This room connection is closed.'));
      if (role === 'host') {
        try { const before = authority.revision; const data = authority.invoke(handle.peerId, operation, body, gameToken); update(data); if (authority.revision !== before) broadcast(); return Promise.resolve(clone(current)); }
        catch (e) { return Promise.reject(e); }
      }
      if (pending.size >= 8) return Promise.reject(new Error('Wait for your previous request to finish.'));
      const id = randomToken(16);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('The host did not answer. Reconnect to refresh the table before trying again.')); }, config.requestTimeout || 15000);
        pending.set(id, { resolve, reject, timer, operation });
        Promise.resolve(handle.send(handle.hostId, { protocol: PROTOCOL, kind: 'request', id, operation, body, ...(gameToken ? { token: gameToken } : {}) })).catch(e => { const item = pending.get(id); if (item) { clearTimeout(item.timer); pending.delete(id); item.reject(networkError(e)); } });
      });
    };
    const close = () => { if (closed) return; closed = true; clearTimeout(botTimer); for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('This room connection is closed.')); } pending.clear(); cache.clear(); traffic.clear(); handle.close(); };
    for (const [peerId, packet] of queued.splice(0)) receive(peerId, packet);
    if (role === 'guest') {
      try { await rpc('join', { name }); } catch (e) { close(); throw e; }
    }
    ready = true;
    const session = {
      initial: clone(current),
      get credentials() { return { kind: 'p2p', role, url: handle.credentials?.url || config.url, room: handle.room, code: handle.room, peerId: handle.peerId, hostId: handle.hostId, seat, token: gameToken, name, transport: clone(handle.credentials || {}) }; },
      request(path, body) {
        const base = '/rooms/' + handle.room;
        if (path === base && body === undefined) return rpc('snapshot');
        if (path === base + '/start') return rpc('start', body);
        if (path === base + '/action') return rpc('action', body);
        return Promise.reject(new Error('Unknown room request.'));
      },
      snapshot: () => rpc('snapshot'), start: body => rpc('start', body), action: body => rpc('action', body), close,
    };
    return session;
  }
  return Object.freeze({ PROTOCOL, HostRoom, validateSnapshot,
    create: config => connect(config, 'host'), join: config => connect(config, 'guest'), reconnect: config => connect(config, 'guest') });
});
