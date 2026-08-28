/* =========================================================================
   ui.js — every DOM concern: menu, lobby overlays, HUD, modals.
   Pure presentation; main.js supplies the callbacks in `on`.
   ========================================================================= */

import {
  HS_LIST, HS_CARDS, HS_NAME, CARD_HS, SUIT_SYM, cardLabel, isRed,
  TEAM_NAME, TEAM_CSS, SEAT_TEAM, canAskClient
} from './engine.js';

export const el = id => document.getElementById(id);

export const on = {
  play: () => {}, host: () => {}, bots: () => {},
  joinLobby: () => {}, joinCode: () => {}, leaveQueue: () => {}, toggleShowAll: () => {},
  startMatch: () => {}, cancelHost: () => {}, requiredChange: () => {}, shuffleSeats: () => {},
  confirmAsk: () => {}, confirmDeclare: () => {}, restart: () => {}, quitToMenu: () => {},
  openAsk: () => {}, openDeclare: () => {}, toggleMotion: () => {},
  rejoinYes: () => {}, rejoinNo: () => {}, seatClick: () => {}
};

/* ---------------- screens ---------------- */
export function showScreen(name) {
  for (const id of ['menu', 'hud']) el(id).classList.toggle('hidden', id !== name);
}
export function overlay(id, show) { el(id).classList.toggle('show', !!show); }

export function toast(text, kind) {
  const t = el('netStatus');
  t.textContent = text || '';
  t.className = 'netStatus' + (kind ? ' ' + kind : '') + (text ? ' show' : '');
}

const NAME_KEY = 'lit.name';

export function playerName() {
  const v = (el('nameInput').value || '').trim();
  return v ? v.slice(0, 14) : 'Player';
}

/** Restore the last-used name so a refresh doesn't wipe it. */
export function restorePlayerName() {
  let saved = '';
  try { saved = localStorage.getItem(NAME_KEY) || ''; } catch (e) {}
  if (saved) el('nameInput').value = saved.slice(0, 14);
  const persist = () => {
    try { localStorage.setItem(NAME_KEY, (el('nameInput').value || '').trim().slice(0, 14)); }
    catch (e) {}
  };
  el('nameInput').addEventListener('input', persist);
  el('nameInput').addEventListener('change', persist);
}

/* ---------------- lobby browser ---------------- */
export function renderLobbies(list, busyId) {
  const box = el('lobbyList');
  box.innerHTML = '';
  if (!list.length) {
    box.innerHTML = '<div class="empty">No tables on your network yet.<br>' +
      'Ask your friend to press <b>Host a Table</b>, or try “Show all networks”.</div>';
    return;
  }
  for (const l of list) {
    const row = document.createElement('div');
    row.className = 'lobbyRow';
    const full = l.queued >= 6;
    row.innerHTML =
      '<div class="lobbyMain"><div class="lobbyName">' + esc(l.name) + '</div>' +
      '<div class="lobbySub">Host: ' + esc(l.host) + ' &nbsp;·&nbsp; code <b>' + esc(l.code) + '</b>' +
      ' &nbsp;·&nbsp; ' + l.queued + '/' + l.required + ' queued</div></div>';
    const b = document.createElement('button');
    b.className = 'primary small';
    b.textContent = full ? 'Full' : (busyId === l.id ? 'Joining…' : 'Join');
    b.disabled = full || !!busyId;
    b.onclick = () => on.joinLobby(l);
    row.appendChild(b);
    box.appendChild(row);
  }
}

export function showQueueView(show, info) {
  el('lobbyBrowse').classList.toggle('hidden', !!show);
  el('queueView').classList.toggle('hidden', !show);
  if (show && info) updateQueueView(info);
}

let queueSeating = null;    // {roster, seat} pushed by the host

export function updateQueueView(info) {
  el('queueTitle').textContent = info.name || 'Table';
  let seating = '';
  if (queueSeating) {
    const { roster, seat } = queueSeating;
    const side = t => roster.filter(r => r.team === t)
      .map(r => '<span class="qName' + (r.seat === seat ? ' me' : '') + '">' +
        esc(r.name) + (r.bot ? ' <i>bot</i>' : '') + '</span>').join('');
    seating =
      '<div class="qTeams">' +
      '<div class="qTeam"><div class="qHead" style="color:' + TEAM_CSS[0] + '">' +
        TEAM_NAME[0] + '</div>' + side(0) + '</div>' +
      '<div class="qTeam"><div class="qHead" style="color:' + TEAM_CSS[1] + '">' +
        TEAM_NAME[1] + '</div>' + side(1) + '</div></div>';
    if (seat >= 0) seating += '<div class="qYou" style="color:' + TEAM_CSS[SEAT_TEAM[seat]] +
      '">You are on ' + TEAM_NAME[SEAT_TEAM[seat]] + '</div>';
  } else {
    seating = '<div class="queueNames">' + (info.players || []).map(esc).join(' · ') + '</div>';
  }
  el('queueInfo').innerHTML =
    '<b>' + info.queued + '</b> of <b>' + info.required + '</b> players queued' +
    seating +
    '<div class="queueWait">Waiting for the host to start the match…</div>';
}

