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
const { verifyEvent } = require('nostr-tools/pure');
const { npubEncode } = require('nostr-tools/nip19');
const PokerGame = require('./poker-game');
const db = require('./database');

const app = express();
app.set('trust proxy', 1); // Trust first proxy (Nginx) for correct req.ip
const server = http.createServer(app);

const PORT = process.env.PORT || 3001;
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'change-me-in-production';

const io = new Server(server, {
  cors: {
    origin: CORS_ORIGIN === '*' ? '*' : CORS_ORIGIN.split(','),
    methods: ["GET", "POST"]
  }
});

// Game state
const games = new Map(); // tableId -> PokerGame instance
const userSockets = new Map(); // userId -> socket.id
const socketUsers = new Map(); // socket.id -> userId

// Multi-table system (toggled OFF for now - focus on single Main Table)
// Future: Spawn table2, table3, etc. when waitlist ≥10
// Future: Consolidate to Main Table when possible (full tables priority)
const MULTI_TABLES_ENABLED = false;

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
    const nonceTag = signedEvent.tags.find(t => t[0] === 'challenge' && t[1] === challenge.nonce);
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

              if (name && !resolved) {
                resolved = true;
                clearTimeout(timeout);

                // Update DB with relay profile
                db.upsertNostrPlayer(pubkeyHex, npubEncode(pubkeyHex), name, picture);
                console.log(`[Auth] Relay profile fetched: ${name} (${pubkeyHex.slice(0, 8)}...)`);

                // Update in-memory game state if player is seated, and broadcast
                for (const [tableId, game] of games) {
                  const player = game.players.find(p => p && p.userId === pubkeyHex);
                  if (player) {
                    player.username = name;
                    player.nostrName = name;
                    player.nostrPicture = picture;
                    broadcastGameState(tableId);
                  }
                }

                // Also notify the player's socket directly with updated profile
                const socketId = userSockets.get(pubkeyHex);
                if (socketId) {
                  io.to(socketId).emit('profile-updated', { name, picture });
                }

                resolve({ name, picture });
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

// WebSocket connection handling
io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);

  /**
   * Join table
   * Client sends: { tableId, sessionToken }
   * Server validates session, loads persistent chips, assigns seat automatically
   */
  socket.on('join-table', ({ tableId, sessionToken }) => {
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

      // 2. Load persistent chips — auto-rebuy to 10K if at 0
      let chips = playerData.current_chips;
      if (chips <= 0) {
        chips = 10000;
        db.db.prepare('UPDATE players SET current_chips = ? WHERE user_id = ?').run(chips, userId);
        console.log(`[Server] Auto-rebuy for ${displayName}: 10,000 chips`);
      }

      // 3. Handle reconnection — if player already at this table, swap socket
      const existingSocketId = userSockets.get(userId);
      if (existingSocketId && existingSocketId !== socket.id) {
        const existingData = socketUsers.get(existingSocketId);
        if (existingData && existingData.tableId === tableId) {
          // Swap socket mapping — player is reconnecting
          socketUsers.delete(existingSocketId);
          userSockets.set(userId, socket.id);
          socketUsers.set(socket.id, { userId, tableId, seatIndex: existingData.seatIndex });
          socket.join(`table-${tableId}`);

          const game = games.get(tableId);
          if (game) {
            const player = game.players[existingData.seatIndex];
            if (player && player.userId === userId) {
              player.disconnected = false;
              console.log(`${displayName} reconnected to table ${tableId} (seat ${existingData.seatIndex + 1})`);

              socket.emit('seat-assigned', {
                seatIndex: existingData.seatIndex,
                displayName
              });
              broadcastGameState(tableId);
              return;
            }
          }
        }
      }

      // 4. Create game if doesn't exist
      if (!games.has(tableId)) {
        const game = new PokerGame(tableId);

        // Set up state change callback to broadcast updates
        game.onStateChange = () => {
          console.log(`[Server] Broadcasting state for table ${tableId}`);
          broadcastGameState(tableId);
        };

        // Set up timer start callback
        game.onTimerStart = (playerIndex, timeoutMs) => {
          io.to(`table-${tableId}`).emit('action-timer-start', {
            playerIndex,
            timeoutMs
          });
        };

        // Set up hand log callback — emit real-time play-by-play lines
        game.onHandLog = (line, type) => {
          io.to(`table-${tableId}`).emit('hand-log', { line, type });
        };

        // Set up deal cards callback — per-player hole card notification
        game.onDealCards = (userId, line) => {
          const socketId = userSockets.get(userId);
          if (socketId) {
            io.to(socketId).emit('hand-log', { line, type: 'deal' });
          }
        };

        // Set up hand complete callback — send compiled history to all players
        game.onHandComplete = (historyText) => {
          io.to(`table-${tableId}`).emit('hand-complete', { history: historyText });
        };

        // Set up auto-rebuy callback — persist chip reset to database
        game.onRebuy = (userId, chips) => {
          try {
            db.db.prepare('UPDATE players SET current_chips = ? WHERE user_id = ?').run(chips, userId);
            console.log(`[Server] Auto-rebuy persisted: ${userId.slice(0, 8)}... → ${chips} chips`);
          } catch (err) {
            console.error(`[Server] Failed to persist rebuy for ${userId}:`, err.message);
          }
        };

        games.set(tableId, game);
      }

      const game = games.get(tableId);

      // 5. Add player with persistent chips and NOSTR metadata
      const assignedSeat = game.addPlayer(userId, displayName, {
        initialStack: chips,
        nostrName,
        nostrPicture
      });

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
      } else {
        broadcastGameState(user.tableId);
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
   * Rebuy — reset chips to starting stack
   */
  socket.on('rebuy', ({ tableId }) => {
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

    const result = game.rebuy(user.userId);
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
    const user = socketUsers.get(socket.id);
    if (user) {
      const game = games.get(user.tableId);
      if (game) {
        // Mark player as disconnected
        const player = game.players.find(p => p && p.userId === user.userId);
        if (player) {
          player.disconnected = true;
          console.log(`${user.userId} disconnected from table ${user.tableId}`);
          
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
        }
      }
      
      userSockets.delete(user.userId);
      socketUsers.delete(socket.id);
    }
    
    console.log(`Client disconnected: ${socket.id}`);
  });
});

/**
 * Broadcast game state to all players at a table
 * Each player receives personalized state (only sees own hole cards)
 */
function broadcastGameState(tableId) {
  const game = games.get(tableId);
  if (!game) return;

  // Get all players at this table
  game.players.forEach((player, idx) => {
    if (!player) return;

    const socketId = userSockets.get(player.userId);
    if (!socketId) return;

    // Send personalized game state to each player
    io.to(socketId).emit('game-state', game.getGameState(player.userId));
  });
}

// Start server
server.listen(PORT, () => {
  console.log(`🃏 SatoshiStacks server running on port ${PORT}`);
  console.log(`WebSocket ready for connections`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
