'use strict';

// Account records remain available before a node is connected and during an
// outage. Only the live payments service can enable external money movement.
function accountState({ db, config, games, payments, userId, tableId, watchOnly = false }) {
  const realMoney = config.isRealMoney(tableId);
  const availableSats = db.getAccountBalance(userId);
  const game = realMoney ? games.get(tableId) : null;
  const stack = game?.players.find(player => player && player.userId === userId);
  const depositsEnabled = realMoney && !!payments?.depositsEnabled();
  const withdrawalsEnabled = realMoney && !!payments?.withdrawalsEnabled();
  const lightningStatus = !realMoney ? 'disabled' : !payments ? 'offline' :
    !depositsEnabled && !withdrawalsEnabled ? 'paused' : 'ready';
  const pendingWithdrawalSats = db.db.prepare(`SELECT COALESCE(SUM(amount_sats),0) AS total
    FROM ledger_entries WHERE user_id=? AND direction='withdrawal'
    AND status IN ('reserved','in_flight','failed')`).get(userId).total;
  return {
    tableId, userId, realMoney, watchOnly, lightningStatus,
    availableSats, creditSats: availableSats, pendingWithdrawalSats,
    tableStackSats: stack?.stack || 0, seated: !!stack,
    canReturnStack: !!stack && !!game.canCashOut(userId).ok,
    canBuyIn: realMoney && !!payments && !payments.breakerState().tripped && !watchOnly,
    depositsEnabled, withdrawalsEnabled,
    payments: db.db.prepare(`SELECT payment_hash,amount_sats,status,created_at,settled_at
      FROM ledger_entries WHERE user_id=? AND direction='withdrawal' ORDER BY id DESC LIMIT 20`).all(userId),
    deposits: db.getWalletDeposits(userId, db.ACCOUNT).map(row => ({ ...row,
      expiresAt: row.expires_at || row.created_at + config.LIGHTNING.invoiceExpirySec })),
    transfers: db.getAccountHistory(userId),
  };
}

module.exports = { accountState };
