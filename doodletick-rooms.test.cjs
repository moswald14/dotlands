'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createServer } = require('./server.cjs');
const Rooms = require('./doodletick-rooms.js');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message) {
  const deadline = Date.now() + 4000;
  while (!check() && Date.now() < deadline) await delay(10);
  assert.ok(check(), message || 'condition reached');
}
async function setup(t, extra = {}) {
  const server = createServer({ doodletick: { requestLimit: 20000 } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const handles = [];
  t.after(async () => {
    for (const handle of handles.reverse()) await handle.close();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  });
  const config = { url: 'http://127.0.0.1:' + server.address().port, pollIntervalMs: 20, retryAfterMs: 100, forceRelay: true, ...extra };
  const hostMessages = [], guestMessages = [], statuses = [], presences = [];
  const host = await Rooms.create({ ...config, onMessage: (from, payload) => hostMessages.push({ from, payload }), onStatus: status => statuses.push(status), onPeer: peer => presences.push(peer) });
  handles.push(host);
  const guest = await Rooms.join({ ...config, room: host.room, onMessage: (from, payload) => guestMessages.push({ from, payload }), onStatus: status => statuses.push(status) });
  handles.push(guest);
  await until(() => presences.some(peer => peer.peerId === guest.peerId && peer.connected));
  return { config, host, guest, handles, hostMessages, guestMessages, statuses, presences };
}

test('mailbox fallback carries bounded ordered game messages and only reports presence changes', async t => {
  const f = await setup(t);
  assert.equal(f.guest.hostId, f.host.peerId);
  assert.equal(f.guest.credentials.token.length, 48);
  await f.guest.send(f.host.peerId, { request: 1 });
  await f.guest.send(f.host.peerId, { request: 2 });
  await until(() => f.hostMessages.length === 2);
  assert.deepEqual(f.hostMessages.map(m => m.payload.request), [1, 2]);
  await f.host.broadcast({ snapshot: 'one' });
  await until(() => f.guestMessages.length === 1);
  assert.deepEqual(f.guestMessages[0], { from: f.host.peerId, payload: { snapshot: 'one' } });
  await delay(120);
  assert.equal(f.presences.filter(p => p.peerId === f.guest.peerId && p.connected).length, 1);
  assert.ok(f.statuses.some(s => s.state === 'connected' && s.transport === 'relay'));
  await assert.rejects(f.guest.send('a'.repeat(32), {}), /reconnecting/);
  await assert.rejects(f.guest.send(f.host.peerId, { data: 'x'.repeat(16000) }), /too large/);
  await f.guest.send(f.host.peerId, { request: 3 });
  await until(() => f.hostMessages.length === 3);
  assert.equal(f.hostMessages[2].payload.request, 3, 'rejected oversized frame must not consume a sequence');
});

test('same-seat refresh uses a new stream epoch and resumes bidirectional traffic', async t => {
  const f = await setup(t);
  await f.guest.send(f.host.peerId, { join: 'first' });
  await until(() => f.hostMessages.length === 1);
  for (let i = 0; i < 3; i++) await f.host.send(f.guest.peerId, { snapshot: i });
  await until(() => f.guestMessages.length === 3);
  const credentials = { ...f.guest.credentials, cursor: 0 };
  await f.guest.close();
  const resumedMessages = [];
  const resumed = await Rooms.join({ ...f.config, ...credentials, onMessage: (from, payload) => resumedMessages.push({ from, payload }) });
  f.handles.push(resumed);
  assert.equal(resumed.peerId, f.guest.peerId);
  await resumed.send(f.host.peerId, { join: 'resume' });
  await until(() => f.hostMessages.length === 2);
  await f.host.send(resumed.peerId, { snapshot: 'fresh' });
  await until(() => resumedMessages.length === 1);
  assert.deepEqual(resumedMessages[0].payload, { snapshot: 'fresh' });
  await resumed.send(f.host.peerId, { request: 'next' });
  await until(() => f.hostMessages.length === 3);
  assert.equal(f.hostMessages[2].payload.request, 'next');
});

class FakeChannel {
  constructor(label) { this.label = label; this.readyState = 'connecting'; this.bufferedAmount = 0; this.partner = null; }
  send(text) {
    assert.equal(this.readyState, 'open');
    const frame = JSON.parse(text);
    if (frame.type === 'message') FakeRTC.sent.push(frame.payload);
    if (frame.type === 'message' && frame.payload.dropDirect) return;
    queueMicrotask(() => { if (this.partner && this.partner.readyState === 'open' && this.partner.onmessage) this.partner.onmessage({ data: text }); });
  }
  close() { this.readyState = 'closed'; if (this.onclose) this.onclose(); }
}
class FakeRTC {
  static all = new Map(); static next = 0; static sent = []; static ice = 0;
  constructor() { this.id = String(++FakeRTC.next); FakeRTC.all.set(this.id, this); this.connectionState = 'new'; this.signalingState = 'stable'; }
  createDataChannel(label, opts) {
    assert.equal(opts.ordered, true); assert.equal(opts.maxRetransmits, undefined);
    this.channel = new FakeChannel(label); return this.channel;
  }
  async createOffer() { return { type: 'offer', sdp: this.id }; }
  async createAnswer() { return { type: 'answer', sdp: this.id }; }
  async setLocalDescription(description) {
    this.localDescription = description;
    if (this.onicecandidate) this.onicecandidate({ candidate: { toJSON: () => ({ candidate: 'candidate:' + this.id, sdpMid: '0' }) } });
  }
  async setRemoteDescription(description) {
    this.remoteDescription = description;
    const other = FakeRTC.all.get(description.sdp);
    if (description.type === 'offer') {
      this.channel = new FakeChannel(other.channel.label);
      this.channel.partner = other.channel; other.channel.partner = this.channel;
      if (this.ondatachannel) this.ondatachannel({ channel: this.channel });
    } else {
      for (const pc of [this, other]) {
        pc.connectionState = 'connected'; pc.channel.readyState = 'open';
        if (pc.onconnectionstatechange) pc.onconnectionstatechange();
        if (pc.channel.onopen) pc.channel.onopen();
      }
    }
  }
  async addIceCandidate() { assert.ok(this.remoteDescription); FakeRTC.ice++; }
  close() { this.connectionState = 'closed'; if (this.channel) this.channel.close(); }
}

test('raw reliable WebRTC uses no game mailbox while healthy; lost direct frame falls back once in order', async t => {
  FakeRTC.sent = []; FakeRTC.ice = 0;
  const f = await setup(t, { forceRelay: false, RTCPeerConnection: FakeRTC });
  await until(() => f.statuses.some(s => s.transport === 'direct'), 'raw data channel opened');
  await f.guest.send(f.host.peerId, { direct: 1 });
  await until(() => f.hostMessages.length === 1);
  assert.deepEqual(FakeRTC.sent, [{ direct: 1 }]);
  await f.guest.send(f.host.peerId, { dropDirect: true, n: 2 });
  await f.guest.send(f.host.peerId, { n: 3 });
  await until(() => f.hostMessages.length === 3, 'missing direct message recovered through relay');
  assert.deepEqual(f.hostMessages.map(m => m.payload.n || m.payload.direct), [1, 2, 3]);
  await delay(200);
  assert.equal(f.hostMessages.length, 3, 'retry duplicates must not reach the game');
  assert.ok(FakeRTC.ice > 0, 'early ICE candidates must survive offer ordering');
});

test('closing a host stops transport and surfaces room closure to guests', async t => {
  const f = await setup(t);
  await f.host.close();
  await until(() => f.statuses.some(s => s.state === 'error' && s.code === 410));
  await assert.rejects(f.guest.send(f.host.peerId, {}), /closed/);
});
