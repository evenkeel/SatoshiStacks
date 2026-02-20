#!/usr/bin/env node
/**
 * Training Bots for SatoshiStacks
 *
 * Smart poker bots that evaluate hand strength, understand position,
 * calculate pot odds, and play distinct styles. Designed to give human
 * players a real challenge.
 *
 * Setup:
 *   npm install
 *
 * Usage:
 *   npm start                                         # 5 bots against satoshistacks.com
 *   node training-bot.js --url https://satoshistacks.com          # same thing
 *   node training-bot.js --url https://satoshistacks.com --bots 3 # 3 bots
 *   node training-bot.js --url https://satoshistacks.com --table table-1
 *   node training-bot.js --url https://satoshistacks.com --hands 200
 *   node training-bot.js --url https://satoshistacks.com --delay 2500
 */

const { io } = require('socket.io-client');
const crypto = require('crypto');
const { getPublicKey, finalizeEvent } = require('nostr-tools/pure');
const { npubEncode } = require('nostr-tools/nip19');


// ==================== INLINE: deck.js ====================

const SUITS = ['h', 'd', 'c', 's'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];

function cardRank(c) { return c[0]; }
function cardSuit(c) { return c[1]; }
function rankIdx(r) { return RANKS.indexOf(r); }


// ==================== INLINE: hand-evaluator.js ====================

const RANK_PLURAL = [
  'Deuces', 'Threes', 'Fours', 'Fives', 'Sixes', 'Sevens', 'Eights', 'Nines',
  'Tens', 'Jacks', 'Queens', 'Kings', 'Aces'
];
const RANK_NAME = [
  'Deuce', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
  'Ten', 'Jack', 'Queen', 'King', 'Ace'
];

function evaluateHand(cards) {
  const combos = getCombos(cards, 5);
  let best = { rank: -1, tb: [], name: '' };
  let bestCards = [];
  for (const c of combos) {
    const r = eval5(c);
    if (r.rank > best.rank || (r.rank === best.rank && cmpTB(r.tb, best.tb) > 0)) {
      best = r;
      bestCards = [...c];
    }
  }
  best.bestCards = bestCards;
  return best;
}

function eval5(cards) {
  const ranks = cards.map(c => rankIdx(cardRank(c))).sort((a, b) => b - a);
  const suits = cards.map(c => cardSuit(c));
  const flush = suits.every(s => s === suits[0]);
  let straight = false, straightHi = -1;
  const uniq = [...new Set(ranks)].sort((a, b) => b - a);
  if (uniq.length >= 5) {
    for (let i = 0; i <= uniq.length - 5; i++) {
      if (uniq[i] - uniq[i + 4] === 4) { straight = true; straightHi = uniq[i]; break; }
    }
    if (!straight && uniq.includes(12) && uniq.includes(0) && uniq.includes(1) && uniq.includes(2) && uniq.includes(3)) {
      straight = true; straightHi = 3;
    }
  }
  const freq = {};
  ranks.forEach(r => freq[r] = (freq[r] || 0) + 1);
  const fv = Object.entries(freq).sort((a, b) => b[1] - a[1] || parseInt(b[0]) - parseInt(a[0]));
  const counts = fv.map(f => f[1]);
  const straightName = straightHi === 3 ? 'Ace to Five' : RANK_NAME[straightHi - 4] + ' to ' + RANK_NAME[straightHi];
  if (flush && straight && straightHi === 12) return { rank: 9, tb: [12], name: 'a Royal Flush' };
  if (flush && straight) return { rank: 8, tb: [straightHi], name: 'a straight flush, ' + straightName };
  if (counts[0] === 4) return { rank: 7, tb: [+fv[0][0], +fv[1][0]], name: 'four of a kind, ' + RANK_PLURAL[+fv[0][0]] };
  if (counts[0] === 3 && counts[1] >= 2) return { rank: 6, tb: [+fv[0][0], +fv[1][0]], name: 'a full house, ' + RANK_PLURAL[+fv[0][0]] + ' full of ' + RANK_PLURAL[+fv[1][0]] };
  if (flush) return { rank: 5, tb: ranks, name: 'a flush, ' + RANK_NAME[ranks[0]] + ' high' };
  if (straight) return { rank: 4, tb: [straightHi], name: 'a straight, ' + straightName };
  if (counts[0] === 3) {
    const k = fv.filter(f => f[1] === 1).map(f => +f[0]).sort((a, b) => b - a);
    return { rank: 3, tb: [+fv[0][0], ...k], name: 'three of a kind, ' + RANK_PLURAL[+fv[0][0]] };
  }
  if (counts[0] === 2 && counts[1] === 2) {
    const p = fv.filter(f => f[1] === 2).map(f => +f[0]).sort((a, b) => b - a);
    const k = fv.find(f => f[1] === 1);
    return { rank: 2, tb: [...p, k ? +k[0] : 0], name: 'two pair, ' + RANK_PLURAL[p[0]] + ' and ' + RANK_PLURAL[p[1]] };
  }
  if (counts[0] === 2) {
    const k = fv.filter(f => f[1] === 1).map(f => +f[0]).sort((a, b) => b - a);
    return { rank: 1, tb: [+fv[0][0], ...k], name: 'a pair of ' + RANK_PLURAL[+fv[0][0]] };
  }
  return { rank: 0, tb: ranks, name: 'high card ' + RANK_NAME[ranks[0]] };
}

