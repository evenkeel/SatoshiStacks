'use strict';
// Rendering regressions for the table: bet entry survives unrelated updates,
// chip and avatar markup never carries network-supplied markup or inline handlers.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('./app.js'), 'utf8');
const avatars = require('./avatars');
const slice = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));

function controlsHarness() {
  let writes = 0, html = '';
  const dataset = {};
  const bc = { dataset,
    get innerHTML() { return html; }, set innerHTML(value) { html = value; if (value) writes++; },
    querySelector: selector => selector === '.action-buttons' && html.includes('action-buttons') ? {} : null };
  const classes = new Set();
  const ca = { style: {}, classList: { add: name => classes.add(name), remove: name => classes.delete(name) } };
  const status = { textContent: '', classList: { toggle() {} } };
  const me = { userId: 'me', stack: 9000, currentBet: 100, folded: false, allIn: false, canRaise: true };
  const context = { myUserId: 'me', fmtNumber: n => String(n), truncName: String,
    gameState: { handId: 'h1', phase: 'preflop', handInProgress: true, yourTurn: true, pot: 0, bigBlind: 100, lastRaise: 100,
      currentBetToCall: 300, currentPlayerIndex: 0, observerCount: 0,
      players: [me, { userId: 'opp', stack: 9000, currentBet: 300, folded: false, allIn: false }] },
    sendAction() {}, parseInt, Math, JSON, isNaN,
    $: id => ({ betControls: bc, mobileTurnStatus: status })[id] || null,
    document: { querySelector: selector => selector === '.controls-area' ? ca : null, querySelectorAll: () => [] } };
  vm.createContext(context);
  vm.runInContext(slice('function renderControls()', '// ============================================================\n//  PRE-ACTION SYSTEM'), context);
  return { context, bc, me, classes, render: () => vm.runInContext('renderControls()', context), writes: () => writes };
}

test('an unrelated table update does not rebuild the betting panel or reset the entered raise', () => {
  const ui = controlsHarness();
  ui.render();
  assert.equal(ui.writes(), 1);
  assert.match(ui.bc.innerHTML, /id="raiseBtn"/);
  // A spectator arrives and another player sits out: same decision for the hero.
  ui.context.gameState.observerCount = 3;
  ui.context.gameState.players.push({ userId: 'late', stack: 5000, currentBet: 0, folded: true, sittingOut: true });
  ui.render(); ui.render();
  assert.equal(ui.writes(), 1, 'the panel (and whatever amount was typed into it) is left alone');
});
test('the betting panel is rebuilt when the decision itself changes and cleared when the turn ends', () => {
  const ui = controlsHarness();
  ui.render();
  ui.context.gameState.currentBetToCall = 900;                 // re-raised: new call amount and minimum raise
  ui.context.gameState.players[1].currentBet = 900;
  ui.render();
  assert.equal(ui.writes(), 2);
  // The label is two parts (action, amount) so desktop buttons can stack them.
  assert.match(ui.bc.innerHTML, /id="ccBtn"><span class="act-verb">Call<\/span> <span class="act-amount">800<\/span>/);
  ui.context.gameState.yourTurn = false;
  ui.render();
  assert.equal(ui.bc.innerHTML, '');
  assert.equal(ui.bc.dataset.controlsKey, undefined);
  ui.context.gameState.yourTurn = true;                        // the same numbers on a later turn still render
  ui.render();
  assert.equal(ui.writes(), 3);
});

test('chip artwork is chosen by denomination and ignores colours or labels sent over the network', () => {
  const context = { Math, Number, Object, CHIP_DEFS: [{ value: 500, label: '500' }, { value: 100, label: '100' }, { value: 1, label: '1' }] };
  vm.createContext(context);
  vm.runInContext(slice('const CHIP_STYLE = {', 'function renderChipStack('), context);
  const hostile = vm.runInContext(`renderChipSVG({ value: 100, label: '<img src=x onerror=alert(1)>', fill: '"/><script>alert(1)</script>', text: 'url(javascript:1)' }, 24)`, context);
  assert.doesNotMatch(hostile, /script|onerror|javascript|<img/i);
  assert.match(hostile, />100<\/text>/);
  assert.equal(hostile, vm.runInContext('renderChipSVG({ value: 100 }, 24)', context));
  assert.notEqual(vm.runInContext('renderChipSVG({ value: 500 }, 24)', context), hostile);
  for (const input of ['{ value: "nope" }', 'null', '{ value: 7 }']) {
    const svg = vm.runInContext(`renderChipSVG(${input}, 24)`, context);
    assert.match(svg, /^<svg /); assert.doesNotMatch(svg, /undefined|NaN/);
  }
});

function seatHarness(player, { mySeat = null } = {}) {
  const attrs = new Map(); let html = ''; const listeners = [];
  const photo = { addEventListener: (type, fn, options) => listeners.push({ type, fn, options }), remove() { photo.removed = true; } };
  const wrap = { classList: { toggle(name, on) { wrap[name] = on; } } };
  const seat = { className: '', getAttribute: key => attrs.get(key) ?? null, setAttribute: (key, value) => attrs.set(key, value),
    get innerHTML() { return html; }, set innerHTML(value) { html = value; seat.writes = (seat.writes || 0) + 1; },
    querySelector: selector => selector === '.avatar-photo' ? (html.includes('avatar-photo') ? photo : null) : selector === '.player-avatar-wrap' ? wrap : null };
  const context = { NUM_SEATS: 1, mySeat, myUserId: 'hero', gameState: { players: [player], currentPlayerIndex: 0, handInProgress: true },
    calculateVisualPosition: seat => seat, $: () => seat, window: { StacksAvatars: avatars }, JSON, syncTurnRing() {},
    esc: value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])) };
  vm.createContext(context);
  vm.runInContext(slice('function renderSeats()', '// ============================================================\n//  TURN CLOCK'), context);
  return { seat, photo, wrap, listeners, context, render: () => vm.runInContext('renderSeats()', context) };
}

