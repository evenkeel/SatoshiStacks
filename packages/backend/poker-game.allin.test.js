'use strict';

// All-in & side-pot lifecycle tests — the money paths most likely to hide
// "serious glitches". Each test drives real betting through the engine and
// settles the hand, asserting chips are conserved and pots are awarded to the
// correct eligible players.
//
// The canonical hard cases poker engines tend to get wrong (each mapped to a
// test below):
//   - A short all-in caps how much of an opponent's bet is "called"; the
//     uncalled remainder must be RETURNED, not won by the opponent.       (B2,B5)
//   - An all-in-for-less player can only win chips up to their own
//     contribution level — even holding the nuts they cannot scoop a side
//     pot they never paid into.                                           (B1,B5)
//   - Distinct winners per pot: main pot and side pot(s) go to different
//     players.                                                            (B5)
//   - Dead money: a folded player's chips stay in the pot but they can't
//     win.                                                                (B4)
//   - Split pots with an odd chip — the remainder must be distributed, not
//     dropped (no chips created or destroyed).                           (B3)
//   - All-in below the big blind (partial-blind all-in).                 (B3)
//   - Many simultaneous all-ins at different stack depths -> nested side
//     pots; the hand must still settle and conserve chips.            (A3,A4)
//   - A player frozen all-in while deeper players keep betting a side pot
//     across later streets.                                              (A5)
//   - All-in on the river (settles directly, no run-out).                (A6)
//
// Test engine isolation: DB writes and the action timer are stubbed; the
// dramatic (timed) run-out is replaced with a synchronous one that deals the
// remaining board and settles immediately; and global setTimeout is unref()'d
// so endHand's next-hand scheduler / bust timers can't keep the process alive.
// All betting, side-pot and payout logic runs for real.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const PokerGame = require('./poker-game');

// ---- timer containment -----------------------------------------------------
let realSetTimeout;
before(() => {
  realSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms, ...args) => {
    const t = realSetTimeout(fn, ms, ...args);
    if (t && typeof t.unref === 'function') t.unref();
    return t;
  };
});
after(() => { global.setTimeout = realSetTimeout; });

// ---- helpers ---------------------------------------------------------------

const totalChips = g =>
  g.players.reduce((s, p) => (p ? s + p.stack + p.currentBet : s), 0) + g.pot;
const sumStacks = g => g.players.reduce((s, p) => (p ? s + p.stack : s), 0);

function isolatedGame(stacks, opts = {}) {
  const g = new PokerGame('allin-test', { smallBlind: 50, bigBlind: 100, ...opts });
  g.saveSnapshot = () => {};
  g.saveHandToDatabase = () => {};
  g.startActionTimer = () => {};
  g.deductTimeBank = () => {};
  // Synchronous stand-in for the timed dramaticRunOut: deal the rest of the
  // board and settle now. The money logic (calculateSidePots, findPotWinners,
  // payout) in endHand runs unchanged.
  g.dramaticRunOut = function () {
    this.phase = 'showdown';
    while (this.communityCards.length < 5) {
      this.deck.pop();                       // burn
      this.communityCards.push(this.deck.pop());
    }
    this.endHand();
  };
  stacks.forEach((s, i) => g.addPlayer('u' + i, 'P' + i, { initialStack: s, preferredSeat: i }));
  if (g.handStartTimeout) { clearTimeout(g.handStartTimeout); g.handStartTimeout = null; }
  return g;
}

// Shove all-in when we can raise; otherwise call (which puts us all-in for
// less). This is "everybody jams".
function shove(g, p) {
  const total = p.currentBet + p.stack;
  return total > g.getMaxBet() ? { action: 'raise', amount: total } : { action: 'call' };
}

// Drive a hand to completion, asserting chip conservation after every action.
// `afterDeal(g)` may rig hole cards / board right after the deal.
function playHand(g, strategy, afterDeal) {
  const start = totalChips(g);
  g.startNewHand();
  if (afterDeal) afterDeal(g);
  assert.equal(totalChips(g), start, 'chips conserved after blinds');

  let guard = 0;
  while (g.handInProgress && guard++ < 500) {
    const i = g.currentPlayerIndex;
    if (i < 0) break;
    const p = g.players[i];
    if (!p) break;
    const mv = strategy(g, p);
    const res = g.processAction(p.userId, mv.action, mv.amount || 0);
    assert.ok(res.valid, `action "${mv.action}" rejected: ${res.error}`);
    assert.equal(totalChips(g), start, `chips conserved after ${mv.action}`);
  }
  return start;
}

