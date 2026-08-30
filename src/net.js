/* =========================================================================
   net.js — lobby discovery + peer connections.

   MQTT (public broker, WSS) is used ONLY for:
     • lobby beacons  — "a game is forming on this network"
     • WebRTC signalling — SDP offer/answer + ICE candidates
   Once a peer is connected, ALL game traffic runs over an RTCDataChannel
   directly between the host and that player. Nothing touches the broker.
   ========================================================================= */

const BASE = 'lit3d/v1';

const BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://test.mosquitto.org:8081/mqtt'
];

const MQTT_CDNS = [
  'https://unpkg.com/mqtt@5/dist/mqtt.min.js',
  'https://cdn.jsdelivr.net/npm/mqtt@5/dist/mqtt.min.js'
];

/* ---------------- ICE configuration ----------------

   STUN lets two peers discover their public address and punch a hole through
   most home routers. It is NOT enough on its own: a symmetric NAT allocates a
   different port per destination, so the address learned from the STUN server
   is not the one the other peer must send to, and the hole punch fails. That
   is common on mobile carriers and CGNAT, and on many corporate networks.

   A TURN server fixes that by relaying, because both peers can always reach it
   outbound. ICE only falls back to a relay when no direct path exists, so
   adding one costs nothing when peer-to-peer already works. A relay forwards
   bytes and nothing more — data channels are DTLS-encrypted end to end, so a
   TURN operator cannot read anyone's cards.

   There is deliberately no default. Every free public TURN relay either no
   longer exists or now requires an account, and shipping dead credentials is
   worse than shipping none: the game fails silently instead of telling you
   why. Set ONE of the two options below, then confirm it with
   tests/netcheck.html, which forces a relay-only connection and fails loudly
   if the relay is not genuinely working.

   Option 1 — static credentials (self-hosted coturn, or any fixed account):

     export const TURN_SERVERS = [
       { urls: 'turn:your.host:3478', username: 'user', credential: 'pass' },
       { urls: 'turns:your.host:5349?transport=tcp', username: 'user', credential: 'pass' }
     ];

   Option 2 — ephemeral credentials from a provider's API (Metered, Cloudflare
   and friends issue short-lived credentials rather than fixed ones). Point
   TURN_FETCH_URL at an endpoint returning a JSON array of RTCIceServer objects
   and it is fetched once at startup:

     export const TURN_FETCH_URL =
       'https://YOURSUB.metered.live/api/v1/turn/credentials?apiKey=YOURKEY';

   Note that anything you put in a static page is public. Prefer a provider
   that issues short-lived credentials, or a relay you can rate-limit. */
export const TURN_SERVERS = [];
export const TURN_FETCH_URL = '';

const STUN_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' }
];

/* Mutated in place by refreshIceServers(), and read by newPeer() at call time,
   so a late-arriving TURN list still reaches every connection made afterwards. */
const RTC_CFG = { iceServers: [...STUN_SERVERS, ...TURN_SERVERS] };

export function iceServers() { return RTC_CFG.iceServers.slice(); }
export function turnServers() {
  return RTC_CFG.iceServers.filter(s => /^turns?:/.test(
    Array.isArray(s.urls) ? s.urls[0] : s.urls));
}

let icePulled = false;
/** Pull ephemeral TURN credentials once, if an endpoint is configured. */
export async function refreshIceServers() {
  if (icePulled || !TURN_FETCH_URL) return RTC_CFG.iceServers;
  icePulled = true;
  try {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 6000);
    const r = await fetch(TURN_FETCH_URL, { signal: ctl.signal });
    clearTimeout(to);
    const list = await r.json();
    if (Array.isArray(list) && list.length) {
      RTC_CFG.iceServers = [...STUN_SERVERS, ...TURN_SERVERS, ...list];
    }
  } catch (e) {
    // Non-fatal: play continues on STUN alone, and a failed connection now
    // explains itself rather than blaming the host.
  }
  return RTC_CFG.iceServers;
}

const BEACON_MS = 2500;
const LOBBY_TTL = 9000;
/** How long a seat stays reclaimable after its player drops. */
export const REJOIN_MS = 10 * 60 * 1000;

export const randomId = (n = 8) =>
  Array.from({ length: n }, () => 'abcdefghijkmnpqrstuvwxyz23456789'[Math.floor(Math.random() * 32)]).join('');
export const randomCode = () =>
  Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');

