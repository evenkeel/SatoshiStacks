#!/usr/bin/env node
/**
 * Bot Player for SatoshiStacks
 *
 * Spawns automated players that authenticate via NOSTR and play poker.
 * Useful for soak testing — run alongside the real game to fill seats.
 *
 * Usage:
 *   node bot-player.js                    # 3 bots against localhost
 *   node bot-player.js --bots 5           # 5 bots
 *   node bot-player.js --url https://satoshistacks.com  # against production
 *   node bot-player.js --bots 2 --style aggressive      # aggressive bots
 *   node bot-player.js --hands 100        # quit after 100 hands per bot
 */

const { io } = require('socket.io-client');
const crypto = require('crypto');
const { getPublicKey, finalizeEvent } = require('nostr-tools/pure');
const { npubEncode } = require('nostr-tools/nip19');

// ==================== CONFIG ====================

const args = parseArgs(process.argv.slice(2));
const SERVER_URL = args.url || 'http://localhost:3001';
const NUM_BOTS = parseInt(args.bots) || 3;
const TABLE_ID = args.table || 'table-1';
const PLAY_STYLE = args.style || 'mixed';  // conservative, aggressive, mixed, random
const MAX_HANDS = parseInt(args.hands) || 0; // 0 = unlimited
const ACTION_DELAY_MS = parseInt(args.delay) || 1500; // think time before acting

const BOT_NAMES = [
  'RoboFish', 'PokerBot3000', 'ChipMuncher', 'FoldMachine',
  'CallStation', 'BluffKing', 'NitBot', 'ManiacBot',
  'GrinderBot', 'StackAttack', 'PotBully', 'TiltBot'
];

// ==================== NOSTR KEYPAIR ====================

function generateNostrKeypair() {
  const secretKey = crypto.randomBytes(32);
  const pubkeyHex = getPublicKey(secretKey);
  const npub = npubEncode(pubkeyHex);
  return { secretKey, pubkeyHex, npub };
}

function signAuthEvent(secretKey, pubkeyHex, nonce) {
  const event = {
    kind: 22242,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['challenge', nonce]],
    content: JSON.stringify({ name: null, picture: null }),
    pubkey: pubkeyHex,
  };
  return finalizeEvent(event, secretKey);
}

// ==================== AUTH ====================

async function authenticate(botName, secretKey, pubkeyHex) {
  // Step 1: Get challenge
  const challengeRes = await fetch(`${SERVER_URL}/api/auth/challenge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  const challengeData = await challengeRes.json();
  if (!challengeData.success) throw new Error(`Challenge failed: ${challengeData.error}`);

  // Step 2: Sign and verify
  const signedEvent = signAuthEvent(secretKey, pubkeyHex, challengeData.nonce);
  const verifyRes = await fetch(`${SERVER_URL}/api/auth/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challengeId: challengeData.challengeId, signedEvent }),
  });
  const verifyData = await verifyRes.json();
  if (!verifyData.success) throw new Error(`Verify failed: ${verifyData.error}`);

  console.log(`  ✓ ${botName} authenticated (${pubkeyHex.slice(0, 8)}...)`);
  return verifyData.sessionToken;
}

// ==================== BOT BRAIN ====================

function chooseAction(gameState, mySeatIndex, style) {
  const me = gameState.players[mySeatIndex];
  if (!me || me.folded || me.allIn || me.sittingOut) return null;
  if (!gameState.yourTurn) return null;

  const maxBet = Math.max(...gameState.players.filter(p => p).map(p => p.currentBet), 0);
  const toCall = maxBet - me.currentBet;
  const myStack = me.stack;
  const potSize = gameState.pot + toCall;
  const bigBlind = gameState.bigBlind || 100;

  // Can we check?
  const canCheck = toCall === 0;

  // Pick style weights
  let weights;
  switch (style) {
    case 'aggressive':
      weights = { fold: 0.10, check: 0.15, call: 0.30, raise: 0.45 };
      break;
    case 'conservative':
      weights = { fold: 0.30, check: 0.30, call: 0.30, raise: 0.10 };
      break;
    case 'random':
      weights = { fold: 0.25, check: 0.25, call: 0.25, raise: 0.25 };
      break;
    case 'mixed':
    default:
      // Vary per hand — sometimes tight, sometimes loose
      weights = Math.random() > 0.5
        ? { fold: 0.15, check: 0.25, call: 0.35, raise: 0.25 }
        : { fold: 0.25, check: 0.25, call: 0.30, raise: 0.20 };
      break;
  }

  // Adjust for situation
  if (toCall > myStack * 0.5) {
    // Facing a big bet — fold more
    weights.fold += 0.25;
    weights.raise -= 0.15;
  }
  if (toCall === 0) {
    // No bet to face — never fold (that'd be silly)
    weights.fold = 0;
  }
  if (toCall > 0 && toCall <= bigBlind) {
    // Cheap call — call more
    weights.call += 0.15;
    weights.fold -= 0.10;
  }

  // Normalize
  const total = weights.fold + weights.check + weights.call + weights.raise;
  const roll = Math.random() * total;
  let cumulative = 0;

  // Fold
  cumulative += weights.fold;
  if (roll < cumulative && toCall > 0) {
    return { action: 'fold' };
  }

  // Check
  cumulative += weights.check;
  if (roll < cumulative && canCheck) {
    return { action: 'check' };
  }

  // Call
  cumulative += weights.call;
  if (roll < cumulative && toCall > 0) {
    return { action: 'call' };
  }

  // Raise
  if (myStack > toCall) {
    // Pick a raise size
    const minRaise = maxBet + Math.max(bigBlind, gameState.lastRaise || bigBlind);
    const sizes = [
      minRaise,                           // min raise
      maxBet + potSize * 0.5,             // half pot
      maxBet + potSize * 0.75,            // 3/4 pot
      maxBet + potSize,                   // pot
      me.currentBet + myStack,            // all-in
    ];

    // Weight toward smaller raises usually
    const sizeWeights = [0.35, 0.25, 0.20, 0.10, 0.10];
    const sizeRoll = Math.random();
    let sizeCum = 0;
    let raiseAmount = minRaise;
    for (let i = 0; i < sizes.length; i++) {
      sizeCum += sizeWeights[i];
      if (sizeRoll < sizeCum) {
        raiseAmount = Math.floor(sizes[i]);
        break;
      }
    }

    // Clamp to valid range
    raiseAmount = Math.max(raiseAmount, minRaise);
    raiseAmount = Math.min(raiseAmount, me.currentBet + myStack);

    return { action: 'raise', amount: raiseAmount };
  }

  // Fallback: call if there's a bet, check if not
  if (toCall > 0) return { action: 'call' };
  return { action: 'check' };
}

