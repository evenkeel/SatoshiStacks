'use strict';
// Showdown procedure: which hands are tabled, which are mucked, and that a
// mucked hand is never visible to anyone but its owner — live or in history.
process.env.SATOSHISTACKS_DB_PATH = process.env.SATOSHISTACKS_DB_PATH || ':memory:';
process.env.ADMIN_TOKEN ||= 'test-admin-token';
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const PokerGame = require('./poker-game');
console.log = () => {};
const games = [];
function game(stacks) {
  const g = new PokerGame('showdown-rules');
  g.saveSnapshot = () => {}; g.saveHandToDatabase = () => {}; g.startActionTimer = () => {};
  g.dramaticRunOut = function () {
    this.phase = 'showdown'; this.currentPlayerIndex = -1;
    while (this.communityCards.length < 5) { this.deck.pop(); this.communityCards.push(this.deck.pop()); }
    this.endHand();
  };
  g.histories = new Map();
  g.onHandComplete = (userId, history) => g.histories.set(userId, history);
  stacks.forEach((stack, i) => g.addPlayer(`u${i}`, `Player${i}`, { initialStack: stack, preferredSeat: i }));
  clearTimeout(g.handStartTimeout); g.handStartTimeout = null;
  games.push(g);
  return g;
}
afterEach(() => {
  for (const g of games.splice(0)) {
    g.clearActionTimer(); g.clearRunoutTimeouts(); clearTimeout(g.handStartTimeout);
    for (const timer of g.sitOutKickTimers.values()) clearTimeout(timer);
  }
});
const current = g => g.players[g.currentPlayerIndex];
function passive(g) { const p = current(g); if (!g.processAction(p.userId, 'check').valid) assert.equal(g.processAction(p.userId, 'call').valid, true); }
function toRiver(g) { let guard = 0; while (g.phase !== 'river' && guard++ < 40) passive(g); assert.equal(g.phase, 'river'); }
// Board with no straight or flush available to the hole cards used below.
const BOARD = ['2c', '7d', '9h', 'Jc', 'Ks'];
const KINGS = ['Kd', '5c'], JACKS = ['Jd', '3s'], SEVENS = ['7s', '4h'], KINGS_TOO = ['Kh', '5d'];
/** Live seats in showdown order when nobody bets the river: clockwise from the button's left. */
function leftOfButton(g) {
  return g.players.filter(p => p && !p.folded)
    .sort((a, b) => ((a.seatIndex - g.dealerSeat - 1 + 6) % 6) - ((b.seatIndex - g.dealerSeat - 1 + 6) % 6));
}
function deal(g, order, hands) { g.communityCards = [...BOARD]; order.forEach((p, i) => { p.holeCards = [...hands[i]]; }); }
function finishChecked(g) { let guard = 0; while (g.handInProgress && guard++ < 10) passive(g); assert.equal(g.handInProgress, false); }
const cardsOf = (state, userId) => state.players.find(p => p && p.userId === userId).holeCards;
// Streets dealt before the test fixes the board are already in the log and may
// contain any card, so leaks are detected by a hand's exact pair, never by a lone card code.
const leak = cards => new RegExp(`\\[${cards[0]} ${cards[1]}\\]|"${cards[0]}","${cards[1]}"`);
function assertHidden(value, ...hands) { for (const hand of hands) assert.doesNotMatch(typeof value === 'string' ? value : JSON.stringify(value), leak(hand)); }

test('with no river bet, hands show clockwise from the button and a beaten hand is mucked unseen', () => {
  const g = game([5000, 5000, 5000]);
  g.startNewHand(); toRiver(g);
  const [first, second, third] = leftOfButton(g);
  deal(g, [first, second, third], [JACKS, SEVENS, KINGS]);
  finishChecked(g);

  assert.equal(first.mucked, false, 'first to show must table their hand even though it later loses');
  assert.equal(second.mucked, true, 'a hand that cannot beat the jacks already shown is mucked');
  assert.equal(third.mucked, false);
  assert.equal(third.wonPot, true);

  // Spectators and opponents never receive the mucked cards or its evaluation.
  for (const viewer of [null, first.userId, third.userId]) {
    const state = g.getGameState(viewer);
    assert.deepEqual(cardsOf(state, second.userId), ['??', '??']);
    const seat = state.players.find(p => p && p.userId === second.userId);
    assert.equal(seat.hand, null); assert.equal(seat.mucked, true);
    assert.deepEqual(cardsOf(state, first.userId), JACKS);
    assert.deepEqual(cardsOf(state, third.userId), KINGS);
    assertHidden(state, SEVENS);   // no field of the state carries the mucked hand
  }
  // Their owner still sees them.
  assert.deepEqual(cardsOf(g.getGameState(second.userId), second.userId), SEVENS);

  // The shared log, the stored history and every other player's history omit them.
  const log = g.currentHandLog.join('\n');
  assert.match(log, new RegExp(`${second.username}: mucks hand`));
  assert.match(log, new RegExp(`Seat ${second.seatIndex + 1}: ${second.username}.* mucked`));
  assert.match(log, new RegExp(`${first.username}: shows \\[Jd 3s\\]`));
  assert.match(log, new RegExp(`${first.username}.* showed \\[Jd 3s\\] and lost`));
  for (const history of [log, g.generateHandHistoryText(), g.histories.get(first.userId), g.histories.get(third.userId)]) {
    assert.ok(history.length > 0);
    assertHidden(history, SEVENS);
  }
  assert.match(g.histories.get(second.userId), /Dealt to Player\d \[7s 4h\]/, 'the owner keeps their own cards in their own history');
});