function cmpTB(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] > b[i]) return 1;
    if (a[i] < b[i]) return -1;
  }
  return 0;
}

function getCombos(arr, k) {
  if (k === 0) return [[]];
  if (arr.length < k) return [];
  const [f, ...r] = arr;
  return [...getCombos(r, k - 1).map(c => [f, ...c]), ...getCombos(r, k)];
}


// ==================== CONFIG ====================

const args = parseArgs(process.argv.slice(2));
const SERVER_URL = args.url || 'http://localhost:3001';
const NUM_BOTS = parseInt(args.bots) || 5;
const TABLE_ID = args.table || 'table-1';
const MAX_HANDS = parseInt(args.hands) || 0;
const ACTION_DELAY_MS = parseInt(args.delay) || 2000;

// ==================== BOT PERSONAS ====================

const PERSONAS = [
  {
    name: 'Ace_Grinder',
    style: 'TAG',
    pfr: 0.18,
    aggression: 0.65,
    bluffFreq: 0.15,
    foldToReraise: 0.55,
    cbet: 0.70,
    slowplay: 0.10,
    desc: 'Solid grinder, plays strong hands aggressively',
  },
  {
    name: 'LuckyDraw',
    style: 'LAG',
    pfr: 0.30,
    aggression: 0.75,
    bluffFreq: 0.30,
    foldToReraise: 0.35,
    cbet: 0.80,
    slowplay: 0.05,
    desc: 'Loose cannon, raises light and bluffs often',
  },
  {
    name: 'IronFold',
    style: 'NIT',
    pfr: 0.12,
    aggression: 0.50,
    bluffFreq: 0.05,
    foldToReraise: 0.70,
    cbet: 0.55,
    slowplay: 0.20,
    desc: 'Patient rock, waits for premium hands',
  },
  {
    name: 'TrapMaster',
    style: 'TRICKY',
    pfr: 0.22,
    aggression: 0.55,
    bluffFreq: 0.25,
    foldToReraise: 0.40,
    cbet: 0.50,
    slowplay: 0.40,
    desc: 'Deceptive player, sets traps with big hands',
  },
  {
    name: 'StackPusher',
    style: 'MANIAC',
    pfr: 0.35,
    aggression: 0.85,
    bluffFreq: 0.40,
    foldToReraise: 0.25,
    cbet: 0.90,
    slowplay: 0.02,
    desc: 'Relentless aggressor, puts maximum pressure',
  },
];


// ==================== PREFLOP HAND RANKINGS ====================

