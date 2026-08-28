/* =========================================================================
   engine.js — pure Literature rules + bot AI.
   No DOM, no Three.js. Runs identically in the host browser and in tests.
   ========================================================================= */

export const SUITS = ['C', 'D', 'H', 'S'];
export const SUIT_SYM = { C: '♣', D: '♦', H: '♥', S: '♠' };
export const SUIT_NAME = { C: 'Clubs', D: 'Diamonds', H: 'Hearts', S: 'Spades' };
const RED_SUITS = { D: true, H: true };

export const MINOR = ['2', '3', '4', '5', '6', '7'];
export const MAJOR = ['9', '10', 'J', 'Q', 'K', 'A'];
export const RANK_ORDER = ['2', '3', '4', '5', '6', '7', '9', '10', 'J', 'Q', 'K', 'A'];

export const HS_LIST = [];
export const HS_CARDS = {};
export const HS_NAME = {};
export const CARD_HS = {};
export const ALL_CARDS = [];

for (const s of SUITS) {
  for (const half of ['minor', 'major']) {
    const hs = s + '-' + half;
    HS_LIST.push(hs);
    HS_NAME[hs] = (half === 'minor' ? 'Minor ' : 'Major ') + SUIT_NAME[s];
    HS_CARDS[hs] = (half === 'minor' ? MINOR : MAJOR).map(r => r + s);
    HS_CARDS[hs].forEach(c => { CARD_HS[c] = hs; ALL_CARDS.push(c); });
  }
}

export const cardRank  = id => id.slice(0, -1);
export const cardSuit  = id => id.slice(-1);
export const cardLabel = id => cardRank(id) + SUIT_SYM[cardSuit(id)];
export const isRed     = id => !!RED_SUITS[cardSuit(id)];

export const SEAT_TEAM = [0, 1, 0, 1, 0, 1];
export const TEAM_NAME = ['Team Blue', 'Team Red'];
export const TEAM_CSS  = ['#5aa9ff', '#ff6b6b'];
export const TEAM_HEX  = [0x3f7fd0, 0xc04242];

export function handSort(a, b) {
  const sa = SUITS.indexOf(cardSuit(a)), sb = SUITS.indexOf(cardSuit(b));
  if (sa !== sb) return sa - sb;
  return RANK_ORDER.indexOf(cardRank(a)) - RANK_ORDER.indexOf(cardRank(b));
}

export function shuffle(a, rnd = Math.random) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ------------------------------------------------------------------ */
/*  Engine — authoritative game state. Only the host ever owns one.    */
/* ------------------------------------------------------------------ */

export class Engine {
  /** @param seats [{name, isBot}] length 6 */
  constructor(seats) {
    this.players = seats.map((s, i) => ({
      seat: i, name: s.name, isBot: !!s.isBot, team: SEAT_TEAM[i], hand: []
    }));
    this.scores = [0, 0];
    this.claimedSets = [[], []];
    this.claimed = {};          // hsId -> winning team
    this.turn = 0;
    this.over = false;
  }

  deal(rnd = Math.random) {
    const deck = shuffle(ALL_CARDS.slice(), rnd);
    this.players.forEach(p => { p.hand = []; });
    for (let i = 0; i < deck.length; i++) this.players[i % 6].hand.push(deck[i]);
    this.players.forEach(p => p.hand.sort(handSort));
  }

  hsLive(hs) { return this.claimed[hs] === undefined; }
  counts()   { return this.players.map(p => p.hand.length); }

  ownerOf(cid) {
    for (const p of this.players) if (p.hand.includes(cid)) return p.seat;
    return -1;
  }

  canAsk(askerSeat, targetSeat, cid) {
    const A = this.players[askerSeat], T = this.players[targetSeat];
    if (!A || !T) return false;
    if (A.team === T.team) return false;
    if (!T.hand.length || !A.hand.length) return false;
    const hs = CARD_HS[cid];
    if (!hs || !this.hsLive(hs)) return false;
    if (A.hand.includes(cid)) return false;
    return A.hand.some(c => CARD_HS[c] === hs);
  }

  hasLegalAsk(seat) {
    const me = this.players[seat];
    if (!me.hand.length) return false;
    const sets = new Set(me.hand.map(c => CARD_HS[c]).filter(h => this.hsLive(h)));
    for (const hs of sets) {
      for (const cid of HS_CARDS[hs]) {
        if (me.hand.includes(cid)) continue;
        for (const o of this.players) {
          if (o.team !== me.team && o.hand.length && this.canAsk(seat, o.seat, cid)) return true;
        }
      }
    }
    return false;
  }

  /** assignment: { cardId: seat } */
  validateClaim(callerSeat, hs, assignment) {
    if (!this.hsLive(hs)) return false;
    const team = this.players[callerSeat].team;
    for (const cid of HS_CARDS[hs]) {
      const declared = assignment[cid];
      if (declared === undefined || declared === null) return false;
      if (SEAT_TEAM[declared] !== team) return false;
      if (this.ownerOf(cid) !== declared) return false;
    }
    return true;
  }

