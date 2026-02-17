/**
 * PokerGame - Server-authoritative poker game engine
 * Single source of truth for game state
 */

const { createDeck, shuffleSecure, evaluateHand } = require('../shared');
const db = require('./database');

const STARTING_STACK = 10000;
const SMALL_BLIND = 50;
const BIG_BLIND = 100;
const NUM_SEATS = 6;
const ACTION_TIMEOUT_MS = 20000; // 20 seconds
const SIT_OUT_KICK_MS = 300000; // 5 minutes

// Chip denominations — sorted high-to-low for greedy breakdown
const CHIP_DEFS = [
  { value: 10000, label: '10K', fill: '#B55239', text: '#F8F3EA' },
  { value: 5000,  label: '5K',  fill: '#2F3E5C', text: '#F8F3EA' },
  { value: 1000,  label: '1K',  fill: '#5A3D5C', text: '#F8F3EA' },
  { value: 500,   label: '500', fill: '#C46E3F', text: '#F8F3EA' },
  { value: 100,   label: '100', fill: '#3C8C84', text: '#F8F3EA' },
  { value: 50,    label: '50',  fill: '#D4A017', text: '#F8F3EA' },
  { value: 10,    label: '10',  fill: '#9FB8A5', text: '#F8F3EA' },
  { value: 5,     label: '5',   fill: '#8B7355', text: '#F8F3EA' },
  { value: 1,     label: '1',   fill: '#F3EBD9', text: '#F3EBD9' },
];


class PokerGame {
  constructor(tableId) {
    this.tableId = tableId;
    this.players = new Array(NUM_SEATS).fill(null);
    this.deck = [];
    this.communityCards = [];
    this.pot = 0;
    this.dealerSeat = 0;
    this.currentPlayerIndex = -1;
    this.phase = 'idle'; // idle, preflop, flop, turn, river, showdown
    this.lastRaise = BIG_BLIND;
    this.actedThisRound = [];
    this.handInProgress = false;
    this.handCount = 0;
    this.lastAggressor = -1;
    this.potChips = []; // Array of individual chip denomination objects for visual pot pile

    // Phase 5.4: Action timeouts & disconnect handling
    this.actionTimeout = null;
    this.sitOutKickTimers = new Map(); // userId -> timeout for kicking after 5 min

    // Hand history tracking
    this.currentHandLog = [];
    this.histSbIdx = -1;
    this.histBbIdx = -1;
  }

  // ==================== HAND HISTORY LOGGING ====================

  /**
   * Emit a hand log line — pushes to currentHandLog AND calls onHandLog callback
   * for real-time play-by-play in the client chat
   */
  emitLog(line, type) {
    this.currentHandLog.push(line);
    if (this.onHandLog) {
      this.onHandLog(line, type || 'log');
    }
  }

  /**
   * Format a card for PokerStars output (e.g., "Ah", "Td")
   */
  cardStr(c) {
    return c || '??';
  }

  cardsStr(cards) {
    return '[' + cards.map(c => this.cardStr(c)).join(' ') + ']';
  }

  seatPosition(idx) {
    if (idx === this.dealerSeat) return ' (button)';
    if (idx === this.histSbIdx) return ' (small blind)';
    if (idx === this.histBbIdx) return ' (big blind)';
    return '';
  }

  /**
   * Add player to table (auto-assigns seat)
   * @param {string} userId - Unique player ID (hex pubkey for NOSTR users)
   * @param {string} username - Display name (NOSTR name or npub short)
   * @param {object} opts - Optional: { initialStack, nostrName, nostrPicture }
   * @returns {number} - Assigned seat index (0-5)
   */
  addPlayer(userId, username, opts = {}) {
    // Idempotent guard — if player already seated, return their existing seat
    const existing = this.players.findIndex(p => p && p.userId === userId);
    if (existing !== -1) {
      console.log(`[PokerGame ${this.tableId}] ${username} already at seat ${existing + 1}, returning existing seat`);
      return existing;
    }

    // Find first available seat (server assigns, client doesn't choose)
    const seatIndex = this.players.findIndex(p => p === null);
    if (seatIndex === -1) {
      throw new Error('Table is full (6/6 seats occupied)');
    }

    this.players[seatIndex] = {
      userId,
      username,
      nostrName: opts.nostrName || null,
      nostrPicture: opts.nostrPicture || null,
      stack: opts.initialStack || STARTING_STACK,
      holeCards: [],
      folded: false,
      allIn: false,
      currentBet: 0,
      totalInvested: 0,
      seatIndex,
      sittingOut: false,
      disconnected: false,
      sitOutTime: null
    };

    console.log(`[PokerGame ${this.tableId}] Assigned ${username} to seat ${seatIndex + 1} (index ${seatIndex})`);

    // Start hand if enough players (2+) and no hand scheduled/in progress
    const activePlayers = this.players.filter(p => p !== null);
    console.log(`[PokerGame ${this.tableId}] Player joined - total: ${activePlayers.length}, handInProgress: ${this.handInProgress}, handScheduled: ${!!this.handStartTimeout}`);
    
    if (activePlayers.length >= 2 && !this.handInProgress && !this.handStartTimeout) {
      console.log(`[PokerGame ${this.tableId}] Scheduling hand start in 2 seconds...`);
      this.handStartTimeout = setTimeout(() => {
        this.handStartTimeout = null;
        this.startNewHand();
        // Notify server to broadcast updated state
        if (this.onStateChange) {
          this.onStateChange();
        }
      }, 2000);
    }
    
    return seatIndex; // Return assigned seat to caller
  }

