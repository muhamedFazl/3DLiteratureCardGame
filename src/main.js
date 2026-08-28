/* =========================================================================
   main.js — application wiring and the app-level state machine.

     MENU ──▶ HOSTING (lobby, waiting)  ──▶ MATCH
          ──▶ BROWSING ──▶ QUEUED       ──▶ MATCH
          ──▶ MATCH (bots, offline)
   ========================================================================= */

import {
  SEAT_TEAM, TEAM_CSS, TEAM_NAME, HS_NAME, cardLabel,
  hasLegalAskClient, shuffle
} from './engine.js';
import * as View from './view.js';
import * as UI from './ui.js';
import { Signal, HostNet, ClientNet, getNetKey, randomId, REJOIN_MS } from './net.js';
import { GameHost, makeIo, PACE } from './game.js';

/* ---------------- app state ---------------- */
const App = {
  mode: 'menu',          // menu | hosting | browsing | queued | match
  isHost: false,
  online: false,
  sig: null,
  netKey: 'global',
  hostNet: null,
  clientNet: null,
  gameHost: null,
  // Host lobby seating: a fixed array of 6 slots, one per seat. Seat parity
  // decides the team (SEAT_TEAM), so "assign a team" means "put them in a seat
  // of that colour" — which keeps teams 3v3 by construction.
  roster: [],            // [{kind:'host'|'peer'|'bot', peerId?, name}]
  hostSeat: 0,
  pickedSeat: -1,        // seat the host has selected for a swap, or -1
  seatOfPeer: new Map(), // peerId -> seat (during a match)
  peerOfSeat: new Map(),
  required: 2,
  // client-side view of the match
  mySeat: 0,
  myHand: [],
  state: null,
  animating: false,
  dealing: false,
  joiningId: null,
  showAll: false,
  // derived locally from public events only — identical on all six clients
  streak: 0,
  streakSeat: -1
};

/* ---------------- boot ---------------- */
View.initView(document.getElementById('app'), {
  onCardClick: cid => {
    const sel = View.setSelected(cid);
    if (sel) UI.setMsg(View.cardInfoText(sel, App.myHand));
  },
  onSeatClick: seat => {
    if (!canAct()) return;
    if (SEAT_TEAM[seat] === SEAT_TEAM[App.mySeat]) {
      UI.setMsg(nameOf(seat) + ' is your teammate — you may not ask them for cards.');
      return;
    }
    if (!App.state.counts[seat]) {
      UI.setMsg(nameOf(seat) + ' has no cards left and cannot be asked.');
      return;
    }
    UI.openAsk({ state: App.state, hand: App.myHand, mySeat: App.mySeat }, seat);
  }
});
UI.wire();
UI.restorePlayerName();
UI.showScreen('menu');

/* Respect the OS preference by default, but let it be overridden either way:
   plenty of people who need this have never set the system flag. */
const RM_QUERY = window.matchMedia('(prefers-reduced-motion: reduce)');
function applyMotionPref() {
  const stored = localStorage.getItem('lit.motion');
  const reduce = stored === 'off' || (stored !== 'on' && RM_QUERY.matches);
  View.setReducedMotion(reduce);
  UI.setMotionToggle(reduce);
}
if (RM_QUERY.addEventListener) RM_QUERY.addEventListener('change', applyMotionPref);
applyMotionPref();
UI.on.toggleMotion = () => {
  const next = View.isReducedMotion() ? 'on' : 'off';   // 'on' = motion enabled
  localStorage.setItem('lit.motion', next);
  applyMotionPref();
};

/* =========================================================================
   Reconnect memory. We remember which lobby we were in and, crucially, the
   peerId we used — the host holds our seat against that same id, so reusing
   it is what proves we are the same player coming back.
   ========================================================================= */
const SESSION_KEY = 'lit.session';

