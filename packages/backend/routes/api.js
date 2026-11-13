/**
 * Public query API endpoints.
 * Read-only access to hands, players, tables, and stats.
 */

const { Router } = require('express');
const db = require('../database');
const { playerHistory } = require('../hand-history');
function publicHand({ events, ...hand }) { return hand; }

const router = Router();

router.get('/my/hands', (req, res) => {
  const player = db.getPlayerBySession(req.headers['x-session-token']);
  if (!player) return res.status(401).json({success:false, error:'Sign in to view your hand histories'});
  const hands = db.getPlayerHands(player.pubkey_hex, 100).map(hand => {
    const own = db.getHandPlayers(hand.hand_id).find(p => p.user_id === player.pubkey_hex);
    return {personal:true, handId:hand.hand_id, tableId:hand.table_id, startedAt:hand.started_at * 1000,
      history:playerHistory(hand.hand_history, own, hand.hand_id)};
  });
  res.set('Cache-Control', 'no-store').json({success:true,hands});
});

/**
 * GET /api/hands/:userId — hand history for a player
 */
router.get('/hands/:userId', (req, res) => {
  try {
    const { userId } = req.params;
    const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 50, 200));
    const hands = db.getPlayerHands(userId, limit);
    res.json({ success: true, userId, count: hands.length, hands: hands.map(publicHand) });
  } catch (error) {
    console.error('[API] Error fetching player hands:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * GET /api/hand/:handId — single hand details
 */
router.get('/hand/:handId', (req, res) => {
  try {
    const { handId } = req.params;
    const hand = db.getHand(handId);
    if (!hand) {
      return res.status(404).json({ success: false, error: 'Hand not found' });
    }
    res.json({ success: true, hand: publicHand(hand) });
  } catch (error) {
    console.error('[API] Error fetching hand:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * GET /api/player/:userId — player stats
 */
router.get('/player/:userId', (req, res) => {
  try {
    const { userId } = req.params;
    const player = db.getPlayer(userId);
    if (!player) {
      return res.status(404).json({ success: false, error: 'Player not found' });
    }
    const { user_id, username, npub, nostr_name, nostr_picture, hands_played, hands_won, first_seen } = player;
    res.json({ success: true, player: { user_id, username, npub, nostr_name, nostr_picture, hands_played, hands_won, first_seen } });
  } catch (error) {
    console.error('[API] Error fetching player:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * GET /api/stats — database statistics
 */
router.get('/stats', (req, res) => {
  try {
    const stats = {
      totalHands: db.db.prepare('SELECT COUNT(*) as count FROM hands').get().count,
      totalPlayers: db.db.prepare('SELECT COUNT(*) as count FROM players').get().count,
      activeTables: db.db.prepare('SELECT COUNT(*) as count FROM tables WHERE is_active = 1').get().count
    };
    res.json({ success: true, stats });
  } catch (error) {
    console.error('[API] Error fetching stats:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
