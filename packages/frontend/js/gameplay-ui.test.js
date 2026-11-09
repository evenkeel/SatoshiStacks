'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
// Execute the production pre-action handler with a minimal UI state.
const source = fs.readFileSync(require.resolve('./app.js'), 'utf8');
const handler = source.slice(source.indexOf('function executePreAction()'), source.indexOf('// ============================================================\n//  SEND ACTION'));
function run(selected, current, action = 'call') {
  const sent = [];
  const context = { preAction: action, preActionToCall: selected, myUserId: 'me',
    gameState: {yourTurn:true, currentBetToCall:current, players:[{userId:'me',currentBet:0}]},
    sendAction: action => sent.push(action) };
  vm.createContext(context);
  vm.runInContext(handler, context);
  const executed = vm.runInContext('executePreAction()', context);
  return { sent, executed };
}
test('a queued call never accepts a larger last-moment raise', () => {
  const result = run(100, 1000);
  assert.equal(result.executed, false);
  assert.deepEqual(result.sent, []);
});
test('an unchanged queued call executes once', () => {
  assert.deepEqual(run(100, 100).sent, ['call']);
});
test('a queued fold remains valid when the wager changes', () => {
  assert.deepEqual(run(100, 1000, 'fold').sent, ['fold']);
});

test('folding clears both hero cards and opponent backs even when cards remain in state', () => {
  const nodes = new Map();
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, { dataset:{}, style:{}, innerHTML:'',
      setAttribute() {}, removeAttribute() {}, querySelector() { return null; },
      replaceChildren() { this.innerHTML = ''; } });
    return nodes.get(id);
  }
  const player = { userId:'me', username:'Alex', stack:1000, holeCards:['As','Ks'], folded:false };
  const context = { NUM_SEATS:1, gameState:{ players:[player], handId:'hand-1' },
    myUserId:'me', calculateVisualPosition:() => 3, $:node,
    renderCardHTML:(card, size) => `<div class="card ${size || ''}">${card || 'back'}</div>`,
    esc:String, truncName:String, fmt:String, myFollowSet:new Set(), BADGE_ICONS:{}, applyBadge() {} };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function updateNameplates()'), source.indexOf('// Dealer button')), context);
  const render = () => vm.runInContext('updateNameplates()', context);
  render();
  assert.match(node('playerCards-3').innerHTML, /As/);
  assert.match(node('playerCards-3').className, /hero/);
  player.folded = true;
  render();
  assert.equal(node('playerCards-3').innerHTML, '');
  player.userId = 'opponent';
  player.folded = false;
  player.holeCards = ['??','??'];
  render();
  assert.equal((node('playerCards-3').innerHTML.match(/back/g) || []).length, 2);
  assert.doesNotMatch(node('playerCards-3').className, /hero/);
  player.folded = true;
  render();
  assert.equal(node('playerCards-3').innerHTML, '');
});

test('only the dealer button renders and follows the rotated seat even after folding', () => {
  const container = { innerHTML:'' };
  const context = { $:() => container, gameState:{handId:'hand-1', players:Array.from({length:6},()=>({folded:true})), smallBlindSeat:1, bigBlindSeat:2}, calculateVisualPosition:seat => 7-seat };
  vm.createContext(context);
  const start = source.indexOf('function renderTableMarkers()');
  vm.runInContext(source.slice(start, source.indexOf('// ============================================================', start)), context);
  for(let seat=0;seat<6;seat++) {
    context.gameState.dealerSeat = seat;
    vm.runInContext('renderTableMarkers()', context);
    assert.match(container.innerHTML, new RegExp(`marker-pos-${6-seat}`));
    assert.equal((container.innerHTML.match(/class="table-marker /g)||[]).length, 1);
    assert.doesNotMatch(container.innerHTML, /Small blind|Big blind|>SB<|>BB</);
  }
  context.gameState.handId = null;
  vm.runInContext('renderTableMarkers()', context);
  assert.equal(container.innerHTML, '');
});
