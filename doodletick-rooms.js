(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DoodletickRooms = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  const LABEL = 'doodletick-games-v1';
  const FRAME_BYTES = 16000;
  const MAX_PENDING = 64;
  const MAX_BUFFER = 256000;
  const validPeer = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
  const byteLength = text => new TextEncoder().encode(text).length;
  function randomId(crypto) {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  }
  function coded(message, code) { const err = new Error(message); err.code = code; return err; }
  function validURL(raw) {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Enter a valid game server address.');
    return url.href.replace(/\/$/, '');
  }
  async function connect(config, role) {
    config = config || {};
    const crypto = config.crypto || root.crypto;
    if (!crypto || !crypto.getRandomValues) throw new Error('This browser cannot create a private room.');
    const url = validURL(config.url || config.serverURL);
    const game = config.game || 'dotlands-v1';
    if (typeof game !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(game)) throw new Error('Invalid game protocol.');
    const fetcher = config.fetch || root.fetch.bind(root);
    const RTC = config.forceRelay || config.RTCPeerConnection === null ? null : (config.RTCPeerConnection || root.RTCPeerConnection);
    const peerId = config.peerId || randomId(crypto);
    if (!validPeer(peerId)) throw new Error('Invalid player identity.');
    const roomInput = String(config.room || '').toUpperCase();
    if (role === 'guest' && !/^[A-Z2-9]{6}$/.test(roomInput)) throw new Error('Enter a six-character room code.');
    let room = roomInput, hostId = null, token = config.token || null;
    let cursor = Number.isSafeInteger(config.cursor) && config.cursor >= 0 ? config.cursor : 0;
    let closed = false, timer = null, pollBusy = false, requestNumber = 0;
    const stream = randomId(crypto), peers = new Map(), links = new Map(), outgoing = new Map(), incoming = new Map(), waitingIce = new Map();
    const requests = new Set();
    const interval = Math.max(10, Number(config.pollIntervalMs) || 1200);
    const requestTimeout = Math.max(100, Number(config.requestTimeoutMs) || 20000);
    const retryAfter = Math.max(10, Number(config.retryAfterMs) || 2500);
    const on = (name, value, other) => { if (typeof config[name] === 'function') config[name](value, other); };
    function status(state, extra) { if (!closed || state === 'closed') on('onStatus', { state, ...(extra || {}) }); }
    function route(suffix) { return '/doodletick/rooms/' + room + suffix; }
    async function request(path, body, auth, signal) {
      if (closed) throw coded('The room is closed.', 'closed');
      const abort = new AbortController(); requests.add(abort);
      const timeout = setTimeout(() => abort.abort(), requestTimeout);
      if (signal) signal.addEventListener('abort', () => abort.abort(), { once: true });
      try {
        const response = await fetcher(url + path, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(auth ? { Authorization: 'Bearer ' + token } : {}) },
          body: body === undefined ? undefined : JSON.stringify(body), signal: abort.signal,
        });
        let data; try { data = await response.json(); } catch (_) { throw coded('The game server did not reply. Try again.', 'network'); }
        if (!response.ok) throw coded(data.error || 'The room could not complete that request.', response.status);
        return data;
      } finally { clearTimeout(timeout); requests.delete(abort); }
    }
    function allowed(id) { return validPeer(id) && id !== peerId && (role === 'host' || id === hostId); }
    async function mailbox(id, kind, payload) {
      if (!allowed(id)) throw coded('That player is not connected to this room.', 'peer');
      return request(route('/send'), { to: id, kind, payload, id: stream + '-' + (++requestNumber) }, true);
    }
    function stateFor(id) {
      if (!outgoing.has(id)) outgoing.set(id, { stream: randomId(crypto), remoteEpoch: null, next: 1, pending: new Map(), bytes: 0 });
      return outgoing.get(id);
    }
    function encode(frame) {
      let text;
      try { text = JSON.stringify(frame); } catch (_) { throw coded('That game message cannot be sent.', 'payload'); }
      if (!text || byteLength(text) > FRAME_BYTES) throw coded('That game message is too large.', 'payload');
      return text;
    }
    function currentChannel(id) {
      const link = links.get(id);
      return link && link.dc && link.dc.readyState === 'open' ? link.dc : null;
    }
    function transportMode() {
      const online = Array.from(peers).filter(([, connected]) => connected).map(([id]) => id);
      const direct = online.filter(id => currentChannel(id)).length;
      return direct === 0 ? 'relay' : direct === online.length ? 'direct' : 'mixed';
    }
    async function sendFrame(id, frame, forceRelay) {
      const text = encode(frame), dc = !forceRelay && currentChannel(id);
      if (dc && dc.bufferedAmount + byteLength(text) <= MAX_BUFFER) {
        try { dc.send(text); return 'direct'; } catch (_) { /* A failing direct link falls back to the mailbox. */ }
      }
      await mailbox(id, 'data', frame);
      return 'relay';
    }
    function announcePath(id) {
      if (peers.get(id)) status('connected', { peerId: id, transport: transportMode() });
    }
    function acknowledge(id, remoteStream, seq) {
      sendFrame(id, { v: 1, type: 'ack', stream: remoteStream, seq }, false).catch(() => {});
    }
    function receive(id, frame) {
      if (closed || !allowed(id) || !frame || frame.v !== 1 || !validPeer(frame.stream) || !Number.isSafeInteger(frame.seq) || frame.seq < 1) return;
      try { encode(frame); } catch (_) { return; }
      if (frame.type === 'ack') {
        const sent = outgoing.get(id); if (!sent || frame.stream !== sent.stream || frame.seq >= sent.next) return;
        for (const [seq, entry] of sent.pending) if (seq <= frame.seq) { sent.bytes -= entry.bytes; sent.pending.delete(seq); }
        return;
      }
      if (frame.type !== 'message' || !Object.prototype.hasOwnProperty.call(frame, 'payload')) return;
      const sender = stateFor(id);
      const knownStreams = incoming.get(id);
      if (sender.remoteEpoch !== frame.stream && knownStreams && knownStreams.has(frame.stream)) {
        const old = knownStreams.get(frame.stream);
        if (old.next > 1) acknowledge(id, frame.stream, old.next - 1);
        return;
      }
      if (sender.remoteEpoch && sender.remoteEpoch !== frame.stream) {
        // A refreshed guest starts a new transport epoch and asks the adapter to
        // resume its seat. Old acknowledged sequences must not strand it.
        sender.stream = randomId(crypto); sender.next = 1; sender.pending.clear(); sender.bytes = 0;
      }
      sender.remoteEpoch = frame.stream;
      let byStream = incoming.get(id);
      if (!byStream) incoming.set(id, byStream = new Map());
      if (!byStream.has(frame.stream)) {
        if (byStream.size >= 4) byStream.delete(byStream.keys().next().value);
        byStream.set(frame.stream, { next: 1, held: new Map() });
      }
      const received = byStream.get(frame.stream);
      if (frame.seq < received.next) { acknowledge(id, frame.stream, received.next - 1); return; }
      if (frame.seq - received.next >= MAX_PENDING || received.held.size >= MAX_PENDING) return;
      received.held.set(frame.seq, frame.payload);
      while (received.held.has(received.next)) {
        const payload = received.held.get(received.next);
        received.held.delete(received.next++);
        try { on('onMessage', id, payload); } catch (_) { status('error', { reason: 'A game message could not be read.' }); }
      }
      if (received.next > 1) acknowledge(id, frame.stream, received.next - 1);
    }
    function disposeLink(id) {
      const link = links.get(id); if (!link) return;
      links.delete(id);
      if (link.dc) { link.dc.onopen = link.dc.onmessage = link.dc.onclose = link.dc.onerror = null; try { link.dc.close(); } catch (_) {} }
      link.pc.onicecandidate = link.pc.ondatachannel = link.pc.onconnectionstatechange = null;
      try { link.pc.close(); } catch (_) {}
    }
    function wireChannel(id, link, dc) {
      if (closed || links.get(id) !== link || dc.label !== LABEL) { try { dc.close(); } catch (_) {} return; }
      if (link.dc && link.dc !== dc) { try { link.dc.close(); } catch (_) {} }
      link.dc = dc;
      dc.onopen = () => announcePath(id);
      dc.onmessage = event => {
        if (links.get(id) !== link || typeof event.data !== 'string' || byteLength(event.data) > FRAME_BYTES) return;
        try { receive(id, JSON.parse(event.data)); } catch (_) {}
      };
      dc.onclose = dc.onerror = () => { if (links.get(id) === link) announcePath(id); };
      if (dc.readyState === 'open') announcePath(id);
    }
    function makeLink(id, connection) {
      if (!RTC || !allowed(id) || closed) return null;
      disposeLink(id);
      let pc;
      try { pc = new RTC({ iceServers: config.iceServers || [{ urls: 'stun:stun.cloudflare.com:3478' }] }); }
      catch (_) { return null; }
      const link = { pc, dc: null, connection: connection || randomId(crypto), candidates: [], born: Date.now() };
      links.set(id, link);
      pc.onicecandidate = event => {
        if (!event.candidate || links.get(id) !== link || closed) return;
        mailbox(id, 'signal', { type: 'candidate', connection: link.connection, candidate: event.candidate.toJSON ? event.candidate.toJSON() : event.candidate }).catch(() => {});
      };
      pc.ondatachannel = event => wireChannel(id, link, event.channel);
      pc.onconnectionstatechange = () => { if (links.get(id) === link && pc.connectionState !== 'connected') announcePath(id); };
      return link;
    }
    async function offer(id) {
      const link = makeLink(id); if (!link) return;
      try {
        wireChannel(id, link, link.pc.createDataChannel(LABEL, { ordered: true }));
        await link.pc.setLocalDescription(await link.pc.createOffer());
        if (!closed && links.get(id) === link) await mailbox(id, 'signal', { type: 'offer', connection: link.connection, description: link.pc.localDescription });
      } catch (_) { if (links.get(id) === link) { disposeLink(id); announcePath(id); } }
    }
    async function receiveSignal(id, signal) {
      if (!RTC || !allowed(id) || !signal || !validPeer(signal.connection)) return;
      let link = links.get(id);
      if (signal.type === 'offer') {
        if (role !== 'guest' || id !== hostId || !signal.description || signal.description.type !== 'offer') return;
        link = makeLink(id, signal.connection); if (!link) return;
        try {
          await link.pc.setRemoteDescription(signal.description);
          const early = waitingIce.get(id + ':' + signal.connection) || [];
          waitingIce.delete(id + ':' + signal.connection);
          for (const candidate of early) await link.pc.addIceCandidate(candidate);
          await link.pc.setLocalDescription(await link.pc.createAnswer());
          if (!closed && links.get(id) === link) await mailbox(id, 'signal', { type: 'answer', connection: link.connection, description: link.pc.localDescription });
        } catch (_) { disposeLink(id); }
        return;
      }
      if (!link || link.connection !== signal.connection) {
        if (signal.type === 'candidate' && signal.candidate) {
          const key = id + ':' + signal.connection;
          if (!waitingIce.has(key)) {
            if (waitingIce.size >= 8) waitingIce.delete(waitingIce.keys().next().value);
            waitingIce.set(key, []);
          }
          if (waitingIce.get(key).length < 64) waitingIce.get(key).push(signal.candidate);
        }
        return;
      }
      try {
        if (signal.type === 'answer' && role === 'host' && signal.description && signal.description.type === 'answer') {
          await link.pc.setRemoteDescription(signal.description);
          for (const candidate of link.candidates.splice(0)) await link.pc.addIceCandidate(candidate);
        } else if (signal.type === 'candidate' && signal.candidate) {
          if (link.pc.remoteDescription) await link.pc.addIceCandidate(signal.candidate);
          else if (link.candidates.length < 64) link.candidates.push(signal.candidate);
        }
      } catch (_) { /* ICE races need not interrupt the working HTTPS path. */ }
    }
    async function retryPending() {
      for (const [id, sent] of outgoing) {
        if (!peers.get(id)) continue;
        for (const entry of sent.pending.values()) {
          if (Date.now() - entry.last < retryAfter || entry.busy) continue;
          entry.busy = true; entry.last = Date.now();
          try { await sendFrame(id, entry.frame, true); } finally { entry.busy = false; }
        }
      }
    }
    async function poll() {
      if (closed || pollBusy) return;
      pollBusy = true;
      try {
        const view = await request(route('/events?after=' + cursor), undefined, true);
        if (closed) return;
        if (view.room !== room || view.hostId !== hostId || !Array.isArray(view.peers) || !Array.isArray(view.events) || !Number.isSafeInteger(view.cursor) || view.cursor < cursor) throw coded('The room response was invalid.', 'protocol');
        const seen = new Set();
        for (const peer of view.peers) {
          if (!allowed(peer.peerId)) continue;
          seen.add(peer.peerId);
          const connected = peer.connected === true;
          if (peers.get(peer.peerId) !== connected) {
            peers.set(peer.peerId, connected); on('onPeer', { peerId: peer.peerId, connected });
            if (connected) announcePath(peer.peerId); else disposeLink(peer.peerId);
          }
          const link = links.get(peer.peerId);
          if (role === 'host' && connected && RTC && (!link || (link.pc.connectionState === 'failed' && Date.now() - link.born > 10000))) offer(peer.peerId);
        }
        for (const [id, connected] of peers) if (connected && !seen.has(id)) { peers.set(id, false); disposeLink(id); on('onPeer', { peerId: id, connected: false }); }
        for (const event of view.events) {
          if (!Number.isSafeInteger(event.seq) || event.seq <= cursor || !allowed(event.from)) continue;
          if (event.kind === 'signal') await receiveSignal(event.from, event.payload);
          else if (event.kind === 'data') receive(event.from, event.payload);
        }
        cursor = view.cursor;
        await retryPending();
        if (!peers.size && role === 'host') status('connected', { transport: 'relay' });
      } catch (error) {
        if (!closed) {
          status(error.code === 410 || error.code === 401 || error.code === 404 ? 'error' : 'disconnected', { reason: error.message, code: error.code });
          if ([410, 401, 404].includes(error.code)) { await stop(false); return; }
        }
      } finally {
        pollBusy = false;
        if (!closed) timer = setTimeout(poll, interval);
      }
    }
    async function stop(notifyServer) {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      for (const abort of requests) abort.abort();
      for (const id of links.keys()) disposeLink(id);
      for (const [id, connected] of peers) if (connected) on('onPeer', { peerId: id, connected: false });
      peers.clear(); outgoing.clear(); incoming.clear(); waitingIce.clear();
      status('closed');
      if (notifyServer && token && room) {
        const abort = new AbortController(), timeout = setTimeout(() => abort.abort(), 2000);
        try { await fetcher(url + route('/leave'), { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: '{}', signal: abort.signal, keepalive: true }); } catch (_) {}
        finally { clearTimeout(timeout); }
      }
    }
    const handle = {
      get room() { return room; }, peerId, get hostId() { return hostId; }, role,
      get credentials() { return { url, game, room, peerId, hostId, token, cursor }; },
      async send(id, payload) {
        if (closed) throw coded('The room is closed.', 'closed');
        if (!allowed(id) || !peers.get(id)) throw coded('That player is reconnecting. Try again shortly.', 'peer');
        const sent = stateFor(id), frame = { v: 1, type: 'message', stream: sent.stream, seq: sent.next, payload };
        const text = encode(frame), bytes = byteLength(text);
        if (sent.pending.size >= MAX_PENDING || sent.bytes + bytes > MAX_BUFFER) throw coded('The connection is busy. Wait for it to catch up.', 'backpressure');
        // Copy once so a caller cannot mutate a message while it awaits a relay retry.
        const entry = { frame: JSON.parse(text), bytes, last: Date.now(), busy: true };
        sent.pending.set(sent.next++, entry); sent.bytes += bytes;
        try { await sendFrame(id, entry.frame, false); status('connected', { peerId: id, transport: transportMode() }); }
        finally { entry.busy = false; }
      },
      async broadcast(payload) {
        const ids = Array.from(peers).filter(([, connected]) => connected).map(([id]) => id);
        await Promise.all(ids.map(id => handle.send(id, payload)));
      },
      close() { return stop(true); },
    };
    status('connecting');
    try {
      const joined = role === 'host'
        ? await request('/doodletick/rooms', { game, peerId, maxPeers: 4 }, false)
        : await request('/doodletick/rooms/' + roomInput + '/join', { game, peerId, ...(token ? { token } : {}) }, false);
      if (!joined || !/^[A-Z2-9]{6}$/.test(joined.room) || joined.peerId !== peerId || !validPeer(joined.hostId) || !/^[a-f0-9]{48}$/.test(joined.token)) throw new Error('The room could not be opened.');
      room = joined.room; hostId = joined.hostId; token = joined.token;
      // Each new transport instance re-authenticates through its game adapter;
      // discard old mailbox history and obtain a fresh authoritative snapshot.
      if (Number.isSafeInteger(joined.cursor) && joined.cursor >= 0) cursor = joined.cursor;
      if (role === 'host' && hostId !== peerId) throw new Error('The room host could not be verified.');
      await poll();
      if (closed) throw coded('This room is no longer available.', 'closed');
      return handle;
    } catch (error) { await stop(false); throw error; }
  }
  return { version: 1, create: config => connect(config, 'host'), join: config => connect(config, 'guest') };
});
