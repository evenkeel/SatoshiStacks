/**
 * Centralized configuration for SatoshiStacks
 * All constants, env vars, and tuning values in one place.
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

if (!process.env.ADMIN_TOKEN) {
  console.error('FATAL: ADMIN_TOKEN environment variable is not set. Refusing to start with insecure admin access. Set ADMIN_TOKEN in your .env file.');
  process.exit(1);
}

// ==================== LIGHTNING / REAL MONEY ====================
// Master switch. When false (the default), EVERY table behaves as play-money and
// NO Lightning infra is required — the live play-money site is unaffected. Only
// when REALMONEY_ENABLED=true does a table flagged `realMoney` accept real sats.
const REALMONEY_ENABLED = process.env.REALMONEY_ENABLED === 'true';
// Kill switch for outbound payments (default ON; set to 'false' to freeze cash-outs).
const WITHDRAWALS_ENABLED = process.env.WITHDRAWALS_ENABLED !== 'false';

const LIGHTNING = {
  network: process.env.LIGHTNING_NETWORK || 'regtest', // regtest | signet | mainnet
  host: process.env.LND_HOST || '127.0.0.1',
  port: process.env.LND_PORT || 10009,
  macaroonPath: process.env.LND_MACAROON_PATH || null,
  tlsCertPath: process.env.LND_TLS_CERT_PATH || null,
  ownPubkey: process.env.LND_OWN_PUBKEY || null, // self-pay-loop guard
  hotWalletCapSats: parseInt(process.env.HOT_WALLET_CAP_SATS || '0', 10),
  maxWithdrawalSats: parseInt(process.env.MAX_WITHDRAWAL_SATS || '0', 10),
  minWithdrawalSats: parseInt(process.env.MIN_WITHDRAWAL_SATS || '1000', 10),
  withdrawalFeeLimitSats: parseInt(process.env.WITHDRAWAL_FEE_LIMIT_SATS || '50', 10),
  invoiceExpirySec: parseInt(process.env.INVOICE_EXPIRY_SEC || '600', 10),
};

// Startup guard: a real-money node must have its Lightning wiring + exposure caps
// configured. This NEVER trips on the default play-money deploy (REALMONEY_ENABLED unset).
if (REALMONEY_ENABLED) {
  const required = {
    LND_MACAROON_PATH: LIGHTNING.macaroonPath,
    LND_TLS_CERT_PATH: LIGHTNING.tlsCertPath,
    LND_OWN_PUBKEY: LIGHTNING.ownPubkey,
  };
  const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    console.error(`FATAL: REALMONEY_ENABLED=true but missing Lightning config: ${missing.join(', ')}. Refusing to start a real-money node without LND wiring.`);
    process.exit(1);
  }
  if (!LIGHTNING.hotWalletCapSats || !LIGHTNING.maxWithdrawalSats) {
    console.error('FATAL: REALMONEY_ENABLED=true requires HOT_WALLET_CAP_SATS and MAX_WITHDRAWAL_SATS (>0) to bound node exposure.');
    process.exit(1);
  }
}

module.exports = {
  REALMONEY_ENABLED,
  WITHDRAWALS_ENABLED,
  LIGHTNING,
  // True only when the master switch is on AND this table is flagged for real money.
  isRealMoney(tableId) {
    return REALMONEY_ENABLED && !!(this.TABLE_CONFIGS[tableId] && this.TABLE_CONFIGS[tableId].realMoney);
  },
  PORT: process.env.PORT || 3001,
  CORS_ORIGIN: process.env.CORS_ORIGIN || '*',
  ADMIN_TOKEN: process.env.ADMIN_TOKEN,
  NOSTR_SERVER_NSEC: process.env.NOSTR_SERVER_NSEC || null,

  // Game rules
  NUM_SEATS: 6,

  // Table definitions
  TABLE_CONFIGS: {
    playmoney: {
      id: 'playmoney', route: '/playmoney', name: '50 / 100', emoji: '🎲',
      smallBlind: 50, bigBlind: 100, minBuyin: 2000, maxBuyin: 10000,
      mode: 'open', minPlayersToStart: 2, realMoney: false,
    },
    station100: {
      id: 'station100', route: '/station100', name: 'Station 100', emoji: '',
      smallBlind: 50, bigBlind: 100, minBuyin: 10000, maxBuyin: 10000,
      mode: 'open', minPlayersToStart: 2, realMoney: true,
    },
  },
  DEFAULT_TABLE: 'station100',

  // Anti-rathole
  RATHOLE_WINDOW_MS: 2 * 60 * 60 * 1000, // 2 hours

  // Timeouts
  DISCONNECT_GRACE_MS: 60000,   // 60s before auto-sit-out
  SOCKET_CLEANUP_MS: 10000,     // 10s before cleaning socket mapping

  // Rate limiting
  AUTH_RATE_LIMIT: { maxRequests: 10, windowSec: 60 },
  ACTION_RATE_LIMIT: { maxActions: 10, windowSec: 10 },
  JOIN_RATE_LIMIT: { maxActions: 10, windowSec: 10 },
  ADMIN_RATE_LIMIT: { maxRequests: 30, windowSec: 60 },

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
