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
  MIN_BUYIN: 2000,
  MAX_BUYIN: 10000,
  NUM_SEATS: 6,
  STARTING_STACK: 10000,
  SMALL_BLIND: 50,
  BIG_BLIND: 100,

  // Anti-rathole
  RATHOLE_WINDOW_MS: 2 * 60 * 60 * 1000, // 2 hours

  // Timeouts
  DISCONNECT_GRACE_MS: 60000,   // 60s before auto-sit-out
  SOCKET_CLEANUP_MS: 10000,     // 10s before cleaning socket mapping

  // Rate limiting
  AUTH_RATE_LIMIT: { maxRequests: 10, windowSec: 60 },
  ACTION_RATE_LIMIT: { maxActions: 5, windowSec: 20 },
  JOIN_RATE_LIMIT: { maxActions: 10, windowSec: 10 },

  // Multi-table (toggled OFF — single Main Table focus)
  MULTI_TABLES_ENABLED: false,

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