  /**
   * Remove player from table
   * If a hand is in progress, fold them and defer removal until hand ends
   */
  removePlayer(userId) {
    const idx = this.players.findIndex(p => p && p.userId === userId);
    if (idx === -1) return;

    if (this.handInProgress) {
      // Don't null the seat mid-hand — their committed chips stay in the pot
      const player = this.players[idx];
      player.folded = true;
      player.sittingOut = true;
      player.disconnected = true;
      player._pendingRemoval = true;
      console.log(`[PokerGame ${this.tableId}] ${player.username} marked for removal after hand`);

      // If it was their turn, advance action
      if (this.currentPlayerIndex === idx) {
        this.advanceAction();
      }
    } else {
      this.players[idx] = null;
    }
  }

  /**
   * Clean up players marked for removal after hand ends
   */
  cleanupPendingRemovals() {
    for (let i = 0; i < this.players.length; i++) {
      if (this.players[i] && this.players[i]._pendingRemoval) {
        console.log(`[PokerGame ${this.tableId}] Removing ${this.players[i].username} (post-hand cleanup)`);
        this.players[i] = null;
      }
    }
  }

  /**
   * Start new hand
   */
  startNewHand() {
    const active = this.players.filter(p => p !== null && p.stack > 0 && !p.sittingOut);
    console.log(`[PokerGame ${this.tableId}] startNewHand() called - active players: ${active.length}`);
    if (active.length < 2) {
      console.log(`[PokerGame ${this.tableId}] Not enough players (need 2+), aborting`);
      return;
    }

    console.log(`[PokerGame ${this.tableId}] Starting hand #${this.handCount + 1}`);
    this.handInProgress = true;
    this.handCount++;
    this.handStartedAt = Date.now();
    this.pot = 0;
    this.potChips = [];
    this.communityCards = [];
    this.phase = 'preflop';
    this.actedThisRound = [];
    this.lastRaise = BIG_BLIND;
    this.lastAggressor = -1;
    this.currentHandLog = [];

    // Create and shuffle deck (crypto-secure)
    this.deck = shuffleSecure(createDeck());

    // Reset player states — sitting-out players don't participate
    this.players.forEach(p => {
      if (p) {
        p.holeCards = [];
        p.allIn = false;
        p.currentBet = 0;
        p.totalInvested = 0;
        p.startingStack = p.stack;
        p.actions = [];
        p._foldPhase = null;
        p._hasBet = false;
        p._histShare = 0;
        if (p.sittingOut) {
          p.folded = true;
          p.participatedThisHand = false;
        } else {
          p.folded = false;
          p.participatedThisHand = true;
        }
      }
    });

    // Move dealer button — skip sitting-out players
    this.dealerSeat = this.nextActiveSeat(this.dealerSeat);

    // Deal hole cards (only to participating players)
    for (let i = 0; i < 2; i++) {
      this.players.forEach(p => {
        if (p && !p.folded && !p.sittingOut) {
          p.holeCards.push(this.deck.pop());
        }
      });
    }

    // Post blinds — skip sitting-out players
    const sbSeat = this.nextActiveSeat(this.dealerSeat);
    const bbSeat = this.nextActiveSeat(sbSeat);
    this.histSbIdx = sbSeat;
    this.histBbIdx = bbSeat;
    this.placeBet(sbSeat, SMALL_BLIND);
    this.placeBet(bbSeat, BIG_BLIND);

    // === HAND HISTORY: Log hand start ===
    const now = new Date();
    const yr = now.getFullYear(), mo = String(now.getMonth()+1).padStart(2,'0'), dy = String(now.getDate()).padStart(2,'0');
    const hh = String(now.getHours()).padStart(2,'0'), mm = String(now.getMinutes()).padStart(2,'0'), ss = String(now.getSeconds()).padStart(2,'0');
    this.emitLog(`Satoshi Stacks Hand #${this.handCount}: Hold'em No Limit (${SMALL_BLIND}/${BIG_BLIND}) - ${yr}/${mo}/${dy} ${hh}:${mm}:${ss}`, 'header');
    this.emitLog(`Table 'Satoshi Stacks' 6-max Seat #${this.dealerSeat + 1} is the button`, 'header');
    for (let i = 0; i < NUM_SEATS; i++) {
      const p = this.players[i];
      if (p && p.participatedThisHand) {
        this.emitLog(`Seat ${i + 1}: ${p.username} (${p.startingStack} in chips)`, 'header');
      }
    }
    // Post blinds log
    const sbP = this.players[sbSeat];
    const bbP = this.players[bbSeat];
    if (sbP) { this.emitLog(`${sbP.username}: posts small blind ${Math.min(SMALL_BLIND, sbP.stack + sbP.currentBet)}`, 'action'); sbP._hasBet = true; }
    if (bbP) { this.emitLog(`${bbP.username}: posts big blind ${Math.min(BIG_BLIND, bbP.stack + bbP.currentBet)}`, 'action'); bbP._hasBet = true; }
    this.emitLog(`*** HOLE CARDS ***`, 'phase');
    // Emit per-player "Dealt to" lines (each player only sees their own cards)
    if (this.onDealCards) {
      this.players.forEach((p, i) => {
        if (p && p.participatedThisHand && p.holeCards.length === 2) {
          this.onDealCards(p.userId, `Dealt to ${p.username} ${this.cardsStr(p.holeCards)}`);
        }
      });
    }

    // Start action after big blind
    this.currentPlayerIndex = this.nextActing(bbSeat);

    // Start action timer for first player
    this.startActionTimer();
  }

