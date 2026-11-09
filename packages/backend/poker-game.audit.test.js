'use strict';
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const PokerGame = require('./poker-game');
const games = [];
function game(stacks, { timedRunout = false } = {}) {
  const g = new PokerGame('gameplay-audit');
  g.saveSnapshot = () => {};
  g.saveHandToDatabase = () => {};
  g.startActionTimer = () => {};
  if (!timedRunout) g.dramaticRunOut = function () {
    this.phase = 'showdown';
    this.currentPlayerIndex = -1;
    while (this.communityCards.length < 5) {
      this.deck.pop();
      this.communityCards.push(this.deck.pop());
    }
    this.endHand();
  };
  stacks.forEach((stack, i) => g.addPlayer(`u${i}`, `Player ${i}`, { initialStack: stack }));
  clearTimeout(g.handStartTimeout);
  g.handStartTimeout = null;
  games.push(g);
  return g;
}
afterEach(() => {
  for (const g of games.splice(0)) {
    g.clearActionTimer();
    g.clearRunoutTimeouts();
    clearTimeout(g.handStartTimeout);
    for (const timer of g.sitOutKickTimers.values()) clearTimeout(timer);
  }
});
const act = (g, action, amount) => g.processAction(g.players[g.currentPlayerIndex].userId, action, amount);
const chips = g => g.pot + g.players.reduce((n, p) => n + (p ? p.stack + p.currentBet : 0), 0);

test('public position markers use the posted blinds, including the heads-up dealer small blind', () => {
  for (const stacks of [[5000,5000],[5000,5000,5000,5000]]) {
    const g = game(stacks);
    if (stacks.length > 2) g.players[1].sittingOut = true;
    g.startNewHand();
    const state = g.getGameState(null);
    assert.equal(state.smallBlindSeat,g.histSbIdx);
    assert.equal(state.bigBlindSeat,g.histBbIdx);
    assert.equal(g.players[state.smallBlindSeat].currentBet,50);
    assert.equal(g.players[state.bigBlindSeat].currentBet,100);
    if (stacks.length===2) assert.equal(state.dealerSeat,state.smallBlindSeat);
    else assert.notEqual(state.smallBlindSeat,1);
  }
});

test('deferred departures broadcast the freed seat even when too few players remain to deal', async () => {
  const g = game([5000, 5000]);
  let updates = 0;
  g.onStateChange = () => { updates++; };
  g.startNewHand();
  const leaving = g.players[g.currentPlayerIndex].userId;
  g.removePlayer(leaving);
  assert.equal(g.handInProgress, false);
  assert.ok(g.players.some(p => p?.userId === leaving));
  const beforeCleanup = updates;
  await new Promise(resolve => setTimeout(resolve, 3100));
  assert.equal(g.players.some(p => p?.userId === leaving), false);
  assert.equal(g.handInProgress, false);
  assert.ok(updates > beforeCleanup);
});

test('forced all-in blinds settle without waiting for an impossible action', () => {
  for (const stacks of [[25, 25], [100, 25], [25, 50], [1, 1, 1], [100, 100, 25]]) {
    const g = game(stacks);
    g.startNewHand();
    let guard = 0;
    while (g.handInProgress && guard++ < 30) assert.equal(act(g, 'call').valid, true);
    assert.equal(g.handInProgress, false);
    assert.equal(chips(g), stacks.reduce((a, b) => a + b));
  }
});

test('a short big blind does not reduce the preflop call or minimum raise', () => {
  const g = game([60, 1000, 1000]);
  g.startNewHand();
  assert.equal(g.getMaxBet(), 100);
  assert.equal(g.getGameState('u1').currentBetToCall, 100);
  assert.equal(act(g, 'raise', 160).valid, false);
  assert.equal(act(g, 'call').valid, true);
  assert.equal(g.players[1].currentBet, 100);
});

test('a previous caller cannot make even a short all-in raise when action has not reopened', () => {
  const g = game([1000, 1000, 300, 250]);
  g.startNewHand(); // seat0 acts first, button1, SB2, BB3
  assert.equal(act(g, 'raise', 200).valid, true); // seat0
  assert.equal(act(g, 'call').valid, true); // seat1
  assert.equal(act(g, 'call').valid, true); // SB first calls200
  assert.equal(act(g, 'raise', 250).valid, true); // BB short raise
  assert.equal(g.currentPlayerIndex, 0);
  assert.equal(g.canPlayerRaise(g.players[0]), false);
  assert.equal(act(g, 'call').valid, true); // last faced250
  assert.equal(act(g, 'call').valid, true); // seat1 last faced250
  assert.equal(act(g, 'raise', 300).valid, false); // SB may only call or fold
  assert.equal(act(g, 'call').valid, true);
  assert.equal(g.phase, 'flop');
});

