/**
 * Public query API endpoints.
 * Read-only access to hands, players, tables, and stats.
 */

const { Router } = require('express');
const db = require('../database');

const router = Router();

/**
 * GET /api/hands/:userId — hand history for a player
 */
router.get('/hands/:userId', (req, res) => {
  try {
    const { userId } = req.params;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const hands = db.getPlayerHands(userId, limit);
    res.json({ success: true, userId, count: hands.length, hands });
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
    res.json({ success: true, hand });
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
    res.json({ success: true, player });
  } catch (error) {
    console.error('[API] Error fetching player:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * GET /api/tables — active tables
 */
router.get('/tables', (req, res) => {
  try {
    const tables = db.getTables();
    res.json({ success: true, count: tables.length, tables });
  } catch (error) {
    console.error('[API] Error fetching tables:', error);
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
