/**
 * NOSTR Services — relay publishing, profile fetching, badge & live activity management.
 * Extracted from server.js for separation of concerns.
 */

const crypto = require('crypto');
const { finalizeEvent, getPublicKey } = require('nostr-tools/pure');
const { npubEncode, decode: nip19Decode } = require('nostr-tools/nip19');
const config = require('../config');
const db = require('../database');

// ==================== SERVER IDENTITY ====================

let serverSk = null;
let serverPk = null;

if (config.NOSTR_SERVER_NSEC) {
  try {
    const { data: decoded } = nip19Decode(config.NOSTR_SERVER_NSEC);
    serverSk = decoded;
    serverPk = getPublicKey(serverSk);
    console.log(`[Nostr] Server identity loaded: ${serverPk.slice(0, 8)}...`);
  } catch (e) {
    console.error('[Nostr] Invalid NOSTR_SERVER_NSEC:', e.message);
  }
} else {
  console.log('[Nostr] No NOSTR_SERVER_NSEC set — badge/activity publishing disabled');
}

function hasServerKey() {
  return !!serverSk;
}

// ==================== RELAY PUBLISHING ====================

async function publishToRelays(event) {
  const WebSocket = (await import('ws')).default;
  let published = 0;
  for (const url of config.RELAYS) {
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

function checkAndAwardBadges(userId, stats, { userSockets, io, games, broadcastGameState }) {
  if (!serverSk) return;

  const checks = [
    { badgeId: 'card-player', condition: stats.handsPlayed >= 1000 },
    { badgeId: 'royal-flush', condition: stats.handName && stats.handName.toLowerCase().includes('royal flush') }
  ];

  for (const { badgeId, condition } of checks) {
    if (!condition) continue;
    if (db.hasBadge(userId, badgeId)) continue;

    const badge = config.BADGE_DEFINITIONS.find(b => b.id === badgeId);
    if (!badge) continue;

    try {
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
      db.awardBadge(userId, badgeId, awardEvent.id);

      console.log(`[Nostr] Badge "${badge.name}" ${badge.icon} awarded to ${userId.slice(0, 8)}...`);

      const socketId = userSockets.get(userId);
      if (socketId) {
        io.to(socketId).emit('badge-awarded', {
          badgeId: badge.id,
          badgeName: badge.name,
          badgeIcon: badge.icon
        });
      }

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

const liveActivityTimers = new Map();

function scheduleLiveActivityUpdate(tableId, games, immediate = false) {
  if (!serverSk) return;

  if (liveActivityTimers.has(tableId)) {
    clearTimeout(liveActivityTimers.get(tableId));
  }

  const delay = immediate ? 0 : 10000;
  const timer = setTimeout(() => {
    liveActivityTimers.delete(tableId);
    publishLiveActivity(tableId, games);
  }, delay);

  liveActivityTimers.set(tableId, timer);
}

function publishLiveActivity(tableId, games) {
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

// ==================== PROFILE FETCHING ====================

async function fetchNostrProfile(pubkeyHex, { games, userSockets, io, broadcastGameState }) {
  const WebSocket = (await import('ws')).default;

  return new Promise((resolve, reject) => {
    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        reject(new Error('Relay timeout'));
      }
    }, 5000);

    let attempts = 0;

    for (const relayUrl of config.RELAYS) {
      try {
        const ws = new WebSocket(relayUrl);
        const subId = crypto.randomBytes(8).toString('hex');

        ws.on('open', () => {
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

                db.upsertNostrPlayer(pubkeyHex, npubEncode(pubkeyHex), name, picture, lud16);
                console.log(`[Auth] Relay profile fetched: ${name} (${pubkeyHex.slice(0, 8)}...)${lud16 ? ` lud16: ${lud16}` : ''}`);

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

                const socketId = userSockets.get(pubkeyHex);
                if (socketId) {
                  io.to(socketId).emit('profile-updated', { name, picture, lud16 });
                }

                resolve({ name, picture, lud16 });
              }
            }
          } catch (e) { /* ignore parse errors */ }
        });

        ws.on('error', () => {});

        setTimeout(() => {
          try { ws.close(); } catch (e) {}
          attempts++;
          if (attempts >= config.RELAYS.length && !resolved) {
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

// ==================== HAND HISTORY PUBLISHING (Kind 1) ====================

/**
 * Publish a completed hand history as a signed kind 1 (regular note) event.
 * Visible in Nostr feeds, tagged with player pubkeys so they can find it.
 * Fire-and-forget: returns event ID on success, null on failure.
 */
async function publishHandHistory(handHistoryText, handId, tableId, playerPubkeys) {
  if (!serverSk) {
    console.log('[Nostr] No server key — skipping hand history publish');
    return null;
  }

  try {
    const tags = [
      ['t', 'poker'],
      ['t', 'satoshistacks'],
      ['t', 'hand-history'],
      ['d', handId],
      ['subject', `Hand #${handId}`],
    ];

    // Tag each player so they can find their hand histories
    for (const pubkey of playerPubkeys) {
      if (pubkey) {
        tags.push(['p', pubkey]);
      }
    }

    const event = finalizeEvent({
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: handHistoryText
    }, serverSk);

    const published = await publishToRelays(event);
    console.log(`[Nostr] Published hand history ${handId} (event ${event.id.slice(0, 8)}...) to ${published} relay(s)`);

    // Store event ID in database for reference
    db.updateHandNostrEventId(handId, event.id);

    return event.id;
  } catch (e) {
    console.error(`[Nostr] Failed to publish hand history ${handId}:`, e.message);
    return null;
  }
}

// ==================== STARTUP PUBLISHING ====================

function publishStartupEvents() {
  if (!serverSk) return;

  // NIP-89: App Handler
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

  // NIP-58: Badge definitions
  for (const badge of config.BADGE_DEFINITIONS) {
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

module.exports = {
  hasServerKey,
  serverPk,
  publishToRelays,
  checkAndAwardBadges,
  scheduleLiveActivityUpdate,
  fetchNostrProfile,
  publishStartupEvents,
  publishHandHistory,
};