function saveSession(patch) {
  try {
    const cur = loadSession() || {};
    localStorage.setItem(SESSION_KEY, JSON.stringify(
      Object.assign(cur, patch, { ts: Date.now() })));
  } catch (e) {}
}
function loadSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); }
  catch (e) { return null; }
}
function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
}
/** A stable per-browser id, reused across reloads so the host recognises us. */
function myPeerId() {
  let id = '';
  try { id = localStorage.getItem('lit.peerId') || ''; } catch (e) {}
  if (!id) {
    id = randomId(10);
    try { localStorage.setItem('lit.peerId', id); } catch (e) {}
  }
  return id;
}

const nameOf = seat => (App.state && App.state.seats[seat]) ? App.state.seats[seat].name : 'Seat ' + seat;

function canAct() {
  return App.mode === 'match' && App.state && !App.state.over &&
    App.state.turn === App.mySeat && !App.animating && !App.dealing;
}

/* Animations are driven by requestAnimationFrame, which browsers pause in a
   backgrounded tab — so a tween's completion callback may never fire. Without
   a watchdog the client's controls would stay disabled, and if it were that
   player's turn the whole match would wait on them. The host's timers keep
   running regardless, so we force the flag down a little after the host has
   already moved on. */
let animGuard = null;
function beginAnim(maxMs) {
  App.animating = true;
  if (animGuard) clearTimeout(animGuard);
  animGuard = setTimeout(() => {
    animGuard = null;
    if (!App.animating) return;
    App.animating = false;
    if (App.state) View.sync(App.myHand, App.state.counts, 0);
    updateControls();
  }, maxMs);
}
function endAnim() {
  if (animGuard) { clearTimeout(animGuard); animGuard = null; }
  App.animating = false;
}

function updateControls() {
  const act = canAct();
  UI.setTurnControls(act, act ? hasLegalAskClient(App.state, App.myHand, App.mySeat) : false);
}

/* =========================================================================
   Client-side message handling — identical for offline bots, host, and peer
   ========================================================================= */
function handleMsg(msg) {
  if (!msg) return;
  switch (msg.k) {

    case 'welcome':
      App.mySeat = msg.mySeat;
      App.state = null;
      App.myHand = [];
      App.streak = 0; App.streakSeat = -1;
      App.mode = 'match';
      UI.clearQueueSeating();
      View.setSeats(msg.seats, App.mySeat);
      UI.clearLog();
      UI.overlay('joinOverlay', false);
      UI.overlay('hostOverlay', false);
      UI.overlay('gameOver', false);
      UI.showScreen('hud');
      UI.toast('');
      if (App.online && !App.isHost && App.clientNet && App.clientNet.lobby) {
        const l = App.clientNet.lobby;
        saveSession({ lobbyId: l.id, code: l.code, hostName: l.host, netKey: App.netKey });
      }
      document.getElementById('goRestart').style.display =
        (App.online && !App.isHost) ? 'none' : '';
      break;

    case 'hand':
      App.myHand = msg.hand;
      if (!App.animating && !App.dealing && App.state) View.sync(App.myHand, App.state.counts);
      break;

    case 'deal':
      App.dealing = true;
      UI.setTitle('Dealing…'); UI.setMsg('');
      View.animateDeal(App.myHand, msg.counts, () => {
        App.dealing = false;
        if (App.state) View.sync(App.myHand, App.state.counts);
        updateControls();
      });
      break;

    case 'state':
      App.state = msg.state;
      UI.refreshScore(App.state);
      UI.refreshSeatStrip(App.state, App.mySeat);
      // hold the ring sweep until the in-flight animation has landed
      View.setActive(App.state.turn, App.animating ? 560 : 0);
      if (!App.animating && !App.dealing) View.sync(App.myHand, App.state.counts);
      updateControls();
      break;

    case 'turn': {
      const s = App.state ? App.state.seats[msg.seat] : null;
      const nm = s ? s.name : 'Player';
      const team = s ? s.team : 0;
      UI.setTitle('<span style="color:' + TEAM_CSS[team] + '">' +
        (msg.seat === App.mySeat ? 'Your turn' : nm + "'s turn") + '</span>' +
        ' <span class="sub">(' + TEAM_NAME[team] + ')</span>');
      if (msg.seat === App.mySeat) {
        UI.setMsg(hasLegalAskClient(App.state, App.myHand, App.mySeat)
          ? 'Click an opponent, or use the Ask button.'
          : 'No legal ask left — you must declare a half-suit.');
      } else {
        UI.setMsg('Waiting…');
      }
      updateControls();
      break;
    }

    case 'lobbyseat':
      App.lobbySeat = msg.seat;
      App.lobbyRoster = msg.roster;
      UI.updateQueueSeating(msg.roster, msg.seat);
      break;

    case 'ev':
      handleEvent(msg);
      break;

    case 'reject':
      UI.setMsg(msg.reason || 'Move rejected.');
      updateControls();
      break;

    case 'over':
      endAnim();
      clearSession();                       // nothing left to come back to
      UI.setTitle('Match complete'); UI.setMsg('');
      UI.log('Match over. Blue ' + msg.scores[0] + ' — Red ' + msg.scores[1] + '.', 'cl');
      setTimeout(() => UI.showOver(msg.scores, App.mySeat), 600);
      updateControls();
      break;
  }
}

