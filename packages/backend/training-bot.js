#!/usr/bin/env node
/**
 * Training Bots for SatoshiStacks
 *
 * Smarter bots that actually evaluate hand strength, understand position,
 * calculate pot odds, and play distinct styles. Designed to give human
 * players a real challenge.
 *
 * Usage:
 *   node training-bot.js                              # 5 training bots
 *   node training-bot.js --bots 3                     # 3 bots
 *   node training-bot.js --url https://example.com    # against remote
 *   node training-bot.js --table table-1              # specific table
 *   node training-bot.js --hands 200                  # quit after 200 hands
 *   node training-bot.js --delay 2000                 # slower thinking
 */

const { io } = require('socket.io-client');
const crypto = require('crypto');
const { getPublicKey, finalizeEvent } = require('nostr-tools/pure');
const { npubEncode } = require('nostr-tools/nip19');
const { evaluateHand, RANKS, rankIdx } = require('../shared');

// ==================== CONFIG ====================

const args = parseArgs(process.argv.slice(2));
const SERVER_URL = args.url || 'http://localhost:3001';
const NUM_BOTS = parseInt(args.bots) || 5;
const TABLE_ID = args.table || 'table-1';
const MAX_HANDS = parseInt(args.hands) || 0;
const ACTION_DELAY_MS = parseInt(args.delay) || 2000;

// ==================== BOT PERSONAS ====================
// Each bot has a distinct personality that affects how it plays

