'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluateHand, eval5, cmpTB } = require('./index');

// Rank constants (0 = worst, 9 = best) — mirror hand-evaluator.js
const HIGH = 0, PAIR = 1, TWO_PAIR = 2, TRIPS = 3, STRAIGHT = 4,
      FLUSH = 5, FULL_HOUSE = 6, QUADS = 7, STR_FLUSH = 8, ROYAL = 9;

// ============================================================
//  eval5 — exact 5-card classification
// ============================================================

test('eval5: royal flush', () => {
  const r = eval5(['Ah', 'Kh', 'Qh', 'Jh', 'Th']);
  assert.equal(r.rank, ROYAL);
  assert.deepEqual(r.tb, [12]);
  assert.equal(r.name, 'a Royal Flush');
});

test('eval5: straight flush (nine-high)', () => {
  const r = eval5(['9h', '8h', '7h', '6h', '5h']);
  assert.equal(r.rank, STR_FLUSH);
  assert.deepEqual(r.tb, [7]);
  assert.equal(r.name, 'a straight flush, Five to Nine');
});

test('eval5: wheel straight flush (A-2-3-4-5) ranks as five-high, not ace-high', () => {
  const r = eval5(['5h', '4h', '3h', '2h', 'Ah']);
  assert.equal(r.rank, STR_FLUSH);
  assert.deepEqual(r.tb, [3]);
  assert.equal(r.name, 'a straight flush, Ace to Five');
});

test('eval5: four of a kind', () => {
  const r = eval5(['9h', '9d', '9c', '9s', 'Kh']);
  assert.equal(r.rank, QUADS);
  assert.deepEqual(r.tb, [7, 11]);
  assert.equal(r.name, 'four of a kind, Nines');
});

test('eval5: full house', () => {
  const r = eval5(['9h', '9d', '9c', 'Kh', 'Kd']);
  assert.equal(r.rank, FULL_HOUSE);
  assert.deepEqual(r.tb, [7, 11]);
  assert.equal(r.name, 'a full house, Nines full of Kings');
});

test('eval5: flush', () => {
  const r = eval5(['Ah', 'Jh', '9h', '5h', '2h']);
  assert.equal(r.rank, FLUSH);
  assert.deepEqual(r.tb, [12, 9, 7, 3, 0]);
  assert.equal(r.name, 'a flush, Ace high');
});

test('eval5: straight (nine-high)', () => {
  const r = eval5(['9c', '8d', '7h', '6s', '5c']);
  assert.equal(r.rank, STRAIGHT);
  assert.deepEqual(r.tb, [7]);
  assert.equal(r.name, 'a straight, Five to Nine');
});

test('eval5: wheel straight (A-2-3-4-5) is the lowest straight', () => {
  const r = eval5(['5c', '4d', '3h', '2s', 'Ac']);
  assert.equal(r.rank, STRAIGHT);
  assert.deepEqual(r.tb, [3]);
  assert.equal(r.name, 'a straight, Ace to Five');
});

test('eval5: broadway straight (T-J-Q-K-A) is ace-high', () => {
  const r = eval5(['Ac', 'Kd', 'Qh', 'Js', 'Tc']);
  assert.equal(r.rank, STRAIGHT);
  assert.deepEqual(r.tb, [12]);
  assert.equal(r.name, 'a straight, Ten to Ace');
});

test('eval5: three of a kind', () => {
  const r = eval5(['9h', '9d', '9c', 'Kh', '2d']);
  assert.equal(r.rank, TRIPS);
  assert.deepEqual(r.tb, [7, 11, 0]);
  assert.equal(r.name, 'three of a kind, Nines');
});

test('eval5: two pair', () => {
  const r = eval5(['9h', '9d', 'Kc', 'Kh', '2d']);
  assert.equal(r.rank, TWO_PAIR);
  assert.deepEqual(r.tb, [11, 7, 0]);
  assert.equal(r.name, 'two pair, Kings and Nines');
});

test('eval5: one pair', () => {
  const r = eval5(['9h', '9d', 'Kc', '7h', '2d']);
  assert.equal(r.rank, PAIR);
  assert.deepEqual(r.tb, [7, 11, 5, 0]);
  assert.equal(r.name, 'a pair of Nines');
});

