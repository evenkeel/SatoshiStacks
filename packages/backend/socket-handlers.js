/**
 * WebSocket event handlers — all Socket.IO logic extracted from server.js.
 * Handles join-table, action, leave-table, sit-out, rebuy, disconnect, observer, chat.
 */

const config = require('./config');
const db = require('./database');
const PokerGame = require('./poker-game');
const nostr = require('./services/nostr');

function generateObserverName() {
  const adj = config.OBSERVER_ADJECTIVES[Math.floor(Math.random() * config.OBSERVER_ADJECTIVES.length)];
  const noun = config.OBSERVER_NOUNS[Math.floor(Math.random() * config.OBSERVER_NOUNS.length)];
  const num = Math.floor(Math.random() * 100);
  return `${adj}${noun}${num}`;
}

/**
 * Set up all socket handlers.
 * @param {Server} io - Socket.IO server instance
 * @param {Map} games - tableId -> PokerGame
 * @param {Map} userSockets - userId -> socket.id
 * @param {Map} socketUsers - socket.id -> { userId, tableId, seatIndex }
 * @param {Map} observerSockets - socket.id -> { observerName, tableId }
 * @param {Function} broadcastGameState - broadcasts state to all at a table
 */
function setup(io, games, userSockets, socketUsers, observerSockets, broadcastGameState) {

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
      io.to(`table-${tableId}`).emit('time-bank-start', { playerIndex, timeBankMs });
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
        nostr.scheduleLiveActivityUpdate(tableId, games, true);
      }
    };

    game.onBadgeCheck = (userId, stats) => {
      nostr.checkAndAwardBadges(userId, stats, { userSockets, io, games, broadcastGameState });
    };

    games.set(tableId, game);
    console.log(`[Server] Created game for table ${tableId}`);
  }

  io.on('connection', (socket) => {
    console.log(`Client connected: ${socket.id}`);

    // ==================== OBSERVE ====================

    socket.on('observe-table', ({ tableId }) => {
      const observerName = generateObserverName();
      observerSockets.set(socket.id, { observerName, tableId });
      socket.join(`table-${tableId}`);
      console.log(`Observer ${observerName} (${socket.id}) watching table ${tableId}`);

      socket.emit('observer-joined', { observerName });
      ensureGameExists(tableId);

      const game = games.get(tableId);
      if (game) {
        socket.emit('game-state', game.getGameState(null));
      }
    });

    // ==================== CHAT ====================

    socket.on('chat-message', ({ text }) => {
      if (!text || typeof text !== 'string') return;
      const trimmed = text.trim().slice(0, 120);
      if (!trimmed) return;

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
        return;
      }

      io.to(`table-${tableId}`).emit('chat-message', {
        sender: senderName,
        senderId: user ? user.userId : null,
        text: trimmed,
        isObserver: !!observer,
        timestamp: Date.now()
      });
    });

    // ==================== JOIN TABLE ====================

    socket.on('join-table', ({ tableId: requestedTableId, sessionToken, preferredSeat, buyIn }) => {
      const tableId = config.MULTI_TABLES_ENABLED ? (requestedTableId || 'table-1') : 'table-1';
      try {
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
        const clientIp = socket.handshake.address;

        // Ban checks
        if (db.isIpBanned(clientIp)) {
          socket.emit('error', { message: 'Your IP address is banned from this site' });
          console.log(`[Server] Blocked banned IP: ${clientIp}`);
          return;
        }
        if (db.isBanned(userId)) {
          socket.emit('error', { message: 'Player is banned' });
          return;
        }

        // Rate limit
        if (db.isRateLimited(userId, clientIp, config.JOIN_RATE_LIMIT.windowSec, config.JOIN_RATE_LIMIT.maxActions)) {
          socket.emit('error', { message: 'Too many actions. Please wait.' });
          db.logAction(userId, clientIp, 'rate-limited');
          return;
        }
        db.logAction(userId, clientIp, 'join-table');

        // Buy-in with anti-rathole rules
        let requestedBuyIn = typeof buyIn === 'number'
          ? Math.max(config.MIN_BUYIN, Math.min(config.MAX_BUYIN, Math.floor(buyIn)))
          : config.MAX_BUYIN;

        let chips;
        if (playerData.left_at && (Date.now() - playerData.left_at * 1000) < config.RATHOLE_WINDOW_MS && playerData.current_chips > 0) {
          chips = Math.max(requestedBuyIn, playerData.current_chips);
          console.log(`[Server] Anti-rathole: ${displayName} returning within 2hr with ${chips} chips (requested ${requestedBuyIn}, left with ${playerData.current_chips})`);
        } else {
          chips = requestedBuyIn;
          console.log(`[Server] ${displayName} buying in for ${chips} playsats`);
        }
        db.db.prepare('UPDATE players SET current_chips = ? WHERE user_id = ?').run(chips, userId);

        // Clean up observer tracking
        if (observerSockets.has(socket.id)) {
          observerSockets.delete(socket.id);
        }

        // Handle reconnection
        const game0 = games.get(tableId);
        if (game0) {
          const existingSeatIdx = game0.players.findIndex(p => p && p.userId === userId);
          if (existingSeatIdx !== -1) {
            const oldSocketId = userSockets.get(userId);
            if (oldSocketId && oldSocketId !== socket.id) {
              socketUsers.delete(oldSocketId);
            }
            userSockets.set(userId, socket.id);
            socketUsers.set(socket.id, { userId, tableId, seatIndex: existingSeatIdx });
            socket.join(`table-${tableId}`);

            const player = game0.players[existingSeatIdx];
            player.disconnected = false;
            console.log(`${displayName} reconnected to table ${tableId} (seat ${existingSeatIdx + 1})`);

            socket.emit('seat-assigned', { seatIndex: existingSeatIdx, displayName });
            broadcastGameState(tableId);
            return;
          }
        }

        // Create game & add player
        ensureGameExists(tableId);
        const game = games.get(tableId);

        const lud16 = playerData.lud16 || null;
        const assignedSeat = game.addPlayer(userId, displayName, {
          initialStack: chips,
          nostrName,
          nostrPicture,
          lud16,
          preferredSeat: typeof preferredSeat === 'number' ? preferredSeat : undefined
        });

        const reconnectedPlayer = game.players[assignedSeat];
        if (reconnectedPlayer && reconnectedPlayer.disconnected) {
          reconnectedPlayer.disconnected = false;
          console.log(`${displayName} reconnected via addPlayer path — cleared disconnected flag`);
        }

        socket.join(`table-${tableId}`);
        userSockets.set(userId, socket.id);
        socketUsers.set(socket.id, { userId, tableId, seatIndex: assignedSeat });

        console.log(`${displayName} (${userId.slice(0, 8)}...) joined table ${tableId} at seat ${assignedSeat + 1}`);
        socket.emit('seat-assigned', { seatIndex: assignedSeat, displayName });
        broadcastGameState(tableId);
        nostr.scheduleLiveActivityUpdate(tableId, games);

      } catch (error) {
        socket.emit('error', { message: error.message });
      }
    });

    // ==================== ACTION ====================

    socket.on('action', ({ tableId, action, amount }) => {
      const user = socketUsers.get(socket.id);
      if (!user) {
        socket.emit('error', { message: 'Not authenticated' });
        return;
      }

      const clientIp = socket.handshake.address;
      if (db.isRateLimited(user.userId, clientIp, config.ACTION_RATE_LIMIT.windowSec, config.ACTION_RATE_LIMIT.maxActions)) {
        socket.emit('error', { message: 'Too many actions. Slow down.' });
        return;
      }
      db.logAction(user.userId, clientIp, `action-${action}`);

      const game = games.get(tableId);
      if (!game) {
        socket.emit('error', { message: 'Table not found' });
        return;
      }

      const result = game.processAction(user.userId, action, amount);
      if (!result.valid) {
        socket.emit('error', { message: result.error });
        return;
      }
      broadcastGameState(tableId);
    });

    // ==================== LEAVE TABLE ====================

    socket.on('leave-table', () => {
      const user = socketUsers.get(socket.id);
      if (!user) return;

      const game = games.get(user.tableId);
      if (game) {
        game.removePlayer(user.userId);
        socket.leave(`table-${user.tableId}`);

        if (game.players.every(p => p === null)) {
          games.delete(user.tableId);
          console.log(`Table ${user.tableId} destroyed (empty)`);
          nostr.scheduleLiveActivityUpdate(user.tableId, games, true);
        } else {
          broadcastGameState(user.tableId);
          nostr.scheduleLiveActivityUpdate(user.tableId, games);
        }
      }

      userSockets.delete(user.userId);
      socketUsers.delete(socket.id);
    });

    // ==================== SIT OUT / SIT BACK IN ====================

    socket.on('sit-back-in', ({ tableId }) => {
      const user = socketUsers.get(socket.id);
      if (!user) { socket.emit('error', { message: 'Not authenticated' }); return; }

      const game = games.get(tableId);
      if (!game) { socket.emit('error', { message: 'Table not found' }); return; }

      const result = game.sitBackIn(user.userId);
      if (result.success) {
        broadcastGameState(tableId);
      } else {
        socket.emit('error', { message: result.error });
      }
    });

    socket.on('sit-out', ({ tableId }) => {
      const user = socketUsers.get(socket.id);
      if (!user) { socket.emit('error', { message: 'Not authenticated' }); return; }

      const game = games.get(tableId);
      if (!game) { socket.emit('error', { message: 'Table not found' }); return; }

      const result = game.voluntarySitOut(user.userId);
      if (result.success) {
        broadcastGameState(tableId);
      } else {
        socket.emit('error', { message: result.error });
      }
    });

    // ==================== REBUY ====================

    socket.on('rebuy', ({ tableId, buyIn }) => {
      const user = socketUsers.get(socket.id);
      if (!user) { socket.emit('error', { message: 'Not authenticated' }); return; }

      const game = games.get(tableId);
      if (!game) { socket.emit('error', { message: 'Table not found' }); return; }

      const amount = typeof buyIn === 'number'
        ? Math.max(config.MIN_BUYIN, Math.min(config.MAX_BUYIN, Math.floor(buyIn)))
        : config.MAX_BUYIN;

      const result = game.rebuy(user.userId, amount);
      if (result.success) {
        db.db.prepare('UPDATE players SET current_chips = ? WHERE user_id = ?').run(result.chips, user.userId);
        console.log(`[Server] Rebuy persisted: ${user.userId.slice(0, 8)}... → ${result.chips} chips`);
        broadcastGameState(tableId);
      } else {
        socket.emit('error', { message: result.error });
      }
    });

    // ==================== DISCONNECT ====================

    socket.on('disconnect', () => {
      if (observerSockets.has(socket.id)) {
        const obs = observerSockets.get(socket.id);
        console.log(`Observer ${obs.observerName} disconnected from table ${obs.tableId}`);
        observerSockets.delete(socket.id);
      }

      const user = socketUsers.get(socket.id);
      if (user) {
        const game = games.get(user.tableId);
        if (game) {
          const player = game.players.find(p => p && p.userId === user.userId);
          if (player) {
            player.disconnected = true;
            console.log(`${user.userId} disconnected from table ${user.tableId} (socket ${socket.id})`);

            socketUsers.delete(socket.id);

            setTimeout(() => {
              if (userSockets.get(user.userId) === socket.id) {
                userSockets.delete(user.userId);
                console.log(`${user.userId} socket mapping cleaned up after grace period`);
              }
            }, config.SOCKET_CLEANUP_MS);

            setTimeout(() => {
              if (player.disconnected && !player.sittingOut) {
                console.log(`${user.userId} did not reconnect - sitting out`);
                player.sittingOut = true;
                player.sitOutTime = Date.now();
                player.folded = true;
                game.startSitOutKickTimer(user.userId);
                broadcastGameState(user.tableId);
              }
            }, config.DISCONNECT_GRACE_MS);
          } else {
            userSockets.delete(user.userId);
            socketUsers.delete(socket.id);
          }
        } else {
          userSockets.delete(user.userId);
          socketUsers.delete(socket.id);
        }
      }

      console.log(`Client disconnected: ${socket.id}`);
    });
  });
}

module.exports = { setup };
