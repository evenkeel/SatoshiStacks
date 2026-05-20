'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const PokerGame = require('./poker-game');

// Build a seated player with only the fields the pot logic reads.
function mkPlayer(opts = {}) {
  return {
    userId: opts.userId || 'u' + Math.random().toString(36).slice(2),
    username: opts.username || 'player',
    folded: !!opts.folded,
    allIn: !!opts.allIn,
    sittingOut: !!opts.sittingOut,
    totalInvested: opts.totalInvested || 0,
    hand: opts.hand || null,
  };
}

// A game with the given players seated from seat 0 onward.
function gameWith(players) {
  const g = new PokerGame('test-table');
  players.forEach((p, i) => { g.players[i] = p; });
  return g;
}

const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0);

// ============================================================
//  calculateSidePots
// ============================================================

test('sidePots: single pot when everyone invested equally', () => {
  const g = gameWith([
    mkPlayer({ totalInvested: 100 }),
    mkPlayer({ totalInvested: 100 }),
    mkPlayer({ totalInvested: 100 }),
  ]);
  const pots = g.calculateSidePots();
  assert.equal(pots.length, 1);
  assert.equal(pots[0].amount, 300);
  assert.equal(pots[0].eligible.length, 3);
});

test('sidePots: short all-in creates a main pot + one side pot', () => {
  const shortStack = mkPlayer({ totalInvested: 50, allIn: true });
  const a = mkPlayer({ totalInvested: 200 });
  const b = mkPlayer({ totalInvested: 200 });
  const g = gameWith([shortStack, a, b]);

  const pots = g.calculateSidePots();
  assert.equal(pots.length, 2);

  // Main pot: all three eligible, 50 from each = 150
  assert.equal(pots[0].amount, 150);
  assert.equal(pots[0].eligible.length, 3);

  // Side pot: only the two deep stacks, 150 from each = 300
  assert.equal(pots[1].amount, 300);
  assert.equal(pots[1].eligible.length, 2);
  assert.ok(!pots[1].eligible.includes(shortStack));

  // Conservation: pots sum to total chips invested
  assert.equal(sum(pots, p => p.amount), 450);
});

test('sidePots: folded player\'s chips stay in the pot but they cannot win', () => {
  const folded = mkPlayer({ totalInvested: 100, folded: true });
  const a = mkPlayer({ totalInvested: 100 });
  const b = mkPlayer({ totalInvested: 100 });
  const g = gameWith([folded, a, b]);

  const pots = g.calculateSidePots();
  assert.equal(pots.length, 1);
  // Dead money from the folded player is still in the pot
  assert.equal(pots[0].amount, 300);
  // ...but they are not eligible to win it
  assert.equal(pots[0].eligible.length, 2);
  assert.ok(!pots[0].eligible.includes(folded));
});

test('sidePots: three all-in tiers produce three nested pots', () => {
  const p1 = mkPlayer({ totalInvested: 100, allIn: true });
  const p2 = mkPlayer({ totalInvested: 200, allIn: true });
  const p3 = mkPlayer({ totalInvested: 500 });
  const g = gameWith([p1, p2, p3]);

  const pots = g.calculateSidePots();
  assert.equal(pots.length, 3);

  assert.equal(pots[0].amount, 300); // 100 x3
  assert.equal(pots[0].eligible.length, 3);

  assert.equal(pots[1].amount, 200); // 100 x2 (p2, p3)
  assert.equal(pots[1].eligible.length, 2);

  assert.equal(pots[2].amount, 300); // 300 x1 (p3 only)
  assert.equal(pots[2].eligible.length, 1);
  assert.equal(pots[2].eligible[0], p3);

  assert.equal(sum(pots, p => p.amount), 800);
});

// ============================================================
//  findPotWinners
// ============================================================

test('findPotWinners: highest hand rank wins outright', () => {
  const g = gameWith([]);
  const fullHouse = mkPlayer({ hand: { rank: 6, tb: [7, 11] } });
  const flush = mkPlayer({ hand: { rank: 5, tb: [12, 9, 7, 3, 0] } });
  const winners = g.findPotWinners([fullHouse, flush]);
  assert.deepEqual(winners, [fullHouse]);
});

test('findPotWinners: identical hands split the pot', () => {
  const g = gameWith([]);
  const a = mkPlayer({ hand: { rank: 2, tb: [11, 7, 5] } });
  const b = mkPlayer({ hand: { rank: 2, tb: [11, 7, 5] } });
  const winners = g.findPotWinners([a, b]);
  assert.equal(winners.length, 2);
  assert.ok(winners.includes(a) && winners.includes(b));
});

test('findPotWinners: kicker breaks a same-rank tie', () => {
  const g = gameWith([]);
  const kingKicker = mkPlayer({ hand: { rank: 1, tb: [7, 11, 5, 0] } });
  const queenKicker = mkPlayer({ hand: { rank: 1, tb: [7, 10, 5, 0] } });
  const winners = g.findPotWinners([queenKicker, kingKicker]);
  assert.deepEqual(winners, [kingKicker]);
});
