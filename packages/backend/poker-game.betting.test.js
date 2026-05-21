'use strict';

// Betting-rule validation tests — what processAction() accepts and rejects, and
// how betting state (maxBet, lastRaise, action reopening) transitions. These
// guard the rules that keep a hand legal:
//   - turn order; you can only act when it's your turn
//   - check is illegal when you owe chips
//   - a raise must exceed the current bet and meet the minimum-raise size
//   - the min-raise increment grows with the last full raise
//   - a short all-in below a full raise is allowed but does NOT reopen action
//     for players who already acted; a full re-raise does reopen it
//
// Blinds are 50/100 throughout. Seat layout on hand 1 is deterministic:
// 3-handed -> seat0 = BB, seat1 = button (first to act preflop), seat2 = SB.

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

function isolatedGame(stacks, opts = {}) {
  const g = new PokerGame('betting-test', { smallBlind: 50, bigBlind: 100, ...opts });
  g.saveSnapshot = () => {};
  g.saveHandToDatabase = () => {};
  g.startActionTimer = () => {};
  g.deductTimeBank = () => {};
  g.dramaticRunOut = function () {
    this.phase = 'showdown';
    while (this.communityCards.length < 5) { this.deck.pop(); this.communityCards.push(this.deck.pop()); }
    this.endHand();
  };
  stacks.forEach((s, i) => g.addPlayer('u' + i, 'P' + i, { initialStack: s, preferredSeat: i }));
  if (g.handStartTimeout) { clearTimeout(g.handStartTimeout); g.handStartTimeout = null; }
  return g;
}

function startedGame(stacks, opts) {
  const g = isolatedGame(stacks, opts);
  g.startNewHand();
  return g;
}

// Act as the player in a specific seat (regardless of whose turn it is, so we
// can probe out-of-turn behavior).
const actAs = (g, seat, action, amount) =>
  g.processAction(g.players[seat].userId, action, amount || 0);

const THREE = [10000, 10000, 10000]; // deep 3-handed: seat1 button acts first

// ============================================================================
//  Action legality
// ============================================================================

test('rejects acting out of turn', () => {
  const g = startedGame(THREE);            // seat1 (button) is to act
  const res = actAs(g, 2, 'call');         // seat2 (SB) tries to act early
  assert.equal(res.valid, false);
  assert.match(res.error, /not your turn/i);
});

test('rejects any action when no hand is in progress', () => {
  const g = isolatedGame(THREE);           // note: NOT started
  const res = actAs(g, 1, 'call');
  assert.equal(res.valid, false);
  assert.match(res.error, /no hand in progress/i);
});

test('rejects an unknown action verb', () => {
  const g = startedGame(THREE);
  const res = actAs(g, 1, 'bet', 500);     // "bet" is not a recognized verb
  assert.equal(res.valid, false);
  assert.match(res.error, /invalid action/i);
});

test('rejects check while facing the big blind', () => {
  const g = startedGame(THREE);            // button owes 100 to call
  const res = actAs(g, 1, 'check');
  assert.equal(res.valid, false);
  assert.match(res.error, /cannot check/i);
});

test('fold and call are always legal on your turn', () => {
  const g1 = startedGame(THREE);
  assert.equal(actAs(g1, 1, 'call').valid, true);
  const g2 = startedGame(THREE);
  assert.equal(actAs(g2, 1, 'fold').valid, true);
});

// ============================================================================
//  Raise sizing
// ============================================================================

test('rejects a raise that does not exceed the current bet', () => {
  const g = startedGame(THREE);            // maxBet = 100 (BB)
  assert.match(actAs(g, 1, 'raise', 50).error, /higher than current bet/i);   // below
  assert.match(actAs(g, 1, 'raise', 100).error, /higher than current bet/i);  // equal
});

test('rejects a raise below the minimum raise size', () => {
  const g = startedGame(THREE);            // min legal raise = 100 + 100 = 200
  const res = actAs(g, 1, 'raise', 150);
  assert.equal(res.valid, false);
  assert.match(res.error, /minimum raise is 200/i);
});

test('accepts a raise to exactly the minimum', () => {
  const g = startedGame(THREE);
  const res = actAs(g, 1, 'raise', 200);
  assert.equal(res.valid, true);
  assert.equal(g.getMaxBet(), 200);
});