function getPreflopStrength(card1, card2) {
  const r1 = rankIdx(card1[0]);
  const r2 = rankIdx(card2[0]);
  const suited = card1[1] === card2[1];
  const hi = Math.max(r1, r2);
  const lo = Math.min(r1, r2);
  const pair = r1 === r2;
  const gap = hi - lo;

  if (pair) {
    return 0.45 + (hi / 12) * 0.55;
  }

  let strength = (hi + lo) / 24;
  if (suited) strength += 0.06;
  if (gap === 1) strength += 0.04;
  else if (gap === 2) strength += 0.02;
  else if (gap >= 5) strength -= 0.04;

  if (hi === 12) {
    if (lo >= 11) strength = suited ? 0.92 : 0.88;
    else if (lo >= 10) strength = suited ? 0.85 : 0.78;
    else if (lo >= 9) strength = suited ? 0.80 : 0.72;
    else if (lo >= 8) strength = suited ? 0.75 : 0.65;
    else if (suited) strength = Math.max(strength, 0.55);
    else strength = Math.max(strength, 0.30);
  } else if (hi === 11) {
    if (lo >= 10) strength = suited ? 0.78 : 0.70;
    else if (lo >= 9) strength = suited ? 0.72 : 0.63;
    else if (lo >= 8) strength = suited ? 0.68 : 0.58;
    else if (suited) strength = Math.max(strength, 0.48);
  } else if (hi === 10) {
    if (lo >= 9) strength = suited ? 0.72 : 0.62;
    else if (lo >= 8) strength = suited ? 0.66 : 0.56;
  } else if (hi === 9 && lo === 8) {
    strength = suited ? 0.65 : 0.55;
  }

  if (suited && gap <= 2 && lo >= 3) {
    strength = Math.max(strength, 0.42);
  }

  return Math.min(1, Math.max(0, strength));
}


// ==================== POSTFLOP HAND EVALUATION ====================

function evaluatePostflop(holeCards, communityCards) {
  if (!communityCards || communityCards.length === 0) {
    return { strength: getPreflopStrength(holeCards[0], holeCards[1]), draws: {}, made: null };
  }

  const allCards = [...holeCards, ...communityCards];
  const made = evaluateHand(allCards);
  let strength = 0;

  switch (made.rank) {
    case 9: strength = 1.00; break;
    case 8: strength = 0.98; break;
    case 7: strength = 0.95; break;
    case 6: strength = 0.90; break;
    case 5: strength = 0.80 + (made.tb[0] / 12) * 0.08; break;
    case 4: strength = 0.72; break;
    case 3: strength = usesHoleCards(holeCards, communityCards, made) ? 0.68 : 0.55; break;
    case 2: strength = usesHoleCards(holeCards, communityCards, made) ? 0.58 : 0.45; break;
    case 1: strength = evaluatePairStrength(holeCards, communityCards, made); break;
    case 0: strength = 0.10 + (made.tb[0] / 12) * 0.12; break;
  }

  const draws = checkDraws(holeCards, communityCards);
  if (draws.flushDraw) strength += 0.12;
  if (draws.oesd) strength += 0.10;
  if (draws.gutshot) strength += 0.05;
  if (draws.flushDraw && draws.oesd) strength += 0.08;

  if (made.rank <= 2) {
    const wetness = getBoardWetness(communityCards);
    strength -= wetness * 0.08;
  }

  return { strength: Math.min(1, Math.max(0, strength)), draws, made };
}

function usesHoleCards(holeCards, community, made) {
  const holeRanks = holeCards.map(c => rankIdx(c[0]));
  if (made.rank === 3) return holeRanks[0] === holeRanks[1] && holeRanks[0] === made.tb[0];
  if (made.rank === 2) {
    const pairRanks = [made.tb[0], made.tb[1]];
    return holeRanks.filter(r => pairRanks.includes(r)).length >= 1;
  }
  return true;
}

function evaluatePairStrength(holeCards, communityCards, made) {
  const holeRanks = holeCards.map(c => rankIdx(c[0]));
  const communityRanks = communityCards.map(c => rankIdx(c[0]));
  const pairRank = made.tb[0];
  const boardHighCard = Math.max(...communityRanks);

  if (holeRanks[0] === holeRanks[1] && holeRanks[0] === pairRank) {
    if (pairRank > boardHighCard) return 0.50 + (pairRank / 12) * 0.10;
    else return 0.30 + (pairRank / 12) * 0.08;
  }
  if (holeRanks.includes(pairRank)) {
    if (pairRank === boardHighCard) {
      const kicker = holeRanks.find(r => r !== pairRank) ?? 0;
      return 0.38 + (pairRank / 12) * 0.06 + (kicker / 12) * 0.08;
    } else {
      return 0.22 + (pairRank / 12) * 0.08;
    }
  }
  return 0.15 + (made.tb[1] / 12) * 0.05;
}

