'use strict';
const { evaluateHand } = require('../packages/shared');

function strength(hole, board) {
  const ranks = hole.map(c => '23456789TJQKA'.indexOf(c[0]) + 2);
  if (board.length >= 3) {
    const hand = evaluateHand([...hole, ...board]);
    const boardRank = board.length >= 5 ? evaluateHand(board).rank : -1;
    const improvesBoard = hand.rank > boardRank || hand.bestCards.some(c => hole.includes(c));
    const made = [0.2, 0.48, 0.68, 0.78, 0.88, 0.93, 0.97, 0.99, 1, 1][hand.rank] || 0.2;
    const suits = [...hole,...board].map(c=>c[1]);
    const draw = board.length < 5 && hole.some(c=>suits.filter(s=>s===c[1]).length===4);
    return Math.min(1, (improvesBoard ? made : .3) + (draw ? .15 : 0));
  }
  return Math.min(1, ranks[0] === ranks[1] ? .55 + ranks[0] / 35 :
    .12 + Math.max(...ranks) / 35 + Math.min(...ranks) / 70 +
    (hole[0][1] === hole[1][1] ? .08 : 0) + (Math.abs(ranks[0]-ranks[1])===1 ? .06 : 0));
}

function chooseAction(state, me, {random = Math.random, aggression = .5, raises = 0} = {}) {
  const bb = state.bigBlind || 100;
  const maxBet = state.currentBetToCall || 0;
  const toCall = Math.max(0, maxBet - me.currentBet);
  const total = me.stack + me.currentBet;
  const pot = state.pot + state.players.reduce((n,p)=>n+(p?.currentBet || 0),0);
  const power = strength(me.holeCards, state.communityCards || []);
  const roll = random();
  const minimum = maxBet + Math.max(bb, state.lastRaise || bb);
  const canRaise = me.canRaise && total > maxBet && raises < 2;
  const wantsRaise = toCall === 0
    ? roll < .22 + aggression * .35 + power * .24
    : power > .7 && roll < .18 + aggression * .25;
  if (canRaise && wantsRaise) {
    const size = state.phase === 'preflop' ? bb * (2 + Math.floor(random()*2)) :
      Math.max(bb, Math.round(pot * (.3 + random()*.3) / bb) * bb);
    return {action:'raise', amount:Math.min(total, Math.max(minimum, maxBet + size))};
  }
  if (toCall > 0) {
    const price = toCall / Math.max(1,pot+toCall);
    const pressured = toCall > Math.max(3*bb, me.stack*.3);
    const foldChance = Math.max(.03, .45 - power*.5 + price*.5 + (pressured ? .2 : 0));
    if (roll < foldChance && power < .88) return {action:'fold'};
    return {action:'call'};
  }
  return {action:'check'};
}

module.exports = {chooseAction, strength};
