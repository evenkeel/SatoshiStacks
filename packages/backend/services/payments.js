/**
 * Lightning accounting for the poker table. NIP-07 authenticates the player;
 * their browser wallet supplies a receiving invoice through WebLN. Only this
 * service reserves funds and dispatches server-side payments.
 *
 * Deposits remain liabilities until consumed by an atomic seat+snapshot commit.
 * Withdrawals atomically reserve credit and/or the between-hands stack with the
 * updated snapshot. Definitive failures restore a durable wallet credit;
 * ambiguous outcomes stay in-flight until reconciliation with LND.
 */
function createPayments(deps) {
  const {
    lnd, db, config, getGame,
    liveStacksTotal = () => 0,
    onSeatPlayer = () => {},
    onRefund = () => {},
    alert = (m) => console.error('[Payments][ALERT]', m),
  } = deps;

  const nowSec = () => Math.floor(Date.now() / 1000);
  const L = () => config.LIGHTNING;
  const depositRequests = new Map();
  let creatingDepositsSats = 0;
  let reconciling = false;

  // ---- circuit breaker -----------------------------------------------------
  let breaker = { tripped: false, reason: null };
  function withdrawalsEnabled() { return config.WITHDRAWALS_ENABLED && !breaker.tripped; }
  function tripBreaker(reason) {
    if (!breaker.tripped) { breaker = { tripped: true, reason }; alert(`CIRCUIT BREAKER TRIPPED: ${reason}`); }
  }
  function resetBreaker() { breaker = { tripped: false, reason: null }; }
  function breakerState() { return { ...breaker }; }
  function depositsEnabled() { return config.DEPOSITS_ENABLED !== false && !breaker.tripped; }

  function availableFunds(userId, tableId) {
    const game = getGame(tableId);
    const seated = game && game.players.some(p => p && p.userId === userId);
    const cc = seated ? game.canCashOut(userId) : { ok: true, stack: 0 };
    if (!cc.ok) return cc;
    const credit = db.getWalletCredit(userId, tableId);
    const deposits = db.getUnseatedDeposits(userId, tableId);
    return { ok: true, stack: cc.stack + credit + deposits.reduce((s, r) => s + r.amount_sats, 0),
      seated: !!seated, seatedStack: cc.stack, credit, deposits };
  }

  const seatIndexOf = (game, userId) => {
    const i = game.players.findIndex(p => p && p.userId === userId);
    return i === -1 ? null : i;
  };

  // ======================= DEPOSIT (buy-in) ===============================

  async function createDepositInvoice({ userId, tableId, amountSats, seatIndex }) {
    if (!config.isRealMoney(tableId)) throw new Error('Not a real-money table');
    if (!depositsEnabled()) throw new Error('New deposits are temporarily paused');
    const game = getGame(tableId);
    if (game?.players.some(p => p && p.userId === userId)) throw new Error('You already have a seat');
    if (game?.players.every(Boolean)) throw new Error('Table is full — wait for a seat before paying');
    amountSats = Math.floor(Number(amountSats));
    if (!Number.isSafeInteger(amountSats) || amountSats <= 0) throw new Error('Invalid amount');
    const table = config.TABLE_CONFIGS?.[tableId];
    if (table && (amountSats < table.minBuyin || amountSats > table.maxBuyin)) throw new Error('Amount outside table buy-in limits');
    const key = `${userId}:${tableId}`;
    if (depositRequests.has(key)) return depositRequests.get(key);
    const pending = db.getPendingLedger().find(r => r.direction === 'deposit' && r.user_id === userId && r.table_id === tableId && r.created_at + L().invoiceExpirySec > nowSec());
    if (pending) return { bolt11: pending.bolt11, paymentHash: pending.payment_hash, amountSats: pending.amount_sats };
    const outstanding = db.getPendingLedger().filter(r => r.direction === 'deposit').reduce((s, r) => s + r.amount_sats, 0);
    const owed = liveStacksTotal() + db.sumWalletCredits() + db.sumHeldDeposits() + outstandingWithdrawals();
    if (L().hotWalletCapSats && owed + outstanding + creatingDepositsSats + amountSats > L().hotWalletCapSats) throw new Error('Table deposit exposure limit reached');
    creatingDepositsSats += amountSats;
    const request = (async () => {
    const { bolt11, paymentHash } = await lnd.createInvoice({
      amountSats, memo: `SatoshiStacks buy-in ${tableId}`, expirySec: L().invoiceExpirySec,
    });
    db.createDepositRow({ userId, tableId, amountSats, paymentHash, bolt11, seatIndex: seatIndex ?? null });
    return { bolt11, paymentHash, amountSats };
    })();
    depositRequests.set(key, request);
    try { return await request; } finally { depositRequests.delete(key); creatingDepositsSats -= amountSats; }
  }

  // Idempotent. Seats the player exactly once, on the pending->settled edge.
  function creditDeposit(paymentHash, amtPaidSat) {
    const res = db.settleDeposit(paymentHash, amtPaidSat);
    if (res.status === 'settled') {
      try { onSeatPlayer(res.row); }
      catch (e) { alert(`Deposit ${paymentHash} settled but seating failed: ${e.message}`); }
    } else if (res.status === 'amount_mismatch') {
      alert(`Deposit ${paymentHash} amount mismatch (paid ${amtPaidSat} != invoice ${res.row && res.row.amount_sats}); NOT seating.`);
    }
    return res;
  }

  // ======================= WITHDRAWAL (cash-out) ==========================

  async function requestWithdrawal({ userId, tableId, bolt11 }) {
    if (!config.isRealMoney(tableId)) throw new Error('Not a real-money table');
    if (!withdrawalsEnabled()) throw new Error('Withdrawals are temporarily paused');

    const game = getGame(tableId);

    // 1. Read-only pre-checks against the authoritative stack.
    const cc = availableFunds(userId, tableId);
    if (!cc.ok) throw new Error(cc.error);
    const amount = cc.stack;
    if (amount <= 0) throw new Error('No chips to cash out');
    // A full-balance exit must also work for a stack below the normal minimum.
    if (L().maxWithdrawalSats && amount > L().maxWithdrawalSats) throw new Error(`Maximum withdrawal is ${L().maxWithdrawalSats} sats`);
    if (L().hotWalletCapSats && amount > L().hotWalletCapSats) throw new Error('Amount exceeds hot-wallet cap');

    // 2. Decode + validate the player-supplied invoice.
    const dec = await lnd.decodeInvoice(bolt11);
    if (!dec || !dec.paymentHash) throw new Error('Invalid invoice');
    if (!(dec.amountSats > 0)) throw new Error('Invoice must specify an amount');
    if (dec.amountSats !== amount) throw new Error(`Invoice amount must equal your stack (${amount} sats)`);
    if (L().ownPubkey && dec.destination === L().ownPubkey) throw new Error('Self-payment is not allowed');
    if (dec.expiresAt && new Date(dec.expiresAt).getTime() < Date.now()) throw new Error('Invoice has expired');

    // Reserve the liability and commit the debited table snapshot in one DB
    // transaction. No await can interleave; restore memory on an outer rollback.
    let row;
    const beforePlayers = game?.players.slice();
    try {
      row = db.db.transaction(() => {
        if (!withdrawalsEnabled()) throw new Error('Withdrawals are temporarily paused');
        const cc2 = availableFunds(userId, tableId);
        if (!cc2.ok) throw new Error(cc2.error);
        if (cc2.stack !== amount) throw new Error('Your stack changed — please retry');
        db.insertWithdrawalReserved({            // throws on UNIQUE -> replay guard
          userId, tableId, amountSats: amount, paymentHash: dec.paymentHash, bolt11,
          seatIndex: cc2.seated ? seatIndexOf(game, userId) : null,
        });
        const r = db.getLedgerByHash(dec.paymentHash, 'withdrawal');
        db.takeWalletCredit(userId, tableId, cc2.credit);
        for (const deposit of cc2.deposits) db.updateLedgerStatus(deposit.id, 'withdrawn');
        if (cc2.seated) game.removePlayer(userId, { payoutReserved: true });
        return r;
      })();
    } catch (e) {
      if (game && beforePlayers) game.players = beforePlayers;
      if (e && (e.code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE/.test(String(e.message)))) {
        throw new Error('This invoice was already submitted');
      }
      throw e;
    }

    // 4. OUTSIDE the transaction: dispatch the payment.
    return dispatchPayment(row);
  }

  // Dispatch (or re-dispatch) a reserved withdrawal. LND dedups by payment_hash,
  // so re-dispatch after a crash is safe and never double-pays.
  async function dispatchPayment(row) {
    const current = db.getLedgerById(row.id);
    if (!current || !['reserved', 'in_flight'].includes(current.status)) return { status: current?.status || 'unknown' };
    db.updateLedgerStatus(row.id, 'in_flight');
    let result;
    try {
      result = await lnd.sendPayment({
        bolt11: row.bolt11,
        paymentHash: row.payment_hash,
        feeLimitSats: L().withdrawalFeeLimitSats,
        timeoutSec: 60,
      });
    } catch (e) {
      // Network error / timeout / unknown fate -> DO NOT refund. Sticky in_flight.
      alert(`Withdrawal ${row.payment_hash} send errored (fate UNKNOWN): ${e.message}. Left in_flight for the reconciler.`);
      return { status: 'in_flight', paymentHash: row.payment_hash };
    }
    if (result && result.status === 'SUCCEEDED') {
      completePayment(row, result);
      return { status: 'succeeded', preimage: result.preimage, feeSats: result.feeSats || 0 };
    }
    if (result && result.status === 'FAILED') {
      db.updateLedgerStatus(row.id, 'failed');
      doRefund(row);
      return { status: 'failed' };
    }
    // Any non-terminal/unknown status -> sticky in_flight, alert.
    alert(`Withdrawal ${row.payment_hash} returned non-terminal status ${result && result.status}; left in_flight.`);
    return { status: 'in_flight', paymentHash: row.payment_hash };
  }

  // Re-credit a player after a DEFINITIVE failure. Only ever called from `failed`.
  function doRefund(row) {
    const fresh = db.db.transaction(() => {
      const fresh = db.getLedgerById(row.id);
      if (!fresh || fresh.status !== 'failed') return null;
      db.addWalletCredit(fresh.user_id, fresh.table_id, fresh.amount_sats);
      db.updateLedgerStatus(row.id, 'refunded', { settledAt: nowSec() });
      return fresh;
    })();
    if (!fresh) return;
    try { onRefund(fresh); }
    catch (e) { alert(`Refund handler failed for ${row.payment_hash}: ${e.message}`); }
  }

  function completePayment(row, result) {
    db.db.transaction(() => {
      db.updateLedgerStatus(row.id, 'succeeded', { feeSats: result.feeSats || 0, settledAt: nowSec() });
    })();
  }

  // ======================= RECONCILE + SOLVENCY ===========================

  // Resolve any non-terminal rows (startup + periodic). Crash-safe.
  async function reconcilePending() {
    if (reconciling) return;
    reconciling = true;
    try {
    const rows = db.getPendingLedger();
    for (const row of rows) {
      if (row.direction === 'deposit') {
        if (lnd.lookupInvoice) {
          try {
            const invoice = await lnd.lookupInvoice(row.payment_hash);
            if (invoice?.confirmed) creditDeposit(row.payment_hash, invoice.amountSats);
            else if (invoice?.canceled || (invoice && row.created_at + L().invoiceExpirySec < nowSec())) db.updateLedgerStatus(row.id, 'expired');
          } catch (e) { alert(`Deposit reconciliation failed: ${e.message}`); }
        }
        continue;
      }
      if (row.status === 'failed') { doRefund(row); continue; }
      // 'reserved' means the process died before the send was ever dispatched
      // (dispatch sets 'in_flight' first), so the payment was never made — safe to
      // (re-)dispatch. LND dedups by payment_hash, so this can never double-pay.
      if (row.status === 'reserved') {
        try { await dispatchPayment(row); }
        catch (e) { alert(`Reconcile could not dispatch reserved ${row.payment_hash}: ${e.message}`); }
        continue;
      }
      // 'in_flight' -> ask LND for the authoritative fate; never assume failure.
      try {
        const st = await lnd.trackPayment(row.payment_hash);
        if (st && st.status === 'SUCCEEDED') {
          completePayment(row, st);
        } else if (st && st.status === 'FAILED') {
          db.updateLedgerStatus(row.id, 'failed');
          doRefund({ ...row, status: 'failed' });
        } // pending / unknown -> leave in_flight for the next pass
      } catch (e) {
        alert(`Reconcile could not resolve in-flight ${row.payment_hash}: ${e.message}`);
      }
    }
    } finally { reconciling = false; }
  }

  // A disconnected/full-table deposit becomes a durable, independently
  // withdrawable balance. No address resolution or automatic outbound payment.
  function releaseUnseatedDeposits(graceSec = 120) {
    for (const row of db.getRefundableDeposits(graceSec)) {
      db.db.transaction(() => {
        if (db.getLedgerById(row.id)?.status !== 'settled_unseated') return;
        db.addWalletCredit(row.user_id, row.table_id, row.amount_sats);
        db.updateLedgerStatus(row.id, 'credited');
      })();
    }
  }

  // The solvency identity: node spendable must cover all live stacks, every
  // withdrawal we've committed to but not yet settled, AND every deposit we're
  // still holding for an un-seated player (owed back to them).
  function outstandingWithdrawals() {
    return db.getPendingLedger()
      .filter(r => r.direction === 'withdrawal' && ['reserved', 'in_flight', 'failed'].includes(r.status))
      .reduce((s, r) => s + r.amount_sats, 0);
  }
  async function solvencyCheck() {
    let spendable;
    try { spendable = await lnd.getSpendableSats(); }
    catch (e) { tripBreaker(`LND unreachable during solvency check: ${e.message}`); return { ok: false, reason: 'lnd_unreachable' }; }
    const owed = liveStacksTotal() + outstandingWithdrawals() + db.sumHeldDeposits() + db.sumWalletCredits();
    if (spendable < owed) {
      tripBreaker(`Solvency violation: node spendable ${spendable} < owed ${owed}`);
      return { ok: false, spendable, owed };
    }
    return { ok: true, spendable, owed };
  }

  return {
    createDepositInvoice,
    creditDeposit,
    requestWithdrawal,
    releaseUnseatedDeposits,
    dispatchPayment,
    reconcilePending,
    solvencyCheck,
    outstandingWithdrawals,
    withdrawalsEnabled,
    depositsEnabled,
    availableFunds,
    tripBreaker,
    resetBreaker,
    breakerState,
  };
}

module.exports = { createPayments };
