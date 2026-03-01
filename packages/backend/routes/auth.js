/**
 * NOSTR authentication endpoints.
 * Challenge-response flow for NIP-07/NIP-46 login.
 */

const { Router } = require('express');
const crypto = require('crypto');
const { verifyEvent } = require('nostr-tools/pure');
const { npubEncode } = require('nostr-tools/nip19');
const config = require('../config');
const db = require('../database');
const nostr = require('../services/nostr');
const { validateBody, schemas } = require('../middleware/validate');

const router = Router();

// ==================== IN-MEMORY RATE LIMITER ====================

const authRateLimits = new Map();

function isAuthRateLimited(ip) {
  const { maxRequests, windowSec } = config.AUTH_RATE_LIMIT;
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

// ==================== ENDPOINTS ====================

/**
 * POST /api/auth/challenge — generate a challenge nonce
 */
router.post('/challenge', (req, res) => {
  try {
    const clientIp = req.ip || req.connection.remoteAddress;
    if (isAuthRateLimited(clientIp)) {
      return res.status(429).json({ success: false, error: 'Too many requests. Try again shortly.' });
    }

    const challengeId = crypto.randomUUID();
    const nonce = crypto.randomBytes(32).toString('hex');
    const expiresAt = Math.floor(Date.now() / 1000) + 300;

    db.createChallenge(challengeId, nonce, expiresAt);
    res.json({ success: true, challengeId, nonce });
  } catch (error) {
    console.error('[Auth] Challenge generation error:', error);
    res.status(500).json({ success: false, error: 'Failed to generate challenge' });
  }
});

/**
 * POST /api/auth/verify — verify a signed NOSTR event
 * Receives context object with game state references for profile fetch callback
 */
let contextRef = null;
router.setContext = (ctx) => { contextRef = ctx; };

router.post('/verify', validateBody(schemas.authVerify), (req, res) => {
  try {
    const { challengeId, signedEvent } = req.body;

    // 1. Validate challenge
    const challenge = db.getAndUseChallenge(challengeId);
    if (!challenge) {
      return res.status(401).json({ success: false, error: 'Invalid or expired challenge' });
    }

    // 2. Verify signature
    if (!verifyEvent(signedEvent)) {
      return res.status(401).json({ success: false, error: 'Invalid event signature' });
    }

    // 3. Verify nonce tag
    if (!Array.isArray(signedEvent.tags)) {
      return res.status(400).json({ success: false, error: 'Malformed event: tags must be an array' });
    }
    const nonceTag = signedEvent.tags.find(t => Array.isArray(t) && t[0] === 'challenge' && t[1] === challenge.nonce);
    if (!nonceTag) {
      return res.status(401).json({ success: false, error: 'Challenge nonce mismatch' });
    }

    // 4. Verify timestamp (within 5 minutes)
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - signedEvent.created_at) > 300) {
      return res.status(401).json({ success: false, error: 'Event timestamp too old' });
    }

    // 5. Verify event kind
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

    db.upsertNostrPlayer(pubkeyHex, npub, nostrName, nostrPicture);

    // Generate session token (24h expiry)
    const sessionToken = crypto.randomBytes(32).toString('hex');
    const sessionExpires = Math.floor(Date.now() / 1000) + 86400;
    db.setSessionToken(pubkeyHex, sessionToken, sessionExpires);

    const player = db.getPlayerByPubkey(pubkeyHex);

    console.log(`[Auth] NOSTR login: ${nostrName || npub.slice(0, 12) + '...'} (${pubkeyHex.slice(0, 8)}...)`);

    res.json({
      success: true,
      sessionToken,
      pubkeyHex,
      npub,
      profile: {
        name: player.nostr_name || player.username,
        picture: player.nostr_picture,
        lud16: player.lud16 || null,
        chips: player.current_chips
      }
    });

    // Background: fetch kind 0 profile from relays (non-blocking)
    if (contextRef) {
      nostr.fetchNostrProfile(pubkeyHex, contextRef).catch(err => {
        console.log(`[Auth] Relay profile fetch failed for ${pubkeyHex.slice(0, 8)}...: ${err.message}`);
      });
    }
  } catch (error) {
    console.error('[Auth] Verify error:', error);
    res.status(500).json({ success: false, error: 'Authentication failed' });
  }
});

/**
 * GET /api/auth/session — validate existing session token
 */
router.get('/session', (req, res) => {
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
        lud16: player.lud16 || null,
        chips: player.current_chips
      }
    });
  } catch (error) {
    console.error('[Auth] Session check error:', error);
    res.status(500).json({ success: false, error: 'Session check failed' });
  }
});

module.exports = router;