/* ---------------- mqtt.js loader (with CDN fallback) ---------------- */
let mqttLoading = null;
export function ensureMqtt() {
  if (window.mqtt) return Promise.resolve(window.mqtt);
  if (mqttLoading) return mqttLoading;
  mqttLoading = new Promise((resolve, reject) => {
    let i = 0;
    const tryNext = () => {
      if (i >= MQTT_CDNS.length) { reject(new Error('Could not load mqtt.js from any CDN')); return; }
      const s = document.createElement('script');
      s.src = MQTT_CDNS[i++];
      s.onload = () => window.mqtt ? resolve(window.mqtt) : tryNext();
      s.onerror = () => tryNext();
      document.head.appendChild(s);
    };
    tryNext();
  });
  return mqttLoading;
}

/* ---------------- network key ----------------
   Players behind the same router share one public IP, so hashing it gives
   a stable "this Wi-Fi" bucket without ever publishing the address itself. */
function fnv(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}

const IP_SERVICES = [
  'https://api.ipify.org?format=json',
  'https://api64.ipify.org?format=json'
];

export async function getNetKey() {
  for (const url of IP_SERVICES) {
    try {
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), 4000);
      const r = await fetch(url, { signal: ctl.signal });
      clearTimeout(to);
      if (!r.ok) continue;
      const j = await r.json();
      if (!j || !j.ip) continue;
      let ip = String(j.ip);
      // IPv6 is per-device — bucket by the /64 prefix so one LAN groups together
      if (ip.includes(':')) ip = ip.split(':').slice(0, 4).join(':');
      return 'n' + fnv(ip);
    } catch (e) { /* try the next service */ }
  }
  return 'global';
}

/* ---------------- broker connection ---------------- */
export class Signal {
  constructor() {
    this.client = null;
    this.subs = new Map();     // topic -> Set(cb)
    this.brokerUrl = null;
  }

  async connect(onStatus) {
    const mqtt = await ensureMqtt();
    await refreshIceServers();          // before any peer connection is built
    for (const url of BROKERS) {
      if (onStatus) onStatus('Connecting to ' + new URL(url).hostname + '…');
      try {
        const client = await this._tryBroker(mqtt, url);
        this.client = client;
        this.brokerUrl = url;
        client.on('message', (topic, payload) => {
          let msg;
          try { msg = JSON.parse(payload.toString()); } catch (e) { return; }
          for (const [pattern, cbs] of this.subs) {
            if (topicMatches(pattern, topic)) cbs.forEach(cb => cb(msg, topic));
          }
        });
        client.on('close', () => { if (onStatus) onStatus('Broker connection lost'); });
        if (onStatus) onStatus('Connected via ' + new URL(url).hostname);
        return this;
      } catch (e) { /* next broker */ }
    }
    throw new Error('No public MQTT broker reachable. Check your network or firewall.');
  }

  _tryBroker(mqtt, url) {
    return new Promise((resolve, reject) => {
      const client = mqtt.connect(url, {
        clientId: 'lit3d_' + randomId(10),
        clean: true, connectTimeout: 6000, reconnectPeriod: 0,
        keepalive: 30
      });
      const fail = e => { try { client.end(true); } catch (_) {} reject(e || new Error('failed')); };
      const timer = setTimeout(() => fail(new Error('timeout')), 7000);
      client.once('connect', () => { clearTimeout(timer); resolve(client); });
      client.once('error', e => { clearTimeout(timer); fail(e); });
    });
  }

  sub(topic, cb) {
    if (!this.subs.has(topic)) {
      this.subs.set(topic, new Set());
      this.client.subscribe(topic, { qos: 0 });
    }
    this.subs.get(topic).add(cb);
  }
  unsub(topic, cb) {
    const set = this.subs.get(topic);
    if (!set) return;
    if (cb) set.delete(cb); else set.clear();
    if (!set.size) { this.subs.delete(topic); try { this.client.unsubscribe(topic); } catch (e) {} }
  }
  pub(topic, obj) {
    if (!this.client || !this.client.connected) return;
    this.client.publish(topic, JSON.stringify(obj), { qos: 0 });
  }
  close() {
    try { if (this.client) this.client.end(true); } catch (e) {}
    this.client = null; this.subs.clear();
  }
}

