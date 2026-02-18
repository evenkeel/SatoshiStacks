/**
 * Database Layer for SatoshiStacks
 * SQLite database for hand history, player stats, and table state
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Create db directory if it doesn't exist
const dbDir = path.join(__dirname, 'db');
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const dbPath = path.join(dbDir, 'satoshistacks.db');
const isdev = process.env.NODE_ENV !== 'production';
const db = new Database(dbPath, isdev ? { verbose: console.log } : {});

// Enable foreign keys
db.pragma('foreign_keys = ON');

/**
 * Initialize database schema
 */
function initDatabase() {
  console.log('[Database] Initializing schema...');

  // Hands table
  db.exec(`
    CREATE TABLE IF NOT EXISTS hands (
      hand_id TEXT PRIMARY KEY,
      table_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      completed_at INTEGER NOT NULL,
      small_blind INTEGER NOT NULL,
      big_blind INTEGER NOT NULL,
      button_seat INTEGER NOT NULL,
      pot_total INTEGER NOT NULL,
      rake INTEGER DEFAULT 0,
      community_cards TEXT,
      hand_history TEXT NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_hands_table ON hands(table_id);
    CREATE INDEX IF NOT EXISTS idx_hands_started ON hands(started_at);
  `);

  // Hand players table
  db.exec(`
    CREATE TABLE IF NOT EXISTS hand_players (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hand_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      seat_index INTEGER NOT NULL,
      starting_stack INTEGER NOT NULL,
      ending_stack INTEGER NOT NULL,
      total_bet INTEGER NOT NULL,
      hole_cards TEXT,
      final_hand TEXT,
      position TEXT,
      actions TEXT NOT NULL,
      won_amount INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY (hand_id) REFERENCES hands(hand_id)
    );
    CREATE INDEX IF NOT EXISTS idx_hand_players_hand ON hand_players(hand_id);
    CREATE INDEX IF NOT EXISTS idx_hand_players_user ON hand_players(user_id);
  `);

  // Players table
  db.exec(`
    CREATE TABLE IF NOT EXISTS players (
      user_id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      current_chips INTEGER DEFAULT 10000,
      hands_played INTEGER DEFAULT 0,
      hands_won INTEGER DEFAULT 0,
      total_winnings INTEGER DEFAULT 0,
      total_losses INTEGER DEFAULT 0,
      first_seen INTEGER DEFAULT (strftime('%s','now')),
      last_seen INTEGER DEFAULT (strftime('%s','now')),
      is_banned BOOLEAN DEFAULT 0,
      ban_reason TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_players_username ON players(username);
    CREATE INDEX IF NOT EXISTS idx_players_last_seen ON players(last_seen);
  `);

  // Migration: Add left_at column for anti-rathole tracking
  try {
    db.exec(`ALTER TABLE players ADD COLUMN left_at INTEGER DEFAULT NULL`);
    console.log('[Database] Added left_at column to players table');
  } catch (e) {
    // Column already exists — ignore
  }

  // Tables table
  db.exec(`
    CREATE TABLE IF NOT EXISTS tables (
      table_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      small_blind INTEGER NOT NULL,
      big_blind INTEGER NOT NULL,
      max_players INTEGER DEFAULT 6,
      current_players INTEGER DEFAULT 0,
      is_active BOOLEAN DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      last_hand_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_tables_active ON tables(is_active);
  `);

  // Abuse log table
  db.exec(`
    CREATE TABLE IF NOT EXISTS abuse_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      ip_address TEXT,
      action_type TEXT NOT NULL,
      timestamp INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_abuse_user_time ON abuse_log(user_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_abuse_ip_time ON abuse_log(ip_address, timestamp);
  `);

  // IP bans table (Phase 5.4B: IP-based enforcement)
  db.exec(`
    CREATE TABLE IF NOT EXISTS ip_bans (
      ip_address TEXT PRIMARY KEY,
      banned_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      reason TEXT,
      banned_by TEXT,
      notes TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ip_bans_banned_at ON ip_bans(banned_at);
  `);

  // NOSTR auth challenges table
  db.exec(`
    CREATE TABLE IF NOT EXISTS nostr_challenges (
      challenge_id TEXT PRIMARY KEY,
      nonce TEXT NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      expires_at INTEGER NOT NULL,
      used INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_challenges_expires ON nostr_challenges(expires_at);
  `);

  // Migration: Add NOSTR columns to players table (safe for existing DBs)
  const migrations = [
    `ALTER TABLE players ADD COLUMN auth_type TEXT DEFAULT 'nostr'`,
    `ALTER TABLE players ADD COLUMN pubkey_hex TEXT`,
    `ALTER TABLE players ADD COLUMN npub TEXT`,
    `ALTER TABLE players ADD COLUMN nostr_name TEXT`,
    `ALTER TABLE players ADD COLUMN nostr_picture TEXT`,
    `ALTER TABLE players ADD COLUMN nip05 TEXT`,
    `ALTER TABLE players ADD COLUMN session_token TEXT`,
    `ALTER TABLE players ADD COLUMN session_expires INTEGER`,
  ];
  for (const sql of migrations) {
    try { db.exec(sql); } catch (e) {
      if (!e.message.includes('duplicate column')) throw e;
    }
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_players_pubkey ON players(pubkey_hex)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_players_session ON players(session_token)`);

  console.log('[Database] Schema initialized successfully');
}

/**
 * Save completed hand to database
 */
function saveHand(handData) {
  const insertHand = db.prepare(`
    INSERT INTO hands (
      hand_id, table_id, started_at, completed_at,
      small_blind, big_blind, button_seat, pot_total,
      rake, community_cards, hand_history
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertHandPlayer = db.prepare(`
    INSERT INTO hand_players (
      hand_id, user_id, username, seat_index,
      starting_stack, ending_stack, total_bet,
      hole_cards, final_hand, position, actions, won_amount
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const saveHandTx = db.transaction((data) => {
    insertHand.run(
      data.hand_id,
      data.table_id,
      data.started_at,
      data.completed_at,
      data.small_blind,
      data.big_blind,
      data.button_seat,
      data.pot_total,
      data.rake || 0,
      JSON.stringify(data.community_cards || []),
      data.hand_history
    );

    for (const player of data.players) {
      insertHandPlayer.run(
        data.hand_id,
        player.user_id,
        player.username,
        player.seat_index,
        player.starting_stack,
        player.ending_stack,
        player.total_bet,
        JSON.stringify(player.hole_cards || []),
        player.final_hand || null,
        player.position,
        JSON.stringify(player.actions || []),
        player.won_amount || 0
      );
    }
  });

  try {
    saveHandTx(handData);
    console.log(`[Database] Saved hand ${handData.hand_id}`);
    return { success: true };
  } catch (error) {
    console.error('[Database] Error saving hand:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Get or create player
 */
function upsertPlayer(userId, username) {
  const stmt = db.prepare(`
    INSERT INTO players (user_id, username)
    VALUES (?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      username = excluded.username,
      last_seen = strftime('%s','now')
    RETURNING *
  `);

  try {
    const player = stmt.get(userId, username);
    return player;
  } catch (error) {
    console.error('[Database] Error upserting player:', error);
    return null;
  }
}

/**
 * Update player stats after hand completion
 */
function updatePlayerStats(userId, stats) {
  const stmt = db.prepare(`
    UPDATE players SET
      hands_played = hands_played + ?,
      hands_won = hands_won + ?,
      total_winnings = total_winnings + ?,
      total_losses = total_losses + ?,
      current_chips = ?
    WHERE user_id = ?
  `);

  try {
    stmt.run(
      stats.hands_played || 0,
      stats.hands_won || 0,
      Math.max(0, stats.net_result || 0),
      Math.max(0, -(stats.net_result || 0)),
      stats.current_chips,
      userId
    );
    return { success: true };
  } catch (error) {
    console.error('[Database] Error updating player stats:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Save player's chip count and departure timestamp (anti-rathole tracking)
 */
function updatePlayerLeftAt(userId, chips) {
  const stmt = db.prepare(`
    UPDATE players SET
      current_chips = ?,
      left_at = strftime('%s','now')
    WHERE user_id = ?
  `);
  try {
    stmt.run(chips, userId);
  } catch (error) {
    console.error('[Database] Error updating player left_at:', error);
  }
}

/**
 * Get player stats
 */
function getPlayer(userId) {
  const stmt = db.prepare('SELECT * FROM players WHERE user_id = ?');
  return stmt.get(userId);
}

/**
 * Get hand history by hand ID
 */
function getHand(handId) {
  const stmt = db.prepare('SELECT * FROM hands WHERE hand_id = ?');
  return stmt.get(handId);
}

/**
 * Get player hand history (last N hands)
 */
function getPlayerHands(userId, limit = 50) {
  const stmt = db.prepare(`
    SELECT h.*
    FROM hands h
    JOIN hand_players hp ON h.hand_id = hp.hand_id
    WHERE hp.user_id = ?
    ORDER BY h.started_at DESC
    LIMIT ?
  `);
  return stmt.all(userId, limit);
}

/**
 * Get all tables
 */
function getTables() {
  const stmt = db.prepare('SELECT * FROM tables WHERE is_active = 1 ORDER BY created_at DESC');
  return stmt.all();
}

/**
 * Upsert table
 */
function upsertTable(tableId, name, smallBlind, bigBlind) {
  const stmt = db.prepare(`
    INSERT INTO tables (table_id, name, small_blind, big_blind)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(table_id) DO UPDATE SET
      name = excluded.name,
      small_blind = excluded.small_blind,
      big_blind = excluded.big_blind
    RETURNING *
  `);

  try {
    return stmt.get(tableId, name, smallBlind, bigBlind);
  } catch (error) {
    console.error('[Database] Error upserting table:', error);
    return null;
  }
}

/**
 * Update table player count
 */
function updateTablePlayerCount(tableId, count) {
  const stmt = db.prepare('UPDATE tables SET current_players = ? WHERE table_id = ?');
  stmt.run(count, tableId);
}

/**
 * Log action for abuse detection
 */
function logAction(userId, ipAddress, actionType) {
  const stmt = db.prepare(`
    INSERT INTO abuse_log (user_id, ip_address, action_type)
    VALUES (?, ?, ?)
  `);
  stmt.run(userId, ipAddress, actionType);
}

/**
 * Check if user/IP is rate-limited
 */
function isRateLimited(userId, ipAddress, windowSeconds = 10, maxActions = 10) {
  const stmt = db.prepare(`
    SELECT COUNT(*) as count
    FROM abuse_log
    WHERE (user_id = ? OR ip_address = ?)
      AND timestamp > strftime('%s','now') - ?
  `);

  const result = stmt.get(userId, ipAddress, windowSeconds);
  return result.count >= maxActions;
}

/**
 * Ban player
 */
function banPlayer(userId, reason) {
  const stmt = db.prepare('UPDATE players SET is_banned = 1, ban_reason = ? WHERE user_id = ?');
  stmt.run(reason, userId);
  console.log(`[Database] Banned player ${userId}: ${reason}`);
}

/**
 * Check if player is banned
 */
function isBanned(userId) {
  const stmt = db.prepare('SELECT is_banned FROM players WHERE user_id = ?');
  const result = stmt.get(userId);
  return result ? result.is_banned === 1 : false;
}

/**
 * Ban an IP address
 */
function banIp(ipAddress, reason, bannedBy = 'admin') {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO ip_bans (ip_address, reason, banned_by, banned_at)
    VALUES (?, ?, ?, strftime('%s','now'))
  `);
  stmt.run(ipAddress, reason, bannedBy);
  console.log(`[Database] Banned IP ${ipAddress}: ${reason}`);
}

/**
 * Check if IP address is banned
 */
function isIpBanned(ipAddress) {
  const stmt = db.prepare('SELECT ip_address FROM ip_bans WHERE ip_address = ?');
  const result = stmt.get(ipAddress);
  return result !== undefined;
}

/**
 * Unban an IP address
 */
function unbanIp(ipAddress) {
  const stmt = db.prepare('DELETE FROM ip_bans WHERE ip_address = ?');
  stmt.run(ipAddress);
  console.log(`[Database] Unbanned IP ${ipAddress}`);
}

/**
 * Get the most recent IP address for a userId
 */
function getPlayerIp(userId) {
  const stmt = db.prepare(`
    SELECT ip_address 
    FROM abuse_log 
    WHERE user_id = ? 
    ORDER BY timestamp DESC 
    LIMIT 1
  `);
  const result = stmt.get(userId);
  return result ? result.ip_address : null;
}

/**
 * Get all banned IPs
 */
function getBannedIps() {
  const stmt = db.prepare('SELECT * FROM ip_bans ORDER BY banned_at DESC');
  return stmt.all();
}

// ==================== NOSTR AUTH FUNCTIONS ====================

/**
 * Get player by hex pubkey
 */
function getPlayerByPubkey(pubkeyHex) {
  const stmt = db.prepare('SELECT * FROM players WHERE pubkey_hex = ?');
  return stmt.get(pubkeyHex);
}

/**
 * Create or update NOSTR-authenticated player.
 * Uses hex pubkey as user_id for consistency.
 */
function upsertNostrPlayer(pubkeyHex, npub, nostrName, nostrPicture) {
  const displayName = nostrName || npub.slice(0, 12) + '...' + npub.slice(-4);
  const stmt = db.prepare(`
    INSERT INTO players (user_id, username, pubkey_hex, npub, nostr_name, nostr_picture, auth_type)
    VALUES (?, ?, ?, ?, ?, ?, 'nostr')
    ON CONFLICT(user_id) DO UPDATE SET
      username = ?,
      npub = excluded.npub,
      nostr_name = COALESCE(excluded.nostr_name, nostr_name),
      nostr_picture = COALESCE(excluded.nostr_picture, nostr_picture),
      auth_type = 'nostr',
      last_seen = strftime('%s','now')
    RETURNING *
  `);
  try {
    return stmt.get(pubkeyHex, displayName, pubkeyHex, npub, nostrName, nostrPicture, displayName);
  } catch (error) {
    console.error('[Database] Error upserting NOSTR player:', error);
    return null;
  }
}

/**
 * Store a NOSTR auth challenge nonce
 */
function createChallenge(challengeId, nonce, expiresAt) {
  const stmt = db.prepare(`
    INSERT INTO nostr_challenges (challenge_id, nonce, expires_at)
    VALUES (?, ?, ?)
  `);
  stmt.run(challengeId, nonce, expiresAt);
}

/**
 * Get and validate a challenge. Returns null if expired or already used.
 */
function getAndUseChallenge(challengeId) {
  const now = Math.floor(Date.now() / 1000);
  const stmt = db.prepare(`
    SELECT * FROM nostr_challenges
    WHERE challenge_id = ? AND used = 0 AND expires_at > ?
  `);
  const challenge = stmt.get(challengeId, now);
  if (!challenge) return null;

  // Mark as used immediately (prevent replay)
  db.prepare('UPDATE nostr_challenges SET used = 1 WHERE challenge_id = ?').run(challengeId);
  return challenge;
}

/**
 * Set session token for a player
 */
function setSessionToken(userId, token, expiresAt) {
  const stmt = db.prepare(`
    UPDATE players SET session_token = ?, session_expires = ? WHERE user_id = ?
  `);
  stmt.run(token, expiresAt, userId);
}

/**
 * Get player by session token. Returns null if expired.
 */
function getPlayerBySession(token) {
  if (!token) return null;
  const now = Math.floor(Date.now() / 1000);
  const stmt = db.prepare(`
    SELECT * FROM players
    WHERE session_token = ? AND session_expires > ?
  `);
  return stmt.get(token, now);
}

/**
 * Clean up expired challenges
 */
function cleanupExpiredChallenges() {
  const now = Math.floor(Date.now() / 1000);
  const stmt = db.prepare('DELETE FROM nostr_challenges WHERE expires_at < ?');
  const result = stmt.run(now);
  if (result.changes > 0) {
    console.log(`[Database] Cleaned up ${result.changes} expired NOSTR challenges`);
  }
}

/**
 * Clean up old abuse log entries (older than 24 hours)
 */
function cleanupAbuseLog() {
  const stmt = db.prepare(`
    DELETE FROM abuse_log
    WHERE timestamp < strftime('%s','now') - 86400
  `);
  const result = stmt.run();
  if (result.changes > 0) {
    console.log(`[Database] Cleaned up ${result.changes} old abuse log entries`);
  }
}

// Initialize on module load
initDatabase();

// Cleanup abuse log and expired challenges every hour
setInterval(() => {
  cleanupAbuseLog();
  cleanupExpiredChallenges();
}, 3600000);

module.exports = {
  db,
  saveHand,
  upsertPlayer,
  updatePlayerStats,
  updatePlayerLeftAt,
  getPlayer,
  getHand,
  getPlayerHands,
  getTables,
  upsertTable,
  updateTablePlayerCount,
  logAction,
  isRateLimited,
  banPlayer,
  isBanned,
  banIp,
  isIpBanned,
  unbanIp,
  getPlayerIp,
  getBannedIps,
  cleanupAbuseLog,
  // NOSTR auth
  getPlayerByPubkey,
  upsertNostrPlayer,
  createChallenge,
  getAndUseChallenge,
  setSessionToken,
  getPlayerBySession,
  cleanupExpiredChallenges,
};