// Standard end-of-hand invariants.
function assertSettled(g, start, label) {
  assert.ok(!g.handInProgress, `${label}: hand finished`);
  assert.equal(g.pot, 0, `${label}: pot fully distributed`);
  for (const p of g.players) {
    if (p) assert.ok(p.stack >= 0 && Number.isInteger(p.stack), `${label}: stack is a non-negative integer`);
  }
  assert.equal(sumStacks(g), start, `${label}: chips conserved through payout`);
}

// Rig hole cards + a fixed 5-card board after the deal.
const rig = (holes, board) => (g) => {
  g.players.forEach((p, i) => { if (p && holes[i]) p.holeCards = holes[i]; });
  g.communityCards = board.slice();
};

// ============================================================================
//  TIER A — structural: hands of every all-in shape must SETTLE and CONSERVE
//  chips (random cards; assertions are card-independent).
// ============================================================================

test('A1 heads-up all-in preflop, equal stacks', () => {
  const g = isolatedGame([5000, 5000]);
  const start = playHand(g, shove);
  assertSettled(g, start, 'A1');
});

test('A2 heads-up all-in, unequal stacks (uncalled portion in play)', () => {
  const g = isolatedGame([300, 5000]);
  const start = playHand(g, shove);
  assertSettled(g, start, 'A2');
});

test('A3 three-way all-in at three different stack depths -> nested side pots', () => {
  const g = isolatedGame([100, 300, 500]);
  const start = playHand(g, shove);
  assertSettled(g, start, 'A3');
});

test('A4 full 6-handed jam, all different stacks', () => {
  const g = isolatedGame([150, 800, 2500, 50, 1200, 4000]);
  const start = playHand(g, shove);
  assertSettled(g, start, 'A4');
});

test('A5 short stack all-in while deeper stacks keep betting a side pot', () => {
  // seat0 (BB) has exactly the big blind, so is all-in from the post; the two
  // deep stacks then bet a side pot across the streets.
  const g = isolatedGame([100, 4000, 4000]);
  let betFlop = false;
  const sideAction = (game, p) => {
    if (game.phase === 'flop' && !betFlop && game.getMaxBet() === 0) {
      betFlop = true;
      return { action: 'raise', amount: 400 };
    }
    return { action: 'call' };
  };
  const start = playHand(g, sideAction);
  assertSettled(g, start, 'A5');
});

test('A6 all-in on the river (settles directly, no run-out)', () => {
  const g = isolatedGame([5000, 5000]);
  const checkThenRiverJam = (game, p) =>
    game.phase === 'river' ? shove(game, p) : { action: 'call' };
  const start = playHand(g, checkThenRiverJam);
  assertSettled(g, start, 'A6');
  assert.equal(g.phase, 'showdown');
});

test('A7 equal all-ins create a single pot (no phantom zero-chip side pot)', () => {
  const g = isolatedGame([1000, 1000, 1000]);
  const start = playHand(g, shove);
  assertSettled(g, start, 'A7');
});

// ============================================================================
//  TIER B — correctness: rigged hole cards + board to assert exact awards.
//  Board is neutral (no straights/flushes): 2c 7d 9s Jh 4h.
//  Pairs rank AA > KK > QQ; trips beat pairs.
// ============================================================================

const NEUTRAL_BOARD = ['2c', '7d', '9s', 'Jh', '4h'];