const PERSONAS = [
  {
    name: 'Ace_Grinder',
    style: 'TAG',          // Tight-aggressive (solid winning style)
    pfr: 0.18,             // preflop raise range (~18% of hands)
    aggression: 0.65,      // postflop aggression factor
    bluffFreq: 0.15,       // how often to bluff on missed boards
    foldToReraise: 0.55,   // fold frequency when facing 3bet+ preflop
    cbet: 0.70,            // continuation bet frequency
    slowplay: 0.10,        // slowplay monsters frequency
    desc: 'Solid grinder, plays strong hands aggressively',
  },
  {
    name: 'LuckyDraw',
    style: 'LAG',          // Loose-aggressive (tricky, hard to read)
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
    style: 'NIT',          // Very tight, only plays premiums
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
    style: 'TRICKY',       // Deceptive — slowplays big hands, overbets bluffs
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
    style: 'MANIAC',       // Hyper-aggressive, pressures every pot
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
// Score from 0-1 representing hand strength preflop.
// Based on standard 6-max opening ranges.

function getPreflopStrength(card1, card2) {
  const r1 = rankIdx(card1[0]);
  const r2 = rankIdx(card2[0]);
  const suited = card1[1] === card2[1];
  const hi = Math.max(r1, r2);
  const lo = Math.min(r1, r2);
  const pair = r1 === r2;
  const gap = hi - lo;

  if (pair) {
    // Pairs: AA=1.0, KK=0.95, ..., 22=0.45
    return 0.45 + (hi / 12) * 0.55;
  }

  // Base strength from high card values
  let strength = (hi + lo) / 24;  // 0 to 1

  // Suited bonus
  if (suited) strength += 0.06;

  // Connectivity bonus (closer cards can make straights)
  if (gap === 1) strength += 0.04;
  else if (gap === 2) strength += 0.02;
  else if (gap >= 5) strength -= 0.04;

  // Premium hand boosts
  if (hi === 12) {        // Ace-x
    if (lo >= 11) strength = suited ? 0.92 : 0.88;  // AK
    else if (lo >= 10) strength = suited ? 0.85 : 0.78;  // AQ
    else if (lo >= 9) strength = suited ? 0.80 : 0.72;   // AJ
    else if (lo >= 8) strength = suited ? 0.75 : 0.65;   // AT
    else if (suited) strength = Math.max(strength, 0.55); // Axs
    else strength = Math.max(strength, 0.30);              // Axo
  } else if (hi === 11) { // King-x
    if (lo >= 10) strength = suited ? 0.78 : 0.70;  // KQ
    else if (lo >= 9) strength = suited ? 0.72 : 0.63;  // KJ
    else if (lo >= 8) strength = suited ? 0.68 : 0.58;  // KT
    else if (suited) strength = Math.max(strength, 0.48);
  } else if (hi === 10) { // Queen-x
    if (lo >= 9) strength = suited ? 0.72 : 0.62;   // QJ
    else if (lo >= 8) strength = suited ? 0.66 : 0.56;  // QT
  } else if (hi === 9 && lo === 8) {
    strength = suited ? 0.65 : 0.55;  // JT
  }

  // Small suited connectors get a floor
  if (suited && gap <= 2 && lo >= 3) {
    strength = Math.max(strength, 0.42);
  }

  return Math.min(1, Math.max(0, strength));
}


// ==================== POSTFLOP HAND EVALUATION ====================

/**
 * Evaluate current hand strength given hole cards + community cards.
 * Returns { made: object, strength: 0-1, draws: object }
 */
function evaluatePostflop(holeCards, communityCards) {
  if (!communityCards || communityCards.length === 0) {
    return { strength: getPreflopStrength(holeCards[0], holeCards[1]), draws: {}, made: null };
  }

  const allCards = [...holeCards, ...communityCards];
  const made = evaluateHand(allCards);

  // Convert hand rank (0-9) to a relative strength score
  // Adjust based on board texture and kicker strength
  let strength = 0;

  switch (made.rank) {
    case 9: strength = 1.00; break;  // Royal flush
    case 8: strength = 0.98; break;  // Straight flush
    case 7: strength = 0.95; break;  // Quads
    case 6: strength = 0.90; break;  // Full house
    case 5:                          // Flush
      strength = 0.80 + (made.tb[0] / 12) * 0.08; // Nut flush vs low flush
      break;
    case 4: strength = 0.72; break;  // Straight
    case 3:                          // Trips
      // Trips using both hole cards (set) vs one (trips) vs board trips
      strength = usesHoleCards(holeCards, communityCards, made) ? 0.68 : 0.55;
      break;
    case 2:                          // Two pair
      strength = usesHoleCards(holeCards, communityCards, made) ? 0.58 : 0.45;
      break;
    case 1:                          // One pair
      strength = evaluatePairStrength(holeCards, communityCards, made);
      break;
    case 0:                          // High card
      strength = 0.10 + (made.tb[0] / 12) * 0.12;
      break;
  }

  // Check for draws
  const draws = checkDraws(holeCards, communityCards);

  // Boost strength for strong draws
  if (draws.flushDraw) strength += 0.12;
  if (draws.oesd) strength += 0.10;
  if (draws.gutshot) strength += 0.05;
  if (draws.flushDraw && draws.oesd) strength += 0.08; // combo draw extra

  // Board wetness penalty for marginal made hands (1 pair, 2 pair)
  if (made.rank <= 2) {
    const wetness = getBoardWetness(communityCards);
    strength -= wetness * 0.08;
  }

  return {
    strength: Math.min(1, Math.max(0, strength)),
    draws,
    made,
  };
}

/**
 * Check if our hand rank specifically uses our hole cards
 * (e.g., set vs board trips, two pair with hole cards vs board pair)
 */
function usesHoleCards(holeCards, community, made) {
  const holeRanks = holeCards.map(c => rankIdx(c[0]));

  if (made.rank === 3) {
    // Three of a kind: do we have a pocket pair matching the trips?
    return holeRanks[0] === holeRanks[1] && holeRanks[0] === made.tb[0];
  }
  if (made.rank === 2) {
    // Two pair: do at least 2 of our hole card ranks appear in the pairs?
    const pairRanks = [made.tb[0], made.tb[1]];
    return holeRanks.filter(r => pairRanks.includes(r)).length >= 1;
  }
  return true;
}

/**
 * Evaluate pair strength with context
 */
function evaluatePairStrength(holeCards, communityCards, made) {
  const holeRanks = holeCards.map(c => rankIdx(c[0]));
  const communityRanks = communityCards.map(c => rankIdx(c[0]));
  const pairRank = made.tb[0];
  const boardHighCard = Math.max(...communityRanks);

  // Pocket pair (overpair, middle pair, underpair)
  if (holeRanks[0] === holeRanks[1] && holeRanks[0] === pairRank) {
    if (pairRank > boardHighCard) {
      return 0.50 + (pairRank / 12) * 0.10; // Overpair
    } else {
      return 0.30 + (pairRank / 12) * 0.08; // Underpair/middle pair
    }
  }

  // Paired with board
  if (holeRanks.includes(pairRank)) {
    if (pairRank === boardHighCard) {
      // Top pair — kicker matters
      const kicker = holeRanks.find(r => r !== pairRank) ?? 0;
      return 0.38 + (pairRank / 12) * 0.06 + (kicker / 12) * 0.08;
    } else {
      // Middle/bottom pair
      return 0.22 + (pairRank / 12) * 0.08;
    }
  }

  // Board pair (we don't contribute)
  return 0.15 + (made.tb[1] / 12) * 0.05;
}

/**
 * Check for drawing hands
 */
function checkDraws(holeCards, communityCards) {
  const allCards = [...holeCards, ...communityCards];
  const suits = {};
  const ranks = allCards.map(c => rankIdx(c[0])).sort((a, b) => a - b);

  // Count suits
  allCards.forEach(c => {
    const s = c[1];
    suits[s] = (suits[s] || 0) + 1;
  });

  const flushDraw = Object.entries(suits).some(([s, count]) => {
    if (count !== 4) return false;
    // Make sure we contribute to the flush draw
    return holeCards.some(c => c[1] === s);
  });

  // Check for straight draws
  const uniqueRanks = [...new Set(ranks)];
  let oesd = false;
  let gutshot = false;

  // Check windows of 5 consecutive rank slots for straight draws
  for (let start = 0; start <= 12; start++) {
    const end = start + 4;
    const inWindow = uniqueRanks.filter(r => r >= start && r <= end);
    // Also check ace-low (wheel draw)
    const inWindowWithWheel = start === 0 && uniqueRanks.includes(12)
      ? [...inWindow, 12]
      : inWindow;
    const count = new Set(inWindowWithWheel).size;

    if (count === 4) {
      // 4 out of 5 ranks filled — check if open-ended or gutshot
      const filled = [];
      for (let r = start; r <= end; r++) {
        const rr = r > 12 ? 0 : r; // handle ace as low
        filled.push(uniqueRanks.includes(rr) || (rr === 0 && start === 0 && uniqueRanks.includes(12)));
      }
      const gaps = filled.reduce((acc, v, i) => v ? acc : [...acc, i], []);
      if (gaps.length === 1 && (gaps[0] === 0 || gaps[0] === 4)) {
        oesd = true; // Open-ended (missing top or bottom)
      } else if (gaps.length === 1) {
        gutshot = true; // Inside draw
      }
    }
  }

  return { flushDraw, oesd, gutshot };
}

/**
 * Evaluate how "wet" (coordinated) the board is.
 * Wet boards make marginal hands less valuable.
 * Returns 0.0 (dry) to 1.0 (very wet)
 */
function getBoardWetness(communityCards) {
  if (communityCards.length === 0) return 0;

  const ranks = communityCards.map(c => rankIdx(c[0])).sort((a, b) => a - b);
  const suits = communityCards.map(c => c[1]);
  let wetness = 0;

  // Flush potential
  const suitCounts = {};
  suits.forEach(s => suitCounts[s] = (suitCounts[s] || 0) + 1);
  const maxSuit = Math.max(...Object.values(suitCounts));
  if (maxSuit >= 3) wetness += 0.3;
  else if (maxSuit === 2 && communityCards.length <= 3) wetness += 0.1;

  // Straight potential (closeness of ranks)
  const uniqueRanks = [...new Set(ranks)];
  let connectors = 0;
  for (let i = 0; i < uniqueRanks.length - 1; i++) {
    if (uniqueRanks[i + 1] - uniqueRanks[i] <= 2) connectors++;
  }
  wetness += (connectors / Math.max(uniqueRanks.length - 1, 1)) * 0.3;

  // High cards on board (more likely opponents have top pair+)
  const highCount = ranks.filter(r => r >= 9).length; // T+
  wetness += (highCount / communityCards.length) * 0.2;

  // Paired board is actually drier
  if (uniqueRanks.length < communityCards.length) wetness -= 0.15;

  return Math.min(1, Math.max(0, wetness));
}


// ==================== POSITION AWARENESS ====================

/**
 * Determine position relative to dealer.
 * Returns a multiplier: positions closer to button get looser ranges.
 */
function getPositionMultiplier(mySeat, dealerSeat, numPlayers) {
  // Calculate seats away from dealer (going clockwise)
  const seatsFromDealer = ((mySeat - dealerSeat) + 6) % 6;

  // In a 6-max game:
  // Seat after dealer = SB (position 1)
  // Seat after SB = BB (position 2)
  // Then UTG, MP, CO, BTN
  // Later position = looser = higher multiplier

  if (numPlayers <= 2) return 1.0; // Heads-up, always play wide

  // Map positions: early=tighter, late=looser
  const positionMap = {
    2: 0.85,   // UTG (earliest to act postflop in 6-max after blinds)
    3: 0.90,   // MP
    4: 1.00,   // CO (cutoff)
    5: 1.10,   // BTN (best position)
    0: 0.80,   // SB (worst position postflop)
    1: 0.85,   // BB (bad position but getting odds)
  };

  return positionMap[seatsFromDealer] || 0.90;
}

/**
 * Check if we have position (act last postflop)
 */
function hasPosition(mySeat, dealerSeat) {
  return mySeat === dealerSeat;
}


// ==================== OPPONENT MODELING ====================

/**
 * Simple opponent tracker — tracks per-opponent stats over the session.
 * Not persistent across restarts, but enough to adapt mid-session.
 */
class OpponentTracker {
  constructor() {
    this.stats = {};  // keyed by seatIndex
  }

  getStats(seatIndex) {
    if (!this.stats[seatIndex]) {
      this.stats[seatIndex] = {
        handsPlayed: 0,
        vpip: 0,        // voluntarily put chips in pot
        pfr: 0,         // preflop raises
        cbet: 0,        // continuation bets
        cbetOpps: 0,    // opportunities to cbet
        foldToCbet: 0,  // folds to cbets
        foldToCbetOpps: 0,
        aggActions: 0,  // raises + bets
        passiveActions: 0, // calls + checks
        showdowns: 0,
        showdownWins: 0,
      };
    }
    return this.stats[seatIndex];
  }

  recordVPIP(seatIndex) {
    this.getStats(seatIndex).vpip++;
  }
  recordPFR(seatIndex) {
    this.getStats(seatIndex).pfr++;
  }
  recordHandPlayed(seatIndex) {
    this.getStats(seatIndex).handsPlayed++;
  }
  recordAggression(seatIndex) {
    this.getStats(seatIndex).aggActions++;
  }
  recordPassive(seatIndex) {
    this.getStats(seatIndex).passiveActions++;
  }

  /**
   * Get opponent profile to adjust strategy
   */
  getProfile(seatIndex) {
    const s = this.getStats(seatIndex);
    if (s.handsPlayed < 5) return 'unknown'; // not enough data

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

  // If we can't see our cards, fallback to basic play
  if (!holeCards || holeCards[0] === '??' || holeCards.length < 2) {
    return fallbackAction(toCall, myStack, bigBlind, pot);
  }

  // Active player count
  const activePlayers = gameState.players.filter(p => p && !p.folded && !p.sittingOut).length;
  const playersInHand = activePlayers;

  // Position
  const dealerSeat = gameState.dealerSeat ?? 0;
  const posMultiplier = getPositionMultiplier(mySeatIndex, dealerSeat, playersInHand);
  const inPosition = hasPosition(mySeatIndex, dealerSeat);

  // ==================== PREFLOP ====================
  if (phase === 'preflop') {
    return preflopDecision(holeCards, toCall, myStack, pot, bigBlind, persona, posMultiplier, playersInHand, maxBet, me);
  }

  // ==================== POSTFLOP ====================
  return postflopDecision(holeCards, community, toCall, myStack, pot, bigBlind, persona, inPosition, playersInHand, maxBet, me, tracker, gameState, phase);
}


// ==================== PREFLOP DECISIONS ====================

function preflopDecision(holeCards, toCall, stack, pot, bb, persona, posMultiplier, playersInHand, maxBet, me) {
  const handStrength = getPreflopStrength(holeCards[0], holeCards[1]);
  const adjustedStrength = handStrength * posMultiplier;

  // Determine the threshold to play based on persona
  const playThreshold = 1 - persona.pfr; // e.g., TAG pfr=0.18 → threshold=0.82

  const facingRaise = toCall > bb;
  const facing3bet = toCall > bb * 3;
  const potOdds = toCall / (pot + toCall);

  // ---- Premium hands (always play) ----
  if (handStrength >= 0.88) {
    // AA, KK, QQ, AKs — always raise or re-raise
    if (facingRaise) {
      // 3bet or 4bet
      const raiseAmt = Math.min(maxBet * 3, me.currentBet + stack);
      return { action: 'raise', amount: Math.max(raiseAmt, maxBet + bb) };
    }
    const openSize = bb * (2.5 + Math.random() * 0.5);
    return { action: 'raise', amount: Math.floor(Math.max(openSize + me.currentBet, maxBet + bb)) };
  }

  // ---- Strong hands ----
  if (adjustedStrength >= playThreshold) {
    if (facing3bet) {
      // Facing a 3bet — only continue with top of range
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
      // Facing an open raise — call or 3bet
      if (handStrength >= 0.75 && Math.random() < persona.aggression * 0.6) {
        const raiseAmt = Math.floor(maxBet * (2.5 + Math.random()));
        return { action: 'raise', amount: Math.min(raiseAmt, me.currentBet + stack) };
      }
      return { action: 'call' };
    }

    // No raise in front — open raise
    if (toCall === 0 || toCall <= bb) {
      const openSize = bb * (2.2 + Math.random() * 0.8);
      return { action: 'raise', amount: Math.floor(Math.max(openSize + me.currentBet, maxBet + bb)) };
    }

    return { action: 'call' };
  }

  // ---- Marginal hands ----
  if (adjustedStrength >= playThreshold * 0.85) {
    // Playable in position or cheap
    if (toCall === 0) {
      // Limp or raise with a mixed strategy
      if (Math.random() < persona.aggression * 0.3) {
        const openSize = bb * (2.2 + Math.random() * 0.5);
        return { action: 'raise', amount: Math.floor(Math.max(openSize + me.currentBet, maxBet + bb)) };
      }
      return { action: 'check' };
    }
    if (toCall <= bb && potOdds < 0.3) {
      return { action: 'call' }; // Getting odds
    }
    return { action: 'fold' };
  }

  // ---- Junk ----
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
  const spr = stack / Math.max(pot, 1); // Stack-to-pot ratio

  // ---- Monster hands (very strong) ----
  if (strength >= 0.80) {
    return playMonster(toCall, stack, pot, bb, persona, maxBet, me, spr);
  }

  // ---- Strong hands (top pair good kicker+, overpair, sets, two pair) ----
  if (strength >= 0.50) {
    return playStrong(toCall, stack, pot, bb, persona, inPosition, maxBet, me, strength, spr, playersInHand);
  }

  // ---- Medium hands (middle pair, top pair bad kicker, weak two pair) ----
  if (strength >= 0.30) {
    return playMedium(toCall, stack, pot, bb, persona, inPosition, maxBet, me, strength, potOdds, draws, phase);
  }

  // ---- Drawing hands ----
  if (hasDraw || hasGutshot) {
    return playDraw(toCall, stack, pot, bb, persona, inPosition, maxBet, me, draws, potOdds, strength);
  }

  // ---- Weak/nothing hands ----
  return playWeak(toCall, stack, pot, bb, persona, inPosition, maxBet, me, phase, potOdds);
}


function playMonster(toCall, stack, pot, bb, persona, maxBet, me, spr) {
  // Slowplay or fast-play?
  if (Math.random() < persona.slowplay && toCall === 0) {
    // Trap: check or small bet
    if (Math.random() < 0.5) return { action: 'check' };
    const smallBet = Math.floor(pot * 0.33);
    return { action: 'raise', amount: Math.max(smallBet + me.currentBet, maxBet + (me.bigBlind || 100)) };
  }

  // If facing a bet — raise big or shove
  if (toCall > 0) {
    if (spr < 3) {
      // Short SPR: shove
      return { action: 'raise', amount: me.currentBet + stack };
    }
    const raiseAmt = Math.floor(maxBet + pot * (0.7 + Math.random() * 0.5));
    return { action: 'raise', amount: Math.min(raiseAmt, me.currentBet + stack) };
  }

  // Bet for value
  const betSize = Math.floor(pot * (0.6 + Math.random() * 0.3));
  return { action: 'raise', amount: Math.max(betSize + me.currentBet, maxBet + (me.bigBlind || 100)) };
}


function playStrong(toCall, stack, pot, bb, persona, inPosition, maxBet, me, strength, spr, playersInHand) {
  // Facing a bet
  if (toCall > 0) {
    const potOdds = toCall / (pot + toCall);

    // Big bet: call or raise based on strength
    if (toCall > pot * 0.6 && strength < 0.60) {
      // Facing an overbet with just-okay hand — be careful
      if (Math.random() < 0.5) return { action: 'call' };
      return { action: 'fold' };
    }

    // Raise for value sometimes
    if (Math.random() < persona.aggression * 0.5 && strength >= 0.55) {
      const raiseAmt = Math.floor(maxBet + pot * (0.5 + Math.random() * 0.5));
      return { action: 'raise', amount: Math.min(raiseAmt, me.currentBet + stack) };
    }

    return { action: 'call' };
  }

  // No bet to face: bet for value or protection
  if (Math.random() < persona.aggression * 0.8) {
    const betFraction = playersInHand > 2 ? 0.65 : 0.50;
    const betSize = Math.floor(pot * (betFraction + Math.random() * 0.2));
    return { action: 'raise', amount: Math.max(betSize + me.currentBet, maxBet + bb) };
  }

  // Check in position for pot control
  if (inPosition && strength < 0.60) return { action: 'check' };

  const betSize = Math.floor(pot * (0.45 + Math.random() * 0.2));
  return { action: 'raise', amount: Math.max(betSize + me.currentBet, maxBet + bb) };
}


function playMedium(toCall, stack, pot, bb, persona, inPosition, maxBet, me, strength, potOdds, draws, phase) {
  const hasDraw = draws.flushDraw || draws.oesd;

  // Facing a bet
  if (toCall > 0) {
    // Getting good odds with a draw backup?
    if (hasDraw && potOdds < 0.30) return { action: 'call' };

    // Small bet — call and see
    if (toCall <= pot * 0.4) return { action: 'call' };

    // Medium bet — position and strength dependent
    if (toCall <= pot * 0.7 && (inPosition || strength >= 0.38)) {
      return { action: 'call' };
    }

    // Big bet — fold most medium hands
    if (strength < 0.40 || potOdds > 0.35) {
      return { action: 'fold' };
    }

    return { action: 'call' };
  }

  // No bet to face
  // C-bet or probe bet on occasion
  if (Math.random() < persona.cbet * 0.5) {
    const betSize = Math.floor(pot * (0.35 + Math.random() * 0.2));
    return { action: 'raise', amount: Math.max(betSize + me.currentBet, maxBet + bb) };
  }

  return { action: 'check' };
}


function playDraw(toCall, stack, pot, bb, persona, inPosition, maxBet, me, draws, potOdds, strength) {
  const isStrong = draws.flushDraw || draws.oesd;
  const outs = (draws.flushDraw ? 9 : 0) + (draws.oesd ? 8 : 0) + (draws.gutshot && !draws.oesd ? 4 : 0);
  // Rough equity from outs (on one card)
  const drawEquity = Math.min(outs * 0.022, 0.45);
  const combinedStrength = strength + drawEquity;

  if (toCall > 0) {
    // Check pot odds vs draw equity
    if (potOdds <= drawEquity + 0.05) {
      // Getting odds — call
      return { action: 'call' };
    }

    // Semi-bluff raise with strong draws
    if (isStrong && Math.random() < persona.aggression * 0.5) {
      const raiseAmt = Math.floor(maxBet + pot * (0.6 + Math.random() * 0.3));
      return { action: 'raise', amount: Math.min(raiseAmt, me.currentBet + stack) };
    }

    // Marginal draw facing a bet — fold if price is bad
    if (potOdds > drawEquity + 0.12) return { action: 'fold' };

    return { action: 'call' };
  }

  // No bet — semi-bluff or check
  if (isStrong && Math.random() < persona.aggression * 0.6) {
    const betSize = Math.floor(pot * (0.5 + Math.random() * 0.25));
    return { action: 'raise', amount: Math.max(betSize + me.currentBet, maxBet + bb) };
  }

  return { action: 'check' };
}


function playWeak(toCall, stack, pot, bb, persona, inPosition, maxBet, me, phase, potOdds) {
  // No bet: occasionally bluff
  if (toCall === 0) {
    const bluffChance = persona.bluffFreq * (inPosition ? 1.2 : 0.7);

    // Bluff more on later streets (scarier)
    const streetMultiplier = phase === 'river' ? 1.3 : phase === 'turn' ? 1.0 : 0.8;

    if (Math.random() < bluffChance * streetMultiplier) {
      // Bluff sizing: bigger on river, smaller on flop
      const sizeMult = phase === 'river' ? 0.75 : phase === 'turn' ? 0.55 : 0.40;
      const betSize = Math.floor(pot * (sizeMult + Math.random() * 0.15));
      return { action: 'raise', amount: Math.max(betSize + me.currentBet, maxBet + bb) };
    }

    return { action: 'check' };
  }

  // Facing a bet with nothing
  // Occasional hero call / float (LAG/MANIAC tendency)
  if (toCall <= pot * 0.35 && Math.random() < persona.bluffFreq * 0.3 && phase !== 'river') {
    return { action: 'call' }; // Float to bluff later
  }

  return { action: 'fold' };
}


// ==================== FALLBACK (if cards not visible) ====================

function fallbackAction(toCall, stack, bb, pot) {
  if (toCall === 0) {
    return Math.random() < 0.6 ? { action: 'check' } : { action: 'raise', amount: Math.floor(pot * 0.5) + bb };
  }
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
  let lastAction = null;

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

  socket.on('seat-assigned', ({ seatIndex, displayName }) => {
    mySeatIndex = seatIndex;
    console.log(`[${botName}] Seated at position ${seatIndex + 1}`);
  });

  socket.on('game-state', (state) => {
    // Track hand count
    if (state.phase === 'preflop' && lastPhase !== 'preflop') {
      handsPlayed++;
      if (MAX_HANDS > 0 && handsPlayed > MAX_HANDS) {
        console.log(`[${botName}] Reached ${MAX_HANDS} hands, leaving.`);
        socket.emit('leave-table');
        socket.disconnect();
        return;
      }

      // Record hands for all active players
      state.players.forEach((p, i) => {
        if (p && !p.sittingOut && i !== mySeatIndex) {
          tracker.recordHandPlayed(i);
        }
      });
    }
    lastPhase = state.phase;

    // Track opponent actions for modeling
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

    // Is it my turn?
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

  socket.on('hand-log', ({ line, type }) => {
    // Track showdown results for opponent modeling
    if (type === 'winner') {
      // Could parse winner info here for deeper tracking
    }
  });

  socket.on('error', ({ message }) => {
    console.log(`  [${botName}] Error: ${message}`);
  });

  socket.on('auth-error', ({ message }) => {
    console.error(`[${botName}] Auth error: ${message}`);
    socket.disconnect();
  });

  socket.on('disconnect', (reason) => {
    console.log(`[${botName}] Disconnected: ${reason}`);
  });

  socket.on('reconnect', () => {
    console.log(`[${botName}] Reconnected, rejoining...`);
    socket.emit('join-table', { tableId: TABLE_ID, sessionToken });
  });

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
    if (i < NUM_BOTS - 1) {
      await sleep(500);
    }
  }

  console.log('');
  console.log(`✅ ${sockets.length}/${NUM_BOTS} training bots running. Press Ctrl+C to stop.`);
  console.log('');

  process.on('SIGINT', () => {
    console.log('\nShutting down training bots...');
    sockets.forEach(s => {
      s.emit('leave-table');
      s.disconnect();
    });
    setTimeout(() => process.exit(0), 1000);
  });
}

// ==================== UTILS ====================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--') && i + 1 < argv.length) {
      result[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return result;
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
