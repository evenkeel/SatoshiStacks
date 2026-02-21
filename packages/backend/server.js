/**
 * WebSocket Server for SatoshiStacks Poker
 * Handles multiplayer connections and game state broadcasting
 */

require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { verifyEvent, finalizeEvent, getPublicKey } = require('nostr-tools/pure');
const { npubEncode, decode: nip19Decode } = require('nostr-tools/nip19');
const PokerGame = require('./poker-game');
const db = require('./database');

const app = express();
app.set('trust proxy', 1); // Trust first proxy (Nginx) for correct req.ip
const server = http.createServer(app);

const PORT = process.env.PORT || 3001;
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
if (!process.env.ADMIN_TOKEN) {
  console.error('FATAL: ADMIN_TOKEN environment variable is not set. Refusing to start with insecure admin access. Set ADMIN_TOKEN in your .env file.');
  process.exit(1);
}
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

// ==================== NOSTR SERVER IDENTITY ====================

let serverSk, serverPk;
if (process.env.NOSTR_SERVER_NSEC) {
  try {
    const { data: decoded } = nip19Decode(process.env.NOSTR_SERVER_NSEC);
    serverSk = decoded;
    serverPk = getPublicKey(serverSk);
    console.log(`[Nostr] Server identity loaded: ${serverPk.slice(0, 8)}...`);
  } catch (e) {
    console.error('[Nostr] Invalid NOSTR_SERVER_NSEC:', e.message);
  }
} else {
  console.log('[Nostr] No NOSTR_SERVER_NSEC set — badge/activity publishing disabled');
}

const io = new Server(server, {
  cors: {
    origin: CORS_ORIGIN === '*' ? '*' : CORS_ORIGIN.split(','),
    methods: ["GET", "POST"]
  }
});

// Game state
const games = new Map(); // tableId -> PokerGame instance
const userSockets = new Map(); // userId -> socket.id
const socketUsers = new Map(); // socket.id -> { userId, tableId, seatIndex }
const observerSockets = new Map(); // socket.id -> { observerName, tableId }

// Random observer name generation
const OBSERVER_ADJECTIVES = ['Curious', 'Lucky', 'Swift', 'Cosmic', 'Zen', 'Bold', 'Neon', 'Pixel', 'Lunar', 'Solar', 'Turbo', 'Ultra'];
const OBSERVER_NOUNS = ['Satoshi', 'Whale', 'Hodler', 'Degen', 'Ape', 'Llama', 'Fox', 'Wolf', 'Eagle', 'Panda', 'Tiger', 'Bear'];
function generateObserverName() {
  const adj = OBSERVER_ADJECTIVES[Math.floor(Math.random() * OBSERVER_ADJECTIVES.length)];
  const noun = OBSERVER_NOUNS[Math.floor(Math.random() * OBSERVER_NOUNS.length)];
  const num = Math.floor(Math.random() * 100);
  return `${adj}${noun}${num}`;
}

// Multi-table system (toggled OFF for now - focus on single Main Table)
// Future: Spawn table2, table3, etc. when waitlist ≥10
// Future: Consolidate to Main Table when possible (full tables priority)
const MULTI_TABLES_ENABLED = false;

// NIP-05: NOSTR identifier verification endpoint (must be before static middleware)
app.get('/.well-known/nostr.json', (req, res) => {
  const name = (req.query.name || '').toLowerCase().trim();

  // Static mapping of NIP-05 identifiers → hex pubkeys
  const identifiers = {
    'allen': '8a3a9236d0eae6bc92eb17782d57e828a01f03cd28d3c68297c7e19d374b9419'
  };

  // CORS required by NIP-05 spec
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');

  if (name && identifiers[name]) {
    res.json({ names: { [name]: identifiers[name] } });
  } else {
    // Return all identifiers if no name or unknown name
    res.json({ names: identifiers });
  }
});

// Serve static files (frontend)
app.use(express.static(path.join(__dirname, '../../packages/frontend')));

// Parse JSON bodies
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), tables: games.size });
});

// Admin auth middleware — protects all /api/admin routes
function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (token !== ADMIN_TOKEN) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  next();
}
app.use('/api/admin', adminAuth);

// ==================== QUERY API ENDPOINTS ====================

/**
 * GET /api/hands/:userId
 * Get hand history for a specific player
 */
