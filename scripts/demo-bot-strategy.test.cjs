'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {chooseAction} = require('./demo-bot-strategy.cjs');
const player = (values={}) => ({holeCards:['Ah','Kh'],stack:10000,currentBet:0,canRaise:true,...values});
const state = (values={}) => ({phase:'flop',communityCards:['Qh','Jh','Th'],bigBlind:100,lastRaise:100,currentBetToCall:0,pot:1200,players:[player(),player()],...values});

test('bots can open betting on flop, turn, and river with their own strong cards', () => {
  for (const [phase,board] of [['flop',['Qh','Jh','Th']],['turn',['Qh','Jh','Th','2c']],['river',['Qh','Jh','Th','2c','3s']]]) {
    const action = chooseAction(state({phase,communityCards:board}),player(),{random:()=>.3});
    assert.equal(action.action,'raise');
    assert.ok(action.amount>=100 && action.amount<=10000);
  }
});

test('a weak hand can fold to pressure, call a modest wager, or check when free', () => {
  const me = player({holeCards:['2c','7d'],canRaise:false});
  const s = state({communityCards:['Kh','Qs','9h'],currentBetToCall:1000});
  assert.equal(chooseAction(s,me,{random:()=>.01}).action,'fold');
  assert.equal(chooseAction(s,me,{random:()=>.99}).action,'call');
  assert.equal(chooseAction({...s,currentBetToCall:0},me).action,'check');
});

test('re-raises respect the legal minimum and short stacks never overspend', () => {
  const s = state({currentBetToCall:600,lastRaise:400});
  const raised = chooseAction(s,player(),{random:()=>.01});
  assert.equal(raised.action,'raise');
  assert.ok(raised.amount>=1000);
  const short = chooseAction(s,player({stack:750,currentBet:100}),{random:()=>.01});
  assert.equal(short.amount,850);
});

test('capped aggression and closed raise rights prevent raise loops', () => {
  const s = state({currentBetToCall:600});
  assert.equal(chooseAction(s,player(),{random:()=>.01,raises:2}).action,'call');
  assert.equal(chooseAction(s,player({canRaise:false}),{random:()=>.01}).action,'call');
});