function topicMatches(pattern, topic) {
  const p = pattern.split('/'), t = topic.split('/');
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '#') return true;
    if (p[i] === '+') { if (t[i] === undefined) return false; continue; }
    if (p[i] !== t[i]) return false;
  }
  return p.length === t.length;
}

/* ---------------- end-to-end crypto for the relay path ----------------

   When WebRTC cannot punch through, game traffic falls back to the same MQTT
   broker used for signalling. That broker is public, and this is a hidden-
   information game — private hands must not be readable by anyone watching a
   topic. So relayed payloads are sealed with AES-GCM under a key both sides
   derive by ECDH, with the public halves riding along on the offer/answer we
   already exchange. The broker only ever sees ciphertext.

   This protects against eavesdropping, not against an active attacker who
   intercepts the key exchange itself. Room topics are unguessable random ids
   and this is a card game between friends, so that trade is deliberate. */

const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = str => Uint8Array.from(atob(str), c => c.charCodeAt(0));

export async function genKeyPair() {
  const kp = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
  const raw = await crypto.subtle.exportKey('raw', kp.publicKey);
  return { priv: kp.privateKey, pub: b64(raw) };
}

export async function deriveKey(priv, peerPub) {
  const pub = await crypto.subtle.importKey(
    'raw', unb64(peerPub), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  return crypto.subtle.deriveKey(
    { name: 'ECDH', public: pub }, priv,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function seal(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key,
    new TextEncoder().encode(JSON.stringify(obj)));
  return { i: b64(iv), d: b64(ct) };
}

async function unseal(key, p) {
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64(p.i) }, key, unb64(p.d));
  return JSON.parse(new TextDecoder().decode(pt));
}

/* Encryption is async, and the game depends on message order (deal before
   state, ask before its result). Chaining every send and every receive onto a
   per-peer promise keeps them strictly sequential. */
function chain(holder, prop, fn) {
  const prev = holder[prop] || Promise.resolve();
  holder[prop] = prev.then(fn).catch(() => {});
  return holder[prop];
}

const relayIn  = (lobbyId, peerId) => `${BASE}/rly/${lobbyId}/${peerId}/h`;
const relayOut = (lobbyId, peerId) => `${BASE}/rly/${lobbyId}/${peerId}/c`;

/* ---------------- shared peer plumbing ---------------- */

/** 'host' | 'srflx' | 'relay' | 'prflx' — what kind of path a candidate offers. */
export function candidateType(cand) {
  const s = (cand && (cand.candidate || cand)) || '';
  const m = /\btyp (\w+)/.exec(String(s));
  return m ? m[1] : 'unknown';
}

function newPeer(onIce, onOpen, onData, onClose) {
  const pc = new RTCPeerConnection(RTC_CFG);
  pc.onicecandidate = e => { if (e.candidate) onIce(e.candidate.toJSON()); };
  pc.onconnectionstatechange = () => {
    if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) onClose();
  };
  const wire = ch => {
    ch.onopen = () => onOpen(ch);
    ch.onclose = () => onClose();
    ch.onmessage = e => { try { onData(JSON.parse(e.data)); } catch (err) {} };
  };
  return { pc, wire };
}

/* ---------------- HOST ---------------- */
export class HostNet {
  /**
   * @param sig    connected Signal
   * @param netKey network bucket
   * @param info   { name, hostName, required }
   */
  constructor(sig, netKey, info) {
    this.sig = sig;
    this.netKey = netKey;
    this.id = randomId(10);
    this.code = randomCode();
    this.info = Object.assign({ name: 'Literature table', hostName: 'Host', required: 2 }, info);
    this.peers = new Map();      // peerId -> {pc, ch, name, pending:[]}
    // Seats whose player dropped mid-match, held open for REJOIN_MS.
    // Keyed by peerId, which is a random secret only that client and we know —
    // so it doubles as the resume credential and never goes on the wire in clear.
    this.vacant = new Map();     // peerId -> {seat, name, ts}
    // ICE can reach us before the offer that creates the peer entry does.
    // Dropping those candidates loses exactly the paths a cross-network
    // connection depends on, so hold them until the entry exists.
    this.preIce = new Map();     // peerId -> [candidate]
    this.open = false;
    this.started = false;
    this.onJoin = () => {};
    this.onRejoin = () => {};
    this.onLeave = () => {};
    this.onMessage = () => {};
    this._beacon = null;
    this._sigTopic = `${BASE}/sig/${this.id}/host`;
  }