test('the minimum-raise increment grows with the last full raise', () => {
  const g = startedGame(THREE);
  assert.equal(actAs(g, 1, 'raise', 200).valid, true);   // increment 100 -> maxBet 200
  // Next min raise = 200 + max(BB, lastRaise=100) = 300
  assert.match(actAs(g, 2, 'raise', 250).error, /minimum raise is 300/i);
  assert.equal(actAs(g, 2, 'raise', 400).valid, true);   // increment 200 -> maxBet 400, lastRaise 200
  assert.equal(g.getMaxBet(), 400);
  // Next min raise = 400 + max(BB, lastRaise=200) = 600
  assert.match(actAs(g, 0, 'raise', 500).error, /minimum raise is 600/i);
  assert.equal(actAs(g, 0, 'raise', 600).valid, true);
});

test('sanitizes a negative raise amount (treated as 0, i.e. not a valid raise)', () => {
  const g = startedGame(THREE);
  const res = actAs(g, 1, 'raise', -100);
  assert.equal(res.valid, false);
  assert.match(res.error, /higher than current bet/i);
});

// ============================================================================
//  All-in raise exemption & reopening
// ============================================================================

test('allows a short all-in raise below the minimum (stack exhausted)', () => {
  // seat1 (button) has exactly 150 — less than the 200 minimum raise — but is
  // putting its whole stack in, so it is allowed.
  const g = startedGame([10000, 150, 10000]);
  const res = actAs(g, 1, 'raise', 150);
  assert.equal(res.valid, true);
  assert.equal(g.players[1].allIn, true);
});

test('rejects a sub-minimum raise when the player keeps chips behind', () => {
  const g = startedGame(THREE);            // deep stack, raise to 150 leaves chips
  const res = actAs(g, 1, 'raise', 150);
  assert.equal(res.valid, false);
  assert.match(res.error, /minimum raise is 200/i);
});

test('a short all-in below a full raise does NOT reopen action', () => {
  // button raises to 200, SB calls, BB jams all-in to 250 (increment 50 < the
  // 100 minimum increment). The already-acted button/SB are NOT given the
  // option to re-raise — the preflop round closes and the hand reaches the flop.
  const g = startedGame([250, 10000, 10000]); // seat0 (BB) total = 250
  assert.equal(actAs(g, 1, 'raise', 200).valid, true);
  assert.equal(actAs(g, 2, 'call').valid, true);
  const res = actAs(g, 0, 'raise', 250);
  assert.equal(res.valid, true);
  assert.equal(g.players[0].allIn, true);
  assert.equal(g.phase, 'flop', 'preflop betting closed without reopening');
});

test('a full re-raise DOES reopen action for players who already acted', () => {
  // Same start, but BB makes a full re-raise to 400 (increment 200 >= 100).
  // Action reopens: it returns to the button, still preflop.
  const g = startedGame([10000, 10000, 10000]);
  assert.equal(actAs(g, 1, 'raise', 200).valid, true);
  assert.equal(actAs(g, 2, 'call').valid, true);
  const res = actAs(g, 0, 'raise', 400);
  assert.equal(res.valid, true);
  assert.equal(g.phase, 'preflop', 'still preflop — action reopened');
  assert.equal(g.currentPlayerIndex, 1, 'action returns to the button');
  assert.equal(g.lastRaise, 200);
});

// ============================================================================
//  Check legality once the bet is matched
// ============================================================================

test('big blind may check when limped to, and the round advances', () => {
  const g = startedGame(THREE);
  assert.equal(actAs(g, 1, 'call').valid, true);   // button limps
  assert.equal(actAs(g, 2, 'call').valid, true);   // SB completes
  assert.equal(g.currentPlayerIndex, 0, 'action is on the big blind');
  const res = actAs(g, 0, 'check');                // BB has nothing to call
  assert.equal(res.valid, true);
  assert.equal(g.phase, 'flop');
  // Postflop, first to act may check into an unbet pot.
  const flopActor = g.currentPlayerIndex;
  assert.equal(g.getMaxBet(), 0);
  assert.equal(actAs(g, flopActor, 'check').valid, true);
});