function handleEvent(msg) {
  const cls = { hit: 'ok', miss: 'no', claim: 'cl', sys: 'sys' }[msg.kind] || '';
  UI.log(msg.text, cls);
  const d = msg.data;

  // "Alice asked Bob for Q♥ — HIT!" → hold the verdict back so the animation
  // isn't spoiled by its own caption. The banner used to print the outcome
  // before the card had even left the other player's hand.
  const neutral = msg.text.split(' — ')[0];

  if (msg.kind === 'hit' && d) {
    if (d.to === App.streakSeat) App.streak++;
    else { App.streakSeat = d.to; App.streak = 1; }

    UI.setMsg(neutral);
    setTimeout(() => UI.setMsg(msg.text), 300);      // verdict lands on the apex hold
    beginAnim(1400);                                // flight is 1080ms
    updateControls();
    View.animateTransfer(d.from, d.to, d.card, App.streak, () => {
      endAnim();
      if (App.state) View.sync(App.myHand, App.state.counts, 260);
      updateControls();
    });

  } else if (msg.kind === 'miss' && d) {
    App.streak = 0; App.streakSeat = -1;
    UI.setMsg(neutral);
    setTimeout(() => UI.setMsg(msg.text), 190);      // verdict lands on the hard stop
    UI.flashBanner();
    beginAnim(1000);                                // miss is 560ms
    updateControls();
    // NB: the event is named from the CARD's point of view, so on a miss
    // d.to is the asker and d.from is the player who refused.
    View.animateMiss(d.to, d.from, d.card, () => {
      endAnim();
      if (App.state) View.sync(App.myHand, App.state.counts, 260);
      updateControls();
    });

  } else if (msg.kind === 'claim' && d) {
    App.streak = 0; App.streakSeat = -1;
    UI.setMsg(msg.text);
    beginAnim(2400);                                // claim sweep is ~1900ms
    updateControls();
    View.animateClaim(d.hs, d.truth, () => {
      endAnim();
      if (App.state) View.sync(App.myHand, App.state.counts);
      updateControls();
    });

  } else {
    UI.setMsg(msg.text);
  }
}

/* ---------------- outgoing actions ---------------- */
function sendAction(msg) {
  if (App.online && !App.isHost) App.clientNet.send(msg);
  else if (App.gameHost) App.gameHost.onAction(App.mySeat, msg);
}

/* =========================================================================
   Offline / bots
   ========================================================================= */
function startBotsMatch() {
  teardownMatch();
  App.online = false;
  App.isHost = true;
  const seats = [{ name: UI.playerName(), isBot: false }];
  const botNames = ['Bot B1', 'Bot A1', 'Bot B2', 'Bot A2', 'Bot B3'];
  botNames.forEach(n => seats.push({ name: n, isBot: true }));

  const io = makeIo(0, handleMsg, () => {});
  App.gameHost = new GameHost(seats, io);
  App.gameHost.start();
}

