/**
 * Deck utilities - shared between client and server
 * Server uses crypto shuffle, client can render cards
 */

const SUITS = ['h', 'd', 'c', 's'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const SUIT_SYM = { h: '\u2665', d: '\u2666', c: '\u2663', s: '\u2660' };
const RANK_DISP = { T: '10', J: 'J', Q: 'Q', K: 'K', A: 'A' };

function createDeck() {
  const d = [];
  for (const s of SUITS) {
    for (const r of RANKS) {
      d.push(r + s);
    }
  }
  return d;
}

/**
 * Cryptographically secure shuffle (server-side only)
 * Uses crypto.randomBytes() instead of Math.random()
 */
function shuffleSecure(deck) {
  const crypto = require('crypto');
  for (let i = deck.length - 1; i > 0; i--) {
    // Generate secure random index
    const buf = crypto.randomBytes(4);
    const rand = buf.readUInt32LE(0) / 0x100000000; // 0.0 to 1.0
    const j = Math.floor(rand * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

/**
 * Insecure shuffle (client display only - NOT for real money)
 * Math.random() is predictable and should never be used server-side
 */
function shuffleInsecure(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function cardRank(c) { return c[0]; }
function cardSuit(c) { return c[1]; }
function rankIdx(r) { return RANKS.indexOf(r); }
function isRed(s) { return s === 'h' || s === 'd'; }

module.exports = {
  SUITS,
  RANKS,
  SUIT_SYM,
  RANK_DISP,
  createDeck,
  shuffleSecure,
  shuffleInsecure,
  cardRank,
  cardSuit,
  rankIdx,
  isRed
};