  applyAsk(askerSeat, targetSeat, cid) {
    const A = this.players[askerSeat], T = this.players[targetSeat];
    const hit = T.hand.includes(cid);
    if (hit) {
      T.hand.splice(T.hand.indexOf(cid), 1);
      A.hand.push(cid);
      A.hand.sort(handSort);
      this.turn = askerSeat;
    } else {
      this.turn = targetSeat;
    }
    return { hit };
  }

  applyClaim(callerSeat, hs, assignment) {
    const caller = this.players[callerSeat];
    const correct = this.validateClaim(callerSeat, hs, assignment);
    const winTeam = correct ? caller.team : (1 - caller.team);

    const truth = {};
    for (const cid of HS_CARDS[hs]) truth[cid] = this.ownerOf(cid);

    this.claimed[hs] = winTeam;
    this.claimedSets[winTeam].push(hs);
    this.scores[winTeam]++;
    for (const p of this.players) p.hand = p.hand.filter(c => CARD_HS[c] !== hs);
    this.turn = callerSeat;

    return { correct, winTeam, truth };
  }

  /** Prefer a teammate holding cards, else anyone holding cards, else -1. */
  findTurnHolder(seat) {
    if (this.players[seat].hand.length) return seat;
    const team = SEAT_TEAM[seat];
    const mates = this.players.filter(p => p.team === team && p.hand.length);
    if (mates.length) return mates[Math.floor(Math.random() * mates.length)].seat;
    const any = this.players.filter(p => p.hand.length);
    if (any.length) return any[Math.floor(Math.random() * any.length)].seat;
    return -1;
  }

  declaredCount() { return HS_LIST.filter(h => !this.hsLive(h)).length; }

  isMatchOver() {
    if (this.scores[0] > 4 || this.scores[1] > 4) return true;
    if (this.declaredCount() === 8) return true;
    return !this.players.some(p => p.hand.length);
  }

  publicState() {
    return {
      turn: this.turn,
      scores: this.scores.slice(),
      claimedSets: [this.claimedSets[0].slice(), this.claimedSets[1].slice()],
      claimed: Object.assign({}, this.claimed),
      counts: this.counts(),
      over: this.over,
      seats: this.players.map(p => ({ seat: p.seat, name: p.name, team: p.team, isBot: p.isBot }))
    };
  }
}

/* ------------------------------------------------------------------ */
/*  Client-side legality helpers (work from public state + own hand)   */
/* ------------------------------------------------------------------ */

export function canAskClient(state, myHand, mySeat, targetSeat, cid) {
  if (SEAT_TEAM[mySeat] === SEAT_TEAM[targetSeat]) return false;
  if (!state.counts[targetSeat]) return false;
  if (!myHand.length) return false;
  const hs = CARD_HS[cid];
  if (!hs || state.claimed[hs] !== undefined) return false;
  if (myHand.includes(cid)) return false;
  return myHand.some(c => CARD_HS[c] === hs);
}