function checkDraws(holeCards, communityCards) {
  const allCards = [...holeCards, ...communityCards];
  const suits = {};
  const ranks = allCards.map(c => rankIdx(c[0])).sort((a, b) => a - b);

  allCards.forEach(c => { const s = c[1]; suits[s] = (suits[s] || 0) + 1; });

  const flushDraw = Object.entries(suits).some(([s, count]) => {
    if (count !== 4) return false;
    return holeCards.some(c => c[1] === s);
  });

  const uniqueRanks = [...new Set(ranks)];
  let oesd = false, gutshot = false;

  for (let start = 0; start <= 12; start++) {
    const end = start + 4;
    const inWindow = uniqueRanks.filter(r => r >= start && r <= end);
    const inWindowWithWheel = start === 0 && uniqueRanks.includes(12) ? [...inWindow, 12] : inWindow;
    const count = new Set(inWindowWithWheel).size;
    if (count === 4) {
      const filled = [];
      for (let r = start; r <= end; r++) {
        const rr = r > 12 ? 0 : r;
        filled.push(uniqueRanks.includes(rr) || (rr === 0 && start === 0 && uniqueRanks.includes(12)));
      }
      const gaps = filled.reduce((acc, v, i) => v ? acc : [...acc, i], []);
      if (gaps.length === 1 && (gaps[0] === 0 || gaps[0] === 4)) oesd = true;
      else if (gaps.length === 1) gutshot = true;
    }
  }

  return { flushDraw, oesd, gutshot };
}

function getBoardWetness(communityCards) {
  if (communityCards.length === 0) return 0;
  const ranks = communityCards.map(c => rankIdx(c[0])).sort((a, b) => a - b);
  const suits = communityCards.map(c => c[1]);
  let wetness = 0;

  const suitCounts = {};
  suits.forEach(s => suitCounts[s] = (suitCounts[s] || 0) + 1);
  const maxSuit = Math.max(...Object.values(suitCounts));
  if (maxSuit >= 3) wetness += 0.3;
  else if (maxSuit === 2 && communityCards.length <= 3) wetness += 0.1;

  const uniqueRanks = [...new Set(ranks)];
  let connectors = 0;
  for (let i = 0; i < uniqueRanks.length - 1; i++) {
    if (uniqueRanks[i + 1] - uniqueRanks[i] <= 2) connectors++;
  }
  wetness += (connectors / Math.max(uniqueRanks.length - 1, 1)) * 0.3;
  const highCount = ranks.filter(r => r >= 9).length;
  wetness += (highCount / communityCards.length) * 0.2;
  if (uniqueRanks.length < communityCards.length) wetness -= 0.15;

  return Math.min(1, Math.max(0, wetness));
}


// ==================== POSITION AWARENESS ====================

function getPositionMultiplier(mySeat, dealerSeat, numPlayers) {
  const seatsFromDealer = ((mySeat - dealerSeat) + 6) % 6;
  if (numPlayers <= 2) return 1.0;
  const positionMap = { 2: 0.85, 3: 0.90, 4: 1.00, 5: 1.10, 0: 0.80, 1: 0.85 };
  return positionMap[seatsFromDealer] || 0.90;
}

function hasPosition(mySeat, dealerSeat) {
  return mySeat === dealerSeat;
}


// ==================== OPPONENT MODELING ====================

class OpponentTracker {
  constructor() { this.stats = {}; }

  getStats(seatIndex) {
    if (!this.stats[seatIndex]) {
      this.stats[seatIndex] = {
        handsPlayed: 0, vpip: 0, pfr: 0, aggActions: 0, passiveActions: 0,
      };
    }
    return this.stats[seatIndex];
  }

  recordVPIP(i) { this.getStats(i).vpip++; }
  recordPFR(i) { this.getStats(i).pfr++; }
  recordHandPlayed(i) { this.getStats(i).handsPlayed++; }
  recordAggression(i) { this.getStats(i).aggActions++; }
  recordPassive(i) { this.getStats(i).passiveActions++; }

  getProfile(seatIndex) {
    const s = this.getStats(seatIndex);
    if (s.handsPlayed < 5) return 'unknown';
    const vpipRate = s.vpip / s.handsPlayed;
    const aggFactor = s.aggActions / Math.max(s.passiveActions, 1);
    if (vpipRate > 0.45 && aggFactor > 1.5) return 'maniac';
    if (vpipRate > 0.35 && aggFactor > 1.0) return 'LAG';
    if (vpipRate > 0.35) return 'calling_station';
    if (vpipRate < 0.18 && aggFactor > 1.0) return 'nit';
    if (vpipRate < 0.25 && aggFactor > 1.2) return 'TAG';
    return 'average';
  }
}


// ==================== THE SMART BRAIN ====================

