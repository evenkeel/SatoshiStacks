'use strict';
// Card secrecy. Plays hundreds of random hands on the real engine (raises,
// shoves, folds, timeouts, players leaving) and, after every change, inspects
// the exact payload each seat, a spectator and a stranger would be sent, plus
// the public hand log and the text that is stored and published.
//
// The rules below are stated independently of getGameState on purpose:
//   - undealt cards, burn cards and folded hands are never sent to anyone;
//   - another player's cards are sent only at a showdown between two or more
//     live hands, and then never a mucked hand;
//   - your own two cards are exactly the two the engine holds for you.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const PokerGame = require('./poker-game');

const HANDS = 400;
const CARD = /(?<![A-Za-z0-9])[2-9TJQKA][shdc](?![A-Za-z0-9])/g;
const cardsIn = value => JSON.stringify(value).match(CARD) || [];

test('no viewer is ever sent a card they are not entitled to see', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const quiet = t.mock.method(console, 'log', () => {});
  let seed = 20261116;
  const rnd = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return Math.floor(seed / 4294967296 * n); };

  const g = new PokerGame('privacy');
  g.saveSnapshot = () => {};
  g.startActionTimer = () => {};                       // this test decides when a seat times out
  let stored = null;
  g.saveHandToDatabase = function () { stored = this.generateHandHistoryText(); };

  const stats = { hands: 0, payloads: 0, showdowns: 0, runoutStates: 0, mucks: 0 };
  let handId = null, tabled = new Set();
  const live = () => g.players.filter(p => p && p.participatedThisHand && !p.folded);
  // Seats whose cards other people may see right now.
  function faceUp() {
    const contested = g.phase === 'showdown' && live().length >= 2;
    const allIn = contested && live().some(p => p.allIn);            // all-in and called: hands are tabled
    return new Set(live().filter(p => contested && (allIn || (!g.handInProgress && !p.mucked))).map(p => p.userId));
  }
  function inspect() {
    if (g.getHandId() !== handId) { handId = g.getHandId(); tabled = new Set(); }
    const open = faceUp(), board = g.communityCards;
    for (const p of g.players) if (p && open.has(p.userId)) p.holeCards.forEach(c => tabled.add(c));
    if (g.phase === 'showdown' && g.handInProgress && board.length < 5) stats.runoutStates++;
    for (const viewer of [null, 'stranger', ...g.players.filter(Boolean).map(p => p.userId)]) {
      const state = JSON.parse(JSON.stringify(g.getGameState(viewer)));
      stats.payloads++;
      const me = g.players.find(p => p && p.userId === viewer);
      const allowed = new Set([...board, ...tabled, ...(me ? me.holeCards : [])]);
      for (const c of cardsIn(state)) assert.ok(allowed.has(c), `${viewer} was sent ${c} during ${g.phase}`);
      assert.deepEqual(state.communityCards, board);
      assert.ok(!JSON.stringify(state).includes('"deck"'));
      state.players.forEach((sent, i) => {
        if (!sent) return;
        const p = g.players[i];
        if (sent.userId === viewer || open.has(p.userId)) return assert.deepEqual(sent.holeCards, p.holeCards);
        assert.ok(sent.holeCards.every(c => c === '??'), `seat ${i} must be face down for ${viewer}`);
        assert.ok(sent.hand == null, 'a face-down hand has no visible strength');
      });
    }
  }
  g.onStateChange = inspect;
  g.onHandLog = line => {                               // goes to everyone watching the table
    const ok = new Set([...g.communityCards, ...tabled]);
    if (g.phase === 'showdown' && live().length >= 2) for (const p of live()) if (!p.mucked) p.holeCards.forEach(c => ok.add(c));
    for (const c of cardsIn(line)) assert.ok(ok.has(c), `public log exposes ${c}: ${line}`);
    if (/mucks hand/.test(line)) stats.mucks++;
  };
  g.onDealCards = (userId, line) => assert.deepEqual(cardsIn(line), g.players.find(p => p?.userId === userId).holeCards);

  const users = ['u0', 'u1', 'u2', 'u3', 'u4', 'u5'];
  function seat() {
    for (const u of users) {
      const p = g.players.find(x => x && x.userId === u);
      if (!p) { try { g.addPlayer(u, 'P' + u, { initialStack: 2000 + rnd(8) * 1000 }); } catch { /* seat still held until the hand ends */ } }
      else if (!g.handInProgress) {
        if (p.stack <= 0 || p.busted) g.rebuy(u, 5000);
        if (p.sittingOut && p.stack > 0) g.sitBackIn(u);
      }
    }
  }
  function playHand() {
    for (let steps = 0; g.handInProgress; steps++) {
      assert.ok(steps < 500, 'hand did not finish');
      inspect();
      if (g.phase === 'showdown' || g.currentPlayerIndex < 0) { t.mock.timers.tick(1000); continue; }
      const idx = g.currentPlayerIndex, p = g.players[idx], roll = rnd(100);
      if (roll < 3) { const other = g.players.filter(x => x && x !== p)[rnd(5)]; if (other) { g.removePlayer(other.userId); continue; } }
      if (roll < 8) { g.handleTimeout(idx); continue; }
      const maxBet = g.getMaxBet(), owes = maxBet > p.currentBet, pick = rnd(100);
      let done = pick < 12 && owes ? g.processAction(p.userId, 'fold')
        : pick < 50 ? g.processAction(p.userId, owes ? 'call' : 'check')
        : pick < 62 ? g.processAction(p.userId, 'raise', p.currentBet + p.stack)
        : g.processAction(p.userId, 'raise', maxBet + Math.max(g.bigBlind, g.lastRaise) * (1 + rnd(4)));
      if (!done.valid) done = g.processAction(p.userId, owes ? 'call' : 'check');
      if (!done.valid) done = g.processAction(p.userId, 'fold');
      assert.ok(done.valid);
      inspect();
    }
    inspect();
    const contested = live().length >= 2;
    if (contested) stats.showdowns++;
    // The text saved to the database, served by /api/hand and published to Nostr.
    const publicCards = new Set(g.communityCards);
    if (contested) for (const p of live()) if (!p.mucked) p.holeCards.forEach(c => publicCards.add(c));
    for (const c of cardsIn(stored)) assert.ok(publicCards.has(c), `stored hand history exposes ${c}`);
    assert.ok(!/Dealt to/.test(stored));
    for (const p of g.players) if (p?.mucked) assert.ok(!p.wonPot, 'a winning hand is never mucked');
    stats.hands++;
  }

  seat();
  for (let spins = 0; stats.hands < HANDS; spins++) {
    assert.ok(spins < HANDS * 400, 'driver stalled');
    if (g.handInProgress) { playHand(); continue; }
    seat();
    inspect();
    t.mock.timers.tick(1000);
  }
  g.clearActionTimer(); g.clearRunoutTimeouts(); clearTimeout(g.handStartTimeout);
  for (const timer of g.sitOutKickTimers.values()) clearTimeout(timer);
  quiet.mock.restore();
  // The run must actually have reached the situations it claims to cover.
  assert.ok(stats.showdowns > 100 && stats.runoutStates > 100 && stats.mucks > 0, JSON.stringify(stats));
});
