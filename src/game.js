/* =========================================================================
   game.js — the authoritative match loop.

   Only the host runs a GameHost. It owns the Engine, drives the bots, and
   emits messages. Crucially, a player's cards are sent ONLY to that player:
   `hand` messages are private, `state` messages carry counts, never cards.
   Single-player is the same code path with every other seat a bot.
   ========================================================================= */

import {
  Engine, Knowledge, HS_NAME, cardLabel, TEAM_NAME, SEAT_TEAM,
  botChooseAsk, botFindCertainClaim, botForcedClaim, noteAsk
} from './engine.js';

export const PACE = {
  BOT_THINK: 1100,
  AFTER_HIT: 1700,
  AFTER_MISS: 1300,
  AFTER_CLAIM: 2600,
  DEAL: 2600
};

export class GameHost {
  /**
   * @param seats [{name, isBot}] length 6
   * @param io    { sendTo(seat, msg), broadcast(msg) }
   */
  constructor(seats, io) {
    this.engine = new Engine(seats);
    this.kn = new Knowledge();
    this.io = io;
    this.dead = false;
    this.timers = [];
  }

  destroy() {
    this.dead = true;
    this.timers.forEach(clearTimeout);
    this.timers = [];
  }
  _later(fn, ms) {
    const t = setTimeout(() => { if (!this.dead) fn(); }, ms);
    this.timers.push(t);
    return t;
  }

  /* ---------------- outgoing ---------------- */
  _pushState() {
    const st = this.engine.publicState();
    this.io.broadcast({ k: 'state', state: st });
  }
  _pushHands() {
    for (const p of this.engine.players) {
      if (p.isBot) continue;
      this.io.sendTo(p.seat, { k: 'hand', hand: p.hand.slice() });
    }
  }
  _ev(kind, text, data) {
    this.io.broadcast({ k: 'ev', kind, text, data: data || null });
  }

  /* ---------------- lifecycle ---------------- */
  start() {
    this.engine.deal();
    for (const p of this.engine.players) {
      if (p.isBot) continue;
      this.io.sendTo(p.seat, {
        k: 'welcome',
        mySeat: p.seat,
        seats: this.engine.publicState().seats
      });
    }
    this._pushHands();
    this.io.broadcast({ k: 'deal', counts: this.engine.counts() });
    this._pushState();
    this._ev('sys', 'New match — 48 cards, 8 half-suits, 8 cards each.');
    this._later(() => this.beginTurn(), PACE.DEAL);
  }

  beginTurn() {
    if (this.dead) return;
    const e = this.engine;

    if (!e.players[e.turn].hand.length) {
      const next = e.findTurnHolder(e.turn);
      if (next < 0) return this.finish();
      if (next !== e.turn) {
        this._ev('sys', e.players[e.turn].name + ' is out of cards — turn passes to ' + e.players[next].name + '.');
        e.turn = next;
      }
    }
    this._pushState();
    this.io.broadcast({ k: 'turn', seat: e.turn });

    const p = e.players[e.turn];
    if (p.isBot) this._later(() => this.botMove(p.seat), PACE.BOT_THINK + Math.random() * 500);
  }

  botMove(seat) {
    if (this.dead) return;
    const e = this.engine;
    if (e.turn !== seat) return;
    const bot = e.players[seat];
    if (!bot.hand.length) { e.turn = e.findTurnHolder(seat); return this.beginTurn(); }

    this.kn.infer(e);

    const claim = botFindCertainClaim(e, this.kn, seat);
    if (claim) return this.resolveClaim(seat, claim.hs, claim.assignment);

    const ask = botChooseAsk(e, this.kn, seat);
    if (ask) return this.resolveAsk(seat, ask.target, ask.card);

    const forced = botForcedClaim(e, this.kn, seat);
    if (forced) {
      this._ev('sys', bot.name + ' has no legal ask and must declare.');
      return this.resolveClaim(seat, forced.hs, forced.assignment);
    }
    e.turn = e.findTurnHolder(seat);
    if (e.turn < 0) return this.finish();
    this.beginTurn();
  }