/** The host rearranged the seats — refresh what the queued player sees. */
export function updateQueueSeating(roster, seat) {
  queueSeating = { roster, seat };
  const t = el('queueTitle').textContent;
  updateQueueView({ name: t, queued: roster.filter(r => !r.bot).length,
                    required: roster.length, players: [] });
}
export function clearQueueSeating() { queueSeating = null; }

/* ---------------- host overlay ----------------
   Six fixed seats, alternating team by parity. The host assigns teams by
   moving people between seats: tap one, tap another, they swap. */
export function renderHostPanel(info) {
  el('hostCode').textContent = info.code;
  el('hostNetLabel').textContent = info.netKey === 'global'
    ? 'visible to everyone (network not detected)'
    : 'visible on your network';

  const box = el('hostPlayers');
  box.innerHTML = '';
  (info.roster || []).forEach((r, i) => {
    const team = SEAT_TEAM[i];
    const d = document.createElement('div');
    d.className = 'hostPlayer seatRow team' + team +
      (info.picked === i ? ' picked' : '') +
      (info.picked >= 0 && info.picked !== i ? ' target' : '') +
      (r.kind === 'bot' ? ' bot' : '');
    d.innerHTML =
      '<span class="dot" style="background:' + TEAM_CSS[team] + '"></span>' +
      '<span class="hpName">' + esc(r.name) +
        (r.kind === 'host' ? ' <i>(you, host)</i>' : '') +
        (r.kind === 'bot' ? ' <i>(bot)</i>' : '') + '</span>' +
      '<span class="hpTeam" style="color:' + TEAM_CSS[team] + '">' + TEAM_NAME[team] + '</span>';
    d.onclick = () => on.seatClick(i);
    box.appendChild(d);
  });

  el('seatHint').textContent = info.picked >= 0
    ? 'Now tap another seat to swap ' + (info.roster[info.picked].name) + ' into it.'
    : 'Tap a seat, then tap another to swap them. Teams follow the seats.';

  el('queuedCount').textContent = info.humans;
  el('reqCount').textContent = info.required;
  el('btnStart').disabled = info.humans < info.required;
  el('btnStart').textContent = info.humans < info.required
    ? 'Waiting for players…' : 'Start Match';
}

/* ---------------- HUD ---------------- */
/** Restart-safe one-shot shudder on the banner. On mobile the move log and
    seat strip are hidden, so this is the ONLY miss feedback those players get. */
export function flashBanner() {
  const b = el('turnBanner');
  b.classList.remove('missHit');
  void b.offsetWidth;                 // force reflow so the animation restarts
  b.classList.add('missHit');
}

export function showRejoin(sess, lobby) {
  el('rejoinInfo').innerHTML =
    'You were playing at <b>' + esc(sess.hostName) + '</b>&rsquo;s table.' +
    '<div class="queueNames">Your seat is still being held' +
    (lobby && lobby.started ? ' &mdash; the match is in progress.' : '.') + '</div>' +
    '<div class="queueWait">Rejoin now to take it back from the bot.</div>';
  overlay('rejoinOverlay', true);
}
export function hideRejoin() { overlay('rejoinOverlay', false); }

export function setMotionToggle(reduced) {
  const b = el('btnMotion');
  if (!b) return;
  b.textContent = reduced ? 'Motion: Reduced' : 'Motion: Full';
  b.setAttribute('aria-pressed', reduced ? 'true' : 'false');
}

export function setTitle(html) { el('turnTitle').innerHTML = html; }
export function setMsg(t) { el('turnMsg').textContent = t || ''; }

export function log(text, cls) {
  const d = document.createElement('div');
  d.className = cls || '';
  d.textContent = text;
  const list = el('logList');
  list.appendChild(d);
  while (list.childNodes.length > 300) list.removeChild(list.firstChild);
  list.scrollTop = list.scrollHeight;
}
export function clearLog() { el('logList').innerHTML = ''; }