test('multiple short raises cumulatively reopen action without changing the last full increment', () => {
  const g = game([300, 1000, 1000, 250]);
  g.startNewHand(); // seat0 acts first
  assert.equal(act(g, 'call').valid, true); // seat0 waits with300
  assert.equal(act(g, 'raise', 200).valid, true); // seat1
  assert.equal(act(g, 'call').valid, true); // seat2
  assert.equal(act(g, 'raise', 250).valid, true); // seat3 all-in
  assert.equal(act(g, 'raise', 300).valid, true); // seat0 all-in, had only faced100
  assert.equal(g.currentPlayerIndex, 1);
  assert.equal(g.canPlayerRaise(g.players[1]), true, 'faces total increase100');
  assert.equal(g.lastRaise, 100);
  assert.equal(act(g, 'raise', 400).valid, true);
});

test('runout locks actions and duplicate settlement cannot pay the pot twice', () => {
  const g = game([100, 1000], { timedRunout: true });
  g.startNewHand();
  assert.equal(act(g, 'call').valid, true);
  assert.equal(g.phase, 'showdown');
  assert.equal(g.currentPlayerIndex, -1);
  assert.equal(g.processAction('u1', 'fold').valid, false);
  while (g.communityCards.length < 5) { g.deck.pop(); g.communityCards.push(g.deck.pop()); }
  g.endHand();
  assert.equal(chips(g), 1100);
  const stacks = g.players.map(p => p?.stack);
  g.endHand();
  assert.deepEqual(g.players.map(p => p?.stack), stacks);
});

test('leaving during all-in runout preserves eligibility and defers payout until settlement', () => {
  const g = game([100, 100], { timedRunout: true });
  g.startNewHand();
  assert.equal(act(g, 'call').valid, true);
  g.removePlayer('u0');
  assert.equal(g.players[0].folded, false);
  assert.equal(g.players[0]._pendingRemoval, true);
  assert.equal(chips(g), 200);
});

test('a non-acting opponent leaving ends an uncontested hand immediately', () => {
  const g = game([1000, 1000]);
  g.startNewHand();
  g.removePlayer('u0'); // BB leaves while SB is to act
  assert.equal(g.handInProgress, false);
  assert.equal(g.players[1].stack, 1100);
  assert.equal(chips(g), 2000);
});

test('odd chip goes to the tied winner left of the button', () => {
  const g = game([51, 1000, 1000]);
  g.startNewHand(); // button1, SB2, BB0
  g.players[0].holeCards = ['3c', '4d'];
  g.players[1].holeCards = ['Th', '5d'];
  g.players[2].holeCards = ['Ts', '6d'];
  assert.equal(act(g, 'call').valid, true);
  assert.equal(act(g, 'call').valid, true);
  while (g.phase !== 'river') assert.equal(act(g, 'check').valid, true);
  g.communityCards = ['Ah', 'Kd', 'Qc', 'Js', '2h'];
  while (g.handInProgress) assert.equal(act(g, 'check').valid, true);
  assert.equal(g.players[2].stack, g.players[1].stack + 1);
  assert.equal(chips(g), 2051);
});

test('duplicate starts cannot replace a live hand or its pot', () => {
  const g = game([1000, 1000]);
  g.startNewHand();
  const before = g.serializeState();
  g.startNewHand();
  assert.deepEqual(g.serializeState(), before);
});

test('recovery preserves depleted time banks and per-player raise restrictions', () => {
  const g = game([250, 1000, 1000]);
  g.startNewHand();
  assert.equal(act(g, 'raise', 200).valid, true);
  assert.equal(act(g, 'call').valid, true);
  assert.equal(act(g, 'raise', 250).valid, true);
  g.players[1].timeBankPreflop = 0;
  g.players[1].timeBankPostflop = 0;
  const restored = PokerGame.deserializeState(g.serializeState());
  assert.equal(restored.players[1].timeBankPreflop, 0);
  assert.equal(restored.players[1].timeBankPostflop, 0);
  assert.equal(restored.canPlayerRaise(restored.players[1]), false);
});

test('invalid buy-in values cannot introduce NaN, negative stacks or free chips', () => {
  const g = game([0, 1000]);
  assert.equal(g.players[0].stack, 0);
  for (const initialStack of [NaN, Infinity, -1, 0.5, '1000']) {
    assert.throws(() => g.addPlayer('invalid', 'Invalid', { initialStack }));
  }
  assert.equal(g.rebuy('u0', NaN).success, false);
  assert.equal(g.players[0].stack, 0);
});

