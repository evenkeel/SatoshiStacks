'use strict';
// Engine regressions from the November 15 review: short all-in big blinds,
// busted seats, and the idle-kick clock after crash recovery.
process.env.SATOSHISTACKS_DB_PATH = process.env.SATOSHISTACKS_DB_PATH || ':memory:';
process.env.ADMIN_TOKEN ||= 'test-admin-token';
const { test, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const db = require('./database');
const PokerGame = require('./poker-game');
console.log = () => {};
const games = [];
function game(stacks) {
  const g = new PokerGame('repro');
  g.saveSnapshot = () => {}; g.saveHandToDatabase = () => {}; g.startActionTimer = () => {};
  g.dramaticRunOut = function () { this.phase = 'showdown'; this.currentPlayerIndex = -1;
    while (this.communityCards.length < 5) { this.deck.pop(); this.communityCards.push(this.deck.pop()); } this.endHand(); };
  stacks.forEach((s, i) => g.addPlayer('u' + i, 'P' + i, { initialStack: s, preferredSeat: i }));
  clearTimeout(g.handStartTimeout); g.handStartTimeout = null; games.push(g); return g;
}
afterEach(() => { for (const g of games.splice(0)) { g.clearActionTimer(); g.clearRunoutTimeouts(); clearTimeout(g.handStartTimeout); for (const t of g.sitOutKickTimers.values()) clearTimeout(t); } });

test('heads-up: a big blind all-in for less than the small blind leaves the small blind nothing to decide', () => {
  const g = game([30, 5000]);            // hand 1: seat1 = button/SB (5000), seat0 = BB (30, all-in on the blind)
  g.startNewHand();
  const sb = g.players[1], bb = g.players[0];
  assert.equal(g.histSbIdx, 1); assert.equal(g.histBbIdx, 0);
  const state = g.getGameState('u1');
  // What the action timer does to a disconnected/slow SB:
  if (g.handInProgress && g.phase !== 'showdown') g.handleTimeout(g.currentPlayerIndex);
  assert.equal(sb.folded, false, 'SB already covers the all-in; a timeout must not fold the hand');
  assert.ok(bb.stack <= 60, `BB can win at most 30 from the SB, but ended with ${bb.stack}`);
});

test('three-handed: folded to a small blind that already covers a short all-in big blind, the hand runs out', () => {
  const g = game([40, 5000, 5000]);     // hand 1: seat0 = BB (40, all-in), seat1 = button, seat2 = SB
  g.startNewHand();
  const bbSeat = g.histBbIdx, sbSeat = g.histSbIdx;
  if (g.players[bbSeat].stack + g.players[bbSeat].currentBet !== 40) {   // rotate until the 40-stack is the BB
    assert.fail(`setup: BB seat is ${bbSeat}`);
  }
  const btn = g.players[g.currentPlayerIndex];
  assert.equal(g.processAction(btn.userId, 'fold').valid, true);
  const sb = g.players[sbSeat], bb = g.players[bbSeat];
  if (g.handInProgress && g.phase !== 'showdown') { g.processAction(sb.userId, 'check'); g.handleTimeout(g.currentPlayerIndex); }
  assert.equal(sb.folded, false);
});

test('a busted player cannot sit back in with no chips or cancel the rebuy clock', () => {
  const g = game([1000, 1000]);
  g.startNewHand();
  let guard = 0;
  while (g.handInProgress && guard++ < 20) { const p = g.players[g.currentPlayerIndex]; if (!g.processAction(p.userId, 'raise', p.stack + p.currentBet).valid) g.processAction(p.userId, 'call'); }
  const loser = g.players.find(p => p && p.stack === 0);   // empty seats are null
  if (!loser) return;                    // split pot: nothing to show this run
  assert.equal(loser.busted, true); assert.ok(g.sitOutKickTimers.has(loser.userId), 'bust kick armed');
  const r = g.sitBackIn(loser.userId);
  assert.equal(r.success, false, 'a 0-chip player must not be able to sit back in');
  assert.ok(g.sitOutKickTimers.has(loser.userId), 'bust-kick timer must stay armed');
});

test('after crash recovery, players who reconnect and keep playing are not idle-kicked five minutes later', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  // ---- before the crash: a live 3-handed hand, snapshotted to the DB by the engine itself
  const live = new PokerGame('station100');
  live.saveHandToDatabase = () => {};
  ['u0', 'u1', 'u2'].forEach((u, i) => live.addPlayer(u, 'P' + i, { initialStack: 10000 }));
  clearTimeout(live.handStartTimeout); live.handStartTimeout = null;
  live.startNewHand();
  live.processAction(live.players[live.currentPlayerIndex].userId, 'call');
  live.clearActionTimer();                                   // process dies here
  // ---- restart: recoverInProgressHands()
  const [{ snapshot }] = db.getAllHandSnapshots();
  const game = PokerGame.deserializeState(snapshot, { expectedRealMoney: false });
  game.saveHandToDatabase = () => {};
  for (const player of game.players) {                       // server.js:224-230
    if (!player) continue;
    player.disconnected = true;
    player.sittingOutNextHand = true;
    if (!game.handInProgress) player.sittingOut = true;
    game.startSitOutKickTimer(player.userId);
  }
  if (game.handInProgress && game.currentPlayerIndex >= 0) game.startActionTimer();   // server.js:247-248
  const total = () => game.pot + game.players.reduce((n, p) => n + (p ? p.stack + p.currentBet : 0), 0);
  assert.equal(total(), 30000);
  // ---- everyone reconnects within seconds (resumeExistingSeat -> setDisconnected(false)) and clicks "Cancel Sit Out"
  mock.timers.tick(5000);
  for (const p of game.players.filter(Boolean)) { game.setDisconnected(p.userId, false); const r = game.voluntarySitOut(p.userId); assert.equal(r.cancelled, true); }
  // ---- they keep playing normally (everyone acts within 2 s, check/call) for the next five minutes
  const removed = []; game.onPlayerLeaving = (u, s) => removed.push(`${u}:${s}`);
  let elapsed = 5000, hands = 0, lastHand = game.handCount, eviction = null;
  while (elapsed < 320000) {
    mock.timers.tick(2000); elapsed += 2000;
    if (game.handCount !== lastHand) { lastHand = game.handCount; hands++; }
    const flagged = game.players.filter(p => p && p._pendingRemoval);
    if (!eviction && (flagged.length || game.players.filter(Boolean).length < 3)) {
      eviction = { atSec: elapsed / 1000, handInProgress: game.handInProgress, log: game.currentHandLog.filter(l => /left table|leaves table|collected|Uncalled/.test(l)), cards: game.players.filter(Boolean).map(p => p.username + ':' + p.holeCards.join('')) };
    }
    const cur = game.handInProgress && game.phase !== 'showdown' ? game.players[game.currentPlayerIndex] : null;
    if (cur && !game.processAction(cur.userId, 'check').valid) game.processAction(cur.userId, 'call');
  }
  mock.timers.reset();
  assert.equal(game.players.filter(Boolean).length, 3, 'active, connected players must not be idle-kicked');
});

test('after crash recovery, a seat nobody returns to is still released by the idle clock', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const g = new PokerGame('station100');
    g.saveSnapshot = () => {}; g.saveHandToDatabase = () => {};
    ['a0', 'a1'].forEach((u, i) => g.addPlayer(u, 'Q' + i, { initialStack: 10000 }));
    clearTimeout(g.handStartTimeout); g.handStartTimeout = null;
    for (const player of g.players) {
      if (!player) continue;
      player.disconnected = true; player.sittingOutNextHand = true; player.sittingOut = true;
      g.startSitOutKickTimer(player.userId);
    }
    g.setDisconnected('a0', false);        // returns, but is still sitting out: the clock keeps running
    assert.equal(g.sitOutKickTimers.has('a0'), true);
    assert.equal(g.sitBackIn('a0').success, true);
    assert.equal(g.sitOutKickTimers.has('a0'), false);
    mock.timers.tick(301000);
    assert.equal(g.players.filter(Boolean).map(p => p.userId).join(), 'a0', 'only the absent seat is released');
    clearTimeout(g.handStartTimeout);
  } finally { mock.timers.reset(); }
});