test('the last player to bet the river shows first, and callers who are beaten muck', () => {
  const g = game([5000, 5000, 5000]);
  g.startNewHand(); toRiver(g);
  const order = leftOfButton(g);
  const [first, second, bettor] = order;
  deal(g, order, [JACKS, SEVENS, KINGS]);
  // Checked to the last seat, who bets; both others call.
  let guard = 0;
  while (current(g) !== bettor && guard++ < 5) assert.equal(g.processAction(current(g).userId, 'check').valid, true);
  assert.equal(g.processAction(bettor.userId, 'raise', 300).valid, true);
  assert.equal(g.processAction(current(g).userId, 'call').valid, true);
  assert.equal(g.processAction(current(g).userId, 'call').valid, true);
  assert.equal(g.handInProgress, false);

  assert.equal(bettor.mucked, false); assert.equal(bettor.wonPot, true);
  assert.equal(first.mucked, true, 'the jacks were shown in the unbet hand, but here the kings show first');
  assert.equal(second.mucked, true);
  const state = g.getGameState(null);
  assert.deepEqual(cardsOf(state, bettor.userId), KINGS);
  assertHidden(state, JACKS, SEVENS);
  assertHidden(g.generateHandHistoryText(), JACKS, SEVENS);
  assert.match(JSON.stringify(g.getGameState(first.userId)), leak(JACKS), 'the leak check does detect a visible hand');
  const shows = g.currentHandLog.filter(line => /: (shows|mucks)/.test(line));
  assert.match(shows[0], new RegExp(`^${bettor.username}: shows`), 'the aggressor is first in the showdown log');
});

test('a hand that ties the best shown hand is tabled and shares the pot', () => {
  const g = game([5000, 5000, 5000]);
  g.startNewHand(); toRiver(g);
  const order = leftOfButton(g);
  deal(g, order, [KINGS, SEVENS, KINGS_TOO]);
  finishChecked(g);
  assert.deepEqual(order.map(p => p.mucked), [false, true, false]);
  assert.deepEqual(order.map(p => !!p.wonPot), [true, false, true]);
  assert.equal(g.players.reduce((sum, p) => sum + (p ? p.stack : 0), 0), 15000);
});

test('when a player is all-in, every live hand is tabled', () => {
  const g = game([1000, 5000, 5000]);
  g.startNewHand();
  let guard = 0;
  while (g.handInProgress && guard++ < 20) {
    const p = current(g);
    if (!g.processAction(p.userId, 'raise', p.stack + p.currentBet).valid) assert.equal(g.processAction(p.userId, 'call').valid, true);
  }
  assert.equal(g.handInProgress, false);
  const live = g.players.filter(p => p && !p.folded);
  assert.ok(live.length >= 2);
  assert.ok(live.every(p => p.mucked === false));
  const state = g.getGameState(null);
  for (const p of live) assert.deepEqual(cardsOf(state, p.userId), p.holeCards);
});

test('a hand won without a showdown reveals nothing', () => {
  const g = game([5000, 5000, 5000]);
  g.startNewHand();
  let guard = 0;
  while (g.handInProgress && guard++ < 5) g.processAction(current(g).userId, 'fold');
  assert.equal(g.handInProgress, false);
  const state = g.getGameState(null);
  assert.ok(state.players.filter(Boolean).every(p => p.holeCards.every(card => card === '??')));
  assert.doesNotMatch(g.currentHandLog.join('\n'), /shows|showed/);
});

test('a restart between hands cannot expose a mucked hand, and the flag clears on the next deal', () => {
  const g = game([5000, 5000, 5000]);
  g.startNewHand(); toRiver(g);
  const order = leftOfButton(g);
  deal(g, order, [JACKS, SEVENS, KINGS]);
  finishChecked(g);
  const restored = PokerGame.deserializeState(JSON.parse(JSON.stringify(g.serializeState())), { expectedRealMoney: false });
  games.push(restored);
  const seat = restored.getGameState(null).players.find(p => p && p.userId === order[1].userId);
  assert.deepEqual(seat.holeCards, ['??', '??']); assert.equal(seat.mucked, true);
  clearTimeout(g.handStartTimeout); g.handStartTimeout = null;
  g.startNewHand();
  assert.ok(g.players.filter(Boolean).every(p => p.mucked === false));
});
