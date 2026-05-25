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
function setup(io, games, userSockets, socketUsers, observerSockets, broadcastGameState, waitlists, getPayments = () => null) {

  // paymentHash -> socket.id of the player who requested that buy-in. Lets a
  // settled deposit seat the exact requesting socket instantly, without relying
  // on a userId->socket lookup that can miss if the observer entry is anonymous.
  const buyinSockets = new Map();

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
      // Real-money stacks live in the Lightning ledger, NOT players.current_chips —
      // never write a real-sat stack into the play-money column (keeps the two worlds
      // strictly separate so a play-money bug can't touch real funds).
      if (config.isRealMoney(tableId)) return;
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

    games.set(tableId, game);
    console.log(`[Server] Created game for table ${tableId} (${tableConfig.name} ${tableConfig.smallBlind}/${tableConfig.bigBlind})`);
  }

  // ==================== CONNECTION HANDLER ====================

  io.on('connection', (socket) => {
    console.log(`Client connected: ${socket.id}`);

    // ==================== OBSERVE ====================

    socket.on('observe-table', ({ tableId, sessionToken }) => {
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

      // Only create game instance for open-mode tables or tables that already have players
      const tc = config.TABLE_CONFIGS[tableId];
      if (tc.mode === 'open' || games.has(tableId)) {
        ensureGameExists(tableId);
      }

      // Broadcast updated observer count to all clients
      if (games.has(tableId)) broadcastGameState(tableId);

      // Real-money: if they already paid a buy-in but weren't seated (socket churned
      // while paying in a wallet app), claim it now that they're connected.
      if (userId && config.isRealMoney(tableId)) claimDeposits(userId, tableId, socket.id);
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

      // Now that we know who they are, claim any settled-but-unseated deposit.
      if (config.isRealMoney(obs.tableId)) claimDeposits(obs.userId, obs.tableId, socket.id);

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

        // Real-money tables: you cannot take a fresh seat for free — chips must be
        // backed by a paid Lightning deposit. (Reconnection to an existing seat was
        // handled above and is always allowed.) Seating happens via the deposit
        // settlement flow (buyin-request -> pay invoice -> seatFromDeposit).
        if (config.isRealMoney(tableId)) {
          socket.emit('error', { message: 'Buy in with sats to take a seat at this table.' });
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

      // Real-money: you cannot just walk away from chips — that would orphan real
      // sats. You must cash out your stack (which routes the payout). Leaving is
      // only allowed once your stack is empty (e.g. you busted).
      if (game && config.isRealMoney(leavingTableId)) {
        const p = game.players.find(x => x && x.userId === user.userId);
        if (p && p.stack > 0) {
          socket.emit('error', { message: 'Cash out your stack to leave this table.' });
          if (ack) ack({ ok: false, error: 'cashout-required' });
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
        if (obs) obs.userId = userId;
        // If they already paid a buy-in that wasn't seated (reconnected after paying),
        // claim it instead of issuing a NEW invoice — prevents accidental double payment.
        if (claimDeposits(userId, tableId, socket.id)) {
          console.log(`[Wallet] Claimed existing unseated deposit for ${userId.slice(0, 8)}... — no new invoice issued`);
          return;
        }
        const tc = config.TABLE_CONFIGS[tableId];
        // Honor the player's chosen buy-in, clamped to the table's [min,max] range.
        const requested = Math.floor(Number(amountSats));
        const amt = (Number.isFinite(requested) && requested > 0)
          ? Math.max(tc.minBuyin, Math.min(tc.maxBuyin, requested))
          : tc.maxBuyin;
        const inv = await payments.createDepositInvoice({ userId, tableId, amountSats: amt });
        buyinSockets.set(inv.paymentHash, socket.id); // seat THIS socket when it settles
        socket.emit('buyin-invoice', { bolt11: inv.bolt11, paymentHash: inv.paymentHash, amountSats: inv.amountSats });
        console.log(`[Wallet] Buy-in invoice ${inv.paymentHash.slice(0, 12)}... for ${inv.amountSats} sats (${userId.slice(0, 8)}...)`);
      } catch (e) {
        socket.emit('error', { message: e.message });
      }
    });

    // ==================== REAL-MONEY: CASH-OUT ====================

    socket.on('cashout-request', async ({ tableId, sessionToken }) => {
      try {
        if (!config.isRealMoney(tableId)) { socket.emit('error', { message: 'Not a real-money table' }); return; }
        const payments = getPayments();
        if (!payments) { socket.emit('error', { message: 'Real-money is not available right now' }); return; }
        const user = socketUsers.get(socket.id);
        const playerData = sessionToken ? db.getPlayerBySession(sessionToken) : null;
        if (!user || !playerData || playerData.pubkey_hex !== user.userId) {
          socket.emit('error', { message: 'Not authorized to cash out this seat' }); return;
        }
        // Cash out the current stack to the Lightning address on their Nostr profile.
        const res = await payments.cashoutToAddress({ userId: user.userId, tableId, lud16: playerData.lud16 });
        socket.emit('cashout-result', res);
        if (res.status === 'succeeded' || res.status === 'in_flight') {
          // requestWithdrawal already removed the player from the game.
          socket.leave(`table-${tableId}`);
          userSockets.delete(user.userId);
          socketUsers.delete(socket.id);
          broadcastGameState(tableId);
          nostr.scheduleLiveActivityUpdate(tableId, games);
        }
        // 'failed' -> refundToPlayer re-seated them; mappings handled there.
      } catch (e) {
        socket.emit('error', { message: e.message });
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

  // ==================== REAL-MONEY SEATING HELPERS ====================
  // Invoked by the payments service (onSeatPlayer / onRefund) — defined at setup
  // scope because they act across sockets, not on a single connection.

  function findSocketId(userId) {
    let socketId = userSockets.get(userId) || null;
    if (!socketId) {
      for (const [sid, obs] of observerSockets) { if (obs.userId === userId) { socketId = sid; break; } }
    }
    return socketId;
  }

  // Seat a player after their deposit settles. If their socket isn't connected at
  // the settlement instant (e.g. they switched to a wallet app to pay and the
  // socket churned), hold as settled_unseated — it will be CLAIMED automatically
  // when they reconnect / observe / re-request a buy-in (see claimDeposits).
  function seatFromDeposit(row) {
    // Prefer the exact socket that requested this buy-in; fall back to a userId lookup.
    const socketId = (buyinSockets.get(row.payment_hash) && io.sockets.sockets.has(buyinSockets.get(row.payment_hash)))
      ? buyinSockets.get(row.payment_hash)
      : findSocketId(row.user_id);
    if (!socketId) {
      db.updateLedgerStatus(row.id, 'settled_unseated');
      console.error(`[Wallet] Deposit ${row.payment_hash} settled but ${row.user_id.slice(0, 8)}... not connected yet — held as settled_unseated; will auto-seat on reconnect.`);
      return;
    }
    buyinSockets.delete(row.payment_hash);
    seatDepositRow(row, socketId);
  }

  // Core seating: put `userId` from a settled deposit `row` into a seat using
  // `socketId`. Idempotent — if already seated, just marks the row consumed.
  // Returns true if the player is seated. Used by seatFromDeposit AND claimDeposits.
  function seatDepositRow(row, socketId) {
    const { user_id: userId, table_id: tableId, amount_sats: amount } = row;
    if (!socketId) return false;
    const playerData = db.getPlayerByPubkey(userId);
    const displayName = (playerData && (playerData.nostr_name || playerData.username)) || userId.slice(0, 8);
    ensureGameExists(tableId);
    const game = games.get(tableId);

    // Already seated (claimed via another trigger / reconnect)? Mark consumed.
    if (game.players.find(p => p && p.userId === userId)) {
      db.updateLedgerStatus(row.id, 'settled');
      return true;
    }

    let assignedSeat;
    try {
      assignedSeat = game.addPlayer(userId, displayName, {
        initialStack: amount,
        nostrName: playerData && playerData.nostr_name,
        nostrPicture: playerData && playerData.nostr_picture,
        lud16: (playerData && playerData.lud16) || null,
        preferredSeat: typeof row.seat_index === 'number' ? row.seat_index : undefined,
      });
    } catch (e) {
      db.updateLedgerStatus(row.id, 'settled_unseated');
      io.to(socketId).emit('error', { message: 'Table is full — your deposit will be refunded.' });
      console.error(`[Wallet][ALERT] Deposit ${row.payment_hash}: seating failed (${e.message}) — settled_unseated`);
      return false;
    }

    db.updateLedgerStatus(row.id, 'settled'); // consumed (credited + seated)
    const sock = io.sockets.sockets.get(socketId);
    if (sock) sock.join(`table-${tableId}`);
    observerSockets.delete(socketId);
    userSockets.set(userId, socketId);
    socketUsers.set(socketId, { userId, tableId, seatIndex: assignedSeat });
    io.to(socketId).emit('seat-assigned', { seatIndex: assignedSeat, displayName });
    io.to(socketId).emit('deposit-confirmed', { tableId, amountSats: amount, paymentHash: row.payment_hash });
    broadcastGameState(tableId);
    nostr.scheduleLiveActivityUpdate(tableId, games);
    console.log(`[Wallet] Seated ${displayName} at ${tableId} seat ${assignedSeat + 1} from deposit ${row.payment_hash.slice(0, 12)}... (${amount} sats)`);
    return true;
  }

  // Seat the player from any settled-but-unseated deposit they have on this table.
  // Called when an authenticated user (re)connects/observes a real-money table or
  // re-requests a buy-in — makes seating resilient to socket churn while paying.
  function claimDeposits(userId, tableId, socketId) {
    if (!config.isRealMoney(tableId) || !userId || !socketId) return false;
    let claimed = false;
    for (const row of db.getUnseatedDeposits(userId, tableId)) {
      if (seatDepositRow(row, socketId)) claimed = true;
    }
    return claimed;
  }

  // Re-credit a player after a DEFINITIVE failed withdrawal — their chips were
  // removed when the cash-out reserved, so re-seat them with the amount.
  function refundToPlayer(row) {
    const { user_id: userId, table_id: tableId, amount_sats: amount } = row;
    const socketId = findSocketId(userId);
    const playerData = db.getPlayerByPubkey(userId);
    const displayName = (playerData && (playerData.nostr_name || playerData.username)) || userId.slice(0, 8);
    ensureGameExists(tableId);
    const game = games.get(tableId);
    try {
      const seat = game.addPlayer(userId, displayName, {
        initialStack: amount,
        nostrName: playerData && playerData.nostr_name,
        nostrPicture: playerData && playerData.nostr_picture,
        lud16: (playerData && playerData.lud16) || null,
      });
      if (socketId) {
        const sock = io.sockets.sockets.get(socketId);
        if (sock) sock.join(`table-${tableId}`);
        userSockets.set(userId, socketId);
        socketUsers.set(socketId, { userId, tableId, seatIndex: seat });
        io.to(socketId).emit('cashout-failed', { tableId, amountSats: amount, message: 'Payment failed — your chips were returned to the table.' });
        io.to(socketId).emit('seat-assigned', { seatIndex: seat, displayName });
      }
      broadcastGameState(tableId);
      console.log(`[Wallet] Refund re-seated ${displayName} at ${tableId} seat ${seat + 1} (${amount} sats) after failed withdrawal ${row.payment_hash.slice(0, 12)}...`);
    } catch (e) {
      console.error(`[Wallet][ALERT] Refund for ${row.payment_hash} could not re-seat (${e.message}) — ${amount} sats owed to ${userId.slice(0, 8)}..., manual handling needed`);
    }
  }

  return { seatFromDeposit, refundToPlayer };
}

module.exports = { setup };