function chooseAction(gameState, mySeatIndex, persona, tracker) {
  const me = gameState.players[mySeatIndex];
  if (!me || me.folded || me.allIn || me.sittingOut) return null;
  if (!gameState.yourTurn) return null;

  const maxBet = Math.max(...gameState.players.filter(p => p).map(p => p.currentBet), 0);
  const toCall = maxBet - me.currentBet;
  const myStack = me.stack;
  const pot = gameState.pot;
  const bigBlind = gameState.bigBlind || 100;
  const phase = gameState.phase;
  const holeCards = me.holeCards;
  const community = gameState.communityCards || [];

  if (!holeCards || holeCards[0] === '??' || holeCards.length < 2) {
    return fallbackAction(toCall, myStack, bigBlind, pot);
  }

  const activePlayers = gameState.players.filter(p => p && !p.folded && !p.sittingOut).length;
  const dealerSeat = gameState.dealerSeat ?? 0;
  const posMultiplier = getPositionMultiplier(mySeatIndex, dealerSeat, activePlayers);
  const inPosition = hasPosition(mySeatIndex, dealerSeat);

  if (phase === 'preflop') {
    return preflopDecision(holeCards, toCall, myStack, pot, bigBlind, persona, posMultiplier, activePlayers, maxBet, me);
  }

  return postflopDecision(holeCards, community, toCall, myStack, pot, bigBlind, persona, inPosition, activePlayers, maxBet, me, tracker, gameState, phase);
}


// ==================== PREFLOP DECISIONS ====================

function preflopDecision(holeCards, toCall, stack, pot, bb, persona, posMultiplier, playersInHand, maxBet, me) {
  const handStrength = getPreflopStrength(holeCards[0], holeCards[1]);
  const adjustedStrength = handStrength * posMultiplier;
  const playThreshold = 1 - persona.pfr;
  const facingRaise = toCall > bb;
  const facing3bet = toCall > bb * 3;
  const potOdds = toCall / (pot + toCall);

  if (handStrength >= 0.88) {
    if (facingRaise) {
      const raiseAmt = Math.min(maxBet * 3, me.currentBet + stack);
      return { action: 'raise', amount: Math.max(raiseAmt, maxBet + bb) };
    }
    const openSize = bb * (2.5 + Math.random() * 0.5);
    return { action: 'raise', amount: Math.floor(Math.max(openSize + me.currentBet, maxBet + bb)) };
  }

  if (adjustedStrength >= playThreshold) {
    if (facing3bet) {
      if (handStrength >= 0.75 || Math.random() < (1 - persona.foldToReraise)) {
        if (handStrength >= 0.82) {
          const raiseAmt = Math.min(maxBet * 2.5, me.currentBet + stack);
          return { action: 'raise', amount: Math.floor(raiseAmt) };
        }
        return { action: 'call' };
      }
      return { action: 'fold' };
    }
    if (facingRaise) {
      if (handStrength >= 0.75 && Math.random() < persona.aggression * 0.6) {
        const raiseAmt = Math.floor(maxBet * (2.5 + Math.random()));
        return { action: 'raise', amount: Math.min(raiseAmt, me.currentBet + stack) };
      }
      return { action: 'call' };
    }
    if (toCall === 0 || toCall <= bb) {
      const openSize = bb * (2.2 + Math.random() * 0.8);
      return { action: 'raise', amount: Math.floor(Math.max(openSize + me.currentBet, maxBet + bb)) };
    }
    return { action: 'call' };
  }

  if (adjustedStrength >= playThreshold * 0.85) {
    if (toCall === 0) {
      if (Math.random() < persona.aggression * 0.3) {
        const openSize = bb * (2.2 + Math.random() * 0.5);
        return { action: 'raise', amount: Math.floor(Math.max(openSize + me.currentBet, maxBet + bb)) };
      }
      return { action: 'check' };
    }
    if (toCall <= bb && potOdds < 0.3) return { action: 'call' };
    return { action: 'fold' };
  }

  if (toCall === 0) return { action: 'check' };
  return { action: 'fold' };
}


// ==================== POSTFLOP DECISIONS ====================

