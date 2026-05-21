'use strict';

// Engine guards for real-money tables: the rebuy free-chip mint must be blocked,
// and canCashOut must mirror the mid-hand rule (withdrawable == live stack, never
// while committed to a live hand). These are the engine-level defenses behind the
// Lightning cash-out flow.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const PokerGame = require('./poker-game');

function game(opts = {}) {
  const g = new PokerGame('rm-test', { smallBlind: 50, bigBlind: 100, ...opts });
  g.saveSnapshot = () => {};
  g.saveHandToDatabase = () => {};
  g.startActionTimer = () => {};
  g.deductTimeBank = () => {};
  return g;
}
function seat(g, stacks) {
  stacks.forEach((s, i) => g.addPlayer('u' + i, 'P' + i, { initialStack: s, preferredSeat: i }));
  if (g.handStartTimeout) { clearTimeout(g.handStartTimeout); g.handStartTimeout = null; }
}

test('real-money table refuses rebuy (no free chips minted)', () => {
  const g = game({ realMoney: true });
  seat(g, [10000]);
  g.players[0].stack = 0; // busted
  const r = g.rebuy('u0', 10000);
  assert.equal(r.success, false);
  assert.match(r.error, /deposit/i);
  assert.equal(g.players[0].stack, 0, 'stack must NOT be minted on a real-money table');
});

test('play-money table still allows rebuy (regression)', () => {
  const g = game({ realMoney: false });
  seat(g, [10000]);
  g.players[0].stack = 0;
  const r = g.rebuy('u0', 5000);
  assert.equal(r.success, true);
  assert.equal(g.players[0].stack, 5000);
});

test('canCashOut returns the live stack between hands', () => {
  const g = game();
  seat(g, [10000, 10000]);
  const r = g.canCashOut('u0');
  assert.equal(r.ok, true);
  assert.equal(r.stack, 10000);
});

test('canCashOut blocked for an active player mid-hand', () => {
  const g = game();
  seat(g, [10000, 10000]);
  g.startNewHand();
  const r = g.canCashOut('u0');
  assert.equal(r.ok, false);
  assert.match(r.error, /active hand/i);
});

test('canCashOut allowed for a folded player mid-hand', () => {
  const g = game();
  seat(g, [10000, 10000, 10000]);
  g.startNewHand();
  const cur = g.players[g.currentPlayerIndex];
  assert.equal(g.processAction(cur.userId, 'fold').valid, true);
  const r = g.canCashOut(cur.userId);
  assert.equal(r.ok, true, 'a folded player has no chips committed and may cash out');
});

test('removePlayer returns the freed stack between hands', () => {
  const g = game();
  seat(g, [7500]);
  const freed = g.removePlayer('u0');
  assert.equal(freed, 7500);
  assert.equal(g.players[0], null);
});
