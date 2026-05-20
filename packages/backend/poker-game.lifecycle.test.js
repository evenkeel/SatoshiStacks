'use strict';

// Full-hand lifecycle integration tests. These drive real betting actions
// through the engine (deal -> betting rounds -> showdown/payout) and assert
// the core money invariant: chips are conserved — never created or destroyed.
//
// The engine is isolated from infrastructure for these tests:
//   - DB writes (saveSnapshot / saveHandToDatabase) are stubbed out
//   - timer methods (startActionTimer / deductTimeBank) are stubbed out
//   - global setTimeout is unref()'d so the engine's bare "next hand" timer
//     in endHand() cannot keep the test process alive
// All betting logic, phase progression, side-pot math and payouts run for real.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const PokerGame = require('./poker-game');

// ---- timer containment -----------------------------------------------------
let realSetTimeout;
before(() => {
  realSetTimeout = global.setTimeout;
  // Keep timers functional for node:test itself, but unref them so no engine
  // timer (e.g. endHand's 3s next-hand scheduler) holds the process open.
  global.setTimeout = (fn, ms, ...args) => {
    const t = realSetTimeout(fn, ms, ...args);
    if (t && typeof t.unref === 'function') t.unref();
    return t;
  };
});
after(() => { global.setTimeout = realSetTimeout; });

// ---- helpers ---------------------------------------------------------------

// Total chips in play: every stack + uncollected bets + the pot.
// This must be invariant from before a hand starts through payout.
function totalChips(g) {
  const onTable = g.players.reduce(
    (sum, p) => (p ? sum + p.stack + p.currentBet : sum), 0
  );
  return onTable + g.pot;
}

// Sum of all seated players' stacks (empty seats are null).
function sumStacks(g) {
  return g.players.reduce((s, p) => (p ? s + p.stack : s), 0);
}

function isolatedGame(stacks, opts = {}) {
  const g = new PokerGame('lifecycle-test', { smallBlind: 50, bigBlind: 100, ...opts });
  // Isolate from infrastructure side-effects.
  g.saveSnapshot = () => {};
  g.saveHandToDatabase = () => {};
  g.startActionTimer = () => {};
  g.deductTimeBank = () => {};
  stacks.forEach((s, i) => g.addPlayer('u' + i, 'P' + i, { initialStack: s, preferredSeat: i }));
  // addPlayer schedules an auto-start timer once 2+ players are seated — cancel
  // it so we control hand starts explicitly.
  if (g.handStartTimeout) { clearTimeout(g.handStartTimeout); g.handStartTimeout = null; }
  return g;
}

// Drive a hand to completion. `strategy(game, player) => { action, amount }`
// decides each player's move. Asserts chip conservation after every action.
function playHand(g, strategy) {
  const startTotal = totalChips(g);
  g.startNewHand();
  assert.equal(totalChips(g), startTotal, 'chips conserved after blinds posted');

  let guard = 0;
  while (g.handInProgress && guard++ < 500) {
    const idx = g.currentPlayerIndex;
    if (idx < 0) break;
    const player = g.players[idx];
    if (!player) break;

    const move = strategy(g, player);
    const res = g.processAction(player.userId, move.action, move.amount || 0);
    assert.ok(res.valid, `action "${move.action}" rejected: ${res.error}`);
    assert.equal(totalChips(g), startTotal, `chips conserved after ${move.action}`);
  }

  assert.ok(!g.handInProgress, 'hand finished within guard limit');
  assert.equal(g.pot, 0, 'pot fully distributed at hand end');
  assert.equal(totalChips(g), startTotal, 'chips conserved through payout');
  return startTotal;
}

// Strategy: passive — always call (which acts as a free check when nothing is
// owed). Drives the hand to showdown with no folds and no all-ins.
const callDown = () => ({ action: 'call' });

// Strategy: everyone folds the moment it's their turn. The hand ends as soon as
// only one player remains.
const foldAlways = () => ({ action: 'fold' });

// ---- tests -----------------------------------------------------------------

test('lifecycle: 6-handed passive showdown conserves chips', () => {
  const g = isolatedGame([10000, 10000, 10000, 10000, 10000, 10000]);
  const before = totalChips(g);
  assert.equal(before, 60000);
  playHand(g, callDown);
  assert.equal(g.phase, 'showdown');
  // No chips created or destroyed.
  assert.equal(sumStacks(g), 60000);
});

test('lifecycle: heads-up call-down conserves chips and reaches showdown', () => {
  const g = isolatedGame([5000, 5000]);
  playHand(g, callDown);
  assert.equal(g.phase, 'showdown');
  assert.equal(sumStacks(g), 10000);
});

test('lifecycle: fold-out awards the pot to the lone survivor, chips conserved', () => {
  const g = isolatedGame([10000, 10000, 10000]);
  playHand(g, foldAlways);
  const survivors = g.players.filter(p => p && !p.folded);
  assert.equal(survivors.length, 1);
  // Exactly one winner; total is unchanged and the winner is up by the blinds
  // the others posted.
  assert.equal(sumStacks(g), 30000);
  assert.ok(survivors[0].stack > 10000, 'survivor collected the blinds');
});

test('lifecycle: a raise followed by calls conserves chips to showdown', () => {
  const g = isolatedGame([10000, 10000, 10000]);
  // First player to act preflop makes one min-legal raise to 300, everyone
  // else just calls; thereafter everyone checks down.
  let raised = false;
  const raiseOnce = (game, player) => {
    const maxBet = game.getMaxBet();
    if (!raised && game.phase === 'preflop' && maxBet === game.bigBlind) {
      raised = true;
      return { action: 'raise', amount: 300 };
    }
    return { action: 'call' };
  };
  playHand(g, raiseOnce);
  assert.equal(g.phase, 'showdown');
  assert.equal(sumStacks(g), 30000);
});

test('lifecycle: chips are conserved across several consecutive hands', () => {
  const g = isolatedGame([10000, 10000, 10000, 10000]);
  const START = 40000;
  for (let hand = 0; hand < 5; hand++) {
    // Alternate between showdown and fold-out hands to exercise both paths.
    playHand(g, hand % 2 === 0 ? callDown : foldAlways);
    assert.equal(sumStacks(g), START, `chips conserved after hand ${hand + 1}`);
  }
  // The dealer button must have advanced over the course of five hands.
  assert.equal(g.handCount, 5);
});
