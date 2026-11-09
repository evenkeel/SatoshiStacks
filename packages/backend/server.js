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
const PokerGame = require('./poker-game');
const apiRoutes = require('./routes/api');
const adminRoutes = require('./routes/admin');
const authRoutes = require('./routes/auth');
const { createProfileRoutes, nip05Lookup } = require('./routes/profile');
const {createLightningAddressHandler} = require('./services/lightning-address');
const socketHandlers = require('./socket-handlers');
const { createLightning } = require('./services/lightning');
const { createPayments } = require('./services/payments');
const { authenticatedSocketId } = require('./socket-session');

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

const games = new Map();              // tableId -> PokerGame
const userSockets = new Map();        // userId -> socket.id
const socketUsers = new Map();        // socket.id -> { userId, tableId, seatIndex }
const observerSockets = new Map();    // socket.id -> { observerName, tableId }
const waitlists = new Map();          // tableId -> [{ socketId, userId, observerName, offeredAt }]

// ==================== BROADCAST HELPER ====================

function broadcastGameState(tableId) {
  const game = games.get(tableId);
  if (!game) return;

  // Count observers for this table
  let observerCount = 0;
  for (const [, obs] of observerSockets) {
    if (obs.tableId === tableId) observerCount++;
  }

  // Waitlist info
  const waitlist = waitlists.get(tableId) || [];
  const waitlistCount = waitlist.length;

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
    state.observerCount = observerCount;
    state.waitlistCount = waitlistCount;
    return state;
  }

  // Send personalized state to each seated player
  game.players.forEach((player) => {
    if (!player) return;
    const socketId = authenticatedSocketId(io, userSockets, player.userId);
    if (!socketId) return;
    io.to(socketId).emit('game-state', addBadgesToState(game.getGameState(player.userId)));
  });

  // Send observer/spectator state (personalized with waitlist position)
  const baseObserverState = addBadgesToState(game.getGameState(null));
  for (const [socketId, obs] of observerSockets) {
    if (obs.tableId === tableId) {
      const wlIdx = waitlist.findIndex(w => w.socketId === socketId);
      if (wlIdx >= 0) {
        // Clone and add personal waitlist position
        const personalState = { ...baseObserverState, waitlistPosition: wlIdx + 1 };
        io.to(socketId).emit('game-state', personalState);
      } else {
        io.to(socketId).emit('game-state', baseObserverState);
      }
    }
  }
}

// ==================== MIDDLEWARE & ROUTES ====================

// NIP-05 identifier (must be before static middleware)
app.get('/.well-known/nostr.json', nip05Lookup);
app.get('/.well-known/lnurlp/:name', createLightningAddressHandler());

// Security headers (helmet) — required dependency
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "https://cdnjs.cloudflare.com", "https://esm.sh"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      connectSrc: ["'self'", "wss:", "ws:"],
      imgSrc: ["'self'", "data:", "blob:", "https:"],
    }
  }
}));
console.log('[Server] Helmet security headers enabled');

// Static files & JSON parsing
const frontendDir = path.join(__dirname, '../../packages/frontend');
app.use(express.static(frontendDir));
app.use(express.json({ limit: '16kb' }));

// Table routes — all serve the same SPA, JS reads URL to determine table
const TABLE_ROUTES = Object.values(config.TABLE_CONFIGS).map(t => t.route);
TABLE_ROUTES.forEach(route => {
  app.get(route, (req, res) => {
    res.sendFile(path.join(frontendDir, 'index.html'));
  });
});

// Health check
app.get('/health', (req, res) => {
  const ready = !config.REALMONEY_ENABLED || walletReady;
  res.status(ready ? 200 : 503).json({ ok: ready, uptime: process.uptime(), tables: games.size, walletReady });
});

// Live table status API
app.get('/api/tables', (req, res) => {
  const tables = Object.values(config.TABLE_CONFIGS).map(tc => {
    const game = games.get(tc.id);
    let observerCount = 0;
    for (const [, obs] of observerSockets) {
      if (obs.tableId === tc.id) observerCount++;
    }
    return {
      ...tc,
      realMoney: config.isRealMoney(tc.id),
      depositsEnabled: !!payments?.depositsEnabled(),
      playerCount: game ? game.players.filter(p => p !== null).length : 0,
      observerCount,
      handInProgress: game ? game.handInProgress : false,
    };
  });
  res.json({ success: true, tables });
});