  /**
   * Process player action
   * @returns {object} { valid: boolean, error?: string }
   */
  processAction(userId, action, amount = 0) {
    if (!this.handInProgress) return { valid: false, error: 'No hand in progress' };
    const player = this.players.find(p => p && p.userId === userId);
    if (!player) return { valid: false, error: 'Player not found' };
    const currentPlayer = this.players[this.currentPlayerIndex];
    if (!currentPlayer || currentPlayer.userId !== userId) {
      return { valid: false, error: 'Not your turn' };
    }
    if (player.folded || player.allIn) return { valid: false, error: 'Cannot act' };
    if (player.sittingOut) return { valid: false, error: 'Cannot act while sitting out' };

    // Clear action timer (player acted in time)
    this.clearActionTimer();

    const idx = player.seatIndex;
    const maxBet = this.getMaxBet();
    const prevMaxBet = maxBet; // capture before action for history logging

    switch (action) {
      case 'fold':
        player.folded = true;
        player._foldPhase = this.phase;
        this.emitLog(`${player.username}: folds`, 'action');
        break;

      case 'check':
        if (player.currentBet < maxBet) {
          this.startActionTimer();
          return { valid: false, error: 'Cannot check - must call or fold' };
        }
        this.emitLog(`${player.username}: checks`, 'action');
        break;

      case 'call': {
        const callAmount = Math.min(maxBet - player.currentBet, player.stack);
        this.placeBet(idx, callAmount);
        player._hasBet = true;
        if (player.allIn) {
          this.emitLog(`${player.username}: calls ${callAmount} and is all-in`, 'action');
        } else {
          this.emitLog(`${player.username}: calls ${callAmount}`, 'action');
        }
        break;
      }

      case 'raise': {
        const raiseTotal = amount;
        if (raiseTotal <= maxBet) {
          this.startActionTimer();
          return { valid: false, error: 'Raise must be higher than current bet' };
        }
        const minRaise = maxBet + Math.max(BIG_BLIND, this.lastRaise);
        if (raiseTotal < minRaise && player.stack > raiseTotal - player.currentBet) {
          this.startActionTimer();
          return { valid: false, error: `Minimum raise is ${minRaise}` };
        }
        const raiseAmount = Math.min(raiseTotal - player.currentBet, player.stack);
        this.placeBet(idx, raiseAmount);
        player._hasBet = true;

        // Log in PokerStars format: "bets" if first aggression, "raises X to Y" otherwise
        if (prevMaxBet === 0 || (this.phase === 'preflop' && prevMaxBet <= BIG_BLIND && player.currentBet > BIG_BLIND)) {
          if (this.phase !== 'preflop' || prevMaxBet === 0) {
            if (player.allIn) this.emitLog(`${player.username}: bets ${player.currentBet} and is all-in`, 'action');
            else this.emitLog(`${player.username}: bets ${player.currentBet}`, 'action');
          } else {
            const raiseBy = player.currentBet - prevMaxBet;
            if (player.allIn) this.emitLog(`${player.username}: raises ${raiseBy} to ${player.currentBet} and is all-in`, 'action');
            else this.emitLog(`${player.username}: raises ${raiseBy} to ${player.currentBet}`, 'action');
          }
        } else {
          const raiseBy = player.currentBet - prevMaxBet;
          if (player.allIn) this.emitLog(`${player.username}: raises ${raiseBy} to ${player.currentBet} and is all-in`, 'action');
          else this.emitLog(`${player.username}: raises ${raiseBy} to ${player.currentBet}`, 'action');
        }

        this.lastRaise = raiseTotal - maxBet;
        this.lastAggressor = idx;
        this.actedThisRound = [player.seatIndex]; // Reset action tracker
        break;
      }

      default:
        return { valid: false, error: 'Invalid action' };
    }

    this.actedThisRound.push(player.seatIndex);

    // Advance to next player or next phase
    this.currentPlayerIndex = this.nextActing(idx);
    if (this.currentPlayerIndex === -1 || this.isRoundDone()) {
      this.advancePhase();
    } else {
      // Start timer for next player
      this.startActionTimer();
    }

    return { valid: true };
  }

