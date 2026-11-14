const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// Virtual time executes the production transport, including its real polling,
// batching and retry logic, without waiting minutes or relying on wall time.
async function clocked(transportSource) {
  let now = 0, serial = 0, cursor = 0, events = [], fail = false, suspended = null;
  const timers = new Map(), listeners = new Map(), requests = [], messages = [], statuses = [];
  const guest = '2'.repeat(32), host = '1'.repeat(32);
  const listen = (name, fn) => listeners.set(name, fn);
  const unlisten = (name, fn) => { if (listeners.get(name) === fn) listeners.delete(name); };
  const context = { URL, TextEncoder, AbortController, Uint8Array, crypto: globalThis.crypto,
    Date: { now: () => now }, navigator: { onLine: true },
    document: { hidden: false, addEventListener: listen, removeEventListener: unlisten },
    addEventListener: listen, removeEventListener: unlisten,
    setTimeout(fn, ms) { const id = ++serial; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimeout(id) { timers.delete(id); },
    async fetch(url, options) {
      const body = options.body && JSON.parse(options.body);
      requests.push({ at: now, url, body });
      if (url.includes('/events?')) {
        if (fail) throw new Error('Temporary outage');
        if (suspended) await suspended.promise;
        const batch = events; events = [];
        return { ok: true, json: async () => ({ room: 'ABC234', hostId: host, cursor, peers: [{ peerId: guest, connected: true }], events: batch }) };
      }
      return { ok: true, json: async () => url.endsWith('/rooms')
        ? { room: 'ABC234', peerId: host, hostId: host, token: 'a'.repeat(48), cursor: 0 } : { ok: true } };
    },
  };
  vm.createContext(context);
  vm.runInContext(transportSource || fs.readFileSync(path.join(__dirname, 'doodletick-rooms.js'), 'utf8'), context);
  const handle = await context.DoodletickRooms.create({ url: 'https://rooms.example', peerId: host, forceRelay: true,
    onMessage: (_, payload) => messages.push(payload), onStatus: value => statuses.push(value) });
  const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
  async function advance(ms) {
    const end = now + ms;
    for (;;) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      now = next[1].at; timers.delete(next[0]); next[1].fn(); await flush();
    }
    now = end; await flush();
  }
  return { handle, guest, context, requests, messages, statuses, timers, listeners, advance,
    polls: () => requests.filter(r => r.url.includes('/events?')),
    sent: () => requests.filter(r => r.url.endsWith('/send')),
    event(frame) { events.push({ seq: ++cursor, from: guest, kind: 'data', payload: frame }); },
    offline() { context.navigator.onLine = false; listeners.get('offline')?.(); },
    online() { context.navigator.onLine = true; listeners.get('online')?.(); },
    hidden(value) { context.document.hidden = value; listeners.get('visibilitychange')?.(); },
    failure(value) { fail = value; },
    suspend() { let resolve; suspended = { promise: new Promise(r => { resolve = r; }), resolve }; },
    release() { suspended.resolve(); suspended = null; },
  };
}

test('default transport checks every five seconds, idles at fifteen, and sends no game packets while quiet', async () => {
  const f = await clocked();
  await f.advance(60000);
  assert.deepEqual(f.polls().map(r => r.at), [0, 5000, 10000, 15000, 20000, 25000, 30000, 45000, 60000]);
  assert.equal(f.sent().length, 0);
  assert.equal(f.statuses.filter(s => s.state === 'connected').length, 1, 'unchanged checks do not churn UI status');
  await f.handle.send(f.guest, { move: 1 });
  await f.advance(5000);
  assert.equal(f.polls().at(-1).at, 65000, 'a move returns the room to active cadence');
  await f.handle.close(); assert.equal(f.timers.size, 0); assert.equal(f.listeners.size, 0);
});

test('hidden tabs ease off, offline pauses checks, and returning catches up immediately', async () => {
  const f = await clocked(); f.hidden(true);
  await f.advance(90000); assert.deepEqual(f.polls().map(r => r.at), [0, 30000, 60000, 90000]);
  f.offline(); const before = f.requests.length;
  await f.advance(120000); assert.equal(f.requests.length, before);
  await assert.rejects(f.handle.send(f.guest, { move: 1 }), /offline/);
  f.online(); await f.advance(0); assert.equal(f.polls().at(-1).at, 210000);
  f.hidden(false); await f.advance(0); assert.equal(f.polls().at(-1).at, 210000);
  await f.advance(5000); assert.equal(f.polls().at(-1).at, 215000);
  await f.handle.close();
});

test('mailbox batches use one cumulative acknowledgement and duplicate delivery is harmless', async () => {
  const f = await clocked(), stream = 'b'.repeat(32);
  for (const seq of [1, 3, 2, 2]) f.event({ v: 1, type: 'message', stream, seq, payload: seq });
  await f.advance(5000);
  assert.deepEqual(f.messages, [1, 2, 3]);
  assert.equal(f.sent().length, 1);
  assert.equal(f.sent()[0].body.payload.seq, 3);
  await f.handle.close();
});

test('mailbox retries allow a background round trip and stop after an acknowledgement', async () => {
  const f = await clocked(); await f.handle.send(f.guest, { move: 1 });
  await f.advance(60000); assert.equal(f.sent().length, 1, 'no premature duplicate while an idle peer collects the move');
  await f.advance(15000); assert.equal(f.sent().length, 2);
  const frame = f.sent()[0].body.payload;
  f.event({ v: 1, type: 'ack', stream: frame.stream, seq: frame.seq });
  await f.advance(180000); assert.equal(f.sent().length, 2);
  await f.handle.close();
});

test('outages back off and overlapping wake requests never overlap fetches', async () => {
  const f = await clocked(); f.failure(true);
  await f.advance(80000);
  assert.deepEqual(f.polls().map(r => r.at), [0, 5000, 10000, 20000, 40000, 70000]);
  f.failure(false); f.suspend(); f.handle.wake(); await f.advance(0);
  const before = f.polls().length;
  f.handle.wake(); f.handle.wake(); await f.advance(0);
  assert.equal(f.polls().length, before);
  f.release(); await f.advance(0); await f.advance(0);
  assert.equal(f.polls().length, before + 1);
  assert.equal(f.statuses.at(-1).state, 'connected');
  await f.handle.close();
});