/* =========================================================================
   Hosting
   ========================================================================= */
async function ensureSignal() {
  if (App.sig && App.sig.client && App.sig.client.connected) return App.sig;
  UI.toast('Connecting to the lobby broker…');
  const sig = new Signal();
  await sig.connect(s => UI.toast(s));
  App.sig = sig;
  App.netKey = await getNetKey();
  UI.toast('');
  return sig;
}

const BOT_POOL = ['Bot Alpha', 'Bot Bravo', 'Bot Cass', 'Bot Delta', 'Bot Echo', 'Bot Foxtrot'];

function freshRoster(hostName) {
  const r = [];
  for (let i = 0; i < 6; i++) r.push({ kind: 'bot', name: BOT_POOL[i] });
  r[0] = { kind: 'host', name: hostName };
  return r;
}
const rosterHumans = () => App.roster.filter(r => r && r.kind !== 'bot').length;
const seatOfPeerId = id => App.roster.findIndex(r => r && r.peerId === id);

/** Public seating summary — safe to share, it is only names and seats. */
function rosterSummary() {
  return App.roster.map((r, i) => ({
    seat: i, name: r.name, bot: r.kind === 'bot', team: SEAT_TEAM[i]
  }));
}

/** Tell every queued player where they are sitting and who else is where. */
function pushLobbySeats() {
  if (!App.hostNet) return;
  const roster = rosterSummary();
  for (const p of App.hostNet.connectedPeers()) {
    const seat = seatOfPeerId(p.id);
    App.hostNet.sendTo(p.id, { k: 'lobbyseat', seat, roster });
  }
}

function swapSeats(a, b) {
  if (a === b || a < 0 || b < 0) return;
  const tmp = App.roster[a];
  App.roster[a] = App.roster[b];
  App.roster[b] = tmp;
  App.hostSeat = App.roster.findIndex(r => r.kind === 'host');
  renderHost();
  pushLobbySeats();
}

async function startHosting() {
  try {
    UI.overlay('hostOverlay', true);
    UI.el('hostCode').textContent = '····';
    UI.el('hostPlayers').innerHTML = '<div class="dim">Connecting…</div>';
    await ensureSignal();
  } catch (e) {
    UI.overlay('hostOverlay', false);
    UI.toast(e.message || 'Could not reach a broker.', 'bad');
    return;
  }

  App.mode = 'hosting';
  App.isHost = true;
  App.online = true;
  App.required = 2;

  const hostName = UI.playerName();
  App.hostNet = new HostNet(App.sig, App.netKey, {
    name: hostName + "'s table", hostName, required: App.required
  });
  App.roster = freshRoster(hostName);
  App.hostSeat = 0;
  App.pickedSeat = -1;

  App.hostNet.onJoin = (peerId, name) => {
    if (seatOfPeerId(peerId) >= 0) return;
    const free = App.roster.findIndex(r => r.kind === 'bot');
    if (free < 0) return;                       // table full; HostNet also guards this
    App.roster[free] = { kind: 'peer', peerId, name };
    UI.log(name + ' joined the queue — seated on ' + TEAM_NAME[SEAT_TEAM[free]] + '.', 'sys');
    renderHost();
    pushLobbySeats();
  };
  App.hostNet.onRejoin = (peerId, name, seat) => {
    App.seatOfPeer.set(peerId, seat);
    App.peerOfSeat.set(seat, peerId);
    // restoreHuman broadcasts the 'reconnected' line to every client already
    if (App.gameHost) App.gameHost.restoreHuman(seat, name);
    renderHost();
  };
  App.hostNet.onLeave = peerId => {
    const i = seatOfPeerId(peerId);
    if (i >= 0 && App.mode !== 'match') {
      App.roster[i] = { kind: 'bot', name: BOT_POOL[i] };
      pushLobbySeats();
    }
    if (App.mode === 'match' && App.seatOfPeer.has(peerId)) {
      const seat = App.seatOfPeer.get(peerId);
      // Capture the name BEFORE convertToBot appends " (bot)", so the seat can
      // be handed back under the player's own name if they return.
      const original = App.gameHost ? App.gameHost.engine.players[seat].name : 'Player';
      App.seatOfPeer.delete(peerId);
      App.peerOfSeat.delete(seat);
      App.hostNet.markVacant(peerId, seat, original);
      if (App.gameHost) App.gameHost.convertToBot(seat);
    }
    renderHost();
  };
  App.hostNet.onMessage = (peerId, data) => {
    if (App.mode !== 'match' || !App.gameHost) return;
    const seat = App.seatOfPeer.get(peerId);
    if (seat === undefined) return;
    App.gameHost.onAction(seat, data);
  };

  App.hostNet.start();
  renderHost();
}