  /**
   * Place bet (handles all-in logic)
   */
  placeBet(seatIndex, amount) {
    const p = this.players[seatIndex];
    if (!p) return;

    const actualAmount = Math.min(amount, p.stack);
    p.stack -= actualAmount;
    p.currentBet += actualAmount;
    p.totalInvested += actualAmount;

    if (p.stack === 0) {
      p.allIn = true;
    }
  }

  /**
   * Advance to next phase
   */
  advancePhase() {
    this.collectBetsToPot();
    this.actedThisRound = [];
    this.lastRaise = BIG_BLIND;

    const active = this.getActivePlayers();
    const acting = this.getActingPlayers();

    // Check if hand should end
    if (active.length <= 1) {
      this.endHand();
      return;
    }

    // Run out if only one player can act (all others all-in)
    if (acting.length <= 1) {
      this.runOut();
      return;
    }

    switch (this.phase) {
      case 'preflop':
        this.phase = 'flop';
        this.deck.pop(); // Burn card
        this.communityCards.push(this.deck.pop(), this.deck.pop(), this.deck.pop());
        this.emitLog(`*** FLOP *** ${this.cardsStr(this.communityCards.slice(0, 3))}`, 'phase');
        break;

      case 'flop':
        this.phase = 'turn';
        this.deck.pop(); // Burn card
        this.communityCards.push(this.deck.pop());
        this.emitLog(`*** TURN *** ${this.cardsStr(this.communityCards.slice(0, 3))} [${this.cardStr(this.communityCards[3])}]`, 'phase');
        break;

      case 'turn':
        this.phase = 'river';
        this.deck.pop(); // Burn card
        this.communityCards.push(this.deck.pop());
        this.emitLog(`*** RIVER *** ${this.cardsStr(this.communityCards.slice(0, 4))} [${this.cardStr(this.communityCards[4])}]`, 'phase');
        break;

      case 'river':
        this.endHand();
        return;
    }

    // Start new betting round
    this.currentPlayerIndex = this.nextActing(this.dealerSeat);
    
    // Start action timer for first player of new round
    this.startActionTimer();
  }

  /**
   * Run out remaining board when all players all-in
   */
  runOut() {
    const prevLen = this.communityCards.length;

    // Deal remaining streets with correct burn pattern
    if (this.communityCards.length < 3) {
      // Flop: burn 1, deal 3
      this.deck.pop(); // burn
      this.communityCards.push(this.deck.pop(), this.deck.pop(), this.deck.pop());
    }
    if (this.communityCards.length < 4) {
      // Turn: burn 1, deal 1
      this.deck.pop(); // burn
      this.communityCards.push(this.deck.pop());
    }
    if (this.communityCards.length < 5) {
      // River: burn 1, deal 1
      this.deck.pop(); // burn
      this.communityCards.push(this.deck.pop());
    }

    // Log any new community cards dealt during runout
    if (prevLen < 3) {
      this.emitLog(`*** FLOP *** ${this.cardsStr(this.communityCards.slice(0, 3))}`, 'phase');
    }
    if (prevLen < 4) {
      this.emitLog(`*** TURN *** ${this.cardsStr(this.communityCards.slice(0, 3))} [${this.cardStr(this.communityCards[3])}]`, 'phase');
    }
    if (prevLen < 5) {
      this.emitLog(`*** RIVER *** ${this.cardsStr(this.communityCards.slice(0, 4))} [${this.cardStr(this.communityCards[4])}]`, 'phase');
    }
    this.endHand();
  }

