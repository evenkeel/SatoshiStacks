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
 * @param {Map} waitlists - tableId -> [{ socketId, userId, observerName, offeredAt }]
 */
function setup(io, games, userSockets, socketUsers, observerSockets, broadcastGameState, waitlists) {

  // ==================== WAITLIST HELPER ====================

  function checkWaitlist(tableId) {
    const game = games.get(tableId);
    if (!game) return;
    const wl = waitlists.get(tableId);
    if (!wl || wl.length === 0) return;

    // Count empty seats
    const emptySeats = game.players.filter(p => p === null).length;
    if (emptySeats === 0) return;

    // Only offer to one person at a time (first in queue)
    const first = wl[0];
    if (first.offeredAt) return; // Already offered, waiting for response

    first.offeredAt = Date.now();
    io.to(first.socketId).emit('seat-available', { tableId, timeoutMs: 60000 });
    console.log(`[Waitlist] Offering seat to ${first.observerName} at ${tableId}`);

    // 60-second timeout — skip to next if no response
    setTimeout(() => {
      const currentWl = waitlists.get(tableId);
      if (!currentWl || currentWl.length === 0) return;
      if (currentWl[0].socketId === first.socketId && currentWl[0].offeredAt) {
        console.log(`[Waitlist] ${first.observerName} timed out, moving to next`);
        currentWl.shift();
        broadcastGameState(tableId);
        checkWaitlist(tableId); // Offer to next person
      }
    }, 60000);
  }

  function removeFromWaitlist(socketId, tableId) {
    const wl = waitlists.get(tableId);
    if (!wl) return;
    const idx = wl.findIndex(w => w.socketId === socketId);
    if (idx >= 0) {
      const wasOffered = idx === 0 && wl[idx].offeredAt;
      wl.splice(idx, 1);
      if (wasOffered) checkWaitlist(tableId); // Offer to next
    }
  }

  function ensureGameExists(tableId) {
    if (games.has(tableId)) return;

    const game = new PokerGame(tableId);

    game.onStateChange = () => {
      console.log(`[Server] Broadcasting state for table ${tableId}`);
      broadcastGameState(tableId);
      checkWaitlist(tableId);
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

    game.onPublishHandHistory = (text, handId, tableId, playerPubkeys) => {
      nostr.publishHandHistory(text, handId, tableId, playerPubkeys).catch(e => {
        console.error(`[Nostr] Failed to publish hand history: ${e.message}`);
      });
    };

    games.set(tableId, game);
    console.log(`[Server] Created game for table ${tableId}`);
  }

  io.on('connection', (socket) => {
    console.log(`Client connected: ${socket.id}`);

    // ==================== OBSERVE ====================

    socket.on('observe-table', ({ tableId, sessionToken }) => {
      let observerName = generateObserverName();
      let userId = null;
      let nostrName = null;
      let nostrPicture = null;

      // Optional authentication for observers
      if (sessionToken) {
        const playerData = db.getPlayerBySession(sessionToken);
        if (playerData) {
          userId = playerData.pubkey_hex;
          nostrName = playerData.nostr_name;
          nostrPicture = playerData.nostr_picture;
          observerName = nostrName || (playerData.npub ? playerData.npub.slice(0, 12) + '...' : observerName);
          console.log(`[Observer] Authenticated: ${observerName} (${userId.slice(0, 8)}...)`);
        }
        // If session is invalid, silently fall back to anonymous observer
      }

      observerSockets.set(socket.id, { observerName, tableId, userId, nostrName, nostrPicture });
      socket.join(`table-${tableId}`);
      console.log(`Observer ${observerName} (${socket.id}) watching table ${tableId}`);

      socket.emit('observer-joined', { observerName, userId, nostrName, nostrPicture });
      ensureGameExists(tableId);

      // Broadcast updated observer count to all clients
      broadcastGameState(tableId);
    });

    // Observer authenticates while already watching
    socket.on('observer-authenticate', ({ sessionToken }) => {
      const obs = observerSockets.get(socket.id);
      if (!obs) return;

      if (!sessionToken) return;

      const playerData = db.getPlayerBySession(sessionToken);
      if (!playerData) {
        socket.emit('auth-error', { message: 'Session expired. Please log in again.' });
        return;
      }

      // Update observer entry with auth info
      obs.userId = playerData.pubkey_hex;
      obs.nostrName = playerData.nostr_name;
      obs.nostrPicture = playerData.nostr_picture;
      obs.observerName = playerData.nostr_name || (playerData.npub ? playerData.npub.slice(0, 12) + '...' : obs.observerName);

      socket.emit('observer-authenticated', {
        observerName: obs.observerName,
        userId: obs.userId,
        nostrName: obs.nostrName,
        nostrPicture: obs.nostrPicture
      });

      console.log(`[Observer] ${obs.observerName} authenticated while observing ${obs.tableId}`);

      // Update waitlist entry if applicable
      const wl = waitlists.get(obs.tableId);
      if (wl) {
        const entry = wl.find(w => w.socketId === socket.id);
        if (entry) {
          entry.userId = obs.userId;
          entry.observerName = obs.observerName;
        }
      }

      broadcastGameState(obs.tableId);
    });

    // ==================== WAITLIST ====================

    socket.on('join-waitlist', ({ tableId }) => {
      const obs = observerSockets.get(socket.id);
      if (!obs || obs.tableId !== tableId) return;

      if (!waitlists.has(tableId)) waitlists.set(tableId, []);
      const wl = waitlists.get(tableId);

      // Prevent duplicate entries
      if (wl.some(w => w.socketId === socket.id)) return;

      wl.push({
        socketId: socket.id,
        userId: obs.userId || null,
        observerName: obs.observerName,
        offeredAt: null
      });

      console.log(`[Waitlist] ${obs.observerName} joined waitlist for ${tableId} (position ${wl.length})`);
      broadcastGameState(tableId);
    });

    socket.on('leave-waitlist', ({ tableId }) => {
      removeFromWaitlist(socket.id, tableId);
      broadcastGameState(tableId);
    });

    socket.on('waitlist-accept', ({ tableId }) => {
      const wl = waitlists.get(tableId);
      if (!wl || wl.length === 0) return;

      // Only the person who was offered can accept
      if (wl[0].socketId !== socket.id || !wl[0].offeredAt) return;

      // Remove from waitlist
      wl.shift();

      // Tell frontend to show buy-in dialog
      socket.emit('seat-offer-accepted', { tableId });
      broadcastGameState(tableId);
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
        senderId: user ? user.userId : (observer ? observer.userId || null : null),
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
        // Only enforced when player left with MORE than max buy-in (i.e. they won chips)
        let requestedBuyIn = typeof buyIn === 'number'
          ? Math.max(config.MIN_BUYIN, Math.min(config.MAX_BUYIN, Math.floor(buyIn)))
          : config.MAX_BUYIN;

        let chips;
        const recentDeparture = playerData.left_at
          && (Date.now() - playerData.left_at * 1000) < config.RATHOLE_WINDOW_MS
          && playerData.current_chips > config.MAX_BUYIN;
        if (recentDeparture) {
          chips = playerData.current_chips;
          console.log(`[Server] Anti-rathole: ${displayName} must return with ${chips} chips (left with ${playerData.current_chips}, max buy-in is ${config.MAX_BUYIN})`);
        } else {
          chips = requestedBuyIn;
          console.log(`[Server] ${displayName} buying in for ${chips} playsats`);
        }
        db.db.prepare('UPDATE players SET current_chips = ? WHERE user_id = ?').run(chips, userId);

        // Clean up observer + waitlist tracking
        if (observerSockets.has(socket.id)) {
          observerSockets.delete(socket.id);
        }
        removeFromWaitlist(socket.id, tableId);

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

    socket.on('action', ({ tableId, action, amount, actionId }) => {
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

      // Deduplication guard: if actionId was already processed, silently re-broadcast
      // current state (idempotent) instead of processing again
      if (actionId && game.processedActionIds && game.processedActionIds.has(actionId)) {
        console.log(`[Server] Duplicate action ${actionId} from ${user.userId.slice(0, 8)}... — ignoring`);
        broadcastGameState(tableId);
        return;
      }

      const result = game.processAction(user.userId, action, amount);
      if (!result.valid) {
        socket.emit('error', { message: result.error });
        return;
      }

      // Record actionId to prevent duplicate processing
      if (actionId && game.processedActionIds) {
        game.processedActionIds.add(actionId);
      }

      broadcastGameState(tableId);
    });

    // ==================== LEAVE TABLE ====================

    socket.on('leave-table', (...args) => {
      // Support optional ack callback (last arg if it's a function)
      const ack = typeof args[args.length - 1] === 'function' ? args.pop() : null;

      const user = socketUsers.get(socket.id);
      if (!user) {
        if (ack) ack({ ok: true });
        return;
      }

      const leavingTableId = user.tableId;
      const game = games.get(leavingTableId);
      if (game) {
        game.removePlayer(user.userId);
        socket.leave(`table-${leavingTableId}`);

        if (game.players.every(p => p === null)) {
          games.delete(leavingTableId);
          console.log(`Table ${leavingTableId} destroyed (empty)`);
          nostr.scheduleLiveActivityUpdate(leavingTableId, games, true);
        } else {
          broadcastGameState(leavingTableId);
          nostr.scheduleLiveActivityUpdate(leavingTableId, games);
          checkWaitlist(leavingTableId);
        }
      }

      userSockets.delete(user.userId);
      socketUsers.delete(socket.id);

      if (ack) ack({ ok: true });
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
        removeFromWaitlist(socket.id, obs.tableId);
        observerSockets.delete(socket.id);
        // Update observer count for remaining clients
        if (games.has(obs.tableId)) broadcastGameState(obs.tableId);
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