  start() {
    this.open = true;
    this.sig.sub(this._sigTopic, m => this._onSignal(m));
    this._publishBeacon();
    this._beacon = setInterval(() => this._publishBeacon(), BEACON_MS);
  }

  _lobbyTopic() { return `${BASE}/net/${this.netKey}/lobbies`; }

  _publishBeacon() {
    if (!this.open) return;
    this.sig.pub(this._lobbyTopic(), {
      t: 'lobby', id: this.id, code: this.code,
      name: this.info.name, host: this.info.hostName,
      required: this.info.required,
      queued: this.humanCount(),
      players: [this.info.hostName, ...[...this.peers.values()].filter(p => p.ch).map(p => p.name)],
      started: this.started, vacant: this._pruneVacant(), live: true, ts: Date.now()
    });
  }

  humanCount() { return 1 + [...this.peers.values()].filter(p => p.ch).length; }

  /** Hold this player's seat open so they can come back to it. */
  markVacant(peerId, seat, name) {
    this.vacant.set(peerId, { seat, name, ts: Date.now() });
    this._publishBeacon();
  }
  _pruneVacant() {
    const now = Date.now();
    for (const [id, v] of this.vacant) if (now - v.ts > REJOIN_MS) this.vacant.delete(id);
    return this.vacant.size;
  }

  setRequired(n) { this.info.required = n; this._publishBeacon(); }

  _onSignal(m) {
    if (!m || !m.from) return;
    const topic = `${BASE}/sig/${this.id}/${m.from}`;

    if (m.t === 'offer') {
      this._pruneVacant();
      const vac = this.vacant.get(m.from);          // a seat we are holding for them
      if (this.started && !vac) {
        this.sig.pub(topic, { t: 'reject', reason: 'Match already started' }); return;
      }
      if (!vac && this.humanCount() >= 6) {
        this.sig.pub(topic, { t: 'reject', reason: 'Table is full' }); return;
      }
      if (this.peers.has(m.from)) return;

      const entry = {
        pc: null, ch: null,
        name: vac ? vac.name : (m.name || 'Player').slice(0, 14),
        pending: []
      };
      const { pc, wire } = newPeer(
        cand => this.sig.pub(topic, { t: 'ice', from: 'host', candidate: cand }),
        ch => {
          entry.ch = ch;
          if (vac) { this.vacant.delete(m.from); this.onRejoin(m.from, entry.name, vac.seat); }
          else this.onJoin(m.from, entry.name);
          this._publishBeacon();
        },
        data => this.onMessage(m.from, data),
        () => this._drop(m.from)
      );
      entry.pc = pc;
      pc.ondatachannel = e => wire(e.channel);
      const early = this.preIce.get(m.from);
      if (early) { entry.pending.push(...early); this.preIce.delete(m.from); }
      this.peers.set(m.from, entry);

      pc.setRemoteDescription({ type: 'offer', sdp: m.sdp })
        .then(() => {
          entry.pending.forEach(c => pc.addIceCandidate(c).catch(() => {}));
          entry.pending = [];
          return pc.createAnswer();
        })
        .then(a => pc.setLocalDescription(a))
        .then(() => this.sig.pub(topic, { t: 'answer', from: 'host', sdp: pc.localDescription.sdp }))
        .catch(() => this._drop(m.from));

    } else if (m.t === 'ice') {
      const entry = this.peers.get(m.from);
      if (!entry) {
        // Offer not processed yet — stash rather than discard.
        const q = this.preIce.get(m.from) || [];
        if (q.length < 64) q.push(m.candidate);
        this.preIce.set(m.from, q);
        return;
      }
      if (entry.pc && entry.pc.remoteDescription) entry.pc.addIceCandidate(m.candidate).catch(() => {});
      else entry.pending.push(m.candidate);

    } else if (m.t === 'bye') {
      this._drop(m.from);
    }
  }

  _drop(peerId) {
    const e = this.peers.get(peerId);
    if (!e) return;
    this.peers.delete(peerId);
    this.preIce.delete(peerId);
    try { if (e.ch) e.ch.close(); } catch (x) {}
    try { if (e.pc) e.pc.close(); } catch (x) {}
    this.onLeave(peerId, e.name);
    this._publishBeacon();
  }

  connectedPeers() {
    return [...this.peers.entries()].filter(([, e]) => e.ch).map(([id, e]) => ({ id, name: e.name }));
  }