  /**
   * End hand and award pot
   */
  endHand() {
    this.handInProgress = false;
    this.clearActionTimer(); // Clear any pending timeout
    this.collectBetsToPot();

    const active = this.getActivePlayers();
    const handStartTime = this.handStartedAt || Date.now();
    let winners = [];
    const PHASE_NAMES = { preflop: 'before Flop', flop: 'on the Flop', turn: 'on the Turn', river: 'on the River', showdown: 'on the River' };

    if (active.length <= 1) {
      // Everyone folded - single winner (or no winner if somehow 0 active)
      if (active.length === 1) {
        const winAmount = this.pot;
        active[0].stack += this.pot;
        active[0]._histShare = winAmount;
        winners = [active[0]];
        this.emitLog(`${active[0].username} collected ${winAmount} from pot`, 'winner');
      }
      this.pot = 0;
      this.potChips = [];
    } else {
      // Showdown - evaluate hands
      this.phase = 'showdown';
      this.emitLog(`*** SHOW DOWN ***`, 'phase');

      // Evaluate all active players
      active.forEach(p => {
        p.hand = evaluateHand([...p.holeCards, ...this.communityCards]);
      });

      // Calculate side pots and distribute
      const pots = this.calculateSidePots();
      const potResults = [];
      pots.forEach((pot, potIdx) => {
        const potWinners = this.findPotWinners(pot.eligible);
        const share = Math.floor(pot.amount / potWinners.length);
        const remainder = pot.amount - share * potWinners.length;
        const potName = pots.length > 1 ? (potIdx === 0 ? 'main pot' : `side pot #${potIdx}`) : 'pot';

        // Sort winners by seat position left of dealer for remainder distribution
        const sorted = [...potWinners].sort((a, b) => {
          const aDist = (a.seatIndex - this.dealerSeat + NUM_SEATS) % NUM_SEATS;
          const bDist = (b.seatIndex - this.dealerSeat + NUM_SEATS) % NUM_SEATS;
          return aDist - bDist;
        });

        sorted.forEach((w, i) => {
          const extra = i < remainder ? 1 : 0;
          w.stack += share + extra;
          w._histShare = (w._histShare || 0) + share + extra;
          if (!winners.includes(w)) winners.push(w);
        });

        potResults.push({ pot, potWinners, share, potName });
      });

      // Log showdown cards and winners
      active.forEach(p => {
        if (p.holeCards && p.holeCards.length === 2 && p.hand) {
          this.emitLog(`${p.username}: shows ${this.cardsStr(p.holeCards)} (${p.hand.name})`, 'showdown');
        }
      });

      potResults.forEach(({ potWinners, share, potName }) => {
        potWinners.forEach(w => {
          const src = pots.length > 1 ? ` from ${potName}` : ' from pot';
          this.emitLog(`${w.username} collected ${share}${src}`, 'winner');
        });
      });

      this.pot = 0;
      this.potChips = [];
    }

    // === HAND HISTORY: Summary ===
    this.emitLog(`*** SUMMARY ***`, 'phase');
    const totalPot = this.players.reduce((s, p) => s + (p ? p.totalInvested || 0 : 0), 0);
    this.emitLog(`Total pot ${totalPot}`, 'summary');
    if (this.communityCards.length > 0) {
      this.emitLog(`Board ${this.cardsStr(this.communityCards)}`, 'summary');
    }
    for (let i = 0; i < NUM_SEATS; i++) {
      const p = this.players[i];
      if (!p || !p.participatedThisHand) continue;
      const isWinner = winners.includes(p);
      const pos = this.seatPosition(i);
      const label = `Seat ${i + 1}: ${p.username}${pos}`;
      if (p.folded) {
        const phaseName = PHASE_NAMES[p._foldPhase] || 'before Flop';
        const didntBet = !p._hasBet ? " (didn't bet)" : '';
        this.emitLog(`${label} folded ${phaseName}${didntBet}`, 'summary');
      } else if (isWinner) {
        const share = p._histShare || 0;
        if (p.hand && active.length > 1) {
          this.emitLog(`${label} showed ${this.cardsStr(p.holeCards)} and won (${share}) with ${p.hand.name}`, 'summary');
        } else {
          this.emitLog(`${label} collected (${share})`, 'summary');
        }
      } else if (active.includes(p)) {
        if (p.hand) {
          this.emitLog(`${label} showed ${this.cardsStr(p.holeCards)} and lost with ${p.hand.name}`, 'summary');
        } else {
          this.emitLog(`${label} mucked`, 'summary');
        }
      }
    }

    // === Finish hand history — emit the complete compiled log ===
    const historyText = this.currentHandLog.join('\n');
    this.emitLog('', 'finish'); // blank line separator
    if (this.onHandComplete) {
      this.onHandComplete(historyText);
    }

    // Save hand to database
    this.saveHandToDatabase(handStartTime, winners);

    // Clean up players who left mid-hand
    this.cleanupPendingRemovals();

    // Schedule next hand
    setTimeout(() => {
      const stillActive = this.players.filter(p => p !== null && p.stack > 0 && !p.sittingOut);
      if (stillActive.length >= 2) {
        this.startNewHand();
        if (this.onStateChange) {
          this.onStateChange();
        }
      }
    }, 3000);
  }