// ==================== BOT INSTANCE ====================

async function startBot(index) {
  const botName = BOT_NAMES[index % BOT_NAMES.length];
  const { secretKey, pubkeyHex, npub } = generateNostrKeypair();
  let mySeatIndex = -1;
  let handsPlayed = 0;
  let lastPhase = 'idle';

  console.log(`[${botName}] Starting... (${npub.slice(0, 16)}...)`);

  // Authenticate
  let sessionToken;
  try {
    sessionToken = await authenticate(botName, secretKey, pubkeyHex);
  } catch (err) {
    console.error(`[${botName}] Auth failed:`, err.message);
    return;
  }

  // Connect socket
  const socket = io(SERVER_URL, {
    transports: ['websocket'],
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 2000,
  });

  socket.on('connect', () => {
    console.log(`[${botName}] Connected, joining ${TABLE_ID}...`);
    socket.emit('join-table', { tableId: TABLE_ID, sessionToken });
  });

  socket.on('seat-assigned', ({ seatIndex, displayName }) => {
    mySeatIndex = seatIndex;
    console.log(`[${botName}] Seated at position ${seatIndex + 1}`);
  });

  socket.on('game-state', (state) => {
    // Track hand count
    if (state.phase === 'preflop' && lastPhase !== 'preflop') {
      handsPlayed++;
      if (MAX_HANDS > 0 && handsPlayed > MAX_HANDS) {
        console.log(`[${botName}] Reached ${MAX_HANDS} hands, leaving table.`);
        socket.emit('leave-table');
        socket.disconnect();
        return;
      }
    }
    lastPhase = state.phase;

    // Is it my turn?
    if (state.yourTurn && mySeatIndex >= 0) {
      const decision = chooseAction(state, mySeatIndex, PLAY_STYLE);
      if (decision) {
        // Delay to simulate thinking
        const delay = ACTION_DELAY_MS + Math.random() * 1000;
        setTimeout(() => {
          const payload = { tableId: TABLE_ID, action: decision.action };
          if (decision.amount !== undefined) payload.amount = decision.amount;
          socket.emit('action', payload);

          // Log action
          const me = state.players[mySeatIndex];
          const stack = me ? me.stack : '?';
          const amtStr = decision.amount ? ` ${decision.amount}` : '';
          console.log(`  [${botName}] ${decision.action}${amtStr} (stack: ${stack}, pot: ${state.pot})`);
        }, delay);
      }
    }
  });

  socket.on('hand-log', ({ line, type }) => {
    // Optionally log play-by-play (uncomment for verbose mode)
    // if (type === 'winner') console.log(`  [${botName}] ${line}`);
  });

  socket.on('error', ({ message }) => {
    console.log(`  [${botName}] Error: ${message}`);
  });

  socket.on('auth-error', ({ message }) => {
    console.error(`[${botName}] Auth error: ${message}`);
    socket.disconnect();
  });

  socket.on('disconnect', (reason) => {
    console.log(`[${botName}] Disconnected: ${reason}`);
  });

  socket.on('reconnect', () => {
    console.log(`[${botName}] Reconnected, rejoining...`);
    socket.emit('join-table', { tableId: TABLE_ID, sessionToken });
  });

  return socket;
}

// ==================== MAIN ====================

async function main() {
  console.log('');
  console.log('🤖 SatoshiStacks Bot Player');
  console.log(`   Server:  ${SERVER_URL}`);
  console.log(`   Bots:    ${NUM_BOTS}`);
  console.log(`   Table:   ${TABLE_ID}`);
  console.log(`   Style:   ${PLAY_STYLE}`);
  console.log(`   Hands:   ${MAX_HANDS || 'unlimited'}`);
  console.log(`   Delay:   ${ACTION_DELAY_MS}ms`);
  console.log('');

  const sockets = [];

  // Stagger bot connections (500ms apart) to avoid rate limiting
  for (let i = 0; i < NUM_BOTS; i++) {
    try {
      const socket = await startBot(i);
      if (socket) sockets.push(socket);
    } catch (err) {
      console.error(`Bot ${i} failed to start:`, err.message);
    }
    if (i < NUM_BOTS - 1) {
      await sleep(500);
    }
  }

  console.log('');
  console.log(`✅ ${sockets.length}/${NUM_BOTS} bots running. Press Ctrl+C to stop.`);
  console.log('');

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\nShutting down bots...');
    sockets.forEach(s => {
      s.emit('leave-table');
      s.disconnect();
    });
    setTimeout(() => process.exit(0), 1000);
  });
}

// ==================== UTILS ====================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--') && i + 1 < argv.length) {
      result[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return result;
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