function postflopDecision(holeCards, community, toCall, stack, pot, bb, persona, inPosition, playersInHand, maxBet, me, tracker, gameState, phase) {
  const eval_ = evaluatePostflop(holeCards, community);
  const strength = eval_.strength;
  const draws = eval_.draws;
  const hasDraw = draws.flushDraw || draws.oesd;
  const hasGutshot = draws.gutshot;
  const potOdds = toCall / (pot + toCall);
  const spr = stack / Math.max(pot, 1);

  if (strength >= 0.80) return playMonster(toCall, stack, pot, bb, persona, maxBet, me, spr);
  if (strength >= 0.50) return playStrong(toCall, stack, pot, bb, persona, inPosition, maxBet, me, strength, spr, playersInHand);
  if (strength >= 0.30) return playMedium(toCall, stack, pot, bb, persona, inPosition, maxBet, me, strength, potOdds, draws, phase);
  if (hasDraw || hasGutshot) return playDraw(toCall, stack, pot, bb, persona, inPosition, maxBet, me, draws, potOdds, strength);
  return playWeak(toCall, stack, pot, bb, persona, inPosition, maxBet, me, phase, potOdds);
}

function playMonster(toCall, stack, pot, bb, persona, maxBet, me, spr) {
  if (Math.random() < persona.slowplay && toCall === 0) {
    if (Math.random() < 0.5) return { action: 'check' };
    const smallBet = Math.floor(pot * 0.33);
    return { action: 'raise', amount: Math.max(smallBet + me.currentBet, maxBet + bb) };
  }
  if (toCall > 0) {
    if (spr < 3) return { action: 'raise', amount: me.currentBet + stack };
    const raiseAmt = Math.floor(maxBet + pot * (0.7 + Math.random() * 0.5));
    return { action: 'raise', amount: Math.min(raiseAmt, me.currentBet + stack) };
  }
  const betSize = Math.floor(pot * (0.6 + Math.random() * 0.3));
  return { action: 'raise', amount: Math.max(betSize + me.currentBet, maxBet + bb) };
}

function playStrong(toCall, stack, pot, bb, persona, inPosition, maxBet, me, strength, spr, playersInHand) {
  if (toCall > 0) {
    if (toCall > pot * 0.6 && strength < 0.60) {
      if (Math.random() < 0.5) return { action: 'call' };
      return { action: 'fold' };
    }
    if (Math.random() < persona.aggression * 0.5 && strength >= 0.55) {
      const raiseAmt = Math.floor(maxBet + pot * (0.5 + Math.random() * 0.5));
      return { action: 'raise', amount: Math.min(raiseAmt, me.currentBet + stack) };
    }
    return { action: 'call' };
  }
  if (Math.random() < persona.aggression * 0.8) {
    const betFraction = playersInHand > 2 ? 0.65 : 0.50;
    const betSize = Math.floor(pot * (betFraction + Math.random() * 0.2));
    return { action: 'raise', amount: Math.max(betSize + me.currentBet, maxBet + bb) };
  }
  if (inPosition && strength < 0.60) return { action: 'check' };
  const betSize = Math.floor(pot * (0.45 + Math.random() * 0.2));
  return { action: 'raise', amount: Math.max(betSize + me.currentBet, maxBet + bb) };
}

function playMedium(toCall, stack, pot, bb, persona, inPosition, maxBet, me, strength, potOdds, draws, phase) {
  const hasDraw = draws.flushDraw || draws.oesd;
  if (toCall > 0) {
    if (hasDraw && potOdds < 0.30) return { action: 'call' };
    if (toCall <= pot * 0.4) return { action: 'call' };
    if (toCall <= pot * 0.7 && (inPosition || strength >= 0.38)) return { action: 'call' };
    if (strength < 0.40 || potOdds > 0.35) return { action: 'fold' };
    return { action: 'call' };
  }
  if (Math.random() < persona.cbet * 0.5) {
    const betSize = Math.floor(pot * (0.35 + Math.random() * 0.2));
    return { action: 'raise', amount: Math.max(betSize + me.currentBet, maxBet + bb) };
  }
  return { action: 'check' };
}