test('a Nostr profile picture is shown on its own; the house avatar appears only if it fails to load', () => {
  const ui = seatHarness({ userId: 'a'.repeat(64), username: 'Mira', nostrPicture: 'https://example.com/p.png', stack: 5000 });
  ui.render();
  assert.match(ui.seat.innerHTML, /<img class="avatar-photo" src="https:\/\/example.com\/p.png"/);
  assert.doesNotMatch(ui.seat.innerHTML, /chip-buddy/, 'a player with a picture is represented by that picture, not a house avatar');
  assert.doesNotMatch(ui.seat.innerHTML, /onerror|onload|onclick/i, 'the CSP blocks inline handlers, so none may be relied on');
  assert.equal(ui.listeners.length, 1); assert.equal(ui.listeners[0].type, 'error');
  const holder = { innerHTML: '' }; ui.photo.parentElement = holder;
  ui.listeners[0].fn();
  assert.match(holder.innerHTML, /^<svg class="chip-buddy"/, 'a broken picture is replaced by the house avatar');
  assert.equal(ui.wrap['active-turn'], true);
});
test('a player without a profile picture gets the house avatar', () => {
  const ui = seatHarness({ userId: 'c'.repeat(64), username: 'June', nostrPicture: null, stack: 5000 });
  ui.render();
  assert.match(ui.seat.innerHTML, /class="chip-buddy"/);
  assert.doesNotMatch(ui.seat.innerHTML, /avatar-photo/);
});
test('unsafe picture URLs and markup in identifiers never reach the page', () => {
  for (const nostrPicture of ['javascript:alert(1)', 'data:text/html,<script>1</script>', '//evil.example/x.png', null]) {
    const ui = seatHarness({ userId: '"><script>alert(1)</script>', username: 'x', nostrPicture, stack: 1 });
    ui.render();
    assert.doesNotMatch(ui.seat.innerHTML, /avatar-photo|<script/);
  }
  const quoted = seatHarness({ userId: 'u', username: 'x', nostrPicture: 'https://example.com/a.png" onerror="alert(1)', stack: 1 });
  quoted.render();
  assert.doesNotMatch(quoted.seat.innerHTML, /" onerror="/);
});
test('avatars are never rebuilt by play: folding, winning or acting only changes classes', () => {
  const player = { userId: 'b'.repeat(64), username: 'Theo', stack: 5000 };
  const ui = seatHarness(player);
  ui.render(); ui.render();
  const first = ui.seat.innerHTML;
  player.stack = 4000; player.folded = true; ui.render();
  assert.match(ui.seat.className, /folded/);
  player.folded = false; player.wonPot = true; player.allIn = true; ui.render();
  assert.match(ui.seat.className, /winner-seat/);
  assert.equal(ui.seat.writes, 1, 'the avatar (and a loaded picture) is built once and left alone');
  assert.equal(ui.seat.innerHTML, first);
  // A new or changed picture does rebuild it.
  player.nostrPicture = 'https://example.com/new.png'; ui.render();
  assert.equal(ui.seat.writes, 2);
  assert.match(ui.seat.innerHTML, /avatar-photo/);
});

test('a mucked hand shows no cards to other players, keeps the owner\'s own cards, and is labelled', () => {
  const nodes = new Map();
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, { dataset:{}, style:{}, innerHTML:'', setAttribute() {}, removeAttribute() {},
      querySelector() { return null; }, replaceChildren() { this.innerHTML = ''; } });
    return nodes.get(id);
  }
  const loser = { userId:'opp', username:'Theo', stack:900, holeCards:['??','??'], folded:false, mucked:true };
  const context = { NUM_SEATS:1, gameState:{ players:[loser], handId:'h', phase:'showdown', communityCards:['2c','7d','9h','Jc','Ks'] },
    myUserId:'me', calculateVisualPosition:() => 4, $:node,
    renderCardHTML:(card, size) => `<div class="card ${size || ''}">${card || 'back'}</div>`,
    esc:String, truncName:String, fmt:String, myFollowSet:new Set(), BADGE_ICONS:{}, applyBadge() {} };
  vm.createContext(context);
  vm.runInContext(slice('function updateNameplates()', '// Dealer button'), context);
  vm.runInContext('updateNameplates()', context);
  assert.equal(node('playerCards-4').innerHTML, '', 'no card backs linger for a hand that was thrown away');
  assert.match(node('nameplate-4').innerHTML, /np-tag mucked">Mucked</);
  // The owner still sees their own two cards.
  Object.assign(loser, { userId:'me', holeCards:['7s','4h'], hand:{ name:'a pair of Sevens', bestCards:[] } });
  vm.runInContext('updateNameplates()', context);
  assert.match(node('playerCards-4').innerHTML, /7s/); assert.match(node('playerCards-4').innerHTML, /4h/);
  assert.match(node('nameplate-4').innerHTML, /np-tag mucked/);
});