export function hasLegalAskClient(state, myHand, mySeat) {
  if (!myHand.length) return false;
  const anyOpp = state.counts.some((n, i) => SEAT_TEAM[i] !== SEAT_TEAM[mySeat] && n > 0);
  if (!anyOpp) return false;
  const sets = new Set(myHand.map(c => CARD_HS[c]).filter(h => state.claimed[h] === undefined));
  for (const hs of sets) {
    for (const cid of HS_CARDS[hs]) if (!myHand.includes(cid)) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/*  Knowledge — strictly public information, used by the bots.         */
/* ------------------------------------------------------------------ */

export class Knowledge {
  constructor() {
    this.has = [], this.not = [], this.hsHas = [];
    for (let i = 0; i < 6; i++) {
      this.has[i] = new Set(); this.not[i] = new Set(); this.hsHas[i] = new Set();
    }
  }
  setHas(seat, cid) {
    this.has[seat].add(cid); this.not[seat].delete(cid);
    this.hsHas[seat].add(CARD_HS[cid]);
    for (let s = 0; s < 6; s++) if (s !== seat) { this.has[s].delete(cid); this.not[s].add(cid); }
  }
  setNot(seat, cid) { this.not[seat].add(cid); this.has[seat].delete(cid); }
  forget(cid) { for (let s = 0; s < 6; s++) { this.has[s].delete(cid); this.not[s].delete(cid); } }
  knownOwner(cid) { for (let s = 0; s < 6; s++) if (this.has[s].has(cid)) return s; return -1; }
  dropSet(hs) { HS_CARDS[hs].forEach(c => this.forget(c)); for (let s = 0; s < 6; s++) this.hsHas[s].delete(hs); }

  /** Deductive closure over everything publicly observable. */
  infer(engine) {
    let changed = true, guard = 0;
    while (changed && guard++ < 12) {
      changed = false;

      // (a) an empty hand holds nothing
      for (const p of engine.players) {
        if (p.hand.length) continue;
        for (const cid of ALL_CARDS) {
          if (!engine.hsLive(CARD_HS[cid]) || this.not[p.seat].has(cid)) continue;
          this.not[p.seat].add(cid); this.has[p.seat].delete(cid); changed = true;
        }
      }
      // (b) claimed sets leave play
      for (const hs of HS_LIST) if (!engine.hsLive(hs)) HS_CARDS[hs].forEach(c => this.forget(c));

      // (c) a live card excluded from five seats must sit at the sixth
      for (const cid of ALL_CARDS) {
        if (!engine.hsLive(CARD_HS[cid]) || this.knownOwner(cid) >= 0) continue;
        const cand = engine.players.filter(p => p.hand.length && !this.not[p.seat].has(cid));
        if (cand.length === 1) { this.setHas(cand[0].seat, cid); changed = true; }
      }
      // (d) known cards == hand size ⇒ everything else excluded
      for (const p of engine.players) {
        const live = [...this.has[p.seat]].filter(c => engine.hsLive(CARD_HS[c]));
        if (!live.length || live.length !== p.hand.length) continue;
        for (const cid of ALL_CARDS) {
          if (!engine.hsLive(CARD_HS[cid])) continue;
          if (this.has[p.seat].has(cid) || this.not[p.seat].has(cid)) continue;
          this.not[p.seat].add(cid); changed = true;
        }
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Bots                                                               */
/* ------------------------------------------------------------------ */

function belief(engine, kn, seat, cid) {
  if (engine.players[seat].hand.includes(cid)) return seat;
  return kn.knownOwner(cid);
}

/** A claim the bot is 100% certain of, or null. */
export function botFindCertainClaim(engine, kn, seat) {
  const team = engine.players[seat].team;
  for (const hs of HS_LIST) {
    if (!engine.hsLive(hs)) continue;
    const assignment = {};
    let ok = true;
    for (const cid of HS_CARDS[hs]) {
      const o = belief(engine, kn, seat, cid);
      if (o < 0 || SEAT_TEAM[o] !== team) { ok = false; break; }
      assignment[cid] = o;
    }
    if (ok) return { hs, assignment };
  }
  return null;
}

/** Best-effort claim, used only when no legal ask exists. */
export function botForcedClaim(engine, kn, seat) {
  const team = engine.players[seat].team;
  const mates = engine.players.filter(p => p.team === team);
  let best = null, bestScore = -Infinity;

  for (const hs of HS_LIST) {
    if (!engine.hsLive(hs)) continue;
    let score = 0;
    const assignment = {};
    for (const cid of HS_CARDS[hs]) {
      const o = belief(engine, kn, seat, cid);
      if (o >= 0 && SEAT_TEAM[o] === team) { assignment[cid] = o; score += 2; }
      else if (o >= 0) { assignment[cid] = seat; score -= 3; }
      else {
        const cand = mates.filter(m => m.hand.length && !kn.not[m.seat].has(cid));
        const pick = cand.length ? cand[Math.floor(Math.random() * cand.length)] : mates[0];
        assignment[cid] = pick.seat;
      }
    }
    if (score > bestScore) { bestScore = score; best = { hs, assignment }; }
  }
  return best;
}

export function botChooseAsk(engine, kn, seat) {
  const bot = engine.players[seat];
  const mySets = new Set(bot.hand.map(c => CARD_HS[c]).filter(h => engine.hsLive(h)));
  const opps = engine.players.filter(o => o.team !== bot.team && o.hand.length);
  let best = null, bestScore = -Infinity;

  for (const hs of mySets) {
    const mine = bot.hand.filter(c => CARD_HS[c] === hs).length;
    for (const cid of HS_CARDS[hs]) {
      if (bot.hand.includes(cid)) continue;
      const known = kn.knownOwner(cid);
      for (const o of opps) {
        if (!engine.canAsk(seat, o.seat, cid)) continue;
        if (kn.not[o.seat].has(cid)) continue;
        if (known >= 0 && known !== o.seat) continue;

        let score;
        if (known === o.seat) {
          score = 1000;                                     // guaranteed hit
        } else {
          score = 20;
          score += mine * 6;                                // finish what we started
          if (kn.hsHas[o.seat].has(hs)) score += 22;        // they showed interest
          score += o.hand.length * 1.2;                     // fatter hand, better odds
          const others = opps.filter(x => x !== o && !kn.not[x.seat].has(cid)).length;
          score -= others * 2.5;
          score += Math.random() * 6;
        }
        if (score > bestScore) { bestScore = score; best = { target: o.seat, card: cid }; }
      }
    }
  }
  return best;
}

/** Record the public consequences of an ask into a Knowledge base. */
export function noteAsk(kn, askerSeat, targetSeat, cid, hit) {
  kn.hsHas[askerSeat].add(CARD_HS[cid]);
  kn.setNot(askerSeat, cid);
  if (hit) kn.setHas(askerSeat, cid);
  else kn.setNot(targetSeat, cid);
}