  /* ---------------- incoming player actions ---------------- */
  onAction(seat, msg) {
    if (this.dead || !msg) return;
    const e = this.engine;
    if (e.turn !== seat) return;                 // not your turn — ignore
    if (e.players[seat].isBot) return;

    if (msg.k === 'ask') {
      if (!e.canAsk(seat, msg.target, msg.card)) {
        this.io.sendTo(seat, { k: 'reject', reason: 'That ask is not legal.' });
        return;
      }
      this.resolveAsk(seat, msg.target, msg.card);
    } else if (msg.k === 'declare') {
      if (!e.hsLive(msg.hs)) {
        this.io.sendTo(seat, { k: 'reject', reason: 'That half-suit is already claimed.' });
        return;
      }
      this.resolveClaim(seat, msg.hs, msg.assignment || {});
    }
  }

  /* ---------------- resolution ---------------- */
  resolveAsk(askerSeat, targetSeat, cid) {
    const e = this.engine;
    const A = e.players[askerSeat], T = e.players[targetSeat];
    const { hit } = e.applyAsk(askerSeat, targetSeat, cid);
    noteAsk(this.kn, askerSeat, targetSeat, cid, hit);
    this.kn.infer(e);

    const line = A.name + ' asked ' + T.name + ' for ' + cardLabel(cid);
    this._ev(hit ? 'hit' : 'miss',
      hit ? line + ' — HIT!' : line + ' — miss. Turn passes to ' + T.name + '.',
      { from: targetSeat, to: askerSeat, card: cid, hit });

    this._pushHands();
    this._pushState();
    this._later(() => this.checkWin(), hit ? PACE.AFTER_HIT : PACE.AFTER_MISS);
  }

  resolveClaim(callerSeat, hs, assignment) {
    const e = this.engine;
    const caller = e.players[callerSeat];
    const { correct, winTeam, truth } = e.applyClaim(callerSeat, hs, assignment);
    this.kn.dropSet(hs);
    this.kn.infer(e);

    const verdict = correct ? 'CORRECT' : 'WRONG';
    this._ev('claim',
      caller.name + ' declared ' + HS_NAME[hs] + ' — ' + verdict + '. Point to ' + TEAM_NAME[winTeam] + '.',
      { hs, truth, correct, winTeam, caller: callerSeat });
    this._ev('sys', '   Actual: ' + Object.keys(truth)
      .map(c => cardLabel(c) + '→' + (truth[c] < 0 ? '—' : e.players[truth[c]].name)).join(', '));

    this._pushHands();
    this._pushState();
    this._later(() => this.checkWin(), PACE.AFTER_CLAIM);
  }

  checkWin() {
    if (this.dead) return;
    if (this.engine.isMatchOver()) return this.finish();
    this.beginTurn();
  }

  finish() {
    if (this.dead) return;
    this.engine.over = true;
    this._pushState();
    this.io.broadcast({ k: 'over', scores: this.engine.scores.slice() });
  }

  /** A human dropped out mid-match — hand the seat to a bot. */
  convertToBot(seat) {
    const p = this.engine.players[seat];
    if (!p || p.isBot) return;
    p.isBot = true;
    p.name = p.name + ' (bot)';
    this._ev('sys', p.name + ' took over for a disconnected player.');
    this._pushState();
    if (this.engine.turn === seat && !this.engine.over) {
      this._later(() => this.botMove(seat), PACE.BOT_THINK);
    }
  }
}

/* -------------------------------------------------------------------------
   LocalIo — single-player / host-side loopback. Messages the host generates
   for its own seat are delivered straight back into the client handler.
   ------------------------------------------------------------------------- */
export function makeIo(hostSeat, deliverLocal, sendRemote) {
  return {
    sendTo(seat, msg) {
      if (seat === hostSeat) deliverLocal(msg);
      else sendRemote(seat, msg);
    },
    broadcast(msg) {
      deliverLocal(msg);
      sendRemote(null, msg);
    }
  };
}