export function refreshScore(state) {
  el('scoreA').textContent = state.scores[0];
  el('scoreB').textContent = state.scores[1];
  for (const [t, node] of [[0, el('setsA')], [1, el('setsB')]]) {
    node.innerHTML = '';
    for (const hs of state.claimedSets[t]) {
      const s = document.createElement('span');
      s.className = 'setIcon';
      s.style.color = isRed(HS_CARDS[hs][0]) ? '#ff8a8a' : '#e6edf5';
      s.textContent = (hs.endsWith('minor') ? 'm' : 'M') + SUIT_SYM[hs[0]];
      s.title = HS_NAME[hs];
      node.appendChild(s);
    }
  }
}

export function refreshSeatStrip(state, mySeat) {
  const box = el('seatStrip');
  box.innerHTML = '';
  for (const s of state.seats) {
    const d = document.createElement('div');
    d.className = 'seatChip' + (s.seat === state.turn ? ' active' : '') + (s.seat === mySeat ? ' me' : '');
    d.style.borderColor = TEAM_CSS[s.team];
    d.innerHTML = '<span style="color:' + TEAM_CSS[s.team] + '">' + esc(s.name) + '</span>' +
      '<b>' + state.counts[s.seat] + '</b>';
    box.appendChild(d);
  }
}

export function setTurnControls(canAct, canAsk) {
  el('btnAsk').disabled = !canAct || !canAsk;
  el('btnDeclare').disabled = !canAct;
}

/* ---------------- ask modal ---------------- */
let askSel = { opp: null, hs: null, card: null };
let askCtx = null;

export function openAsk(ctx, preOpp) {
  askCtx = ctx;
  askSel = { opp: (preOpp !== undefined && preOpp !== null) ? preOpp : null, hs: null, card: null };
  renderAsk();
  overlay('askModal', true);
}
export function closeAsk() { overlay('askModal', false); }

function renderAsk() {
  const { state, hand, mySeat } = askCtx;
  const myTeam = SEAT_TEAM[mySeat];

  const oppBox = el('askOpps'); oppBox.innerHTML = '';
  for (const s of state.seats) {
    if (s.team === myTeam) continue;
    const c = document.createElement('div');
    const n = state.counts[s.seat];
    c.className = 'chip' + (askSel.opp === s.seat ? ' sel' : '');
    c.textContent = s.name + ' (' + n + ')';
    if (!n) { c.style.opacity = .35; c.style.cursor = 'not-allowed'; }
    else c.onclick = () => { askSel.opp = s.seat; askSel.card = null; renderAsk(); };
    oppBox.appendChild(c);
  }

  const setBox = el('askSets'); setBox.innerHTML = '';
  const mySets = [...new Set(hand.map(c => CARD_HS[c]))]
    .filter(h => state.claimed[h] === undefined).sort();
  if (!mySets.length) setBox.innerHTML = '<span class="dim">No eligible half-suits.</span>';
  for (const hs of mySets) {
    const c = document.createElement('div');
    c.className = 'chip ' + (isRed(HS_CARDS[hs][0]) ? 'rd' : 'bk') + (askSel.hs === hs ? ' sel' : '');
    c.textContent = HS_NAME[hs] + ' · ' + hand.filter(x => CARD_HS[x] === hs).length;
    c.onclick = () => { askSel.hs = hs; askSel.card = null; renderAsk(); };
    setBox.appendChild(c);
  }

  const cardBox = el('askCards'); cardBox.innerHTML = '';
  if (!askSel.hs) {
    cardBox.innerHTML = '<span class="dim">Pick a half-suit first.</span>';
  } else {
    const avail = HS_CARDS[askSel.hs].filter(c => !hand.includes(c));
    if (!avail.length) cardBox.innerHTML = '<span class="dim">You hold this whole set — declare it!</span>';
    for (const cid of avail) {
      const c = document.createElement('div');
      c.className = 'chip ' + (isRed(cid) ? 'rd' : 'bk') + (askSel.card === cid ? ' sel' : '');
      c.textContent = cardLabel(cid);
      c.onclick = () => { askSel.card = cid; renderAsk(); };
      cardBox.appendChild(c);
    }
  }

  const ok = askSel.opp !== null && askSel.card &&
    canAskClient(state, hand, mySeat, askSel.opp, askSel.card);
  el('askConfirm').disabled = !ok;
}

/* ---------------- declare modal ----------------
   You name a half-suit; you do NOT say who holds what. Every teammate then
   surrenders whatever they hold of it automatically. If the six cards are all
   on your team you score, otherwise the other team does. */
let declCtx = null;