  sendTo(peerId, obj) {
    const e = this.peers.get(peerId);
    if (!e || !e.ch || e.ch.readyState !== 'open') return false;
    e.ch.send(JSON.stringify(obj));
    return true;
  }
  broadcast(obj) { for (const id of this.peers.keys()) this.sendTo(id, obj); }

  markStarted() { this.started = true; this._publishBeacon(); }

  close() {
    this.open = false;
    if (this._beacon) clearInterval(this._beacon);
    this.sig.pub(this._lobbyTopic(), { t: 'lobby', id: this.id, live: false, ts: Date.now() });
    for (const id of [...this.peers.keys()]) this._drop(id);
    this.sig.unsub(this._sigTopic);
  }
}

/* ---------------- CLIENT ---------------- */
export class ClientNet {
  constructor(sig, netKey, peerId) {
    this.sig = sig;
    this.netKey = netKey;
    // Reusing the same peerId across a reload is what lets the host recognise
    // us and give back the seat it was holding.
    this.peerId = peerId || randomId(10);
    this.lobbies = new Map();
    this.onLobbies = () => {};
    this.onMessage = () => {};
    this.onJoined = () => {};
    this.onRejected = () => {};
    this.onClosed = () => {};
    this.pc = null; this.ch = null; this.lobby = null;
    this._scanTopic = null; this._sweep = null; this._sigTopic = null;
    this._pending = [];
  }

  /** showAll=false → only lobbies on this network bucket. */
  discover(showAll) {
    this.stopDiscovery();
    this.lobbies.clear();
    this._scanTopic = showAll ? `${BASE}/net/+/lobbies` : `${BASE}/net/${this.netKey}/lobbies`;
    this._onBeacon = m => {
      if (!m || m.t !== 'lobby' || !m.id) return;
      if (m.live === false || m.started) this.lobbies.delete(m.id);
      else this.lobbies.set(m.id, Object.assign({}, m, { seen: Date.now() }));
      this._emit();
    };
    this.sig.sub(this._scanTopic, this._onBeacon);
    this._sweep = setInterval(() => {
      const now = Date.now();
      let changed = false;
      for (const [id, l] of this.lobbies) if (now - l.seen > LOBBY_TTL) { this.lobbies.delete(id); changed = true; }
      if (changed) this._emit();
    }, 1500);
  }
  _emit() { this.onLobbies([...this.lobbies.values()].sort((a, b) => a.name.localeCompare(b.name))); }

  stopDiscovery() {
    if (this._scanTopic) this.sig.unsub(this._scanTopic, this._onBeacon);
    if (this._sweep) clearInterval(this._sweep);
    this._scanTopic = null; this._sweep = null;
  }

  /** Listen across every network bucket for one specific lobby id.
      Resolves with the beacon, or null on timeout. */
  probeLobby(lobbyId, timeoutMs) {
    return new Promise(resolve => {
      const topic = `${BASE}/net/+/lobbies`;
      let settled = false;
      const finish = v => {
        if (settled) return;
        settled = true;
        this.sig.unsub(topic, cb);
        clearTimeout(timer);
        resolve(v);
      };
      const cb = m => {
        if (m && m.t === 'lobby' && m.id === lobbyId) {
          finish(m.live === false ? null : m);
        }
      };
      this.sig.sub(topic, cb);
      const timer = setTimeout(() => finish(null), timeoutMs || 6000);
    });
  }

  findByCode(code) {
    for (const l of this.lobbies.values()) if (l.code === code.toUpperCase()) return l;
    return null;
  }

  /** Search EVERY network bucket for a room code. The code is the mechanism for
      playing with someone on a different network, so it must not be limited to
      the bucket we happen to be subscribed to. */
  probeByCode(code, timeoutMs) {
    const want = String(code || '').toUpperCase();
    const local = this.findByCode(want);
    if (local) return Promise.resolve(local);

    return new Promise(resolve => {
      const topic = `${BASE}/net/+/lobbies`;
      let settled = false;
      const finish = v => {
        if (settled) return;
        settled = true;
        this.sig.unsub(topic, cb);
        clearTimeout(timer);
        resolve(v);
      };
      const cb = m => {
        if (m && m.t === 'lobby' && m.code === want && m.live !== false && !m.started) {
          this.lobbies.set(m.id, Object.assign({}, m, { seen: Date.now() }));
          finish(this.lobbies.get(m.id));
        }
      };
      this.sig.sub(topic, cb);
      const timer = setTimeout(() => finish(null), timeoutMs || 7000);
    });
  }