test('eval5: high card', () => {
  const r = eval5(['Ah', 'Jd', '9c', '7h', '2d']);
  assert.equal(r.rank, HIGH);
  assert.deepEqual(r.tb, [12, 9, 7, 5, 0]);
  assert.equal(r.name, 'high card Ace');
});

// ============================================================
//  cmpTB — tiebreaker comparison
// ============================================================

test('cmpTB: higher leading value wins', () => {
  assert.equal(cmpTB([12], [11]), 1);
  assert.equal(cmpTB([11], [12]), -1);
});

test('cmpTB: equal arrays tie', () => {
  assert.equal(cmpTB([7, 11, 0], [7, 11, 0]), 0);
});

test('cmpTB: later kicker breaks tie', () => {
  assert.equal(cmpTB([7, 12], [7, 11]), 1);
  assert.equal(cmpTB([7, 11], [7, 12]), -1);
});

// ============================================================
//  evaluateHand — best 5 of 7
// ============================================================

test('evaluateHand: picks flush over a lower-ranked made hand', () => {
  // Trip kings present, but five hearts make a flush (higher rank)
  const r = evaluateHand(['Ah', 'Qh', '5h', '2h', 'Kh', 'Kd', 'Kc']);
  assert.equal(r.rank, FLUSH);
  assert.deepEqual(r.tb, [12, 11, 10, 3, 0]); // A, K, Q, 5, 2 of hearts
});

test('evaluateHand: finds broadway straight among 7 cards', () => {
  const r = evaluateHand(['Ac', 'Kd', 'Qh', 'Js', 'Tc', '2d', '3h']);
  assert.equal(r.rank, STRAIGHT);
  assert.deepEqual(r.tb, [12]);
});

test('evaluateHand: finds wheel when no higher straight exists', () => {
  const r = evaluateHand(['Ac', '2d', '3h', '4s', '5c', 'Kd', 'Qh']);
  assert.equal(r.rank, STRAIGHT);
  assert.deepEqual(r.tb, [3]);
});

test('evaluateHand: full house from 7 cards', () => {
  const r = evaluateHand(['9h', '9d', '9c', 'Kh', 'Kd', '2c', '3s']);
  assert.equal(r.rank, FULL_HOUSE);
  assert.deepEqual(r.tb, [7, 11]);
});

test('evaluateHand: quads from 7 cards', () => {
  const r = evaluateHand(['9h', '9d', '9c', '9s', 'Kh', 'Kd', '2c']);
  assert.equal(r.rank, QUADS);
  assert.deepEqual(r.tb, [7, 11]);
});

test('evaluateHand: straight flush beats four of a kind', () => {
  // 6h-7h-8h-9h-Th straight flush, plus 6c6d6s would be quads if it existed;
  // here we have trip sixes alongside the straight flush
  const r = evaluateHand(['6h', '7h', '8h', '9h', 'Th', '6c', '6d']);
  assert.equal(r.rank, STR_FLUSH);
  assert.deepEqual(r.tb, [8]); // ten-high straight flush
});

test('evaluateHand: two boards-play hands compare equal (chopped pot)', () => {
  // Both players "play the board" — identical best five from shared cards
  const board = ['Ah', 'Kd', 'Qc', 'Js', 'Tc'];
  const a = evaluateHand([...board, '2d', '3h']); // broadway
  const b = evaluateHand([...board, '4s', '5c']); // broadway
  assert.equal(a.rank, b.rank);
  assert.equal(cmpTB(a.tb, b.tb), 0);
});

test('evaluateHand: higher kicker wins same top pair', () => {
  // Both pair of aces; one has a king kicker, other a queen
  const withKing = evaluateHand(['Ah', 'Ad', 'Kh', '7c', '4d', '3s', '2c']);
  const withQueen = evaluateHand(['As', 'Ac', 'Qh', '7d', '4h', '3c', '2d']);
  assert.equal(withKing.rank, PAIR);
  assert.equal(withQueen.rank, PAIR);
  assert.equal(cmpTB(withKing.tb, withQueen.tb), 1);
});