export function openDeclare(ctx) {
  declCtx = ctx;
  const { state, hand } = ctx;
  const sel = el('declSet');
  sel.innerHTML = '';
  const live = HS_LIST.filter(h => state.claimed[h] === undefined);
  live.sort((a, b) =>
    hand.filter(c => CARD_HS[c] === b).length - hand.filter(c => CARD_HS[c] === a).length);
  for (const hs of live) {
    const o = document.createElement('option');
    o.value = hs;
    o.textContent = HS_NAME[hs] + '  (you hold ' + hand.filter(c => CARD_HS[c] === hs).length + ')';
    sel.appendChild(o);
  }
  sel.onchange = renderDeclRows;
  renderDeclRows();
  overlay('declModal', true);
}
export function closeDeclare() { overlay('declModal', false); }

function renderDeclRows() {
  const { state, hand, mySeat } = declCtx;
  const myTeam = SEAT_TEAM[mySeat];
  const hs = el('declSet').value;
  const box = el('declRows');
  box.innerHTML = '';
  if (!hs) return;

  const mine = HS_CARDS[hs].filter(c => hand.includes(c));
  const missing = HS_CARDS[hs].filter(c => !hand.includes(c));
  const mates = state.seats.filter(s => s.team === myTeam && s.seat !== mySeat);

  const chips = list => list.length
    ? list.map(c => '<span class="declChip" style="color:' +
        (isRed(c) ? '#ff8080' : '#e6edf5') + '">' + cardLabel(c) + '</span>').join('')
    : '<span class="dim">none</span>';

  box.innerHTML =
    '<div class="declBlock"><div class="declHead">You surrender</div>' +
    '<div class="declChips">' + chips(mine) + '</div></div>' +
    '<div class="declBlock"><div class="declHead">' +
    mates.map(m => esc(m.name)).join(' and ') + ' must hold every one of these</div>' +
    '<div class="declChips">' + chips(missing) + '</div></div>';
}

/* ---------------- game over ---------------- */
export function showOver(scores, mySeat) {
  const myTeam = SEAT_TEAM[mySeat];
  const [a, b] = scores;
  const t = el('goTitle'), s = el('goSub');
  if (a === b) { t.textContent = 'DRAW'; t.style.color = '#ffd479'; }
  else {
    const win = a > b ? 0 : 1;
    t.textContent = TEAM_NAME[win].toUpperCase() + ' WINS';
    t.style.color = TEAM_CSS[win];
    s.textContent = (win === myTeam ? 'Your team took it. ' : 'Better luck next round. ');
  }
  s.textContent = (s.textContent || '') + 'Final score — Blue ' + a + ' : ' + b + ' Red';
  overlay('gameOver', true);
}

/* ---------------- wiring ---------------- */
export function wire() {
  el('btnPlay').onclick = () => on.play();
  el('btnHost').onclick = () => on.host();
  el('btnRules').onclick = () => overlay('rulesModal', true);
  el('rulesClose').onclick = () => overlay('rulesModal', false);

  el('btnBots').onclick = () => on.bots();
  el('btnJoinBack').onclick = () => { overlay('joinOverlay', false); on.leaveQueue(); };
  el('btnLeaveQueue').onclick = () => on.leaveQueue();
  el('chkShowAll').onchange = e => on.toggleShowAll(e.target.checked);
  el('btnJoinCode').onclick = () => on.joinCode((el('codeInput').value || '').trim().toUpperCase());
  el('codeInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') on.joinCode((el('codeInput').value || '').trim().toUpperCase());
  });

  el('btnStart').onclick = () => on.startMatch();
  el('btnCancelHost').onclick = () => on.cancelHost();
  el('btnShuffleSeats').onclick = () => on.shuffleSeats();
  el('reqMinus').onclick = () => on.requiredChange(-1);
  el('reqPlus').onclick = () => on.requiredChange(1);

  el('btnAsk').onclick = () => on.openAsk();
  el('btnDeclare').onclick = () => on.openDeclare();
  el('btnQuit').onclick = () => on.quitToMenu();
  el('btnMotion').onclick = () => on.toggleMotion();
  el('rejoinYes').onclick = () => on.rejoinYes();
  el('rejoinNo').onclick = () => on.rejoinNo();

  el('askCancel').onclick = closeAsk;
  el('askConfirm').onclick = () => {
    if (askSel.opp === null || !askSel.card) return;
    closeAsk();
    on.confirmAsk(askSel.opp, askSel.card);
  };

  el('declCancel').onclick = closeDeclare;
  el('declConfirm').onclick = () => {
    const hs = el('declSet').value;
    if (!hs) return;
    closeDeclare();
    on.confirmDeclare(hs);
  };

  el('goRestart').onclick = () => { overlay('gameOver', false); on.restart(); };
  el('goMenu').onclick = () => { overlay('gameOver', false); on.quitToMenu(); };
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