// Mount route modules
app.use('/api', apiRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/profile', createProfileRoutes({
  canPurchase: () => config.REALMONEY_ENABLED && walletReady && !!payments && !payments.breakerState().tripped,
  onUpdate(pubkey, profile) {
  const name = profile.display_name || profile.name || pubkey.slice(0,12);
  for (const [tableId, game] of games) {
    const player = game.players.find(p => p?.userId === pubkey);
    if (player) {
      Object.assign(player, {username:name,nostrName:name,nostrPicture:profile.picture || null,lud16:profile.lud16 || null});
      broadcastGameState(tableId);
    }
  }
  for (const [socketId, observer] of observerSockets) {
    if (observer.userId === pubkey) {
      Object.assign(observer,{observerName:name,nostrName:name,nostrPicture:profile.picture || null});
      io.to(socketId).emit('profile-updated',{name,picture:profile.picture || null,lud16:profile.lud16 || null});
    }
  }
  for (const entries of waitlists.values()) for (const entry of entries) if (entry.userId === pubkey) entry.observerName = name;
  const socketId = userSockets.get(pubkey);
  if (socketId) io.to(socketId).emit('profile-updated',{name,picture:profile.picture || null,lud16:profile.lud16 || null});
} }));

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

// ==================== CRASH RECOVERY ====================
// Restore in-progress hands from snapshots (survives server restart)

function recoverInProgressHands() {
  try {
    const snapshots = db.getAllHandSnapshots();
    if (snapshots.length === 0) {
      console.log('[Recovery] No in-progress hands to recover');
      return;
    }

    for (const { table_id, hand_id, snapshot } of snapshots) {
      try {
        const game = PokerGame.deserializeState(snapshot, { expectedRealMoney: config.isRealMoney(table_id) });
        walletHandlers.wireGame(table_id, game);
        for (const player of game.players) {
          if (!player) continue;
          player.disconnected = true;
          player.sittingOutNextHand = true;
          if (!game.handInProgress) player.sittingOut = true;
          game.startSitOutKickTimer(player.userId);
        }
        games.set(table_id, game);

        // Resume interrupted timers. The snapshot doesn't serialize the
        // timeouts themselves — just the game-state that tells us which one
        // was running.
        if (game.handInProgress) {
          if (game.phase === 'showdown') {
            // Dramatic runout was mid-flight. Either resume dealing remaining
            // streets or finish the hand if all cards are already out.
            if (game.communityCards.length < 5) {
              console.log(`[Recovery] Resuming dramatic runout on ${table_id} (${game.communityCards.length}/5 community cards dealt)`);
              game.dramaticRunOut();
            } else {
              console.log(`[Recovery] Finishing stalled showdown on ${table_id}`);
              setTimeout(() => { try { game.endHand(); } catch (e) { console.error('[Recovery] endHand failed:', e.message); } }, 500);
            }
          } else if (game.currentPlayerIndex >= 0) {
            game.startActionTimer();
          }
        }

        console.log(`[Recovery] Restored hand ${hand_id} on table ${table_id} (phase: ${game.phase}, players: ${game.players.filter(p => p).length})`);
      } catch (e) {
        console.error(`[Recovery] Failed to restore hand on table ${table_id}:`, e.message);
        // Preserve evidence and liabilities. Never discard a funded snapshot.
        throw e;
      }
    }

    console.log(`[Recovery] Recovered ${snapshots.length} in-progress hand(s)`);
  } catch (e) {
    console.error('[Recovery] Crash recovery failed:', e.message);
    process.exit(1);
  }
}

// ==================== SEED TABLE CONFIGS ====================
// Ensure all configured tables exist in the database
for (const [id, tc] of Object.entries(config.TABLE_CONFIGS)) {
  db.upsertTable(id, tc.name, tc.smallBlind, tc.bigBlind);
}
console.log(`[Server] Seeded ${Object.keys(config.TABLE_CONFIGS).length} table configs`);

// ==================== WEBSOCKET HANDLERS ====================

// Lightning real-money services. `payments` stays null on a play-money node, so
// socket handlers reach it lazily via the getter (it's set below only when the
// REALMONEY_ENABLED master switch is on).
let lightning = null;
let payments = null;
let accountPayments = null;
let walletReady = false;

