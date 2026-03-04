/**
 * Centralized configuration for SatoshiStacks
 * All constants, env vars, and tuning values in one place.
 */

require('dotenv').config();

if (!process.env.ADMIN_TOKEN) {
  console.error('FATAL: ADMIN_TOKEN environment variable is not set. Refusing to start with insecure admin access. Set ADMIN_TOKEN in your .env file.');
  process.exit(1);
}

module.exports = {
  PORT: process.env.PORT || 3001,
  CORS_ORIGIN: process.env.CORS_ORIGIN || '*',
  ADMIN_TOKEN: process.env.ADMIN_TOKEN,
  NOSTR_SERVER_NSEC: process.env.NOSTR_SERVER_NSEC || null,

  // Game rules
  NUM_SEATS: 6,

  // Table definitions — min buyin = 20bb, max buyin = 100bb
  TABLE_CONFIGS: {
    playmoney: {
      id: 'playmoney', route: '/playmoney', name: '50 / 100', emoji: '🎲',
      smallBlind: 50, bigBlind: 100, minBuyin: 2000, maxBuyin: 10000,
      mode: 'open', minPlayersToStart: 2,
    },
    pond: {
      id: 'pond', route: '/pond', name: '50 / 100', emoji: '🐟',
      smallBlind: 50, bigBlind: 100, minBuyin: 2000, maxBuyin: 10000,
      mode: 'open', minPlayersToStart: 2,
    },
    reef: {
      id: 'reef', route: '/reef', name: '250 / 500', emoji: '🦀',
      smallBlind: 250, bigBlind: 500, minBuyin: 10000, maxBuyin: 50000,
      mode: 'interest', minPlayersToStart: 4,
    },
    deep: {
      id: 'deep', route: '/deep', name: '500 / 1K', emoji: '🦈',
      smallBlind: 500, bigBlind: 1000, minBuyin: 20000, maxBuyin: 100000,
      mode: 'interest', minPlayersToStart: 4,
    },
    abyss: {
      id: 'abyss', route: '/abyss', name: '5K / 10K', emoji: '🐋',
      smallBlind: 5000, bigBlind: 10000, minBuyin: 200000, maxBuyin: 1000000,
      mode: 'interest', minPlayersToStart: 4,
    },
  },
  DEFAULT_TABLE: 'pond',

  // Anti-rathole
  RATHOLE_WINDOW_MS: 2 * 60 * 60 * 1000, // 2 hours

  // Timeouts
  DISCONNECT_GRACE_MS: 60000,   // 60s before auto-sit-out
  SOCKET_CLEANUP_MS: 10000,     // 10s before cleaning socket mapping

  // Rate limiting
  AUTH_RATE_LIMIT: { maxRequests: 10, windowSec: 60 },
  ACTION_RATE_LIMIT: { maxActions: 10, windowSec: 10 },
  JOIN_RATE_LIMIT: { maxActions: 10, windowSec: 10 },

  // Observer name generation
  OBSERVER_ADJECTIVES: ['Curious', 'Lucky', 'Swift', 'Cosmic', 'Zen', 'Bold', 'Neon', 'Pixel', 'Lunar', 'Solar', 'Turbo', 'Ultra'],
  OBSERVER_NOUNS: ['Satoshi', 'Whale', 'Hodler', 'Degen', 'Ape', 'Llama', 'Fox', 'Wolf', 'Eagle', 'Panda', 'Tiger', 'Bear'],

  // NOSTR relays
  RELAYS: [
    'wss://relay.damus.io',
    'wss://relay.nostr.band',
    'wss://nos.lol',
    'wss://relay.primal.net'
  ],

  // NIP-58 badge definitions
  BADGE_DEFINITIONS: [
    { id: 'card-player', name: 'Card Player', description: 'Played 1000 hands on SatoshiStacks', icon: '🃏', d_tag: 'card-player' },
    { id: 'royal-flush', name: 'Royal Flush', description: 'Hit a Royal Flush on SatoshiStacks', icon: '👑', d_tag: 'royal-flush' }
  ],
};