  join(lobby, name, resume) {
    this.lobby = lobby;
    // Handshake phase, so a failure can name its own cause instead of blaming
    // the host for everything. 'offering' = the host never replied (signalling);
    // 'negotiating' = the host replied but no network path could be opened (NAT).
    this.phase = 'offering';
    this.candTypes = { host: 0, srflx: 0, relay: 0, prflx: 0, unknown: 0 };
    this._sigTopic = `${BASE}/sig/${lobby.id}/${this.peerId}`;
    const hostTopic = `${BASE}/sig/${lobby.id}/host`;

    this.sig.sub(this._sigTopic, m => {
      if (!m) return;
      if (m.t === 'answer') {
        this.phase = 'negotiating';
        this.pc.setRemoteDescription({ type: 'answer', sdp: m.sdp })
          .then(() => {
            this._pending.forEach(c => this.pc.addIceCandidate(c).catch(() => {}));
            this._pending = [];
          }).catch(() => this.onClosed('Handshake failed'));
      } else if (m.t === 'ice') {
        if (this.pc && this.pc.remoteDescription) this.pc.addIceCandidate(m.candidate).catch(() => {});
        else this._pending.push(m.candidate);
      } else if (m.t === 'reject') {
        this.onRejected(m.reason || 'Rejected by host');
        this.leave(false);
      }
    });

    const { pc, wire } = newPeer(
      cand => {
        this.candTypes[candidateType(cand)] = (this.candTypes[candidateType(cand)] || 0) + 1;
        this.sig.pub(hostTopic, { t: 'ice', from: this.peerId, candidate: cand });
      },
      ch => { this.ch = ch; this.phase = 'connected'; this.onJoined(); },
      data => this.onMessage(data),
      () => { if (this.ch) { this.ch = null; this.onClosed('Connection to host lost'); } }
    );
    this.pc = pc;

    /* An ICE failure before the channel ever opens used to be completely
       silent — onClose short-circuits on `this.ch` being null — so the only
       symptom was the 20s timeout claiming the host never responded. That is
       the wrong diagnosis and it sends you looking at the lobby code. */
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState !== 'failed' || this.ch) return;
      clearTimeout(this._joinTimer);
      this.onClosed(this.noRouteMessage());
      this.leave(false);
    };
    const ch = pc.createDataChannel('game', { ordered: true });
    wire(ch);

    pc.createOffer()
      .then(o => pc.setLocalDescription(o))
      .then(() => this.sig.pub(hostTopic, {
        t: 'offer', from: this.peerId, name, resume: !!resume, sdp: pc.localDescription.sdp
      }))
      .catch(() => this.onClosed('Could not create offer'));

    // If nothing has completed, say which half of the process stalled.
    this._joinTimer = setTimeout(() => {
      if (this.ch) return;
      this.onClosed(this.phase === 'offering'
        ? 'The host never answered. They may have closed the table, or signalling is blocked here.'
        : this.noRouteMessage());
      this.leave(false);
    }, 30000);
  }

  /** Reached the host over the broker but could not open a media path. */
  noRouteMessage() {
    const c = this.candTypes || {};
    return c.srflx
      ? 'Reached the host, but no direct network path could be opened between you. ' +
        'One of your networks blocks peer-to-peer (typically mobile data or a strict firewall) — ' +
        'this needs a TURN relay.'
      : 'Could not discover your public address (no STUN reply), so no connection to the host was possible. ' +
        'A firewall is probably blocking UDP.';
  }

  send(obj) {
    if (!this.ch || this.ch.readyState !== 'open') return false;
    this.ch.send(JSON.stringify(obj));
    return true;
  }

  leave(notify = true) {
    if (this._joinTimer) { clearTimeout(this._joinTimer); this._joinTimer = null; }
    if (notify && this.lobby) {
      this.sig.pub(`${BASE}/sig/${this.lobby.id}/host`, { t: 'bye', from: this.peerId });
    }
    if (this._sigTopic) { this.sig.unsub(this._sigTopic); this._sigTopic = null; }
    try { if (this.ch) this.ch.close(); } catch (e) {}
    try { if (this.pc) this.pc.close(); } catch (e) {}
    this.ch = null; this.pc = null; this.lobby = null; this._pending = [];
  }
}
