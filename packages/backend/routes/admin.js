/**
 * Admin API endpoints — all protected by adminAuth middleware.
 * Ban/unban, player management, abuse logs, table inspection.
 */

const { Router } = require('express');
const crypto = require('crypto');
const config = require('../config');
const db = require('../database');
const { validateBody, schemas } = require('../middleware/validate');

const router = Router();

// Per-IP rate limit applied before auth, so failed attempts count toward the
// cap. Caps brute-force speed on ADMIN_TOKEN to maxRequests/windowSec.
const adminRateLimits = new Map(); // ip -> [timestamps]

function isAdminRateLimited(ip) {
  const { maxRequests, windowSec } = config.ADMIN_RATE_LIMIT;
  const now = Date.now();
  const cutoff = now - windowSec * 1000;
  let timestamps = adminRateLimits.get(ip) || [];
  timestamps = timestamps.filter(t => t > cutoff);
  if (timestamps.length >= maxRequests) {
    adminRateLimits.set(ip, timestamps);
    return true;
  }
  timestamps.push(now);
  adminRateLimits.set(ip, timestamps);
  return false;
}

const adminRateCleanup = setInterval(() => {
  const cutoff = Date.now() - 120000;
  for (const [ip, ts] of adminRateLimits) {
    if (ts.every(t => t < cutoff)) adminRateLimits.delete(ip);
  }
}, 300000);
adminRateCleanup.unref();

router.use((req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  if (isAdminRateLimited(ip)) {
    return res.status(429).json({ success: false, error: 'Too many requests' });
  }
  next();
});

// Admin auth middleware — timing-safe token comparison
router.use((req, res, next) => {
  const token = req.headers['x-admin-token'] || '';
  const expected = Buffer.from(config.ADMIN_TOKEN);
  const received = Buffer.from(String(token));
  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  next();
});

/**
 * POST /api/admin/ban — ban a player (optionally also ban their IP)
 */
router.post('/ban', validateBody(schemas.adminBan), (req, res) => {
  try {
    const { userId, reason, banIp: shouldBanIp } = req.body;

    db.banPlayer(userId, reason);

    if (shouldBanIp !== false) {
      const playerIp = db.getPlayerIp(userId);
      if (playerIp) {
        db.banIp(playerIp, reason, 'admin');
        console.log(`[API] Also banned IP ${playerIp} for user ${userId}`);
      }
    }

    res.json({
      success: true,
      message: `Player ${userId} banned` + (shouldBanIp !== false ? ' (including IP)' : '')
    });
  } catch (error) {
    console.error('[API] Error banning player:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/admin/unban — unban a player
 */
router.post('/unban', validateBody(schemas.adminUnban), (req, res) => {
  try {
    const { userId } = req.body;
    db.db.prepare('UPDATE players SET is_banned = 0, ban_reason = NULL WHERE user_id = ?').run(userId);
    res.json({ success: true, message: `Player ${userId} unbanned` });
  } catch (error) {
    console.error('[API] Error unbanning player:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/admin/abuse-log — recent abuse log entries
 */
router.get('/abuse-log', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const logs = db.db.prepare('SELECT * FROM abuse_log ORDER BY timestamp DESC LIMIT ?').all(limit);
    res.json(logs);
  } catch (error) {
    console.error('[API] Error fetching abuse log:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/admin/players — all players with stats
 */
router.get('/players', (req, res) => {
  try {
    const players = db.db.prepare(`
      SELECT user_id, username, hands_played, hands_won, is_banned as banned, created_at
      FROM players ORDER BY hands_played DESC
    `).all();
    res.json(players);
  } catch (error) {
    console.error('[API] Error fetching players:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/admin/tables — active tables with game state
 * Receives `games` Map via setup function
 */
let gamesRef = null;
router.setGames = (games) => { gamesRef = games; };

router.get('/tables', (req, res) => {
  try {
    const activeTables = [];
    if (gamesRef) {
      for (const [tableId, game] of gamesRef.entries()) {
        activeTables.push({
          id: tableId,
          players: game.players.filter(p => p).map(p => ({
            userId: p.userId,
            username: p.username,
            stack: p.stack,
            sittingOut: p.sittingOut || false
          })),
          handInProgress: game.handInProgress,
          pot: game.pot,
          phase: game.phase
        });
      }
    }
    res.json(activeTables);
  } catch (error) {
    console.error('[API] Error fetching active tables:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/admin/ban-ip — ban an IP address directly
 */
router.post('/ban-ip', validateBody(schemas.adminBanIp), (req, res) => {
  try {
    const { ipAddress, reason } = req.body;
    db.banIp(ipAddress, reason, 'admin');
    res.json({ success: true, message: `IP ${ipAddress} banned` });
  } catch (error) {
    console.error('[API] Error banning IP:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/admin/unban-ip — unban an IP address
 */
router.post('/unban-ip', validateBody(schemas.adminUnbanIp), (req, res) => {
  try {
    const { ipAddress } = req.body;
    db.unbanIp(ipAddress);
    res.json({ success: true, message: `IP ${ipAddress} unbanned` });
  } catch (error) {
    console.error('[API] Error unbanning IP:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/admin/ip-bans — all banned IPs
 */
router.get('/ip-bans', (req, res) => {
  try {
    const bans = db.getBannedIps();
    res.json(bans);
  } catch (error) {
    console.error('[API] Error fetching IP bans:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