test('1000 seeded mixed-action hands finish, preserve unique cards and conserve every chip', () => {
  let seed = 613872;
  const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed >>> 8) % n; };
  for (let hand = 0; hand < 1000; hand++) {
    const stacks = Array.from({ length: 2 + random(5) }, () => 1 + random(3000));
    const g = game(stacks);
    const total = chips(g);
    g.startNewHand();
    let turns = 0;
    while (g.handInProgress && turns++ < 150) {
      const p = g.players[g.currentPlayerIndex];
      assert.ok(p && !p.allIn && !p.folded && !p.sittingOut, `hand ${hand} has a valid actor`);
      const move = random(5);
      const action = move === 0 ? 'fold' : move >= 3 && g.canPlayerRaise(p) ? 'raise' : 'call';
      const amount = Math.min(p.currentBet + p.stack, g.getMaxBet() + Math.max(g.bigBlind, g.lastRaise) + random(400));
      assert.equal(act(g, action, amount).valid, true, `hand ${hand}: ${action}`);
      assert.equal(chips(g), total, `hand ${hand}: conservation after ${action}`);
    }
    assert.equal(g.handInProgress, false, `hand ${hand} terminates`);
    assert.equal(chips(g), total);
    const cards = [...g.communityCards, ...g.players.filter(Boolean).flatMap(p => p.holeCards)];
    assert.equal(new Set(cards).size, cards.length);
    // Release timers as we go so a long audit cannot start the next hand.
    clearTimeout(g.handStartTimeout);
    for (const timer of g.sitOutKickTimers.values()) clearTimeout(timer);
  }
});

test('duplicate action IDs survive recovery and are scoped to each player', () => {
  const g = game([1000, 1000, 1000]);
  g.startNewHand();
  assert.equal(g.processAction('u1', 'call', 0, {actionId:'same-id'}).valid, true);
  const restored = PokerGame.deserializeState(g.serializeState());
  const before = restored.serializeState();
  assert.equal(restored.processAction('u1', 'call', 0, {actionId:'same-id'}).valid, true);
  assert.deepEqual(restored.serializeState(), before, 'retry is a no-op');
  assert.equal(g.processAction('u2', 'call', 0, {actionId:'same-id'}).valid, true, 'another player owns a different ID namespace');
});

test('delayed actions from an earlier hand and malformed amounts cannot mutate the table', () => {
  const g = game([1000, 1000]);
  g.startNewHand();
  const before = g.serializeState();
  assert.equal(g.processAction('u1', 'fold', 0, {handCount:0}).valid, false);
  assert.equal(g.processAction('u1', 'raise', {toString:0,valueOf:0}).valid, false);
  assert.equal(g.processAction('u1', 'call', 0, {actionId:{}}).valid, false);
  assert.deepEqual(g.serializeState(), before);
});

test('uncalled all-in excess is refunded without declaring the losing hand a winner', () => {
  const g = game([300, 1000], {timedRunout:true});
  g.startNewHand();
  g.players[0].holeCards = ['Ah','Ad'];
  g.players[1].holeCards = ['Kh','Kd'];
  assert.equal(act(g, 'raise', 1000).valid, true);
  assert.equal(act(g, 'call').valid, true);
  assert.equal(g.players[1].stack, 700, 'uncalled excess returned before showdown');
  g.communityCards = ['2c','3d','7s','8h','9c'];
  g.endHand();
  assert.equal(g.players[0].stack, 600);
  assert.equal(g.players[1].stack, 700);
  assert.equal(g.players[1].wonPot, false);
});

test('time-bank growth adds only the configured increment to an empty bank', () => {
  const g = game([1000, 1000]);
  g.players[0].timeBankPreflop = 0;
  g.players[0].timeBankPostflop = 0;
  g.players[0].handsDealtCount = 9;
  g.startNewHand();
  assert.equal(g.players[0].timeBankPreflop, 5000);
  assert.equal(g.players[0].timeBankPostflop, 5000);
});

test('actual timed runout deals exactly five cards and settles once', t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const g = game([25,25], {timedRunout:true});
  let completions = 0;
  g.onHandComplete = () => completions++;
  g.startNewHand();
  assert.equal(g.phase, 'showdown');
  g.dramaticRunOut(); // duplicate scheduling must be a no-op
  t.mock.timers.tick(9000);
  assert.equal(g.communityCards.length, 5);
  assert.equal(g.handInProgress, false);
  assert.equal(chips(g), 50);
  assert.equal(completions, 2, 'one completion per participant');
});

test('forfeited side-pot money remains allocated after out-of-turn departures', () => {
  const g = game([1000,1000,1000]);
  g.players[0].totalInvested = 100;
  g.players[1].totalInvested = 200;
  g.players[2].totalInvested = 500;
  g.players[2].folded = true;
  const pots = g.calculateSidePots();
  assert.equal(pots.reduce((sum,pot)=>sum+pot.amount,0), 800);
  assert.ok(pots.every(pot=>pot.eligible.length > 0 && !pot.eligible.includes(g.players[2])));
});

test('real action timer uses the time bank, then folds and settles without losing chips', t => {
  t.mock.timers.enable({apis:['setTimeout','Date'],now:1000});
  const g = game([1000,1000]);
  g.startActionTimer = PokerGame.prototype.startActionTimer;
  g.startNewHand();
  t.mock.timers.tick(15000);
  assert.equal(g.handInProgress, true, 'base timer activates invested player time bank');
  assert.equal(g.timerPhase, 'timebank');
  t.mock.timers.tick(15000);
  assert.equal(g.handInProgress, false);
  assert.equal(g.players[1].timeBankPreflop, 0);
  assert.equal(g.players[1].sittingOutNextHand, true);
  assert.equal(g.players[1].actions.at(-1).action, 'fold');
  assert.equal(chips(g), 2000);
});
