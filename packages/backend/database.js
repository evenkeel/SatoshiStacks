/**
 * Database Layer for SatoshiStacks
 * SQLite database for hand history, player stats, and table state
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Create db directory if it doesn't exist
const dbDir = path.join(__dirname, 'db');
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const dbPath = path.join(dbDir, 'satoshistacks.db');
const isdev = process.env.NODE_ENV !== 'production';
const db = new Database(dbPath, isdev ? { verbose: console.log } : {});

// Enable foreign keys and WAL mode for better concurrent read/write performance
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');

// In-memory badge cache to avoid DB queries on every game state broadcast
const badgeCache = new Map(); // userId -> { badges: [...], cachedAt: timestamp }
const BADGE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

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

  // Badge awards table (NIP-58)
  db.exec(`
    CREATE TABLE IF NOT EXISTS badge_awards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      badge_id TEXT NOT NULL,
      awarded_at INTEGER DEFAULT (strftime('%s','now')),
      nostr_event_id TEXT,
      UNIQUE(user_id, badge_id)
    );
    CREATE INDEX IF NOT EXISTS idx_badge_awards_user ON badge_awards(user_id);
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
    `ALTER TABLE players ADD COLUMN lud16 TEXT`,
  ];
  for (const sql of migrations) {
    try { db.exec(sql); } catch (e) {
      if (!e.message.includes('duplicate column')) throw e;
    }
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_players_pubkey ON players(pubkey_hex)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_players_session ON players(session_token)`);

  // Hand snapshots table (crash recovery — stores in-progress hand state)
  db.exec(`
    CREATE TABLE IF NOT EXISTS hand_snapshots (
      table_id TEXT PRIMARY KEY,
      hand_id TEXT NOT NULL,
      snapshot TEXT NOT NULL,
      updated_at INTEGER DEFAULT (strftime('%s','now'))
    );
  `);

  // Migration: Add chip_version for optimistic locking
  try {
    db.exec(`ALTER TABLE players ADD COLUMN chip_version INTEGER DEFAULT 0`);
    console.log('[Database] Added chip_version column to players table');
  } catch (e) {
    if (!e.message.includes('duplicate column')) throw e;
  }

  // Migration: Add nostr_event_id to hands table (signed hand history reference)
  try {
    db.exec(`ALTER TABLE hands ADD COLUMN nostr_event_id TEXT`);
    console.log('[Database] Added nostr_event_id column to hands table');
  } catch (e) {
    if (!e.message.includes('duplicate column')) throw e;
  }

  // Stake interest list (gauge demand for higher-stakes tables)
  db.exec(`
    CREATE TABLE IF NOT EXISTS stake_interests (
      user_id TEXT NOT NULL,
      stake_level TEXT NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      PRIMARY KEY(user_id, stake_level)
    );
  `);

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
function upsertNostrPlayer(pubkeyHex, npub, nostrName, nostrPicture, lud16) {
  const displayName = nostrName || npub.slice(0, 8) + '...' + npub.slice(-3);
  const stmt = db.prepare(`
    INSERT INTO players (user_id, username, pubkey_hex, npub, nostr_name, nostr_picture, lud16, auth_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'nostr')
    ON CONFLICT(user_id) DO UPDATE SET
      username = ?,
      npub = excluded.npub,
      nostr_name = COALESCE(excluded.nostr_name, nostr_name),
      nostr_picture = COALESCE(excluded.nostr_picture, nostr_picture),
      lud16 = COALESCE(excluded.lud16, lud16),
      auth_type = 'nostr',
      last_seen = strftime('%s','now')
    RETURNING *
  `);
  try {
    return stmt.get(pubkeyHex, displayName, pubkeyHex, npub, nostrName, nostrPicture, lud16 || null, displayName);
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
  const hashedToken = crypto.createHash('sha256').update(token).digest('hex');
  const stmt = db.prepare(`
    UPDATE players SET session_token = ?, session_expires = ? WHERE user_id = ?
  `);
  stmt.run(hashedToken, expiresAt, userId);
}

/**
 * Get player by session token. Returns null if expired.
 */