function renderHost() {
  if (!App.hostNet) return;
  App.hostNet.setRequired(App.required);
  UI.renderHostPanel({
    code: App.hostNet.code,
    netKey: App.netKey,
    roster: App.roster,
    humans: rosterHumans(),
    picked: App.pickedSeat,
    required: App.required
  });
}

function cancelHosting() {
  if (App.hostNet) { App.hostNet.close(); App.hostNet = null; }
  App.roster = []; App.pickedSeat = -1;
  App.mode = 'menu';
  App.online = false;
  UI.overlay('hostOverlay', false);
  UI.toast('Table closed.', 'warn');
}

function startHostedMatch() {
  if (!App.hostNet) return;
  if (rosterHumans() < App.required) return;

  App.hostNet.markStarted();
  App.seatOfPeer.clear(); App.peerOfSeat.clear();

  const seats = App.roster.map((r, i) => {
    if (r.kind === 'peer') { App.seatOfPeer.set(r.peerId, i); App.peerOfSeat.set(i, r.peerId); }
    return { name: r.name, isBot: r.kind === 'bot' };
  });
  App.hostSeat = App.roster.findIndex(r => r.kind === 'host');

  const io = makeIo(App.hostSeat, handleMsg, (seat, msg) => {
    if (seat === null) {
      for (const [pid] of App.seatOfPeer) App.hostNet.sendTo(pid, msg);
    } else {
      const pid = App.peerOfSeat.get(seat);
      if (pid) App.hostNet.sendTo(pid, msg);
    }
  });

  if (App.gameHost) App.gameHost.destroy();
  App.gameHost = new GameHost(seats, io);
  App.mode = 'match';
  UI.overlay('hostOverlay', false);
  App.gameHost.start();
}

/* =========================================================================
   Joining
   ========================================================================= */
/* Client callbacks live here so both the lobby browser and the rejoin
   flow can share one wired ClientNet. */
function wireClientNet() {
  if (App.clientNet && App.clientNet._wired) return;
  if (!App.clientNet) App.clientNet = new ClientNet(App.sig, App.netKey, myPeerId());
  App.clientNet.onLobbies = list => {
    if (App.mode === 'browsing') UI.renderLobbies(list, App.joiningId);
    if (App.mode === 'queued' && App.clientNet.lobby) {
      const mine = list.find(l => l.id === App.clientNet.lobby.id);
      if (mine) UI.updateQueueView(mine);
    }
  };
  App.clientNet.onMessage = handleMsg;
  App.clientNet.onJoined = () => {
    App.mode = 'queued';
    App.joiningId = null;
    const l = App.clientNet.lobby;
    if (l) saveSession({ lobbyId: l.id, code: l.code, hostName: l.host, netKey: App.netKey });
    UI.toast('Connected to the table — waiting for the host.', 'good');
    UI.showQueueView(true, {
      name: App.clientNet.lobby.name,
      queued: App.clientNet.lobby.queued,
      required: App.clientNet.lobby.required,
      players: App.clientNet.lobby.players || []
    });
  };
  App.clientNet.onRejected = reason => {
    App.joiningId = null;
    App.mode = 'browsing';
    UI.showQueueView(false);
    UI.toast(reason, 'bad');
  };
  App.clientNet.onClosed = reason => {
    App.joiningId = null;
    if (App.mode === 'match') {
      UI.setMsg(reason + ' — returning to the menu.');
      setTimeout(() => quitToMenu(), 2200);
    } else {
      App.mode = 'browsing';
      UI.showQueueView(false);
    }
    UI.toast(reason, 'bad');
  };
  App.clientNet._wired = true;
}

