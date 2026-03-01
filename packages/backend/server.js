/**
 * SatoshiStacks Poker — Main Server
 * Slim orchestrator: sets up Express, Socket.IO, mounts routes & socket handlers.
 */

const express = require('express');
const http = require('http');
const path = require('path');
const helmet = require('helmet');
const { Server } = require('socket.io');

const config = require('./config');
const db = require('./database');
const nostr = require('./services/nostr');
const apiRoutes = require('./routes/api');
const adminRoutes = require('./routes/admin');
const authRoutes = require('./routes/auth');
const socketHandlers = require('./socket-handlers');

// ==================== EXPRESS & SOCKET.IO SETUP ====================

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: config.CORS_ORIGIN === '*' ? '*' : config.CORS_ORIGIN.split(','),
    methods: ['GET', 'POST']
  }
});

// ==================== SHARED STATE ====================

const games = new Map();           // tableId -> PokerGame
const userSockets = new Map();     // userId -> socket.id
const socketUsers = new Map();     // socket.id -> { userId, tableId, seatIndex }
const observerSockets = new Map(); // socket.id -> { observerName, tableId }

// ==================== BROADCAST HELPER ====================

function broadcastGameState(tableId) {
  const game = games.get(tableId);
  if (!game) return;

  // Pre-fetch badges for all seated players
  const badgeMap = new Map();
  for (const p of game.players) {
    if (p) {
      const badges = db.getPlayerBadges(p.userId);
      badgeMap.set(p.userId, badges.map(b => b.badge_id));
    }
  }

  function addBadgesToState(state) {
    for (const p of state.players) {
      if (p) {
        p.badges = badgeMap.get(p.userId) || [];
      }
    }
    return state;
  }

  // Send personalized state to each seated player
  game.players.forEach((player) => {
    if (!player) return;
    const socketId = userSockets.get(player.userId);
    if (!socketId) return;
    io.to(socketId).emit('game-state', addBadgesToState(game.getGameState(player.userId)));
  });

  // Send observer/spectator state
  const observerState = addBadgesToState(game.getGameState(null));
  for (const [socketId, obs] of observerSockets) {
    if (obs.tableId === tableId) {
      io.to(socketId).emit('game-state', observerState);
    }
  }
}

// ==================== MIDDLEWARE & ROUTES ====================

// NIP-05 identifier (must be before static middleware)
app.get('/.well-known/nostr.json', (req, res) => {
  const name = (req.query.name || '').toLowerCase().trim();
  const identifiers = {
    'allen': '8a3a9236d0eae6bc92eb17782d57e828a01f03cd28d3c68297c7e19d374b9419'
  };
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');
  if (name && identifiers[name]) {
    res.json({ names: { [name]: identifiers[name] } });
  } else {
    res.json({ names: identifiers });
  }
});

// Security headers (helmet) — required dependency
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com", "https://esm.sh"],
      scriptSrcAttr: ["'unsafe-inline'"],  // needed for onclick handlers in login buttons
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      connectSrc: ["'self'", "wss:", "ws:"],
      imgSrc: ["'self'", "data:", "blob:", "https:"],
      manifestSrc: ["'self'", "blob:"],
    }
  }
}));
console.log('[Server] Helmet security headers enabled');

// Static files & JSON parsing
const frontendDir = path.join(__dirname, '../../packages/frontend');
app.use(express.static(frontendDir));
app.use('/playmoney', express.static(frontendDir));  // serve under /playmoney too (matches nginx prefix)
app.use(express.json({ limit: '16kb' }));

// Health check
app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), tables: games.size });
});

// Mount route modules
app.use('/api', apiRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/auth', authRoutes);

// Admin dashboard HTML
app.get('/admin', (req, res) => {
  res.sendFile(__dirname + '/admin.html');
});

// Global error handler — prevents leaking stack traces to clients
app.use((err, req, res, _next) => {
  console.error('[Server] Unhandled route error:', err);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

// Give route modules access to shared state
adminRoutes.setGames(games);
const sharedContext = { games, userSockets, io, broadcastGameState };
authRoutes.setContext(sharedContext);

// ==================== WEBSOCKET HANDLERS ====================

socketHandlers.setup(io, games, userSockets, socketUsers, observerSockets, broadcastGameState);

// ==================== START ====================

server.listen(config.PORT, () => {
  console.log(`🃏 SatoshiStacks server running on port ${config.PORT}`);
  console.log(`WebSocket ready for connections`);
  nostr.publishStartupEvents();
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

// Catch unhandled promise rejections (e.g. NOSTR relay failures)
process.on('unhandledRejection', (reason) => {
  console.error('[Server] Unhandled promise rejection:', reason);
});