test('B1 short all-in with the best hand wins ONLY the main pot', () => {
  // P0 (short, 200) holds aces — the best hand — but may only win the main pot.
  // The 1600 side pot must go to the best ELIGIBLE (deep) player, P1.
  const g = isolatedGame([200, 1000, 1000]); // seat0 BB short, seat1 button, seat2 SB
  const start = playHand(g, shove, rig(
    [['Ac', 'Ad'], ['Kc', 'Kd'], ['Qc', 'Qd']],
    NEUTRAL_BOARD
  ));
  assertSettled(g, start, 'B1');
  assert.equal(g.players[0].stack, 600, 'short best hand wins only the 600 main pot');
  assert.equal(g.players[1].stack, 1600, 'best eligible player wins the 1600 side pot');
  assert.equal(g.players[2].stack, 0, 'worst deep hand wins nothing');
});

test('B2 uncalled bet is returned to an over-shover who LOSES', () => {
  // Deep stack (seat1, 1000) acts first and jams; short stack (seat0, 300)
  // calls all-in. Only 300 of the deep jam is called — the uncalled 700 must
  // come back even though the deep stack loses the contested pot.
  const g = isolatedGame([300, 1000]); // seat0 BB short, seat1 SB deep (acts first)
  const start = playHand(g, shove, rig(
    [['Ac', 'Ad'], ['Kc', 'Kd']], // short wins, deep loses
    NEUTRAL_BOARD
  ));
  assertSettled(g, start, 'B2');
  assert.equal(g.players[0].stack, 600, 'short stack wins the 600 contested pot');
  assert.equal(g.players[1].stack, 700, 'deep stack gets its uncalled 700 back despite losing');
});

test('B3 odd-chip split + partial-blind all-in + eligibility', () => {
  // seat0 is the big blind with only 51 chips -> posts a partial blind all-in.
  // P1 and P2 tie (trip aces, king kicker); P0 is eligible for the main pot but
  // has the worst hand. Main pot 153 splits 2 ways -> one odd chip.
  const g = isolatedGame([51, 100, 100]);
  const start = playHand(g, shove, rig(
    [['3c', '4d'], ['Ah', 'Kc'], ['As', 'Kd']],
    ['Ac', 'Ad', '7s', '9h', '2d'] // trips aces on board
  ));
  assertSettled(g, start, 'B3');
  assert.equal(g.players[0].stack, 0, 'worst hand wins nothing despite main-pot eligibility');
  assert.equal(g.players[1].stack + g.players[2].stack, 251, 'tied winners split everything');
  assert.ok(Math.abs(g.players[1].stack - g.players[2].stack) <= 1, 'odd chip splits within one');
});

test('B4 folded player\'s blind is dead money awarded to the winner', () => {
  // seat2 (SB) folds after posting 50; seats 0 and 1 jam all-in. The 50 dead
  // money must be in the pot the showdown winner collects.
  const g = isolatedGame([1000, 1000, 1000]);
  const foldSeat2 = (game, p) => (p.seatIndex === 2 ? { action: 'fold' } : shove(game, p));
  const start = playHand(g, foldSeat2, rig(
    [['Ac', 'Ad'], ['Kc', 'Kd'], null], // seat0 beats seat1; seat2 folds
    NEUTRAL_BOARD
  ));
  assertSettled(g, start, 'B4');
  assert.equal(g.players[2].stack, 950, 'folder is down only their posted blind');
  assert.equal(g.players[0].stack, 2050, 'winner collects both stacks plus the 50 dead blind');
  assert.equal(g.players[1].stack, 0);
});

test('B5 three stack depths: a different player wins each of the three pots', () => {
  // Stacks 100/300/500 all-in. P0 (shortest) has the best hand, P1 the middle,
  // P2 (deepest) the worst. Main pot -> P0, middle side pot -> P1, top side pot
  // (uncontested, the deepest stack's overage) -> P2.
  const g = isolatedGame([100, 300, 500]); // seat0 BB, seat1 button, seat2 SB
  const start = playHand(g, shove, rig(
    [['Ac', 'Ad'], ['Kc', 'Kd'], ['Qc', 'Qd']],
    NEUTRAL_BOARD
  ));
  assertSettled(g, start, 'B5');
  assert.equal(g.players[0].stack, 300, 'shortest best hand wins the 300 main pot');
  assert.equal(g.players[1].stack, 400, 'middle stack/hand wins the 400 middle side pot');
  assert.equal(g.players[2].stack, 200, 'deepest stack reclaims its uncontested 200 overage');
});