async function startBrowsing() {
  UI.overlay('joinOverlay', true);
  UI.showQueueView(false);
  UI.renderLobbies([]);
  try {
    await ensureSignal();
  } catch (e) {
    UI.toast(e.message || 'Could not reach a broker.', 'bad');
    UI.el('lobbyList').innerHTML =
      '<div class="empty">Could not reach a signalling broker.<br>You can still play offline with bots.</div>';
    return;
  }
  App.mode = 'browsing';
  App.online = true;
  App.isHost = false;

  wireClientNet();
  App.clientNet.discover(App.showAll);
}

function joinLobby(lobby) {
  if (!App.clientNet) return;
  App.joiningId = lobby.id;
  UI.renderLobbies([...App.clientNet.lobbies.values()], App.joiningId);
  UI.toast('Connecting to ' + lobby.name + '…');
  App.clientNet.join(lobby, UI.playerName());
}

function leaveQueue() {
  clearSession();
  UI.clearQueueSeating();                           // leaving on purpose is not a dropout
  if (App.clientNet) App.clientNet.leave();
  App.joiningId = null;
  if (App.mode === 'queued') App.mode = 'browsing';
  UI.showQueueView(false);
}

/* =========================================================================
   Teardown
   ========================================================================= */
function teardownMatch() {
  if (App.gameHost) { App.gameHost.destroy(); App.gameHost = null; }
  endAnim(); App.dealing = false;
  App.state = null; App.myHand = [];
  View.clearTable();
}

function quitToMenu() {
  clearSession();
  teardownMatch();
  if (App.hostNet) { App.hostNet.close(); App.hostNet = null; }
  if (App.clientNet) { App.clientNet.leave(); App.clientNet.stopDiscovery(); }
  App.roster = []; App.pickedSeat = -1; App.seatOfPeer.clear(); App.peerOfSeat.clear();
  App.mode = 'menu'; App.online = false; App.isHost = false;
  UI.overlay('joinOverlay', false);
  UI.overlay('hostOverlay', false);
  UI.overlay('gameOver', false);
  UI.overlay('askModal', false);
  UI.overlay('declModal', false);
  UI.showScreen('menu');
  UI.toast('');
}

/* =========================================================================
   Rejoin — offer to put a returning player back in the seat being held.
   ========================================================================= */
let pendingRejoin = null;

async function offerRejoin() {
  const sess = loadSession();
  if (!sess || !sess.lobbyId) return;
  if (Date.now() - (sess.ts || 0) > REJOIN_MS) { clearSession(); return; }

  try { await ensureSignal(); } catch (e) { return; }

  if (!App.clientNet) App.clientNet = new ClientNet(App.sig, App.netKey, myPeerId());
  UI.toast('Checking whether your table is still running…');
  const lobby = await App.clientNet.probeLobby(sess.lobbyId, 6000);
  UI.toast('');

  // Only offer if the table is alive AND a seat is actually being held for
  // someone — otherwise there is nothing to return to.
  if (!lobby || !lobby.vacant) { clearSession(); return; }
  if (App.mode !== 'menu') return;          // they already started doing something

  pendingRejoin = { sess, lobby };
  UI.showRejoin(sess, lobby);
}

