'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {planTransition, TIMING, create} = require('./table-motion');
const player = (userId, values={}) => ({userId,stack:5000,currentBet:0,holeCards:['??','??'],folded:false,...values});
const state = (values={}) => ({tableId:'station100',handId:'hand-1',handCount:1,handInProgress:true,dealerSeat:0,
  communityCards:[],pot:0,players:[player('a'),player('b'),null,null,null,null],...values});

test('joining or restoring a hand never replays a deal, board, or payout', () => {
  const restored = state({communityCards:['Ah','Kd','Qs'],handInProgress:false,players:[player('a',{wonPot:true})]});
  for (const before of [null,restored]) {
    const plan = planTransition(before,restored);
    for (const type of ['deal','board','reveal','bets','collect','winners']) assert.equal(plan[type].length,0);
  }
});
test('a fresh hand deals two clockwise rounds and completes in under one second at six seats', () => {
  const plan = planTransition(state(),state({handId:'hand-2',dealerSeat:4,players:Array.from({length:6},(_,i)=>player(String(i)))}));
  assert.deepEqual(plan.deal.map(p=>p.seat),[5,0,1,2,3,4,5,0,1,2,3,4]);
  assert.deepEqual(plan.deal.map(p=>p.card),[0,0,0,0,0,0,1,1,1,1,1,1]);
  assert.ok((plan.deal.length-1)*TIMING.dealStagger+TIMING.deal < 1000);
  assert.equal(planTransition(state(),state({handId:'hand-2',handInProgress:false})).deal.length,0);
});
test('only newly received community cards flip; identical updates leave existing cards alone', () => {
  const flop = state({communityCards:['Ah','Kd','Qs']});
  const turn = state({communityCards:['Ah','Kd','Qs','2c']});
  assert.deepEqual(planTransition(state(),flop).board,[0,1,2]);
  assert.deepEqual(planTransition(flop,turn).board,[3]);
  assert.deepEqual(planTransition(turn,turn).board,[]);
  assert.deepEqual(planTransition(turn,flop).board,[]);
});
test('bet movements follow increased wagers and street collection without replaying snapshots', () => {
  const before = state({players:[player('a',{currentBet:100}),player('b',{currentBet:100})]});
  const raised = state({players:[player('a',{currentBet:300}),player('b',{currentBet:100})]});
  assert.deepEqual(planTransition(before,raised).bets,[{seat:0,amount:200}]);
  assert.deepEqual(planTransition(raised,raised).bets,[]);
  const flop = state({pot:400});
  assert.deepEqual(planTransition(raised,flop).collect,[{seat:0,amount:300},{seat:1,amount:100}]);
  // A returned uncalled bet is not a street collection.
  assert.deepEqual(planTransition(raised,before).collect,[]);
});
test('split and side pots animate every flagged winner by identity even with identical display names', () => {
  const before = state({players:[player('a',{username:'Player'}),player('b',{username:'Player'}),player('c')]});
  const settled = state({handInProgress:false,players:[player('a',{stack:5200,wonPot:true}),
    player('b',{stack:5100,wonPot:true}),player('c',{wonPot:false})]});
  const plan = planTransition(before,settled);
  assert.deepEqual(plan.winners,[{seat:0,amount:200},{seat:1,amount:100}]);
  assert.deepEqual(planTransition(settled,settled).winners,[]);
  const replacement = state({handInProgress:false,players:[player('new',{stack:10000,wonPot:true})]});
  assert.deepEqual(planTransition(before,replacement).winners,[]);
});
test('showdown reveals only newly public cards and does not reveal folded hands', () => {
  const before = state();
  const after = state({players:[player('a',{holeCards:['Ah','As']}),player('b',{holeCards:['Kh','Ks'],folded:true})]});
  assert.deepEqual(planTransition(before,after).reveal,[0]);
  assert.deepEqual(planTransition(after,after).reveal,[]);
});
test('reduced motion skips JavaScript animation and detaches listeners on destruction', () => {
  const original = global.document;
  const listeners = new Map(), mediaListeners = new Map();
  global.document = {hidden:false,addEventListener:(key,fn)=>listeners.set(key,fn),removeEventListener:key=>listeners.delete(key)};
  const media = {matches:true,addEventListener:(key,fn)=>mediaListeners.set(key,fn),removeEventListener:key=>mediaListeners.delete(key)};
  const table = {animate() {throw new Error('Reduced motion must not start an animation');}};
  try {
    const motion = create({table,media});
    motion.play(state(),state({handId:'hand-2'}));
    motion.destroy();
    assert.equal(listeners.size,0); assert.equal(mediaListeners.size,0);
  } finally { if (original === undefined) delete global.document; else global.document=original; }
});
test('interrupted motion cancels only its own overlays and leaves the real pot intact', () => {
  const original = global.document;
  const packets = [], animations = [];
  function element() {
    return {style:{},children:[],setAttribute(){},appendChild(child){this.children.push(child);},
      remove(){this.removed=true;},getBoundingClientRect(){return {left:0,top:0,width:100,height:50};},
      animate() {
        let finish;
        const animation={cancelled:false,finished:{then(_,cancel){finish=cancel;}},cancel(){this.cancelled=true;finish?.();}};
        animations.push(animation);return animation;
      }};
  }
  const pot=element(), seat=element(), bet=element();
  const table={...element(),offsetWidth:100,offsetHeight:50,clientLeft:0,clientTop:0,
    querySelector:selector=>selector==='#tablePotChips'?pot:null};
  global.document={hidden:false,addEventListener(){},removeEventListener(){},
    createElement(){const el=element();packets.push(el);return el;}};
  try {
    const motion=create({table,media:{matches:false},seatElement:()=>seat,betElement:()=>bet,chipHTML:()=>'<svg></svg>'});
    const previous=state(),next=state({players:[player('a',{currentBet:100}),player('b')]});
    motion.play(previous,next,motion.capture());
    assert.equal(animations.length,1);
    motion.cancel();
    assert.ok(animations.every(a=>a.cancelled));
    assert.equal(packets.filter(el=>el.className==='table-motion-packet motion-chips').every(el=>el.removed),true);
    assert.equal(pot.removed,undefined);
    motion.destroy();
  } finally {if(original===undefined)delete global.document;else global.document=original;}
});
