/**
 * WebSocket event handlers — all Socket.IO logic extracted from server.js.
 * Handles join-table, action, leave-table, sit-out, rebuy, disconnect, observer, chat.
 */

const config = require('./config');
const db = require('./database');
const PokerGame = require('./poker-game');
const nostr = require('./services/nostr');
const { authenticatedSocketId } = require('./socket-session');

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
function setup(io, games, userSockets, socketUsers, observerSockets, broadcastGameState, waitlists, getPayments = () => null, getAccountPayments = getPayments) {

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

    const tableConfig = config.TABLE_CONFIGS[tableId];
    if (!tableConfig) return; // Invalid table

    const game = new PokerGame(tableId, {
      smallBlind: tableConfig.smallBlind,
      bigBlind: tableConfig.bigBlind,
      minBuyin: tableConfig.minBuyin,
      maxBuyin: tableConfig.maxBuyin,
      realMoney: config.isRealMoney(tableId),
    });

    wireGame(tableId, game);
    games.set(tableId, game);
    console.log(`[Server] Created game for table ${tableId}`);
  }

  function wireGame(tableId, game) {

    game.onStateChange = () => {
      game.saveSnapshot();
      // Idle kicks and deferred departures also need to release the socket's
      // seat mapping so it continues receiving the public table state.
      for (const [socketId, seated] of socketUsers) {
        if (seated.tableId !== tableId || game.players.some(p => p?.userId === seated.userId)) continue;
        socketUsers.delete(socketId);
        if (userSockets.get(seated.userId) === socketId) userSockets.delete(seated.userId);
        const socket = io.sockets.sockets.get(socketId);
        if (socket) {
          const player = db.getPlayerBySession(socket.data?.sessionToken);
          observerSockets.set(socketId, { tableId, userId: player?.pubkey_hex || null,
            observerName: player?.nostr_name || player?.username || generateObserverName(),
            nostrName: player?.nostr_name || null, nostrPicture: player?.nostr_picture || null });
        }
      }
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
      const socketId = authenticatedSocketId(io, userSockets, userId);
      if (socketId) {
        io.to(socketId).emit('hand-log', { line, type: 'deal' });
      }
    };

    game.onHandComplete = (userId, historyText, handId) => {
      const socketId = authenticatedSocketId(io, userSockets, userId);
      if (socketId) {
        io.to(socketId).emit('hand-complete', { history: historyText, handId });
      }
    };

    game.onPlayerLeaving = (userId, stack) => {
      // Real-money stacks live in the Lightning ledger, NOT players.current_chips —
      // never write a real-sat stack into the play-money column (keeps the two worlds
      // strictly separate so a play-money bug can't touch real funds).
      if (game.realMoney) {
        db.creditAccount(userId, tableId, 'table_cashout', stack);
        return;
      }
      try {
        db.updatePlayerLeftAt(userId, stack, tableId);
        console.log(`[Server] Saved departure: ${userId.slice(0, 8)}... with ${stack} chips from ${tableId}`);
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

  }

  function resumeExistingSeat(socket, userId, tableId, displayName) {
    if (socket.data?.watchOnly) return false;
    const game = games.get(tableId);
    const seatIndex = game?.players.findIndex(player => player && player.userId === userId) ?? -1;
    if (seatIndex === -1 || db.isBanned(userId) || db.isIpBanned(socket.handshake.address)) return false;
    const previousSocket = userSockets.get(userId);
    if (previousSocket && previousSocket !== socket.id) socketUsers.delete(previousSocket);
    observerSockets.delete(socket.id);
    removeFromWaitlist(socket.id, tableId);
    userSockets.set(userId, socket.id);
    socketUsers.set(socket.id, { userId, tableId, seatIndex });
    game.setDisconnected(userId, false);
    socket.join(`table-${tableId}`);
    socket.emit('seat-assigned', { seatIndex, displayName });
    broadcastGameState(tableId);
    return true;
  }

  // ==================== CONNECTION HANDLER ====================

  io.on('connection', (socket) => {
    console.log(`Client connected: ${socket.id}`);
    socket.data ||= {};
    // Phone play is paused. Keep this connection on public spectator state,
    // even when it authenticates with an account that already has a seat.
    socket.data.watchOnly = socket.handshake.auth?.watchOnly === true ||
      /Android|iPhone|iPod|webOS|BlackBerry|Opera Mini|IEMobile/i.test(socket.handshake.headers?.['user-agent'] || '') ||
      socket.handshake.headers?.['sec-ch-ua-mobile'] === '?1';
    const playEvents = new Set(['join-table', 'join-waitlist', 'waitlist-accept',
      'action', 'sit-back-in', 'sit-out', 'rebuy', 'buyin-request']);
    // Reject malformed packets before destructuring event payloads or hashing
    // tokens. A public observer must not be able to crash the process with null.
    const objectEvents = new Set(['observe-table', 'observer-authenticate', 'join-waitlist',
      'leave-waitlist', 'waitlist-accept', 'chat-message', 'join-table', 'action',
      'sit-back-in', 'sit-out', 'rebuy', 'buyin-request', 'cashout-request', 'wallet-state-request', 'account-deposit-request', 'table-cashout-request']);
    socket.use(([event, payload], next) => {
      if (objectEvents.has(event) && (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
          (payload.sessionToken !== undefined && (typeof payload.sessionToken !== 'string' || payload.sessionToken.length > 256)))) {
        socket.emit('error', { message: 'Invalid request payload' });
        return;
      }
      if (socket.data.watchOnly && playEvents.has(event)) {
        socket.emit('error', { message: 'Phones are watch-only for now. Use a desktop to play.' });
        return;
      }
      const seated = socketUsers.get(socket.id);
      if (seated && payload?.sessionToken !== undefined &&
          db.getPlayerBySession(payload.sessionToken)?.pubkey_hex !== seated.userId) {
        socket.emit('auth-error', { message: 'Reconnect before switching accounts.' });
        return;
      }
      if (seated && event === 'observe-table') {
        // Repeated observation must not turn a seated connection into a second
        // observer channel or leave its old seat attached to an anonymous page.
        if (db.getPlayerBySession(payload.sessionToken)?.pubkey_hex !== seated.userId || payload.tableId !== seated.tableId) {
          socket.emit('auth-error', { message: 'Reconnect before changing tables or accounts.' });
          return;
        }
      }
      const actor = seated || (event === 'chat-message' ? observerSockets.get(socket.id) : null);
      if (['action','sit-back-in','sit-out','rebuy','leave-table','chat-message'].includes(event) && actor?.userId) {
        const player = db.getPlayerBySession(socket.data.sessionToken);
        if (!player || player.pubkey_hex !== actor.userId) {
          socket.emit('auth-error', { message: 'Session expired or signed out. Sign in again to resume.' });
          return;
        }
      }
      if (seated && ['action','sit-back-in','sit-out','rebuy'].includes(event) && payload.tableId !== seated.tableId) {
        socket.emit('error', { message: 'Invalid table for this seat' });
        return;
      }
      next();
    });

    // ==================== OBSERVE ====================

    socket.on('observe-table', ({ tableId, sessionToken, resumeSeat = true }) => {
      // Validate table exists
      if (!config.TABLE_CONFIGS[tableId]) {
        socket.emit('error', { message: 'Invalid table' });
        return;
      }

      let observerName = generateObserverName();
      let userId = null;
      let nostrName = null;
      let nostrPicture = null;

      // Optional authentication for observers
      if (sessionToken) {
        const playerData = db.getPlayerBySession(sessionToken);
        if (playerData) {
          socket.data.sessionToken = sessionToken;
          userId = playerData.pubkey_hex;
          nostrName = playerData.nostr_name;
          nostrPicture = playerData.nostr_picture;
          observerName = nostrName || (playerData.npub ? playerData.npub.slice(0, 12) + '...' : observerName);
          console.log(`[Observer] Authenticated: ${observerName} (${userId.slice(0, 8)}...)`);
        }
        // If session is invalid, silently fall back to anonymous observer
      }

      observerSockets.set(socket.id, { observerName, tableId, userId, nostrName, nostrPicture, resumeSeat });
      socket.join(`table-${tableId}`);
      console.log(`Observer ${observerName} (${socket.id}) watching table ${tableId}`);

      socket.emit('observer-joined', { observerName, userId, nostrName, nostrPicture });

      // Only create game instance for open-mode tables or tables that already have players
      const tc = config.TABLE_CONFIGS[tableId];
      if (tc.mode === 'open' || games.has(tableId)) {
        ensureGameExists(tableId);
      }

      if (userId && resumeSeat !== false && resumeExistingSeat(socket, userId, tableId, observerName)) return;

      // Broadcast updated observer count to all clients
      if (games.has(tableId)) broadcastGameState(tableId);

      // Real-money: if they already paid a buy-in but weren't seated (socket churned
      // while paying in a wallet app), claim it now that they're connected.
      if (userId && config.isRealMoney(tableId)) db.getAccountBalance(userId);
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

      socket.data.sessionToken = sessionToken;
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

      if (obs.resumeSeat !== false && resumeExistingSeat(socket, obs.userId, obs.tableId, obs.observerName)) return;

      // Now that we know who they are, claim any settled-but-unseated deposit.
      if (config.isRealMoney(obs.tableId)) db.getAccountBalance(obs.userId);

      // Update waitlist entry if applicable
      const wl = waitlists.get(obs.tableId);
      if (wl) {
        const entry = wl.find(w => w.socketId === socket.id);
        if (entry) {
          entry.userId = obs.userId;
          entry.observerName = obs.observerName;
        }
      }

      if (games.has(obs.tableId)) broadcastGameState(obs.tableId);
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
      const tableId = requestedTableId;
      const tableConfig = config.TABLE_CONFIGS[tableId];
      if (!tableConfig) {
        socket.emit('error', { message: 'Invalid table' });
        return;
      }

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

        socket.data.sessionToken = sessionToken;
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

        // Buy-in with anti-rathole rules (per-table limits)
        let requestedBuyIn = typeof buyIn === 'number'
          ? Math.max(tableConfig.minBuyin, Math.min(tableConfig.maxBuyin, Math.floor(buyIn)))
          : tableConfig.maxBuyin;

        let chips;
        const sameTable = playerData.left_table === tableId;
        const recentDeparture = sameTable
          && playerData.left_at
          && (Date.now() - playerData.left_at * 1000) < config.RATHOLE_WINDOW_MS
          && playerData.current_chips > tableConfig.maxBuyin;
        if (recentDeparture) {
          chips = playerData.current_chips;
          console.log(`[Server] Anti-rathole: ${displayName} must return with ${chips} chips (left ${tableId} with ${playerData.current_chips}, max buy-in is ${tableConfig.maxBuyin})`);
        } else {
          chips = requestedBuyIn;
          console.log(`[Server] ${displayName} buying in for ${chips} playsats at ${tableConfig.name}`);
        }

        // Clean up observer + waitlist tracking
        if (observerSockets.has(socket.id)) {
          observerSockets.delete(socket.id);
        }
        removeFromWaitlist(socket.id, tableId);

        // A refresh or a new signed session resumes the funded seat without
        // issuing another invoice or losing the personal game-state channel.
        if (resumeExistingSeat(socket, userId, tableId, displayName)) return;

        // Real-money tables: you cannot take a fresh seat for free — chips must be
        // backed by a paid Lightning deposit. (Reconnection to an existing seat was
        // handled above and is always allowed.) Seating happens via the deposit
        // settlement flow (buyin-request -> pay invoice -> seatFromDeposit).
        if (config.isRealMoney(tableId)) {
          // Session restoration may refer to an old seat (cash-out, idle exit,
          // or failed payout). Keep the user connected as an authenticated
          // observer so their independent balance is still accessible.
          observerSockets.set(socket.id, { observerName: displayName, tableId, userId, nostrName, nostrPicture });
          socket.join(`table-${tableId}`);
          ensureGameExists(tableId);
          socket.emit('observer-joined', { observerName: displayName, userId, nostrName, nostrPicture });
          broadcastGameState(tableId);
          return;
        }

        // Create game & add player — persist buy-in to DB only now, since the
        // reconnect branch above doesn't spend chips and mustn't clobber the
        // live in-memory stack between hands.
        ensureGameExists(tableId);
        const game = games.get(tableId);

        db.db.prepare('UPDATE players SET current_chips = ? WHERE user_id = ?').run(chips, userId);

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
          game.setDisconnected(userId, false);
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

    socket.on('action', ({ tableId, action, amount, actionId, handCount }) => {
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

      // The engine snapshots action IDs with the mutation, so recovery cannot
      // apply a previously committed action for a second time.
      const result = game.processAction(user.userId, action, amount, { actionId, handCount });
      if (!result.valid) {
        socket.emit('error', { message: result.error });
        return;
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

      if (game && config.isRealMoney(leavingTableId)) {
        const funds = game.canCashOut(user.userId);
        if (!funds.ok) {
          game.voluntarySitOut(user.userId);
          socket.emit('error', { message: 'Finish this hand before returning your stack to your account.' });
          if (ack) ack({ ok: false, error: 'hand-in-progress' });
          return;
        }
      }

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

      // Real-money: a "rebuy" would mint free chips. Adding chips must be a new
      // paid deposit. (The engine also refuses, but reject early with a clear msg.)
      if (config.isRealMoney(tableId)) {
        socket.emit('error', { message: 'Buy in with sats to add chips on this table.' });
        return;
      }

      const amount = typeof buyIn === 'number'
        ? Math.max(game.minBuyin, Math.min(game.maxBuyin, Math.floor(buyIn)))
        : game.maxBuyin;

      const result = game.rebuy(user.userId, amount);
      if (result.success) {
        db.db.prepare('UPDATE players SET current_chips = ? WHERE user_id = ?').run(result.chips, user.userId);
        console.log(`[Server] Rebuy persisted: ${user.userId.slice(0, 8)}... → ${result.chips} chips`);
        broadcastGameState(tableId);
      } else {
        socket.emit('error', { message: result.error });
      }
    });

    // ==================== REAL-MONEY: BUY-IN ====================

    socket.on('buyin-request', async ({ tableId, sessionToken, amountSats }) => {
      try {
        if (!config.isRealMoney(tableId)) { socket.emit('error', { message: 'Not a real-money table' }); return; }
        const payments = getPayments();
        if (!payments) { socket.emit('error', { message: 'Real-money is not available right now' }); return; }
        const playerData = sessionToken ? db.getPlayerBySession(sessionToken) : null;
        if (!playerData) { socket.emit('auth-error', { message: 'Sign in to buy in' }); return; }
        socket.data.sessionToken = sessionToken;
        const userId = playerData.pubkey_hex;
        const clientIp = socket.handshake.address;
        if (db.isIpBanned(clientIp) || db.isBanned(userId)) { socket.emit('error', { message: 'Not allowed' }); return; }
        if (db.isRateLimited(userId, clientIp, config.JOIN_RATE_LIMIT.windowSec, config.JOIN_RATE_LIMIT.maxActions)) {
          socket.emit('error', { message: 'Too many actions. Please wait.' }); return;
        }
        // Tie this live socket to the authenticated user, so the deposit can seat
        // them the instant it settles (their observer entry may still be anonymous
        // if they signed in after they started observing).
        const obs = observerSockets.get(socket.id);
        db.logAction(userId, clientIp, 'buyin-request');
        if (obs) obs.userId = userId;
        ensureGameExists(tableId);
        const seatIndex = payments.buyInFromAccount({ userId, tableId, amountSats, player: playerData });
        resumeExistingSeat(socket, userId, tableId, playerData.nostr_name || playerData.username);
        socket.emit('account-buyin-confirmed', { tableId, seatIndex, amountSats });
        nostr.scheduleLiveActivityUpdate(tableId, games);
      } catch (e) {
        socket.emit('error', { message: e.message });
      }
    });

    // ==================== REAL-MONEY: CASH-OUT ====================

    socket.on('account-deposit-request', async ({ tableId, sessionToken, amountSats }) => {
      try {
        if (!config.isRealMoney(tableId)) throw new Error('Real-money accounts are unavailable in demo mode');
        const player = sessionToken && db.getPlayerBySession(sessionToken);
        if (!player) { socket.emit('auth-error', { message: 'Sign in to deposit' }); return; }
        const userId = player.pubkey_hex;
        if (db.isBanned(userId) || db.isIpBanned(socket.handshake.address)) throw new Error('Not allowed');
        if (db.isRateLimited(userId, socket.handshake.address, config.JOIN_RATE_LIMIT.windowSec, config.JOIN_RATE_LIMIT.maxActions)) throw new Error('Too many requests. Please wait.');
        db.logAction(userId, socket.handshake.address, 'account-deposit-request');
        const payments = getPayments();
        if (!payments) throw new Error('Account wallet is temporarily unavailable');
        const invoice = await payments.createDepositInvoice({ userId, tableId: db.ACCOUNT, amountSats });
        socket.emit('buyin-invoice', { ...invoice, userId, tableId });
      } catch (error) { socket.emit('error', { message: error.message }); }
    });

    socket.on('table-cashout-request', ({ tableId, sessionToken }) => {
      try {
        const player = sessionToken && db.getPlayerBySession(sessionToken);
        if (!player) { socket.emit('auth-error', { message: 'Sign in to return your stack' }); return; }
        const payments = getAccountPayments();
        if (!payments) throw new Error('Account wallet is temporarily unavailable');
        const game = games.get(tableId);
        if (game?.handInProgress && game.players.some(p => p && p.userId === player.pubkey_hex && p.participatedThisHand && !p.sittingOutNextHand && !p.sittingOut)) game.voluntarySitOut(player.pubkey_hex);
        const result = payments.returnStackToAccount({ userId: player.pubkey_hex, tableId });
        const seatedSocket = userSockets.get(player.pubkey_hex);
        if (socketUsers.get(seatedSocket)?.tableId === tableId) {
          socketUsers.delete(seatedSocket);
          userSockets.delete(player.pubkey_hex);
          io.to(seatedSocket).emit('account-table-cashout', { tableId, ...result });
        }
        if (seatedSocket !== socket.id) socket.emit('account-table-cashout', { tableId, ...result });
        broadcastGameState(tableId);
        checkWaitlist(tableId);
        nostr.scheduleLiveActivityUpdate(tableId, games);
      } catch (error) { socket.emit('error', { message: error.message }); }
    });

    socket.on('cashout-request', async ({ tableId, sessionToken, bolt11 }) => {
      try {
        if (!config.isRealMoney(tableId)) throw new Error('Real-money accounts are unavailable in demo mode');
        const player = sessionToken && db.getPlayerBySession(sessionToken);
        if (!player) { socket.emit('auth-error', { message: 'Sign in to withdraw' }); return; }
        const payments = getPayments();
        if (!payments) throw new Error('Account wallet is temporarily unavailable');
        const result = await payments.requestWithdrawal({ userId: player.pubkey_hex, tableId: db.ACCOUNT, bolt11,
          onReserved: summary => socket.emit('cashout-pending', summary) });
        socket.emit('cashout-result', result);
      } catch (error) { socket.emit('error', { message: error.message }); }
    });

    socket.on('wallet-state-request', ({ tableId, sessionToken } = {}) => {
      const player = sessionToken && db.getPlayerBySession(sessionToken);
      if (!player || !config.TABLE_CONFIGS[tableId]) return;
      try {
        const payments = getPayments();
        const availableSats = db.getAccountBalance(player.pubkey_hex);
        const stack = games.get(tableId)?.players.find(p => p && p.userId === player.pubkey_hex);
        const tableFunds = stack && games.get(tableId).canCashOut(player.pubkey_hex);
        socket.emit('wallet-state', { tableId, userId: player.pubkey_hex, availableSats,
          tableStackSats: stack?.stack || 0, seated: !!stack, canReturnStack: !!tableFunds?.ok,
          error: !payments ? 'Account wallet is temporarily unavailable. Your balance remains recorded.' : undefined,
          payments: db.db.prepare("SELECT payment_hash,amount_sats,status FROM ledger_entries WHERE user_id=? AND direction='withdrawal' ORDER BY id DESC LIMIT 20").all(player.pubkey_hex),
          deposits: db.getWalletDeposits(player.pubkey_hex, db.ACCOUNT).map(row => ({ ...row, expiresAt: row.expires_at || row.created_at + config.LIGHTNING.invoiceExpirySec })),
          transfers: db.getAccountHistory(player.pubkey_hex),
          depositsEnabled: !!payments?.depositsEnabled(),
          creditSats: availableSats, withdrawalsEnabled: !!payments?.withdrawalsEnabled() });
      } catch (error) { socket.emit('error', { message: error.message }); }
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
            game.setDisconnected(user.userId, true);
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
                player.sittingOutNextHand = true;
                // The action timer handles the current hand. Silently folding
                // every disconnected player at once can leave no pot winner.
                if (!game.handInProgress || !player.participatedThisHand || player.folded) {
                  player.sittingOut = true;
                  player.sitOutTime = Date.now();
                  game.startSitOutKickTimer(user.userId);
                }
                game.saveSnapshot();
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

  // ==================== REAL-MONEY SEATING HELPERS ====================
  // Invoked by the payments service (onSeatPlayer / onRefund) — defined at setup
  // scope because they act across sockets, not on a single connection.

  function findSocketId(userId) {
    let socketId = authenticatedSocketId(io, userSockets, userId);
    if (!socketId) {
      for (const [sid, obs] of observerSockets) {
        if (obs.userId === userId && db.getPlayerBySession(io.sockets.sockets.get(sid)?.data?.sessionToken)?.pubkey_hex === userId) {
          socketId = sid;
          break;
        }
      }
    }
    return socketId;
  }

  // Legacy table invoices issued before this upgrade settle into the account.
  function seatFromDeposit(row) {
    db.getAccountBalance(row.user_id);
    const socketId = findSocketId(row.user_id);
    if (socketId) io.to(socketId).emit('account-deposit-confirmed', { amountSats: row.amount_sats });
  }

  // A definitive failed payment is restored to the account before notification.
  function refundToPlayer(row) {
    const { user_id: userId, table_id: tableId, amount_sats: amount } = row;
    const socketId = findSocketId(userId);
    if (socketId) io.to(socketId).emit('cashout-failed', { tableId, amountSats: amount,
      message: 'Payment failed. Your funds are available in your account balance.' });
    if (config.TABLE_CONFIGS[tableId]) broadcastGameState(tableId);
  }

  return { seatFromDeposit, refundToPlayer, wireGame };
}

module.exports = { setup };
