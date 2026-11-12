'use strict';

// The service introduces peers and forwards bounded messages when a direct
// connection is unavailable. Game rules and game state live in the host browser.
const crypto = require('node:crypto');
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PEER = /^[a-f0-9]{32}$/;
const TOKEN = /^[a-f0-9]{48}$/;
const MESSAGE_ID = /^[A-Za-z0-9_-]{1,96}$/;
const MAX_BODY = 64 * 1024;
const MAX_EVENTS = 256;
const MAX_QUEUE_BYTES = 1024 * 1024;
const REPLAY_MS = 5 * 60 * 1000;
const ROOM_MS = 24 * 60 * 60 * 1000;

function createDoodletickService(options = {}) {
  const now = options.now || Date.now;
  const rooms = new Map(), traffic = new Map(), creations = new Map();
  const maxRooms = Math.min(200, options.maxRooms || 200);
  function fail(status, message) { const e = new Error(message); e.status = status; throw e; }
  function send(res, status, value) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  }
  function count(map, key, limit, period) {
    const time = now(); let item = map.get(key);
    if (!item || item.until <= time) { item = { count: 0, until: time + period }; map.set(key, item); }
    if (++item.count > limit) fail(429, 'Too many connection requests. Please try again shortly.');
  }
  function pruneEvents(member) {
    const cutoff = now() - REPLAY_MS;
    while (member.events.length && (member.events[0].time < cutoff || member.events.length > MAX_EVENTS || member.bytes > MAX_QUEUE_BYTES)) {
      const old = member.events.shift(); member.bytes -= old.bytes; member.droppedThrough = old.event.seq;
    }
    for (const [id, receipt] of member.sent) if (receipt.time < cutoff) member.sent.delete(id);
    while (member.sent.size > 512) member.sent.delete(member.sent.keys().next().value);
  }
  function cleanup() {
    const time = now();
    for (const [code, room] of rooms) {
      if (time - room.touchedAt > ROOM_MS || (room.closedAt !== null && time - room.closedAt > 60000)) rooms.delete(code);
      else for (const member of room.members.values()) pruneEvents(member);
    }
    for (const map of [traffic, creations]) for (const [key, bucket] of map) if (bucket.until <= time) map.delete(key);
  }
  async function readBody(req) {
    if (Number(req.headers['content-length'] || 0) > MAX_BODY) fail(413, 'The connection message is too large.');
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) fail(413, 'The connection message is too large.'); chunks.push(chunk); }
    let value;
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { fail(400, 'Send a valid JSON message.'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'Send a JSON object.');
    return value;
  }
  function code() {
    for (let attempt = 0; attempt < 100; attempt++) {
      let value = ''; for (let i = 0; i < 6; i++) value += ALPHABET[crypto.randomInt(ALPHABET.length)];
      if (!rooms.has(value)) return value;
    }
    fail(503, 'Could not create a room. Please try again.');
  }
  function secretMatches(a, b) { return typeof a === 'string' && TOKEN.test(a) && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
  function openRoom(room) { if (room.closedAt !== null) fail(410, 'The host closed this room. Ask for a new invitation.'); }
  function member(room, peerId) {
    const peer = { peerId, token: crypto.randomBytes(24).toString('hex'), lastSeen: now(), left: false, events: [], bytes: 0, droppedThrough: 0, sent: new Map() };
    room.members.set(peerId, peer); room.touchedAt = now(); return peer;
  }
  function credentials(room, peer) { return { room: room.code, game: room.game, peerId: peer.peerId, hostId: room.hostId, token: peer.token, cursor: room.sequence }; }
  function authenticate(req, room) {
    const match = /^Bearer ([a-f0-9]{48})$/.exec(req.headers.authorization || '');
    const peer = match && [...room.members.values()].find(m => secretMatches(match[1], m.token));
    if (!peer) fail(401, 'Your connection key is missing or no longer valid. Rejoin the room.');
    if (peer.left) fail(401, 'This peer left the room. Reconnect with your saved connection.');
    peer.lastSeen = now(); room.touchedAt = now();
    count(traffic, 'peer:' + room.code + ':' + peer.peerId, options.requestLimit || 1200, 60000);
    return peer;
  }
  return {
    async handle(req, res) {
      let url;
      try { url = new URL(req.url, 'http://localhost'); } catch { return false; }
      if (url.pathname !== '/doodletick' && !url.pathname.startsWith('/doodletick/')) return false;
      try {
        cleanup();
        const ip = req.socket.remoteAddress || 'unknown';
        if (url.pathname === '/doodletick/health' && req.method === 'GET') {
          send(res, 200, { ok: true, service: 'Doodletick', protocol: 1 }); return true;
        }
        if (url.pathname === '/doodletick/rooms' && req.method === 'POST') {
          count(creations, ip, options.creationLimit || 12, 3600000);
          const body = await readBody(req);
          if (!PEER.test(body.peerId || '')) fail(400, 'Invalid peer identity.');
          const game = body.game === undefined ? 'dotlands-v1' : body.game;
          if (typeof game !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(game)) fail(400, 'Invalid game protocol.');
          const maxPeers = body.maxPeers === undefined ? 4 : body.maxPeers;
          if (!Number.isInteger(maxPeers) || maxPeers < 2 || maxPeers > 4) fail(400, 'A room supports two to four peers.');
          if (rooms.size >= maxRooms) fail(503, 'The connection service is full. Please try again later.');
          const room = { code: code(), game, hostId: body.peerId, maxPeers, members: new Map(), sequence: 0, touchedAt: now(), closedAt: null };
          const host = member(room, body.peerId); rooms.set(room.code, room);
          send(res, 201, credentials(room, host)); return true;
        }
        const match = /^\/doodletick\/rooms\/([A-Z2-9]{6})\/(join|events|send|leave)$/i.exec(url.pathname);
        if (!match) fail(404, 'That connection address was not found.');
        const room = rooms.get(match[1].toUpperCase());
        if (!room) fail(404, 'Room not found. Check the code or ask for a new invitation.');
        openRoom(room);
        const operation = match[2].toLowerCase();
        if (operation === 'join' && req.method === 'POST') {
          count(traffic, 'join:' + ip, options.joinLimit || 120, 60000);
          const body = await readBody(req); openRoom(room);
          if (body.game !== undefined && body.game !== room.game) fail(409, 'That room belongs to a different game version.');
          if (!PEER.test(body.peerId || '')) fail(400, 'Invalid peer identity.');
          let peer = room.members.get(body.peerId);
          if (peer) {
            if (!secretMatches(body.token, peer.token)) fail(401, 'This identity needs its saved connection key.');
            peer.left = false; peer.lastSeen = now(); room.touchedAt = now();
            send(res, 200, credentials(room, peer)); return true;
          }
          if (body.token !== undefined) fail(401, 'That saved connection does not belong to this room.');
          if (room.members.size >= room.maxPeers) fail(409, 'This room already has four peers.');
          peer = member(room, body.peerId); send(res, 201, credentials(room, peer)); return true;
        }
        const peer = authenticate(req, room);
        if (operation === 'events' && req.method === 'GET') {
          const raw = url.searchParams.get('after') || '0';
          if (!/^\d{1,16}$/.test(raw)) fail(400, 'Invalid event cursor.');
          const after = Number(raw);
          if (!Number.isSafeInteger(after) || after > room.sequence) fail(400, 'Invalid event cursor.');
          pruneEvents(peer);
          if (after < peer.droppedThrough) fail(410, 'The connection fell too far behind. Reconnect to refresh the game.');
          send(res, 200, { room: room.code, game: room.game, hostId: room.hostId,
            peers: [...room.members.values()].map(m => ({ peerId: m.peerId, connected: !m.left && now() - m.lastSeen <= 30000 })),
            events: peer.events.filter(item => item.event.seq > after).map(item => item.event), cursor: room.sequence });
          return true;
        }
        if (operation === 'send' && req.method === 'POST') {
          const body = await readBody(req); openRoom(room);
          if (!MESSAGE_ID.test(body.id || '') || !PEER.test(body.to || '') || !['signal', 'data'].includes(body.kind) || !Object.hasOwn(body, 'payload')) fail(400, 'Invalid connection message.');
          const target = room.members.get(body.to);
          if (!target || target.peerId === peer.peerId) fail(400, 'Choose another peer in this room.');
          // A sender's declared from/seat fields never determine routing identity.
          const content = JSON.stringify({ to: body.to, kind: body.kind, payload: body.payload });
          const digest = crypto.createHash('sha256').update(content).digest('hex');
          pruneEvents(peer);
          const old = peer.sent.get(body.id);
          if (old) {
            if (old.digest !== digest) fail(409, 'That message ID was already used for different content.');
            send(res, 200, { ok: true, seq: old.seq, duplicate: true }); return true;
          }
          const event = { seq: ++room.sequence, from: peer.peerId, kind: body.kind, payload: body.payload };
          const bytes = Buffer.byteLength(JSON.stringify(event));
          if (bytes > MAX_BODY) { room.sequence--; fail(413, 'The connection message is too large.'); }
          target.events.push({ event, bytes, time: now() }); target.bytes += bytes;
          peer.sent.set(body.id, { digest, seq: event.seq, time: now() }); pruneEvents(peer); pruneEvents(target);
          send(res, 200, { ok: true, seq: event.seq, duplicate: false }); return true;
        }
        if (operation === 'leave' && req.method === 'POST') {
          await readBody(req); openRoom(room);
          peer.left = true;
          if (peer.peerId === room.hostId) room.closedAt = now();
          send(res, 200, { ok: true }); return true;
        }
        fail(405, 'That connection method is not supported.');
      } catch (error) {
        if (!res.headersSent) send(res, error.status || 500, { error: error.status ? error.message : 'Could not complete the connection request.' });
        req.resume(); return true;
      }
    },
  };
}
module.exports = { createDoodletickService };