function playDraw(toCall, stack, pot, bb, persona, inPosition, maxBet, me, draws, potOdds, strength) {
  const isStrong = draws.flushDraw || draws.oesd;
  const outs = (draws.flushDraw ? 9 : 0) + (draws.oesd ? 8 : 0) + (draws.gutshot && !draws.oesd ? 4 : 0);
  const drawEquity = Math.min(outs * 0.022, 0.45);

  if (toCall > 0) {
    if (potOdds <= drawEquity + 0.05) return { action: 'call' };
    if (isStrong && Math.random() < persona.aggression * 0.5) {
      const raiseAmt = Math.floor(maxBet + pot * (0.6 + Math.random() * 0.3));
      return { action: 'raise', amount: Math.min(raiseAmt, me.currentBet + stack) };
    }
    if (potOdds > drawEquity + 0.12) return { action: 'fold' };
    return { action: 'call' };
  }
  if (isStrong && Math.random() < persona.aggression * 0.6) {
    const betSize = Math.floor(pot * (0.5 + Math.random() * 0.25));
    return { action: 'raise', amount: Math.max(betSize + me.currentBet, maxBet + bb) };
  }
  return { action: 'check' };
}

function playWeak(toCall, stack, pot, bb, persona, inPosition, maxBet, me, phase, potOdds) {
  if (toCall === 0) {
    const bluffChance = persona.bluffFreq * (inPosition ? 1.2 : 0.7);
    const streetMultiplier = phase === 'river' ? 1.3 : phase === 'turn' ? 1.0 : 0.8;
    if (Math.random() < bluffChance * streetMultiplier) {
      const sizeMult = phase === 'river' ? 0.75 : phase === 'turn' ? 0.55 : 0.40;
      const betSize = Math.floor(pot * (sizeMult + Math.random() * 0.15));
      return { action: 'raise', amount: Math.max(betSize + me.currentBet, maxBet + bb) };
    }
    return { action: 'check' };
  }
  if (toCall <= pot * 0.35 && Math.random() < persona.bluffFreq * 0.3 && phase !== 'river') {
    return { action: 'call' };
  }
  return { action: 'fold' };
}

function fallbackAction(toCall, stack, bb, pot) {
  if (toCall === 0) return Math.random() < 0.6 ? { action: 'check' } : { action: 'raise', amount: Math.floor(pot * 0.5) + bb };
  if (toCall <= bb * 2) return { action: 'call' };
  if (Math.random() < 0.4) return { action: 'call' };
  return { action: 'fold' };
}


// ==================== NOSTR AUTH ====================

function generateNostrKeypair() {
  const secretKey = crypto.randomBytes(32);
  const pubkeyHex = getPublicKey(secretKey);
  const npub = npubEncode(pubkeyHex);
  return { secretKey, pubkeyHex, npub };
}

function signAuthEvent(secretKey, pubkeyHex, nonce) {
  const event = {
    kind: 22242,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['challenge', nonce]],
    content: JSON.stringify({ name: null, picture: null }),
    pubkey: pubkeyHex,
  };
  return finalizeEvent(event, secretKey);
}

async function authenticate(botName, secretKey, pubkeyHex) {
  const challengeRes = await fetch(`${SERVER_URL}/api/auth/challenge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  const challengeData = await challengeRes.json();
  if (!challengeData.success) throw new Error(`Challenge failed: ${challengeData.error}`);

  const signedEvent = signAuthEvent(secretKey, pubkeyHex, challengeData.nonce);
  const verifyRes = await fetch(`${SERVER_URL}/api/auth/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challengeId: challengeData.challengeId, signedEvent }),
  });
  const verifyData = await verifyRes.json();
  if (!verifyData.success) throw new Error(`Verify failed: ${verifyData.error}`);

  console.log(`  ✓ ${botName} authenticated (${pubkeyHex.slice(0, 8)}...)`);
  return verifyData.sessionToken;
}


// ==================== BOT INSTANCE ====================

