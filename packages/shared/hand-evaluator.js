/**
 * Hand evaluation - shared between client and server
 * Takes 7 cards, returns best 5-card hand
 */

const { RANKS, cardRank, cardSuit, rankIdx } = require('./deck');

const RANK_PLURAL = [
  'Deuces', 'Threes', 'Fours', 'Fives', 'Sixes', 'Sevens', 'Eights', 'Nines',
  'Tens', 'Jacks', 'Queens', 'Kings', 'Aces'
];

const RANK_NAME = [
  'Deuce', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
  'Ten', 'Jack', 'Queen', 'King', 'Ace'
];

/**
 * Evaluate best hand from 7 cards
 * @param {string[]} cards - Array of 7 cards (e.g., ['Ah', 'Kh', ...])
 * @returns {object} { rank: number (0-9), tb: number[], name: string }
 */
function evaluateHand(cards) {
  const combos = getCombos(cards, 5);
  let best = { rank: -1, tb: [], name: '' };
  
  for (const c of combos) {
    const r = eval5(c);
    if (r.rank > best.rank || (r.rank === best.rank && cmpTB(r.tb, best.tb) > 0)) {
      best = r;
    }
  }
  
  return best;
}

/**
 * Evaluate exactly 5 cards
 * @param {string[]} cards - Array of 5 cards
 * @returns {object} { rank, tb, name }
 */
function eval5(cards) {
  const ranks = cards.map(c => rankIdx(cardRank(c))).sort((a, b) => b - a);
  const suits = cards.map(c => cardSuit(c));
  
  const flush = suits.every(s => s === suits[0]);
  let straight = false, straightHi = -1;
  
  const uniq = [...new Set(ranks)].sort((a, b) => b - a);
  
  // Check for straight
  if (uniq.length >= 5) {
    for (let i = 0; i <= uniq.length - 5; i++) {
      if (uniq[i] - uniq[i + 4] === 4) {
        straight = true;
        straightHi = uniq[i];
        break;
      }
    }
    // Check for wheel (A-2-3-4-5)
    if (!straight && uniq.includes(12) && uniq.includes(0) && uniq.includes(1) && uniq.includes(2) && uniq.includes(3)) {
      straight = true;
      straightHi = 3; // Five-high straight
    }
  }
  
  // Count rank frequencies
  const freq = {};
  ranks.forEach(r => freq[r] = (freq[r] || 0) + 1);
  const fv = Object.entries(freq).sort((a, b) => b[1] - a[1] || parseInt(b[0]) - parseInt(a[0]));
  const counts = fv.map(f => f[1]);
  
  const straightName = straightHi === 3 
    ? 'Ace to Five' 
    : RANK_NAME[straightHi - 4] + ' to ' + RANK_NAME[straightHi];
  
  // Hand rankings (9 = best, 0 = worst)
  if (flush && straight && straightHi === 12) {
    return { rank: 9, tb: [12], name: 'a Royal Flush' };
  }
  if (flush && straight) {
    return { rank: 8, tb: [straightHi], name: 'a straight flush, ' + straightName };
  }
  if (counts[0] === 4) {
    return { rank: 7, tb: [+fv[0][0], +fv[1][0]], name: 'four of a kind, ' + RANK_PLURAL[+fv[0][0]] };
  }
  if (counts[0] === 3 && counts[1] >= 2) {
    return { 
      rank: 6, 
      tb: [+fv[0][0], +fv[1][0]], 
      name: 'a full house, ' + RANK_PLURAL[+fv[0][0]] + ' full of ' + RANK_PLURAL[+fv[1][0]] 
    };
  }
  if (flush) {
    return { rank: 5, tb: ranks, name: 'a flush, ' + RANK_NAME[ranks[0]] + ' high' };
  }
  if (straight) {
    return { rank: 4, tb: [straightHi], name: 'a straight, ' + straightName };
  }
  if (counts[0] === 3) {
    const k = fv.filter(f => f[1] === 1).map(f => +f[0]).sort((a, b) => b - a);
    return { rank: 3, tb: [+fv[0][0], ...k], name: 'three of a kind, ' + RANK_PLURAL[+fv[0][0]] };
  }
  if (counts[0] === 2 && counts[1] === 2) {
    const p = fv.filter(f => f[1] === 2).map(f => +f[0]).sort((a, b) => b - a);
    const k = fv.find(f => f[1] === 1);
    return { 
      rank: 2, 
      tb: [...p, k ? +k[0] : 0], 
      name: 'two pair, ' + RANK_PLURAL[p[0]] + ' and ' + RANK_PLURAL[p[1]] 
    };
  }
  if (counts[0] === 2) {
    const k = fv.filter(f => f[1] === 1).map(f => +f[0]).sort((a, b) => b - a);
    return { rank: 1, tb: [+fv[0][0], ...k], name: 'a pair of ' + RANK_PLURAL[+fv[0][0]] };
  }
  
  return { rank: 0, tb: ranks, name: 'high card ' + RANK_NAME[ranks[0]] };
}

/**
 * Compare tiebreakers (returns 1 if a wins, -1 if b wins, 0 if tie)
 */
function cmpTB(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] > b[i]) return 1;
    if (a[i] < b[i]) return -1;
  }
  return 0;
}

/**
 * Generate all k-combinations of array
 */
function getCombos(arr, k) {
  if (k === 0) return [[]];
  if (arr.length < k) return [];
  const [f, ...r] = arr;
  return [
    ...getCombos(r, k - 1).map(c => [f, ...c]),
    ...getCombos(r, k)
  ];
}

module.exports = {
  evaluateHand,
  eval5,
  cmpTB,
  getCombos,
  RANK_PLURAL,
  RANK_NAME
};