  /**
   * Save completed hand to database
   */
  saveHandToDatabase(startTime, winners) {
    try {
      const handId = `${this.tableId}-${Date.now()}`;
      const completedAt = Math.floor(Date.now() / 1000);
      const startedAt = Math.floor(startTime / 1000);

      // Collect player data
      const playerData = [];
      this.players.forEach((p, idx) => {
        if (p && p.participatedThisHand) {
          const won = winners.includes(p);
          const endStack = p.stack;
          const startStack = p.startingStack || STARTING_STACK;
          const totalBet = p.totalInvested || 0;
          
          playerData.push({
            user_id: p.userId,
            username: p.username,
            seat_index: idx,
            starting_stack: startStack,
            ending_stack: endStack,
            total_bet: totalBet,
            hole_cards: p.holeCards || [],
            final_hand: p.hand ? p.hand.name : null,
            position: this.getPositionName(idx),
            actions: p.actions || [],
            won_amount: won ? (endStack - (startStack - totalBet)) : 0
          });

          // Update player stats
          db.upsertPlayer(p.userId, p.username);
          db.updatePlayerStats(p.userId, {
            hands_played: 1,
            hands_won: won ? 1 : 0,
            net_result: endStack - startStack,
            current_chips: endStack
          });
        }
      });

      // Save hand
      const handData = {
        hand_id: handId,
        table_id: this.tableId,
        started_at: startedAt,
        completed_at: completedAt,
        small_blind: SMALL_BLIND,
        big_blind: BIG_BLIND,
        button_seat: this.dealerSeat,
        pot_total: playerData.reduce((sum, p) => sum + p.total_bet, 0),
        rake: 0,
        community_cards: this.communityCards,
        hand_history: this.generateHandHistoryText(),
        players: playerData
      };

      db.saveHand(handData);
      console.log(`[Database] Saved hand ${handId}`);

    } catch (error) {
      console.error('[Database] Error saving hand:', error);
      // Don't crash the game on DB errors
    }
  }

  /**
   * Generate hand history text (PokerStars format)
   * Uses the accumulated currentHandLog from emitLog calls
   */
  generateHandHistoryText() {
    return this.currentHandLog.join('\n');
  }

  /**
   * Get position name for seat
   */
  getPositionName(seatIndex) {
    if (seatIndex === this.dealerSeat) return 'BTN';
    if (seatIndex === (this.dealerSeat + 1) % NUM_SEATS) return 'SB';
    if (seatIndex === (this.dealerSeat + 2) % NUM_SEATS) return 'BB';
    return `UTG+${(seatIndex - this.dealerSeat - 3 + NUM_SEATS) % NUM_SEATS}`;
  }

  /**
   * Calculate side pots
   */
  calculateSidePots() {
    const active = this.getActivePlayers();
    const levels = [...new Set(active.map(p => p.totalInvested))].sort((a, b) => a - b);
    const pots = [];
    let prevLevel = 0;

    for (const level of levels) {
      const perPlayer = level - prevLevel;
      if (perPlayer <= 0) continue;

      const eligible = active.filter(p => p.totalInvested >= level);
      let amount = 0;

      // Everyone contributes to this tier
      this.players.forEach(p => {
        if (p) {
          const contrib = Math.min(p.totalInvested, level) - Math.min(p.totalInvested, prevLevel);
          if (contrib > 0) amount += contrib;
        }
      });

      if (amount > 0) {
        pots.push({ amount, eligible });
      }

      prevLevel = level;
    }

    return pots;
  }