async function startBot(index) {
  const persona = PERSONAS[index % PERSONAS.length];
  const botName = persona.name;
  const { secretKey, pubkeyHex, npub } = generateNostrKeypair();
  const tracker = new OpponentTracker();
  let mySeatIndex = -1;
  let handsPlayed = 0;
  let lastPhase = 'idle';

  console.log(`[${botName}] Starting (${persona.style}: ${persona.desc})`);

  let sessionToken;
  try {
    sessionToken = await authenticate(botName, secretKey, pubkeyHex);
  } catch (err) {
    console.error(`[${botName}] Auth failed:`, err.message);
    return;
  }

  const socket = io(SERVER_URL, {
    transports: ['websocket'],
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 2000,
  });

  socket.on('connect', () => {
    console.log(`[${botName}] Connected, joining ${TABLE_ID}...`);
    socket.emit('join-table', { tableId: TABLE_ID, sessionToken });
  });

  socket.on('seat-assigned', ({ seatIndex }) => {
    mySeatIndex = seatIndex;
    console.log(`[${botName}] Seated at position ${seatIndex + 1}`);
  });

  socket.on('game-state', (state) => {
    if (state.phase === 'preflop' && lastPhase !== 'preflop') {
      handsPlayed++;
      if (MAX_HANDS > 0 && handsPlayed > MAX_HANDS) {
        console.log(`[${botName}] Reached ${MAX_HANDS} hands, leaving.`);
        socket.emit('leave-table');
        socket.disconnect();
        return;
      }
      state.players.forEach((p, i) => {
        if (p && !p.sittingOut && i !== mySeatIndex) tracker.recordHandPlayed(i);
      });
    }
    lastPhase = state.phase;

    if (state.phase !== 'idle' && state.phase !== 'showdown') {
      state.players.forEach((p, i) => {
        if (!p || i === mySeatIndex || p.folded || p.sittingOut) return;
        if (p.currentBet > 0 && state.phase === 'preflop') {
          tracker.recordVPIP(i);
          if (p.currentBet > (state.bigBlind || 100)) {
            tracker.recordPFR(i);
            tracker.recordAggression(i);
          } else {
            tracker.recordPassive(i);
          }
        }
      });
    }

    if (state.yourTurn && mySeatIndex >= 0) {
      const decision = chooseAction(state, mySeatIndex, persona, tracker);
      if (decision) {
        const delay = ACTION_DELAY_MS + Math.random() * 1500;
        setTimeout(() => {
          const payload = { tableId: TABLE_ID, action: decision.action };
          if (decision.amount !== undefined) payload.amount = decision.amount;
          socket.emit('action', payload);

          const me = state.players[mySeatIndex];
          const stack = me ? me.stack : '?';
          const amtStr = decision.amount ? ` ${decision.amount}` : '';
          const cards = me && me.holeCards ? `[${me.holeCards.join(' ')}]` : '';
          console.log(`  [${botName}] ${decision.action}${amtStr} ${cards} (stack: ${stack}, pot: ${state.pot}, phase: ${state.phase})`);
        }, delay);
      }
    }
  });

  socket.on('hand-log', () => {});
  socket.on('error', ({ message }) => console.log(`  [${botName}] Error: ${message}`));
  socket.on('auth-error', ({ message }) => { console.error(`[${botName}] Auth error: ${message}`); socket.disconnect(); });
  socket.on('disconnect', (reason) => console.log(`[${botName}] Disconnected: ${reason}`));
  socket.on('reconnect', () => { console.log(`[${botName}] Reconnected, rejoining...`); socket.emit('join-table', { tableId: TABLE_ID, sessionToken }); });

  return socket;
}


// ==================== MAIN ====================

async function main() {
  console.log('');
  console.log('🎯 SatoshiStacks Training Bots');
  console.log(`   Server:  ${SERVER_URL}`);
  console.log(`   Bots:    ${NUM_BOTS}`);
  console.log(`   Table:   ${TABLE_ID}`);
  console.log(`   Hands:   ${MAX_HANDS || 'unlimited'}`);
  console.log(`   Delay:   ${ACTION_DELAY_MS}ms`);
  console.log('');
  console.log('   Bot Roster:');
  for (let i = 0; i < NUM_BOTS; i++) {
    const p = PERSONAS[i % PERSONAS.length];
    console.log(`     ${i + 1}. ${p.name} (${p.style}) — ${p.desc}`);
  }
  console.log('');

  const sockets = [];
  for (let i = 0; i < NUM_BOTS; i++) {
    try {
      const socket = await startBot(i);
      if (socket) sockets.push(socket);
    } catch (err) {
      console.error(`Bot ${i} failed to start:`, err.message);
    }
    if (i < NUM_BOTS - 1) await sleep(500);
  }

  console.log('');
  console.log(`✅ ${sockets.length}/${NUM_BOTS} training bots running. Press Ctrl+C to stop.`);
  console.log('');

  process.on('SIGINT', () => {
    console.log('\nShutting down training bots...');
    sockets.forEach(s => { s.emit('leave-table'); s.disconnect(); });
    setTimeout(() => process.exit(0), 1000);
  });
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--') && i + 1 < argv.length) { result[argv[i].slice(2)] = argv[i + 1]; i++; }
  }
  return result;
}

main().catch(err => { console.error('Fatal error:', err); process.exit(1); });