function getPlayerBySession(token) {
  if (!token) return null;
  const hashedToken = crypto.createHash('sha256').update(token).digest('hex');
  const now = Math.floor(Date.now() / 1000);
  const stmt = db.prepare(`
    SELECT * FROM players
    WHERE session_token = ? AND session_expires > ?
  `);
  return stmt.get(hashedToken, now);
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

// ==================== BADGE FUNCTIONS (NIP-58) ====================

/**
 * Award a badge to a player. Returns true if newly awarded, false if already had it.
 */
function awardBadge(userId, badgeId, nostrEventId) {
  try {
    const stmt = db.prepare(`
      INSERT INTO badge_awards (user_id, badge_id, nostr_event_id)
      VALUES (?, ?, ?)
    `);
    stmt.run(userId, badgeId, nostrEventId || null);
    invalidateBadgeCache(userId);
    console.log(`[Database] Badge "${badgeId}" awarded to ${userId.slice(0, 8)}...`);
    return true;
  } catch (e) {
    if (e.message.includes('UNIQUE constraint')) return false; // Already has badge
    console.error('[Database] Error awarding badge:', e);
    return false;
  }
}

/**
 * Check if player already has a specific badge
 */
function hasBadge(userId, badgeId) {
  const stmt = db.prepare('SELECT id FROM badge_awards WHERE user_id = ? AND badge_id = ?');
  return stmt.get(userId, badgeId) !== undefined;
}

/**
 * Get all badges for a player (cached — avoids DB hit on every broadcast)
 */
function getPlayerBadges(userId) {
  const cached = badgeCache.get(userId);
  if (cached && (Date.now() - cached.cachedAt) < BADGE_CACHE_TTL) {
    return cached.badges;
  }

  const stmt = db.prepare('SELECT badge_id, awarded_at FROM badge_awards WHERE user_id = ? ORDER BY awarded_at');
  const badges = stmt.all(userId);
  badgeCache.set(userId, { badges, cachedAt: Date.now() });
  return badges;
}

/**
 * Invalidate the badge cache for a specific user (call after awarding a badge)
 */
function invalidateBadgeCache(userId) {
  badgeCache.delete(userId);
}

// ==================== HAND SNAPSHOT FUNCTIONS (Crash Recovery) ====================

/**
 * Save or update a hand snapshot for crash recovery.
 * UPSERT — one snapshot per table (only in-progress hand matters).
 */
function saveHandSnapshot(tableId, handId, snapshot) {
  const stmt = db.prepare(`
    INSERT INTO hand_snapshots (table_id, hand_id, snapshot, updated_at)
    VALUES (?, ?, ?, strftime('%s','now'))
    ON CONFLICT(table_id) DO UPDATE SET
      hand_id = excluded.hand_id,
      snapshot = excluded.snapshot,
      updated_at = strftime('%s','now')
  `);
  try {
    stmt.run(tableId, handId, JSON.stringify(snapshot));
  } catch (error) {
    console.error('[Database] Error saving hand snapshot:', error);
  }
}

/**
 * Get the latest hand snapshot for a table (for crash recovery).
 */
function getHandSnapshot(tableId) {
  const stmt = db.prepare('SELECT * FROM hand_snapshots WHERE table_id = ?');
  const row = stmt.get(tableId);
  if (row) {
    row.snapshot = JSON.parse(row.snapshot);
  }
  return row || null;
}

/**
 * Get all hand snapshots (for startup recovery).
 */
function getAllHandSnapshots() {
  const stmt = db.prepare('SELECT * FROM hand_snapshots');
  const rows = stmt.all();
  return rows.map(row => {
    row.snapshot = JSON.parse(row.snapshot);
    return row;
  });
}

/**
 * Delete hand snapshot after hand completes normally.
 */
function deleteHandSnapshot(tableId) {
  const stmt = db.prepare('DELETE FROM hand_snapshots WHERE table_id = ?');
  stmt.run(tableId);
}

// ==================== ATOMIC SETTLEMENT (Real-Money Safe) ====================

/**
 * Settle a completed hand atomically — single transaction wraps:
 *   1. Insert into hands table
 *   2. Insert into hand_players table (each participant)
 *   3. Update player stats + chip balances (with optimistic locking)
 *   4. Delete hand snapshot (cleanup)
 *
 * All-or-nothing: if anything fails, nothing is persisted.
 */
const settleHandTx = db.transaction((handData, playerUpdates) => {
  // 1. Insert hand record
  db.prepare(`
    INSERT INTO hands (
      hand_id, table_id, started_at, completed_at,
      small_blind, big_blind, button_seat, pot_total,
      rake, community_cards, hand_history
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    handData.hand_id,
    handData.table_id,
    handData.started_at,
    handData.completed_at,
    handData.small_blind,
    handData.big_blind,
    handData.button_seat,
    handData.pot_total,
    handData.rake || 0,
    JSON.stringify(handData.community_cards || []),
    handData.hand_history
  );

  // 2. Insert hand_players records
  const insertPlayer = db.prepare(`
    INSERT INTO hand_players (
      hand_id, user_id, username, seat_index,
      starting_stack, ending_stack, total_bet,
      hole_cards, final_hand, position, actions, won_amount
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const p of handData.players) {
    insertPlayer.run(
      handData.hand_id,
      p.user_id,
      p.username,
      p.seat_index,
      p.starting_stack,
      p.ending_stack,
      p.total_bet,
      JSON.stringify(p.hole_cards || []),
      p.final_hand || null,
      p.position,
      JSON.stringify(p.actions || []),
      p.won_amount || 0
    );
  }

  // 3. Update each player's stats and chip balance atomically
  const updateStats = db.prepare(`
    UPDATE players SET
      hands_played = hands_played + 1,
      hands_won = hands_won + ?,
      total_winnings = total_winnings + ?,
      total_losses = total_losses + ?,
      current_chips = ?,
      chip_version = chip_version + 1,
      last_seen = strftime('%s','now')
    WHERE user_id = ?
  `);

  for (const pu of playerUpdates) {
    // Ensure player exists
    db.prepare(`
      INSERT INTO players (user_id, username)
      VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        username = excluded.username,
        last_seen = strftime('%s','now')
    `).run(pu.user_id, pu.username);

    updateStats.run(
      pu.hands_won,
      Math.max(0, pu.net_result),       // winnings (positive part)
      Math.max(0, -pu.net_result),      // losses (negative part)
      pu.current_chips,
      pu.user_id
    );
  }

  // 4. Delete hand snapshot (hand completed successfully)
  db.prepare('DELETE FROM hand_snapshots WHERE table_id = ?').run(handData.table_id);
});

function settleHand(handData, playerUpdates) {
  try {
    settleHandTx(handData, playerUpdates);
    console.log(`[Database] Settled hand ${handData.hand_id} (atomic)`);
    return { success: true };
  } catch (error) {
    console.error('[Database] Error settling hand:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Update hand record with Nostr event ID after publishing.
 */
function updateHandNostrEventId(handId, eventId) {
  try {
    db.prepare('UPDATE hands SET nostr_event_id = ? WHERE hand_id = ?').run(eventId, handId);
  } catch (error) {
    console.error('[Database] Error updating nostr_event_id:', error);
  }
}

// ==================== STAKE INTEREST LIST ====================

const VALID_STAKE_LEVELS = ['250/500', '500/1000', '5000/10000'];

/**
 * Toggle a user's interest in a stake level (INSERT if absent, DELETE if present).
 * Returns { interested: boolean } indicating the new state.
 */
function toggleStakeInterest(userId, stakeLevel) {
  if (!VALID_STAKE_LEVELS.includes(stakeLevel)) {
    return { interested: false, error: 'Invalid stake level' };
  }
  const existing = db.prepare('SELECT 1 FROM stake_interests WHERE user_id = ? AND stake_level = ?').get(userId, stakeLevel);
  if (existing) {
    db.prepare('DELETE FROM stake_interests WHERE user_id = ? AND stake_level = ?').run(userId, stakeLevel);
    return { interested: false };
  } else {
    db.prepare('INSERT INTO stake_interests (user_id, stake_level) VALUES (?, ?)').run(userId, stakeLevel);
    return { interested: true };
  }
}

/**
 * Get counts of interested players per stake level.
 * Returns { '250/500': 3, '500/1000': 5, '5000/10000': 1 }
 */
function getStakeInterestCounts() {
  const rows = db.prepare('SELECT stake_level, COUNT(*) as count FROM stake_interests GROUP BY stake_level').all();
  const counts = {};
  for (const level of VALID_STAKE_LEVELS) {
    counts[level] = 0;
  }
  for (const row of rows) {
    counts[row.stake_level] = row.count;
  }
  return counts;
}

/**
 * Get the stake levels a specific user is interested in.
 * Returns array like ['250/500', '5000/10000']
 */
function getUserInterests(userId) {
  const rows = db.prepare('SELECT stake_level FROM stake_interests WHERE user_id = ?').all(userId);
  return rows.map(r => r.stake_level);
}

// Initialize on module load
initDatabase();

/**
 * Clean up expired session tokens (older than 24h expiry)
 */
function cleanupExpiredSessions() {
  const now = Math.floor(Date.now() / 1000);
  const stmt = db.prepare(`
    UPDATE players SET session_token = NULL, session_expires = NULL
    WHERE session_expires IS NOT NULL AND session_expires < ?
  `);
  const result = stmt.run(now);
  if (result.changes > 0) {
    console.log(`[Database] Cleaned up ${result.changes} expired session tokens`);
  }
}

// Cleanup abuse log, expired challenges, and expired sessions every hour
setInterval(() => {
  cleanupAbuseLog();
  cleanupExpiredChallenges();
  cleanupExpiredSessions();
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
  cleanupExpiredSessions,
  // Badges (NIP-58)
  awardBadge,
  hasBadge,
  getPlayerBadges,
  invalidateBadgeCache,
  // Crash recovery & atomic settlement
  saveHandSnapshot,
  getHandSnapshot,
  getAllHandSnapshots,
  deleteHandSnapshot,
  settleHand,
  updateHandNostrEventId,
  // Stake interest list
  toggleStakeInterest,
  getStakeInterestCounts,
  getUserInterests,
};