  /**
   * Find winners for a pot
   */
  findPotWinners(eligible) {
    let best = { rank: -1, tb: [] };
    let winners = [];

    eligible.forEach(p => {
      const cmp = p.hand.rank > best.rank ? 1 :
                  (p.hand.rank === best.rank ? this.compareTiebreakers(p.hand.tb, best.tb) : -1);
      
      if (cmp > 0) {
        best = p.hand;
        winners = [p];
      } else if (cmp === 0) {
        winners.push(p);
      }
    });

    return winners;
  }

  /**
   * Compare hand tiebreakers
   */
  compareTiebreakers(a, b) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i] > b[i]) return 1;
      if (a[i] < b[i]) return -1;
    }
    return 0;
  }

  /**
   * Convert a numeric amount into chip denomination objects (greedy, high-to-low)
   */
  static getChipBreakdown(amount) {
    const result = [];
    let rem = Math.floor(amount);
    for (const def of CHIP_DEFS) {
      if (rem >= def.value) {
        const count = Math.floor(rem / def.value);
        result.push({ ...def, count });
        rem -= count * def.value;
      }
      if (rem === 0) break;
    }
    return result;
  }

  /**
   * Collect bets into pot — converts numeric bets into individual chip
   * denomination objects pushed to potChips[] for visual accumulation.
   * Every chip is always accounted for.
   */
  collectBetsToPot() {
    for (const p of this.players) {
      if (p && p.currentBet > 0) {
        const chips = PokerGame.getChipBreakdown(p.currentBet);
        for (const denom of chips) {
          for (let j = 0; j < denom.count; j++) {
            this.potChips.push({ value: denom.value, label: denom.label, fill: denom.fill, text: denom.text });
          }
        }
        this.pot += p.currentBet;
        p.currentBet = 0;
      }
    }
  }

  /**
   * Get game state for a specific player (filters opponent hole cards)
   * @param {string} userId - Player requesting state
   * @returns {object} Filtered game state
   */
  getGameState(userId) {
    return {
      tableId: this.tableId,
      players: this.players.map((p, idx) => {
        if (!p) return null;
        
        return {
          userId: p.userId,
          username: p.username,
          nostrName: p.nostrName || null,
          nostrPicture: p.nostrPicture || null,
          stack: p.stack,
          currentBet: p.currentBet,
          folded: p.folded,
          allIn: p.allIn,
          seatIndex: idx,
          sittingOut: p.sittingOut || false,
          // Only show hole cards if:
          // 1. It's the requesting player's own cards
          // 2. Showdown phase and player is active
          holeCards: (p.userId === userId || (this.phase === 'showdown' && !p.folded))
            ? p.holeCards
            : p.holeCards.length > 0 ? ['??', '??'] : [],
          hand: (this.phase === 'showdown' && !p.folded) ? p.hand : null
        };
      }),
      communityCards: this.communityCards,
      pot: this.pot,
      potChips: this.potChips, // Individual chip denomination objects for visual pile
      dealerSeat: this.dealerSeat,
      currentPlayerIndex: this.currentPlayerIndex,
      phase: this.phase,
      handInProgress: this.handInProgress,
      bigBlind: BIG_BLIND,
      lastRaise: this.lastRaise,
      yourTurn: this.players[this.currentPlayerIndex]?.userId === userId
    };
  }

  // Helper methods
  getMaxBet() {
    return Math.max(...this.players.filter(p => p).map(p => p.currentBet), 0);
  }

  getActivePlayers() {
    return this.players.filter(p => p && !p.folded);
  }

  getActingPlayers() {
    return this.players.filter(p => p && !p.folded && !p.allIn && !p.sittingOut);
  }

  nextSeat(current) {
    for (let i = 1; i <= NUM_SEATS; i++) {
      const idx = (current + i) % NUM_SEATS;
      if (this.players[idx]) return idx;
    }
    return current;
  }

  /**
   * Next active (non-sitting-out) seat — used for dealer/blinds assignment
   * Skips empty seats AND sitting-out players
   */
  nextActiveSeat(current) {
    for (let i = 1; i <= NUM_SEATS; i++) {
      const idx = (current + i) % NUM_SEATS;
      const p = this.players[idx];
      if (p && !p.sittingOut && p.stack > 0) return idx;
    }
    return current;
  }

  nextActing(current) {
    for (let i = 1; i <= NUM_SEATS; i++) {
      const idx = (current + i) % NUM_SEATS;
      const p = this.players[idx];
      if (p && !p.folded && !p.allIn && !p.sittingOut) {
        // Check if this player has already acted this round
        if (this.actedThisRound.includes(p.seatIndex) && this.lastAggressor !== -1) {
          continue;
        }
        return idx;
      }
    }
    return -1; // No one left to act
  }

  isRoundDone() {
    const acting = this.getActingPlayers();
    const maxBet = this.getMaxBet();
    
    // Round is done if all acting players have:
    // 1. Acted this round
    // 2. Matched the current bet
    return acting.every(p => 
      this.actedThisRound.includes(p.seatIndex) && p.currentBet === maxBet
    );
  }

  // ==================== PHASE 5.4: TIMEOUT & DISCONNECT HANDLING ====================

  /**
   * Start action timer for current player
   */
  startActionTimer() {
    this.clearActionTimer();
    
    const playerIndex = this.currentPlayerIndex;
    if (playerIndex === -1) return;
    
    const player = this.players[playerIndex];
    if (!player || player.sittingOut) return;
    
    console.log(`[PokerGame ${this.tableId}] Starting 20s timer for ${player.username}`);
    
    this.actionTimeout = setTimeout(() => {
      console.log(`[PokerGame ${this.tableId}] ${player.username} timed out!`);
      this.handleTimeout(playerIndex);
    }, ACTION_TIMEOUT_MS);
    
    // Notify frontend to start countdown
    if (this.onTimerStart) {
      this.onTimerStart(playerIndex, ACTION_TIMEOUT_MS);
    }
  }

  /**
   * Clear action timer
   */
  clearActionTimer() {
    if (this.actionTimeout) {
      clearTimeout(this.actionTimeout);
      this.actionTimeout = null;
    }
  }

  /**
   * Handle timeout - auto-fold and sit out
   */
  handleTimeout(playerIndex) {
    const player = this.players[playerIndex];
    if (!player) return;
    
    console.log(`[PokerGame ${this.tableId}] Auto-folding ${player.username} due to timeout`);

    // Auto-fold
    player.folded = true;
    player._foldPhase = this.phase;
    this.emitLog(`${player.username}: folds [timeout]`, 'action');
    
    // Sit out immediately
    player.sittingOut = true;
    player.sitOutTime = Date.now();
    
    console.log(`[PokerGame ${this.tableId}] ${player.username} is now sitting out`);
    
    // Start 5-minute kick timer
    this.startSitOutKickTimer(player.userId);
    
    // Advance to next player
    this.currentPlayerIndex = this.nextActing(playerIndex);
    if (this.currentPlayerIndex === -1 || this.isRoundDone()) {
      this.advancePhase();
    } else {
      this.startActionTimer();
    }
    
    // Broadcast state change
    if (this.onStateChange) {
      this.onStateChange();
    }
  }

  /**
   * Start timer to kick player after 5 minutes of sitting out
   */
  startSitOutKickTimer(userId) {
    // Clear existing timer if any
    if (this.sitOutKickTimers.has(userId)) {
      clearTimeout(this.sitOutKickTimers.get(userId));
    }
    
    const timer = setTimeout(() => {
      console.log(`[PokerGame ${this.tableId}] Kicking player ${userId} (sitting out >5 min)`);
      this.removePlayer(userId);
      this.sitOutKickTimers.delete(userId);
      
      if (this.onStateChange) {
        this.onStateChange();
      }
    }, SIT_OUT_KICK_MS);
    
    this.sitOutKickTimers.set(userId, timer);
  }

  /**
   * Allow player to sit back in.
   * Standard poker rule: player is marked as "waiting for BB" and will
   * rejoin when the big blind reaches their seat. For simplicity in this
   * play-money game, we let them back in immediately for the next hand.
   */
  sitBackIn(userId) {
    const player = this.players.find(p => p && p.userId === userId);
    if (!player) return { success: false, error: 'Player not found' };
    if (!player.sittingOut) return { success: false, error: 'Not sitting out' };

    player.sittingOut = false;
    player.sitOutTime = null;

    // Cancel kick timer
    if (this.sitOutKickTimers.has(userId)) {
      clearTimeout(this.sitOutKickTimers.get(userId));
      this.sitOutKickTimers.delete(userId);
    }

    console.log(`[PokerGame ${this.tableId}] ${player.username} sat back in — will play next hand`);

    // If no hand is in progress and enough players, schedule a new hand
    const activePlayers = this.players.filter(p => p !== null && p.stack > 0 && !p.sittingOut);
    if (activePlayers.length >= 2 && !this.handInProgress && !this.handStartTimeout) {
      this.handStartTimeout = setTimeout(() => {
        this.handStartTimeout = null;
        this.startNewHand();
        if (this.onStateChange) {
          this.onStateChange();
        }
      }, 2000);
    }

    return { success: true };
  }
}

module.exports = PokerGame;
