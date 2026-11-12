'use strict';

// A small, authoritative, in-memory private-room server. No npm dependencies.
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const COLORS = ['#78aa8b', '#dc917d', '#d5b45d', '#afa1c7'];
const BOT_NAMES = ['Moss', 'Ember', 'Honey', 'Iris'];
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_LIFETIME = 24 * 60 * 60 * 1000;

function createServer(options = {}) {
  const engine = options.engine || require('./engine.js');
  const rooms = new Map();
  const traffic = new Map();
  const creationTraffic = new Map();
  const now = options.now || Date.now;
  const maxRooms = options.maxRooms || 200;
  const configuredOrigins = options.allowedOrigins !== undefined
    ? options.allowedOrigins
    : (process.env.ALLOWED_ORIGINS || '*');
  const origins = Array.isArray(configuredOrigins) ? configuredOrigins : configuredOrigins.split(',').map(v => v.trim()).filter(Boolean);
  const publicFiles = [
    options.indexPath,
    path.join(__dirname, 'index.html'),
    path.resolve(__dirname, '../../outputs/index.html'),
    path.resolve(__dirname, '../../outputs/DOTLANDS.html'),
  ].filter(Boolean);

  function problem(status, message, extra = {}) {
    const error = new Error(message);
    error.status = status;
    error.extra = extra;
    throw error;
  }

  function send(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  }

  function countRequest(map, key, limit, duration) {
    const time = now();
    let bucket = map.get(key);
    if (!bucket || bucket.reset <= time) { bucket = { count: 0, reset: time + duration }; map.set(key, bucket); }
    if (++bucket.count > limit) problem(429, 'Too many requests. Please wait a minute and try again.');
  }

  function cleanup() {
    const time = now();
    for (const [code, room] of rooms) if (time - room.touchedAt > ROOM_LIFETIME) rooms.delete(code);
    for (const map of [traffic, creationTraffic]) for (const [key, bucket] of map) if (bucket.reset <= time) map.delete(key);
  }

  async function readBody(req) {
    const contentLength = Number(req.headers['content-length'] || 0);
    if (contentLength > 8192) { req.resume(); problem(413, 'The request is too large.'); }
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 8192) problem(413, 'The request is too large.');
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (!text) return {};
    let body;
    try { body = JSON.parse(text); } catch { problem(400, 'Send a valid JSON request.'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) problem(400, 'Send a JSON object.');
    return body;
  }

  function readName(value) {
    if (typeof value !== 'string') problem(400, 'Enter your player name.');
    const name = value.trim().replace(/\s+/g, ' ');
    if (name.length < 1 || name.length > 22 || /[\u0000-\u001f\u007f]/.test(name)) problem(400, 'Use a name between 1 and 22 characters.');
    return name;
  }

  function roomCode() {
    for (let attempt = 0; attempt < 100; attempt++) {
      let code = '';
      for (let i = 0; i < 6; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
      if (!rooms.has(code)) return code;
    }
    problem(503, 'Could not make a room. Please try again.');
  }

  function addMember(room, name) {
    const member = { name, seat: room.members.length, token: crypto.randomBytes(24).toString('hex') };
    room.members.push(member);
    return member;
  }

  function authenticate(req, room) {
    const match = /^Bearer ([a-f0-9]{48})$/.exec(req.headers.authorization || '');
    const member = match && room.members.find(m => m.token === match[1]);
    if (!member) problem(401, 'Your room key is missing or no longer valid. Rejoin the room.');
    room.touchedAt = now();
    return member;
  }

  function snapshot(room, member, includeToken = false) {
    const data = {
      code: room.code,
      phase: room.state ? 'playing' : 'lobby',
      revision: room.revision,
      players: room.members.map(({ name, seat }) => ({ name, seat })),
      hostSeat: 0,
      maxPlayers: room.maxPlayers,
      state: room.state,
      seat: member.seat,
    };
    if (includeToken) data.token = member.token;
    return data;
  }

  function checkRevision(body, room) {
    if (!Number.isInteger(body.expectedRevision)) problem(400, 'A room revision is required. Refresh and try again.');
    if (body.expectedRevision !== room.revision) problem(409, 'The room changed. Refresh and try again.', { revision: room.revision });
  }

  function runBots(room) {
    let changed = false;
    // A full cycle is bounded even if an engine change accidentally fails to advance.
    for (let turn = 0; turn < 4 && room.state.winner == null; turn++) {
      const state = room.state;
      const player = state.players[state.currentPlayer];
      if (!player || player.controller !== 'ai') break;
      changed = true;
      for (let move = 0; move < 64 && state.winner == null; move++) {
        const choice = engine.chooseAIMove(state);
        if (!choice) break;
        const result = engine.applyMove(state, choice.from, choice.to, engine.maxSend(state, choice.from, choice.to));
        if (!result || !result.ok) break;
      }
      if (state.winner == null) engine.endTurn(state);
    }
    return changed;
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const origin = req.headers.origin;
    if (origins.includes('*')) res.setHeader('Access-Control-Allow-Origin', '*');
    else if (origin && origins.includes(origin)) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
    else if (origin) { send(res, 403, { error: 'This game page is not allowed by this server.' }); req.resume(); return; }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    try {
      cleanup();
      const ip = req.socket.remoteAddress || 'unknown';
      let pathname;
      try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { problem(400, 'Invalid address.'); }

      if (req.method === 'GET' && (pathname === '/api' || pathname === '/api/health')) {
        send(res, 200, { ok: true, game: 'Dotlands', protocol: 1 }); return;
      }
      // Known seats have independent request budgets, including behind hosting
      // proxies that expose one IP for every visitor. Invalid tokens still use
      // the IP budget; arbitrary forwarded headers are never trusted.
      const roomPath = /^\/api\/rooms\/([A-Z2-9]{6})(?:\/(?:start|action))?$/i.exec(pathname);
      const requestToken = /^Bearer ([a-f0-9]{48})$/.exec(req.headers.authorization || '');
      const rateRoom = roomPath && rooms.get(roomPath[1].toUpperCase());
      const rateMember = rateRoom && requestToken && rateRoom.members.find(m => m.token === requestToken[1]);
      const requestKey = rateMember ? `seat:${rateRoom.code}:${rateMember.seat}` : `ip:${ip}`;
      countRequest(traffic, requestKey, options.requestLimit || 240, 60000);
      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        const file = publicFiles.find(p => fs.existsSync(p));
        if (!file) { send(res, 200, { ok: true, game: 'Dotlands', message: 'Room server is running. Open the Dotlands game and use this server address for online play.' }); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
        fs.createReadStream(file).pipe(res); return;
      }
      if (pathname === '/api/rooms' && req.method === 'POST') {
        countRequest(creationTraffic, ip, 12, 3600000);
        if (rooms.size >= maxRooms) problem(503, 'The server is full. Please try again later.');
        const body = await readBody(req);
        const name = readName(body.name);
        const maxPlayers = body.maxPlayers === undefined ? 4 : body.maxPlayers;
        if (!Number.isInteger(maxPlayers) || maxPlayers < 2 || maxPlayers > 4) problem(400, 'A room needs 2 to 4 seats.');
        const radius = body.radius === undefined ? 3 : body.radius;
        if (radius !== 3 && radius !== 4) problem(400, 'Choose a compact or large map.');
        if (body.seed !== undefined && !((typeof body.seed === 'string' && body.seed.length <= 64) || (typeof body.seed === 'number' && Number.isFinite(body.seed)))) problem(400, 'Invalid map seed.');
        const room = { code: roomCode(), members: [], maxPlayers, radius, seed: body.seed === undefined ? crypto.randomBytes(8).toString('hex') : body.seed, state: null, revision: 1, touchedAt: now() };
        const member = addMember(room, name);
        rooms.set(room.code, room);
        send(res, 201, snapshot(room, member, true)); return;
      }

      const match = /^\/api\/rooms\/([A-Z2-9]{6})(?:\/(join|start|action))?$/i.exec(pathname);
      if (!match) problem(404, 'That address was not found.');
      const room = rooms.get(match[1].toUpperCase());
      if (!room) problem(404, 'Room not found. Check the code, or create a new room.');
      const operation = match[2] && match[2].toLowerCase();

      if (operation === 'join' && req.method === 'POST') {
        const body = await readBody(req);
        if (room.state) problem(409, 'This game has already started. Ask the host for a new room.');
        if (room.members.length >= room.maxPlayers) problem(409, 'This room is full.');
        const member = addMember(room, readName(body.name));
        room.revision++;
        room.touchedAt = now();
        send(res, 201, snapshot(room, member, true)); return;
      }

      const member = authenticate(req, room);
      if (!operation && req.method === 'GET') {
        // If all humans have been eliminated, polling still lets the remaining
        // computers finish the match instead of stranding it on an AI turn.
        if (room.state && runBots(room)) room.revision++;
        send(res, 200, snapshot(room, member)); return;
      }
      if (operation === 'start' && req.method === 'POST') {
        const body = await readBody(req);
        if (member.seat !== 0) problem(403, 'Only the host can start the game.');
        if (room.state) problem(409, 'This game has already started.');
        checkRevision(body, room);
        if (body.fillBots !== undefined && typeof body.fillBots !== 'boolean') problem(400, 'Invalid computer-player option.');
        if (room.members.length < 2 && !body.fillBots) problem(409, 'Invite another player, or fill the empty seats with computers.');
        const players = room.members.map(m => ({ name: m.name, color: COLORS[m.seat], controller: 'human' }));
        if (body.fillBots) while (players.length < room.maxPlayers) players.push({ name: BOT_NAMES[players.length] + ' Bot', color: COLORS[players.length], controller: 'ai' });
        room.state = engine.createGame({ seed: room.seed, radius: room.radius, players });
        runBots(room);
        room.revision++;
        send(res, 200, snapshot(room, member)); return;
      }
      if (operation === 'action' && req.method === 'POST') {
        const body = await readBody(req);
        if (!room.state) problem(409, 'Wait for the host to start the game.');
        if (room.state.winner != null) problem(409, 'This game is finished. Create a room for a rematch.');
        if (room.state.currentPlayer !== member.seat) problem(403, 'It is another player’s turn.');
        checkRevision(body, room);
        if (body.type === 'move') {
          if (typeof body.from !== 'string' || typeof body.to !== 'string' || body.from.length > 16 || body.to.length > 16) problem(400, 'Choose your hex, then a neighboring hex.');
          // Army size is a rule, not client input. A stale or modified client
          // cannot move a partial army or exceed the one-dot garrison limit.
          const amount = engine.maxSend(room.state, body.from, body.to);
          const result = engine.applyMove(room.state, body.from, body.to, amount);
          if (!result || !result.ok) problem(400, result && result.error ? result.error : 'That move is not allowed.');
        } else if (body.type === 'endTurn') {
          engine.endTurn(room.state);
          runBots(room);
        } else problem(400, 'Unknown action.');
        room.revision++;
        send(res, 200, snapshot(room, member)); return;
      }
      problem(405, 'That request method is not supported.');
    } catch (error) {
      if (!res.headersSent) send(res, error.status || 500, { error: error.status ? error.message : 'The server could not complete that action. Please try again.', ...(error.extra || {}) });
      if (!error.status) console.error('Dotlands server error:', error);
      req.resume();
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return server;
}

module.exports = { createServer };
if (require.main === module) {
  const port = Number(process.env.PORT || 8787);
  createServer().listen(port, '0.0.0.0', () => console.log(`Dotlands room server listening on port ${port}`));
}