UI.on.rejoinYes = () => {
  UI.hideRejoin();
  if (!pendingRejoin) return;
  const { lobby } = pendingRejoin;
  pendingRejoin = null;
  App.mode = 'browsing';
  App.online = true;
  App.isHost = false;
  wireClientNet();
  UI.toast('Reconnecting…');
  App.clientNet.join(lobby, UI.playerName(), true);
};
UI.on.rejoinNo = () => {
  UI.hideRejoin();
  pendingRejoin = null;
  clearSession();
};

/* =========================================================================
   Callbacks
   ========================================================================= */
UI.on.play = () => startBrowsing();
UI.on.host = () => startHosting();
UI.on.bots = () => { UI.overlay('joinOverlay', false); leaveQueue(); startBotsMatch(); };

UI.on.joinLobby = joinLobby;
UI.on.joinCode = code => {
  if (!code || !App.clientNet) return;
  const l = App.clientNet.findByCode(code);
  if (l) joinLobby(l);
  else UI.toast('No table with code ' + code + ' on this network. Try “Show all networks”.', 'bad');
};
UI.on.leaveQueue = leaveQueue;
UI.on.toggleShowAll = v => {
  App.showAll = v;
  if (App.clientNet && App.mode === 'browsing') App.clientNet.discover(v);
};

UI.on.startMatch = startHostedMatch;
UI.on.cancelHost = cancelHosting;
UI.on.requiredChange = delta => {
  App.required = Math.max(2, Math.min(6, App.required + delta));
  renderHost();
};
UI.on.shuffleSeats = () => {
  if (!App.roster.length) return;
  App.roster = shuffle(App.roster.slice());
  App.hostSeat = App.roster.findIndex(r => r.kind === 'host');
  App.pickedSeat = -1;
  renderHost();
  pushLobbySeats();
};

/* Click one seat then another to swap their occupants. Works for humans and
   bots alike, so the host can build whatever two teams they want. */
UI.on.seatClick = i => {
  if (!App.roster.length) return;
  if (App.pickedSeat === -1) App.pickedSeat = i;
  else if (App.pickedSeat === i) App.pickedSeat = -1;
  else { const a = App.pickedSeat; App.pickedSeat = -1; swapSeats(a, i); return; }
  renderHost();
};

UI.on.openAsk = () => {
  if (!canAct()) return;
  UI.openAsk({ state: App.state, hand: App.myHand, mySeat: App.mySeat });
};
UI.on.openDeclare = () => {
  if (!canAct()) return;
  UI.openDeclare({ state: App.state, hand: App.myHand, mySeat: App.mySeat });
};
UI.on.confirmAsk = (target, card) => sendAction({ k: 'ask', target, card });
UI.on.confirmDeclare = hs => sendAction({ k: 'declare', hs });

UI.on.restart = () => {
  if (!App.online) { startBotsMatch(); return; }
  if (App.isHost && App.gameHost) {
    const seats = App.gameHost.engine.players.map(p => ({ name: p.name, isBot: p.isBot }));
    App.gameHost.destroy();
    teardownMatch();
    const io = makeIo(App.hostSeat, handleMsg, (seat, msg) => {
      if (seat === null) { for (const [pid] of App.seatOfPeer) App.hostNet.sendTo(pid, msg); }
      else { const pid = App.peerOfSeat.get(seat); if (pid) App.hostNet.sendTo(pid, msg); }
    });
    App.gameHost = new GameHost(seats, io);
    App.mode = 'match';
    App.gameHost.start();
  }
};
UI.on.quitToMenu = quitToMenu;

/* Opt-in debug handle (#debug in the URL). Exposes only what this client
   already knows — its own hand and the public state — never other hands. */
if (location.hash === '#debug') {
  window.__LIT = { App, UI, View, sendAction, canAct };
}

// Ask about a held seat shortly after boot, once the menu is up.
setTimeout(() => { offerRejoin(); }, 400);

window.addEventListener('beforeunload', () => {
  if (App.hostNet) App.hostNet.close();
  if (App.clientNet) App.clientNet.leave();
});