app.get('/api/hands/:userId', (req, res) => {
  try {
    const { userId } = req.params;
    const limit = parseInt(req.query.limit) || 50;
    
    const hands = db.getPlayerHands(userId, limit);
    
    res.json({
      success: true,
      userId,
      count: hands.length,
      hands
    });
  } catch (error) {
    console.error('[API] Error fetching player hands:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/hand/:handId
 * Get details of a specific hand
 */
app.get('/api/hand/:handId', (req, res) => {
  try {
    const { handId } = req.params;
    const hand = db.getHand(handId);
    
    if (!hand) {
      return res.status(404).json({
        success: false,
        error: 'Hand not found'
      });
    }
    
    res.json({
      success: true,
      hand
    });
  } catch (error) {
    console.error('[API] Error fetching hand:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/player/:userId
 * Get player stats
 */
app.get('/api/player/:userId', (req, res) => {
  try {
    const { userId } = req.params;
    const player = db.getPlayer(userId);
    
    if (!player) {
      return res.status(404).json({
        success: false,
        error: 'Player not found'
      });
    }
    
    res.json({
      success: true,
      player
    });
  } catch (error) {
    console.error('[API] Error fetching player:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/tables
 * List all active tables
 */
app.get('/api/tables', (req, res) => {
  try {
    const tables = db.getTables();
    
    res.json({
      success: true,
      count: tables.length,
      tables
    });
  } catch (error) {
    console.error('[API] Error fetching tables:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/stats
 * Get overall database statistics
 */
app.get('/api/stats', (req, res) => {
  try {
    const stats = {
      totalHands: db.db.prepare('SELECT COUNT(*) as count FROM hands').get().count,
      totalPlayers: db.db.prepare('SELECT COUNT(*) as count FROM players').get().count,
      activeTables: db.db.prepare('SELECT COUNT(*) as count FROM tables WHERE is_active = 1').get().count
    };
    
    res.json({
      success: true,
      stats
    });
  } catch (error) {
    console.error('[API] Error fetching stats:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ==================== ADMIN ENDPOINTS ====================

/**
 * POST /api/admin/ban
 * Ban a player
 * Body: { userId, reason }
 */
app.post('/api/admin/ban', (req, res) => {
  try {
    const { userId, reason, banIp: shouldBanIp } = req.body;
    
    if (!userId || !reason) {
      return res.status(400).json({
        success: false,
        error: 'userId and reason required'
      });
    }
    
    // Ban the userId
    db.banPlayer(userId, reason);
    
    // Also ban their IP address (Phase 5.4B: IP-based enforcement)
    if (shouldBanIp !== false) { // Default to true
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
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/admin/abuse-log
 * Get recent abuse log entries
 */
app.get('/api/admin/abuse-log', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const logs = db.db.prepare(`
      SELECT * FROM abuse_log 
      ORDER BY timestamp DESC 
      LIMIT ?
    `).all(limit);
    
    res.json(logs); // Return array directly for admin dashboard
  } catch (error) {
    console.error('[API] Error fetching abuse log:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/admin/unban
 * Unban a player
 */
app.post('/api/admin/unban', (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({
        success: false,
        error: 'userId required'
      });
    }
    
    db.db.prepare('UPDATE players SET is_banned = 0, ban_reason = NULL WHERE user_id = ?').run(userId);
    
    res.json({
      success: true,
      message: `Player ${userId} unbanned`
    });
  } catch (error) {
    console.error('[API] Error unbanning player:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/admin/players
 * Get all players with stats
 */
app.get('/api/admin/players', (req, res) => {
  try {
    const players = db.db.prepare(`
      SELECT 
        user_id,
        username,
        hands_played,
        hands_won,
        is_banned as banned,
        created_at
      FROM players
      ORDER BY hands_played DESC
    `).all();
    
    res.json(players);
  } catch (error) {
    console.error('[API] Error fetching players:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/admin/tables
 * Get active tables with current game state
 */
app.get('/api/admin/tables', (req, res) => {
  try {
    const activeTables = [];
    
    for (const [tableId, game] of games.entries()) {
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
    
    res.json(activeTables);
  } catch (error) {
    console.error('[API] Error fetching active tables:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/admin/ban-ip
 * Ban an IP address directly
 */
app.post('/api/admin/ban-ip', (req, res) => {
  try {
    const { ipAddress, reason } = req.body;
    
    if (!ipAddress || !reason) {
      return res.status(400).json({
        success: false,
        error: 'ipAddress and reason required'
      });
    }
    
    db.banIp(ipAddress, reason, 'admin');
    
    res.json({
      success: true,
      message: `IP ${ipAddress} banned`
    });
  } catch (error) {
    console.error('[API] Error banning IP:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/admin/unban-ip
 * Unban an IP address
 */
app.post('/api/admin/unban-ip', (req, res) => {
  try {
    const { ipAddress } = req.body;
    
    if (!ipAddress) {
      return res.status(400).json({
        success: false,
        error: 'ipAddress required'
      });
    }
    
    db.unbanIp(ipAddress);
    
    res.json({
      success: true,
      message: `IP ${ipAddress} unbanned`
    });
  } catch (error) {
    console.error('[API] Error unbanning IP:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/admin/ip-bans
 * Get all banned IPs
 */
app.get('/api/admin/ip-bans', (req, res) => {
  try {
    const bans = db.getBannedIps();
    res.json(bans);
  } catch (error) {
    console.error('[API] Error fetching IP bans:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Serve admin dashboard
 */
app.get('/admin', (req, res) => {
  res.sendFile(__dirname + '/admin.html');
});

// ==================== NOSTR AUTH ENDPOINTS ====================

// Simple in-memory rate limiter for auth endpoints (IP -> timestamp[])
const authRateLimits = new Map();
function isAuthRateLimited(ip, maxRequests = 10, windowSec = 60) {
  const now = Date.now();
  const cutoff = now - windowSec * 1000;
  let timestamps = authRateLimits.get(ip) || [];
  timestamps = timestamps.filter(t => t > cutoff);
  if (timestamps.length >= maxRequests) {
    authRateLimits.set(ip, timestamps);
    return true;
  }
  timestamps.push(now);
  authRateLimits.set(ip, timestamps);
  return false;
}
// Clean up stale entries every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - 120000;
  for (const [ip, ts] of authRateLimits) {
    if (ts.every(t => t < cutoff)) authRateLimits.delete(ip);
  }
}, 300000);

/**
 * POST /api/auth/challenge
 * Generate a challenge nonce for NOSTR authentication.
 * Client must sign this nonce with their NOSTR key and return it to /api/auth/verify.
 */
app.post('/api/auth/challenge', (req, res) => {
  try {
    const clientIp = req.ip || req.connection.remoteAddress;
    if (isAuthRateLimited(clientIp)) {
      return res.status(429).json({ success: false, error: 'Too many requests. Try again shortly.' });
    }

    const challengeId = crypto.randomUUID();
    const nonce = crypto.randomBytes(32).toString('hex');
    const expiresAt = Math.floor(Date.now() / 1000) + 300; // 5 minutes

    db.createChallenge(challengeId, nonce, expiresAt);

    res.json({
      success: true,
      challengeId,
      nonce
    });
  } catch (error) {
    console.error('[Auth] Challenge generation error:', error);
    res.status(500).json({ success: false, error: 'Failed to generate challenge' });
  }
});

/**
 * POST /api/auth/verify
 * Verify a signed NOSTR event to authenticate the player.
 * Body: { challengeId, signedEvent }
 *
 * The signedEvent should be a kind 22242 event with the nonce in a tag.
 * Returns session token on success.
 */
app.post('/api/auth/verify', (req, res) => {
  try {
    const { challengeId, signedEvent } = req.body;

    if (!challengeId || !signedEvent) {
      return res.status(400).json({ success: false, error: 'challengeId and signedEvent required' });
    }

    // 1. Validate challenge exists, not expired, not used
    const challenge = db.getAndUseChallenge(challengeId);
    if (!challenge) {
      return res.status(401).json({ success: false, error: 'Invalid or expired challenge' });
    }

    // 2. Verify the signed event cryptographically
    if (!verifyEvent(signedEvent)) {
      return res.status(401).json({ success: false, error: 'Invalid event signature' });
    }

    // 3. Verify the event contains our nonce
    if (!Array.isArray(signedEvent.tags)) {
      return res.status(400).json({ success: false, error: 'Malformed event: tags must be an array' });
    }
    const nonceTag = signedEvent.tags.find(t => Array.isArray(t) && t[0] === 'challenge' && t[1] === challenge.nonce);
    if (!nonceTag) {
      return res.status(401).json({ success: false, error: 'Challenge nonce mismatch' });
    }

    // 4. Verify event is recent (within 5 minutes)
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - signedEvent.created_at) > 300) {
      return res.status(401).json({ success: false, error: 'Event timestamp too old' });
    }

    // 5. Verify event kind is 22242 (auth)
    if (signedEvent.kind !== 22242) {
      return res.status(401).json({ success: false, error: 'Invalid event kind' });
    }

    // Auth passed — create session
    const pubkeyHex = signedEvent.pubkey;
    const npub = npubEncode(pubkeyHex);

    // Extract profile info from event content if provided
    let nostrName = null;
    let nostrPicture = null;
    try {
      if (signedEvent.content) {
        const profile = JSON.parse(signedEvent.content);
        nostrName = profile.name || profile.display_name || null;
        nostrPicture = profile.picture || null;
      }
    } catch (e) {
      // Content isn't JSON profile data — that's fine
    }

    // Upsert player in DB (with whatever we have so far)
    db.upsertNostrPlayer(pubkeyHex, npub, nostrName, nostrPicture);

    // Generate session token (24h expiry)
    const sessionToken = crypto.randomBytes(32).toString('hex');
    const sessionExpires = Math.floor(Date.now() / 1000) + 86400; // 24 hours
    db.setSessionToken(pubkeyHex, sessionToken, sessionExpires);

    // Load player data for response
    let player = db.getPlayerByPubkey(pubkeyHex);

    console.log(`[Auth] NOSTR login: ${nostrName || npub.slice(0, 12) + '...'} (${pubkeyHex.slice(0, 8)}...)`);

    // Respond immediately, then fetch relay profile in background
    res.json({
      success: true,
      sessionToken,
      pubkeyHex,
      npub,
      profile: {
        name: player.nostr_name || player.username,
        picture: player.nostr_picture,
        lud16: player.lud16 || null,
        chips: player.current_chips
      }
    });

    // Background: fetch kind 0 profile from relays (non-blocking)
    fetchNostrProfile(pubkeyHex).catch(err => {
      console.log(`[Auth] Relay profile fetch failed for ${pubkeyHex.slice(0, 8)}...: ${err.message}`);
    });
  } catch (error) {
    console.error('[Auth] Verify error:', error);
    res.status(500).json({ success: false, error: 'Authentication failed' });
  }
});

/**
 * GET /api/auth/session
 * Validate an existing session token. Used by frontend on page load to restore session.
 * Header: x-session-token
 */
app.get('/api/auth/session', (req, res) => {
  try {
    const token = req.headers['x-session-token'];
    if (!token) {
      return res.status(401).json({ success: false, error: 'No session token' });
    }

    const player = db.getPlayerBySession(token);
    if (!player) {
      return res.status(401).json({ success: false, error: 'Invalid or expired session' });
    }

    res.json({
      success: true,
      pubkeyHex: player.pubkey_hex,
      npub: player.npub,
      profile: {
        name: player.nostr_name || player.username,
        picture: player.nostr_picture,
        lud16: player.lud16 || null,
        chips: player.current_chips
      }
    });
  } catch (error) {
    console.error('[Auth] Session check error:', error);
    res.status(500).json({ success: false, error: 'Session check failed' });
  }
});

// ==================== RELAY PROFILE FETCH ====================

const RELAYS = [
  'wss://relay.damus.io',
  'wss://relay.nostr.band',
  'wss://nos.lol',
  'wss://relay.primal.net'
];

/**
 * Publish a signed Nostr event to all relays.
 * Non-blocking, best-effort delivery.
 */
async function publishToRelays(event) {
  const WebSocket = (await import('ws')).default;
  let published = 0;
  for (const url of RELAYS) {
    try {
      const ws = new WebSocket(url);
      ws.on('open', () => {
        ws.send(JSON.stringify(['EVENT', event]));
        published++;
      });
      ws.on('error', () => {});
      setTimeout(() => { try { ws.close(); } catch (e) {} }, 3000);
    } catch (e) { /* ignore relay errors */ }
  }
  return published;
}

// ==================== NIP-58 BADGE SYSTEM ====================

const BADGE_DEFINITIONS = [
  { id: 'card-player', name: 'Card Player', description: 'Played 1000 hands on SatoshiStacks', icon: '🃏', d_tag: 'card-player' },
  { id: 'royal-flush', name: 'Royal Flush', description: 'Hit a Royal Flush on SatoshiStacks', icon: '👑', d_tag: 'royal-flush' }
];

/**
 * Check badge eligibility and award if earned.
 * Called after each hand by poker-game.js via onBadgeCheck callback.
 */
function checkAndAwardBadges(userId, stats) {
  if (!serverSk) return; // Can't publish without server key

  const checks = [
    { badgeId: 'card-player', condition: stats.handsPlayed >= 1000 },
    { badgeId: 'royal-flush', condition: stats.handName && stats.handName.toLowerCase().includes('royal flush') }
  ];

  for (const { badgeId, condition } of checks) {
    if (!condition) continue;
    if (db.hasBadge(userId, badgeId)) continue;

    const badge = BADGE_DEFINITIONS.find(b => b.id === badgeId);
    if (!badge) continue;

    try {
      // Publish kind 8 badge award event to relays
      const awardEvent = finalizeEvent({
        kind: 8,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['a', `30009:${serverPk}:${badge.d_tag}`],
          ['p', userId]
        ],
        content: ''
      }, serverSk);

      publishToRelays(awardEvent);

      // Store in DB
      db.awardBadge(userId, badgeId, awardEvent.id);

      console.log(`[Nostr] Badge "${badge.name}" ${badge.icon} awarded to ${userId.slice(0, 8)}...`);

      // Notify player via socket
      const socketId = userSockets.get(userId);
      if (socketId) {
        io.to(socketId).emit('badge-awarded', {
          badgeId: badge.id,
          badgeName: badge.name,
          badgeIcon: badge.icon
        });
      }

      // Broadcast updated game state so nameplates show the badge
      for (const [tableId, game] of games) {
        if (game.players.some(p => p && p.userId === userId)) {
          broadcastGameState(tableId);
        }
      }
    } catch (e) {
      console.error(`[Nostr] Failed to award badge "${badgeId}":`, e.message);
    }
  }
}

// ==================== NIP-53 LIVE ACTIVITIES ====================

const liveActivityTimers = new Map(); // tableId -> setTimeout id

/**
 * Publish/update a kind 30311 Live Activity event for a table.
 * Debounced to avoid spamming relays on rapid join/leave.
 */
function scheduleLiveActivityUpdate(tableId, immediate = false) {
  if (!serverSk) return;

  if (liveActivityTimers.has(tableId)) {
    clearTimeout(liveActivityTimers.get(tableId));
  }

  const delay = immediate ? 0 : 10000; // 10s debounce unless immediate
  const timer = setTimeout(() => {
    liveActivityTimers.delete(tableId);
    publishLiveActivity(tableId);
  }, delay);

  liveActivityTimers.set(tableId, timer);
}

function publishLiveActivity(tableId) {
  if (!serverSk) return;

  const game = games.get(tableId);
  const seatedPlayers = game ? game.players.filter(p => p !== null) : [];
  const isLive = seatedPlayers.length > 0;

  try {
    const tags = [
      ['d', `satoshistacks-table-${tableId}`],
      ['title', `SatoshiStacks Poker - Table ${tableId}`],
      ['summary', isLive ? `${seatedPlayers.length} player${seatedPlayers.length !== 1 ? 's' : ''} • 25/50 blinds` : 'Table empty'],
      ['streaming', 'https://satoshistacks.com'],
      ['status', isLive ? 'live' : 'ended'],
      ['t', 'poker'],
      ['t', 'nostr'],
      ['t', 'bitcoin']
    ];

    // Add p tags for each seated player
    for (const p of seatedPlayers) {
      tags.push(['p', p.userId]);
    }

    const activityEvent = finalizeEvent({
      kind: 30311,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: ''
    }, serverSk);

    publishToRelays(activityEvent);
    console.log(`[Nostr] Published live activity: table ${tableId} - ${isLive ? seatedPlayers.length + ' players' : 'ended'}`);
  } catch (e) {
    console.error(`[Nostr] Failed to publish live activity for ${tableId}:`, e.message);
  }
}

/**
 * Fetch kind 0 (profile metadata) from NOSTR relays.
 * Updates DB with display name and picture if found.
 * Non-blocking — called after auth response is sent.
 */
async function fetchNostrProfile(pubkeyHex) {
  const WebSocket = (await import('ws')).default;

  return new Promise((resolve, reject) => {
    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        reject(new Error('Relay timeout'));
      }
    }, 5000);

    // Try relays in parallel, use first valid response
    let attempts = 0;

    for (const relayUrl of RELAYS) {
      try {
        const ws = new WebSocket(relayUrl);
        const subId = crypto.randomBytes(8).toString('hex');

        ws.on('open', () => {
          // Request kind 0 for this pubkey
          ws.send(JSON.stringify(['REQ', subId, { kinds: [0], authors: [pubkeyHex], limit: 1 }]));
        });

        ws.on('message', (data) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg[0] === 'EVENT' && msg[2] && msg[2].kind === 0) {
              const profile = JSON.parse(msg[2].content);
              const name = profile.display_name || profile.name || null;
              const picture = profile.picture || null;
              const lud16 = profile.lud16 || null;

              if (name && !resolved) {
                resolved = true;
                clearTimeout(timeout);

                // Update DB with relay profile (including lud16 Lightning address)
                db.upsertNostrPlayer(pubkeyHex, npubEncode(pubkeyHex), name, picture, lud16);
                console.log(`[Auth] Relay profile fetched: ${name} (${pubkeyHex.slice(0, 8)}...)${lud16 ? ` lud16: ${lud16}` : ''}`);

                // Update in-memory game state if player is seated, and broadcast
                for (const [tableId, game] of games) {
                  const player = game.players.find(p => p && p.userId === pubkeyHex);
                  if (player) {
                    player.username = name;
                    player.nostrName = name;
                    player.nostrPicture = picture;
                    player.lud16 = lud16;
                    broadcastGameState(tableId);
                  }
                }

                // Also notify the player's socket directly with updated profile
                const socketId = userSockets.get(pubkeyHex);
                if (socketId) {
                  io.to(socketId).emit('profile-updated', { name, picture, lud16 });
                }

                resolve({ name, picture, lud16 });
              }
            }
          } catch (e) { /* ignore parse errors */ }
        });

        ws.on('error', () => { /* ignore relay errors */ });

        // Close socket after 4 seconds regardless
        setTimeout(() => {
          try { ws.close(); } catch (e) {}
          attempts++;
          if (attempts >= RELAYS.length && !resolved) {
            resolved = true;
            clearTimeout(timeout);
            reject(new Error('No profile found on any relay'));
          }
        }, 4000);

      } catch (e) {
        attempts++;
      }
    }
  });
}

// ==================== WEBSOCKET ====================

/**
 * Ensure a game instance exists for the given tableId.
 * Creates one with all callbacks if it doesn't exist yet.
 */
function ensureGameExists(tableId) {
  if (games.has(tableId)) return;

  const game = new PokerGame(tableId);

  game.onStateChange = () => {
    console.log(`[Server] Broadcasting state for table ${tableId}`);
    broadcastGameState(tableId);
  };

  game.onTimerStart = (playerIndex, baseMs, timeBankInfo) => {
    io.to(`table-${tableId}`).emit('action-timer-start', {
      playerIndex,
      timeoutMs: baseMs,
      timeBankMs: timeBankInfo ? timeBankInfo.timeBankMs : 0,
      isPreflop: timeBankInfo ? timeBankInfo.isPreflop : true
    });
  };

  game.onTimeBankStart = (playerIndex, timeBankMs) => {
    io.to(`table-${tableId}`).emit('time-bank-start', {
      playerIndex,
      timeBankMs
    });
  };

  game.onHandLog = (line, type) => {
    io.to(`table-${tableId}`).emit('hand-log', { line, type });
  };

  game.onDealCards = (userId, line) => {
    const socketId = userSockets.get(userId);
    if (socketId) {
      io.to(socketId).emit('hand-log', { line, type: 'deal' });
    }
  };

  game.onHandComplete = (userId, historyText) => {
    const socketId = userSockets.get(userId);
    if (socketId) {
      io.to(socketId).emit('hand-complete', { history: historyText });
    }
  };

  game.onPlayerLeaving = (userId, stack) => {
    try {
      db.updatePlayerLeftAt(userId, stack);
      console.log(`[Server] Saved departure: ${userId.slice(0, 8)}... with ${stack} chips`);
    } catch (err) {
      console.error(`[Server] Failed to save departure for ${userId}:`, err.message);
    }
  };

  game.onRebuy = (userId, chips) => {
    try {
      db.db.prepare('UPDATE players SET current_chips = ? WHERE user_id = ?').run(chips, userId);
      console.log(`[Server] Auto-rebuy persisted: ${userId.slice(0, 8)}... → ${chips} chips`);
    } catch (err) {
      console.error(`[Server] Failed to persist rebuy for ${userId}:`, err.message);
    }
  };

  game.onTableMaybeEmpty = () => {
    if (game.players.every(p => p === null)) {
      games.delete(tableId);
      console.log(`Table ${tableId} destroyed (empty after auto-kick)`);
      // NIP-53: Publish "ended" live activity when table empties
      scheduleLiveActivityUpdate(tableId, true);
    }
  };

  // NIP-58: Badge check callback after each hand
  game.onBadgeCheck = (userId, stats) => {
    checkAndAwardBadges(userId, stats);
  };

  games.set(tableId, game);
  console.log(`[Server] Created game for table ${tableId}`);
}

// WebSocket connection handling
io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);

  /**
   * Observe table — no auth required.
   * Client sends: { tableId }
   * Server assigns a random observer name and sends game state.
   */
  socket.on('observe-table', ({ tableId }) => {
    const observerName = generateObserverName();
    observerSockets.set(socket.id, { observerName, tableId });
    socket.join(`table-${tableId}`);
    console.log(`Observer ${observerName} (${socket.id}) watching table ${tableId}`);

    socket.emit('observer-joined', { observerName });

    // Create game if it doesn't exist yet (so observers see empty seats)
    ensureGameExists(tableId);

    // Send current game state (observer view — no private cards)
    const game = games.get(tableId);
    if (game) {
      socket.emit('game-state', game.getGameState(null));
    }
  });

  /**
   * Chat message — works for both players and observers.
   * Client sends: { text }
   */
  socket.on('chat-message', ({ text }) => {
    if (!text || typeof text !== 'string') return;
    const trimmed = text.trim().slice(0, 120);
    if (!trimmed) return;

    // Determine sender name and table
    const user = socketUsers.get(socket.id);
    const observer = observerSockets.get(socket.id);

    let senderName, tableId;
    if (user) {
      const game = games.get(user.tableId);
      const player = game?.players?.find(p => p && p.userId === user.userId);
      senderName = player?.nostrName || player?.username || 'Unknown';
      tableId = user.tableId;
    } else if (observer) {
      senderName = observer.observerName;
      tableId = observer.tableId;
    } else {
      return; // Not connected to any table
    }

    // Broadcast to all in the table room (players + observers)
    io.to(`table-${tableId}`).emit('chat-message', {
      sender: senderName,
      senderId: user ? user.userId : null, // pubkey hex for mute filtering (NIP-51)
      text: trimmed,
      isObserver: !!observer,
      timestamp: Date.now()
    });
  });

  /**
   * Join table
   * Client sends: { tableId, sessionToken, preferredSeat?, buyIn? }
   * Server validates session, loads persistent chips, assigns seat
   */
  socket.on('join-table', ({ tableId: requestedTableId, sessionToken, preferredSeat, buyIn }) => {
    // Enforce single-table mode: ignore client tableId when multi-table is disabled
    const tableId = MULTI_TABLES_ENABLED ? (requestedTableId || 'table-1') : 'table-1';
    try {
      // 1. Validate session token
      if (!sessionToken) {
        socket.emit('error', { message: 'Authentication required' });
        return;
      }

      const playerData = db.getPlayerBySession(sessionToken);
      if (!playerData) {
        socket.emit('auth-error', { message: 'Session expired. Please log in again.' });
        return;
      }

      const userId = playerData.pubkey_hex;
      const displayName = playerData.nostr_name || playerData.username;
      const nostrName = playerData.nostr_name;
      const nostrPicture = playerData.nostr_picture;

      // Rate limiting & anti-abuse
      const clientIp = socket.handshake.address;

      // Check if IP is banned
      if (db.isIpBanned(clientIp)) {
        socket.emit('error', { message: 'Your IP address is banned from this site' });
        console.log(`[Server] Blocked banned IP: ${clientIp}`);
        return;
      }

      // Check if player is banned
      if (db.isBanned(userId)) {
        socket.emit('error', { message: 'Player is banned' });
        return;
      }

      // Check rate limit
      if (db.isRateLimited(userId, clientIp, 10, 10)) {
        socket.emit('error', { message: 'Too many actions. Please wait.' });
        db.logAction(userId, clientIp, 'rate-limited');
        return;
      }

      // Log action for abuse detection
      db.logAction(userId, clientIp, 'join-table');

      // 2. Determine buy-in amount with anti-rathole rules
      const MIN_BUYIN = 2000;
      const MAX_BUYIN = 10000;
      const RATHOLE_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 hours
      let requestedBuyIn = typeof buyIn === 'number' ? Math.max(MIN_BUYIN, Math.min(MAX_BUYIN, Math.floor(buyIn))) : MAX_BUYIN;

      let chips;
      if (playerData.left_at && (Date.now() - playerData.left_at * 1000) < RATHOLE_WINDOW_MS && playerData.current_chips > 0) {
        // Within 2hr anti-rathole window: must sit with at least old stack
        chips = Math.max(requestedBuyIn, playerData.current_chips);
        console.log(`[Server] Anti-rathole: ${displayName} returning within 2hr with ${chips} chips (requested ${requestedBuyIn}, left with ${playerData.current_chips})`);
      } else {
        // Fresh start or busted — use requested buy-in
        chips = requestedBuyIn;
        console.log(`[Server] ${displayName} buying in for ${chips} playsats`);
      }
      db.db.prepare('UPDATE players SET current_chips = ? WHERE user_id = ?').run(chips, userId);

      // Clean up observer tracking if this socket was observing
      if (observerSockets.has(socket.id)) {
        observerSockets.delete(socket.id);
      }

      // 3. Handle reconnection — if player already seated at this table, swap socket
      const game0 = games.get(tableId);
      if (game0) {
        const existingSeatIdx = game0.players.findIndex(p => p && p.userId === userId);
        if (existingSeatIdx !== -1) {
          // Player is already in the game — this is a reconnection
          const oldSocketId = userSockets.get(userId);
          if (oldSocketId && oldSocketId !== socket.id) {
            socketUsers.delete(oldSocketId); // clean up stale entry if any
          }
          userSockets.set(userId, socket.id);
          socketUsers.set(socket.id, { userId, tableId, seatIndex: existingSeatIdx });
          socket.join(`table-${tableId}`);

          const player = game0.players[existingSeatIdx];
          player.disconnected = false;
          console.log(`${displayName} reconnected to table ${tableId} (seat ${existingSeatIdx + 1})`);

          socket.emit('seat-assigned', {
            seatIndex: existingSeatIdx,
            displayName
          });
          broadcastGameState(tableId);
          return;
        }
      }

      // 4. Create game if doesn't exist
      ensureGameExists(tableId);

      const game = games.get(tableId);

      // 5. Add player with persistent chips, NOSTR metadata, and preferred seat
      const lud16 = playerData.lud16 || null;
      const assignedSeat = game.addPlayer(userId, displayName, {
        initialStack: chips,
        nostrName,
        nostrPicture,
        lud16,
        preferredSeat: typeof preferredSeat === 'number' ? preferredSeat : undefined
      });

      // Fix: Reset disconnected flag on reconnection via addPlayer path
      // (handles case where old socket was already cleaned from maps,
      //  so the reconnection-swap block above was skipped)
      const reconnectedPlayer = game.players[assignedSeat];
      if (reconnectedPlayer && reconnectedPlayer.disconnected) {
        reconnectedPlayer.disconnected = false;
        console.log(`${displayName} reconnected via addPlayer path — cleared disconnected flag`);
      }

      // Join socket room for this table
      socket.join(`table-${tableId}`);

      // Track user-socket mapping
      userSockets.set(userId, socket.id);
      socketUsers.set(socket.id, { userId, tableId, seatIndex: assignedSeat });

      console.log(`${displayName} (${userId.slice(0, 8)}...) joined table ${tableId} at seat ${assignedSeat + 1}`);

      // Tell client which seat they got
      socket.emit('seat-assigned', {
        seatIndex: assignedSeat,
        displayName
      });

      // Broadcast updated game state to all players at table
      broadcastGameState(tableId);

      // NIP-53: Update live activity when player joins
      scheduleLiveActivityUpdate(tableId);

    } catch (error) {
      socket.emit('error', { message: error.message });
    }
  });

  /**
   * Player action (fold/check/call/raise)
   * Client sends: { tableId, action, amount }
   */
  socket.on('action', ({ tableId, action, amount }) => {
    const user = socketUsers.get(socket.id);
    if (!user) {
      socket.emit('error', { message: 'Not authenticated' });
      return;
    }

    // Rate limiting for actions
    const clientIp = socket.handshake.address;
    if (db.isRateLimited(user.userId, clientIp, 5, 20)) {
      socket.emit('error', { message: 'Too many actions. Slow down.' });
      return;
    }
    
    db.logAction(user.userId, clientIp, `action-${action}`);

    const game = games.get(tableId);
    if (!game) {
      socket.emit('error', { message: 'Table not found' });
      return;
    }

    // Validate and process action server-side
    const result = game.processAction(user.userId, action, amount);
    
    if (!result.valid) {
      socket.emit('error', { message: result.error });
      return;
    }

    // Broadcast updated state to all players
    broadcastGameState(tableId);
  });

  /**
   * Leave table
   */
  socket.on('leave-table', () => {
    const user = socketUsers.get(socket.id);
    if (!user) return;

    const game = games.get(user.tableId);
    if (game) {
      game.removePlayer(user.userId);
      socket.leave(`table-${user.tableId}`);

      // Cleanup if table is empty
      if (game.players.every(p => p === null)) {
        games.delete(user.tableId);
        console.log(`Table ${user.tableId} destroyed (empty)`);
        // NIP-53: Publish "ended" live activity
        scheduleLiveActivityUpdate(user.tableId, true);
      } else {
        broadcastGameState(user.tableId);
        // NIP-53: Update live activity when player leaves
        scheduleLiveActivityUpdate(user.tableId);
      }
    }

    userSockets.delete(user.userId);
    socketUsers.delete(socket.id);
  });

  /**
   * Sit back in (return from sitting out)
   */
  socket.on('sit-back-in', ({ tableId }) => {
    const user = socketUsers.get(socket.id);
    if (!user) {
      socket.emit('error', { message: 'Not authenticated' });
      return;
    }

    const game = games.get(tableId);
    if (!game) {
      socket.emit('error', { message: 'Table not found' });
      return;
    }

    const result = game.sitBackIn(user.userId);
    if (result.success) {
      broadcastGameState(tableId);
    } else {
      socket.emit('error', { message: result.error });
    }
  });

  /**
   * Voluntary sit out — toggle sit-out-next-hand
   */
  socket.on('sit-out', ({ tableId }) => {
    const user = socketUsers.get(socket.id);
    if (!user) {
      socket.emit('error', { message: 'Not authenticated' });
      return;
    }

    const game = games.get(tableId);
    if (!game) {
      socket.emit('error', { message: 'Table not found' });
      return;
    }

    const result = game.voluntarySitOut(user.userId);
    if (result.success) {
      broadcastGameState(tableId);
    } else {
      socket.emit('error', { message: result.error });
    }
  });

  /**
   * Rebuy — reset chips to chosen buy-in amount (2000-10000)
   */
  socket.on('rebuy', ({ tableId, buyIn }) => {
    const user = socketUsers.get(socket.id);
    if (!user) {
      socket.emit('error', { message: 'Not authenticated' });
      return;
    }

    const game = games.get(tableId);
    if (!game) {
      socket.emit('error', { message: 'Table not found' });
      return;
    }

    const MIN_BUYIN = 2000;
    const MAX_BUYIN = 10000;
    const amount = typeof buyIn === 'number' ? Math.max(MIN_BUYIN, Math.min(MAX_BUYIN, Math.floor(buyIn))) : MAX_BUYIN;

    const result = game.rebuy(user.userId, amount);
    if (result.success) {
      // Persist to database
      db.db.prepare('UPDATE players SET current_chips = ? WHERE user_id = ?').run(result.chips, user.userId);
      console.log(`[Server] Rebuy persisted: ${user.userId.slice(0, 8)}... → ${result.chips} chips`);
      broadcastGameState(tableId);
    } else {
      socket.emit('error', { message: result.error });
    }
  });

  /**
   * Disconnect
   */
  socket.on('disconnect', () => {
    // Clean up observer if applicable
    if (observerSockets.has(socket.id)) {
      const obs = observerSockets.get(socket.id);
      console.log(`Observer ${obs.observerName} disconnected from table ${obs.tableId}`);
      observerSockets.delete(socket.id);
    }

    const user = socketUsers.get(socket.id);
    if (user) {
      const game = games.get(user.tableId);
      if (game) {
        // Mark player as disconnected
        const player = game.players.find(p => p && p.userId === user.userId);
        if (player) {
          player.disconnected = true;
          console.log(`${user.userId} disconnected from table ${user.tableId} (socket ${socket.id})`);

          // Keep userSockets mapping alive for 10 seconds so reconnection-swap works.
          // If the player refreshes, the new join-table will find the old socketId and swap it.
          // Only clean up socketUsers for the old socket immediately (it's dead).
          socketUsers.delete(socket.id);

          setTimeout(() => {
            // After 10s, if the mapping still points to the old (dead) socket, clean it up.
            // If the player reconnected, userSockets will point to a new socket — leave it alone.
            if (userSockets.get(user.userId) === socket.id) {
              userSockets.delete(user.userId);
              console.log(`${user.userId} socket mapping cleaned up after grace period`);
            }
          }, 10000);

          // Give 60 seconds to reconnect before auto-sitting out
          setTimeout(() => {
            // Check if still disconnected
            if (player.disconnected && !player.sittingOut) {
              console.log(`${user.userId} did not reconnect - sitting out`);
              player.sittingOut = true;
              player.sitOutTime = Date.now();
              player.folded = true; // Auto-fold current hand
              game.startSitOutKickTimer(user.userId);
              broadcastGameState(user.tableId);
            }
          }, 60000); // 60 second grace period
        } else {
          // Player not in game — clean up immediately
          userSockets.delete(user.userId);
          socketUsers.delete(socket.id);
        }
      } else {
        // No game — clean up immediately
        userSockets.delete(user.userId);
        socketUsers.delete(socket.id);
      }
    }

    console.log(`Client disconnected: ${socket.id}`);
  });
});

/**
 * Broadcast game state to all players at a table
 * Each player receives personalized state (only sees own hole cards)
 * Observers receive spectator view (no private cards)
 */
function broadcastGameState(tableId) {
  const game = games.get(tableId);
  if (!game) return;

  // Pre-fetch badges for all seated players (batch lookup)
  const badgeMap = new Map();
  for (const p of game.players) {
    if (p) {
      const badges = db.getPlayerBadges(p.userId);
      badgeMap.set(p.userId, badges.map(b => b.badge_id));
    }
  }

  // Helper: attach badges to game state
  function addBadgesToState(state) {
    for (const p of state.players) {
      if (p) {
        p.badges = badgeMap.get(p.userId) || [];
      }
    }
    return state;
  }

  // Send personalized state to each seated player
  game.players.forEach((player, idx) => {
    if (!player) return;

    const socketId = userSockets.get(player.userId);
    if (!socketId) return;

    io.to(socketId).emit('game-state', addBadgesToState(game.getGameState(player.userId)));
  });

  // Send observer/spectator state to all observers at this table
  const observerState = addBadgesToState(game.getGameState(null));
  for (const [socketId, obs] of observerSockets) {
    if (obs.tableId === tableId) {
      io.to(socketId).emit('game-state', observerState);
    }
  }
}

// Start server
server.listen(PORT, () => {
  console.log(`🃏 SatoshiStacks server running on port ${PORT}`);
  console.log(`WebSocket ready for connections`);

  // NIP-89: Publish App Handler at startup (makes SatoshiStacks discoverable)
  if (serverSk) {
    try {
      const handlerEvent = finalizeEvent({
        kind: 31990,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['d', 'satoshistacks'],
          ['k', '30311'],
          ['web', 'https://satoshistacks.com', 'nevent'],
          ['name', 'SatoshiStacks'],
          ['about', 'Play-money poker built on Nostr identity and Lightning'],
          ['picture', 'https://satoshistacks.com/favicon.ico']
        ],
        content: ''
      }, serverSk);
      publishToRelays(handlerEvent);
      console.log('[Nostr] Published NIP-89 app handler');
    } catch (e) {
      console.error('[Nostr] Failed to publish app handler:', e.message);
    }

    // NIP-58: Publish badge definitions (kind 30009)
    const BADGE_DEFINITIONS = [
      { id: 'card-player', name: 'Card Player', description: 'Played 1000 hands on SatoshiStacks', icon: '🃏' },
      { id: 'royal-flush', name: 'Royal Flush', description: 'Hit a Royal Flush on SatoshiStacks', icon: '👑' }
    ];
    for (const badge of BADGE_DEFINITIONS) {
      try {
        const badgeDefEvent = finalizeEvent({
          kind: 30009,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ['d', badge.id],
            ['name', badge.name],
            ['description', badge.description],
            ['image', `https://satoshistacks.com/badges/${badge.id}.png`],
            ['thumb', `https://satoshistacks.com/badges/${badge.id}-thumb.png`]
          ],
          content: ''
        }, serverSk);
        publishToRelays(badgeDefEvent);
      } catch (e) {
        console.error(`[Nostr] Failed to publish badge definition "${badge.id}":`, e.message);
      }
    }
    console.log('[Nostr] Published NIP-58 badge definitions');
  }
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