const walletHandlers = socketHandlers.setup(
  io, games, userSockets, socketUsers, observerSockets, broadcastGameState, waitlists,
  () => payments,
  () => accountPayments,
);
recoverInProgressHands();

// ==================== LIGHTNING REAL-MONEY WIRING ====================
// Total sats currently represented as real-money stacks/pots across all tables.
function liveStacksTotal() {
  let total = 0;
  for (const [tableId, game] of games) {
    if (!config.isRealMoney(tableId)) continue;
    for (const p of game.players) {
      if (p) total += (p.stack || 0) + (p.currentBet || 0);
    }
    total += game.pot || 0;
  }
  return total;
}

if (config.REALMONEY_ENABLED) {
  lightning = createLightning(config.LIGHTNING);
  const connectedPayments = createPayments({
    lnd: lightning,
    db,
    config,
    getGame: (id) => games.get(id),
    liveStacksTotal,
    onSeatPlayer: (row) => walletHandlers.seatFromDeposit(row),
    onRefund: (row) => walletHandlers.refundToPlayer(row),
    onDeposit: (row) => { if (row.table_id === db.ACCOUNT) walletHandlers.seatFromDeposit(row); },
    alert: (m) => console.error('[Wallet][ALERT]', m),
  });
  accountPayments = connectedPayments;
  let subscription = null;
  let maintenanceRunning = false;
  async function maintainWallet() {
    if (maintenanceRunning) return;
    maintenanceRunning = true;
    try {
      await lightning.connect();
      if (!subscription) {
        const stream = lightning.subscribeInvoices(s => connectedPayments.creditDeposit(s.paymentHash, s.amountSats));
        subscription = stream;
        stream.on('error', error => {
          if (subscription !== stream) return;
          console.error('[Wallet] Invoice stream failed:', error.message);
          stream.removeAllListeners('invoice_updated');
          subscription = null;
          stream.cancel?.();
          walletReady = false;
          payments = null;
        });
      }
      await connectedPayments.reconcilePending();
      const solvency = await connectedPayments.solvencyCheck();
      walletReady = solvency.ok;
      payments = walletReady ? connectedPayments : null;
      adminRoutes.setPayments(connectedPayments);
      if (walletReady) connectedPayments.releaseUnseatedDeposits();
    } catch (error) {
      walletReady = false;
      payments = null;
      console.error('[Wallet] Not ready:', error.message);
    } finally { maintenanceRunning = false; }
  }
  maintainWallet();
  setInterval(maintainWallet, 15000).unref();
}

// ==================== START ====================

server.listen(config.PORT, () => {
  console.log(`🃏 SatoshiStacks server running on port ${config.PORT}`);
  console.log(`WebSocket ready for connections`);
  nostr.publishStartupEvents();
});

// ==================== SHUTDOWN ====================

let isShuttingDown = false;

function flushSnapshots(label) {
  let flushed = 0;
  for (const [tableId, game] of games) {
    try {
      if (game.handInProgress || game.realMoney) {
        game.saveSnapshot();
        flushed++;
      }
    } catch (err) {
      console.error(`[${label}] Snapshot failed for ${tableId}: ${err.message}`);
    }
  }
  if (flushed > 0) console.log(`[${label}] Flushed ${flushed} snapshot(s)`);
}

function shutdown(reason, exitCode) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[Shutdown] ${reason}`);

  flushSnapshots('Shutdown');

  try { io.disconnectSockets(true); } catch (e) { /* noop */ }

  const forceExit = setTimeout(() => {
    console.error('[Shutdown] Forced exit after 10s timeout');
    process.exit(exitCode || 1);
  }, 10000);
  forceExit.unref();

  server.close(() => {
    console.log('[Shutdown] HTTP server closed');
    process.exit(exitCode);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM received', 0));
process.on('SIGINT', () => shutdown('SIGINT received', 0));

// Unhandled promise rejection — log but keep running (NOSTR relay failures etc.)
process.on('unhandledRejection', (reason) => {
  console.error('[Server] Unhandled promise rejection:', reason);
});

// Uncaught exception — try to persist state before exiting, since the process
// is in an undefined state and staying up risks corrupting further hands.
process.on('uncaughtException', (err) => {
  console.error('[Server] Uncaught exception:', err);
  shutdown('Uncaught exception', 1);
});
