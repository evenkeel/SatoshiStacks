/**
 * Payments service — the real-money boundary between the poker engine and the
 * Lightning node. This is where all node-draining risk is concentrated, so the
 * rules here are deliberately strict:
 *
 *   - Deposits credit chips ONLY on a confirmed, amount-matched settlement, and
 *     crediting is idempotent (LND redelivers settled invoices on reconnect).
 *   - Withdrawable == the player's live authoritative stack, only when NOT
 *     committed to a live hand. The stack is debited (player removed from the
 *     game) INSIDE one synchronous SQLite transaction, BEFORE any payment is
 *     dispatched, so a crash can never leave chips removed without a ledger row
 *     (or vice-versa).
 *   - A refund (re-crediting the player) is ONLY legal from a definitive LND
 *     FAILED. Timeout / unknown / in-flight is sticky — we NEVER auto-refund a
 *     payment whose fate is unknown (that is the classic double-pay drain).
 *
 * Built as a factory so it can be unit-tested with a mock LND client and a real
 * (or fake) game, with no live node required.
 *
 * deps:
 *   lnd            - { createInvoice, decodeInvoice, sendPayment, trackPayment, getSpendableSats }
 *   db             - the database module (ledger helpers + raw `db` for transactions)
 *   config         - { isRealMoney(tableId), WITHDRAWALS_ENABLED, LIGHTNING:{...} }
 *   getGame        - (tableId) => live PokerGame | undefined
 *   liveStacksTotal- () => total sats currently represented as real-money stacks/pots
 *   onSeatPlayer   - (depositRow) => seat the player after a settled deposit (wiring)
 *   onRefund       - (withdrawalRow) => re-credit a player after a FAILED payment (wiring)
 *   alert          - (msg) => operator alert (default console.error)
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

  // ---- circuit breaker -----------------------------------------------------
  let breaker = { tripped: false, reason: null };
  function withdrawalsEnabled() { return config.WITHDRAWALS_ENABLED && !breaker.tripped; }
  function tripBreaker(reason) {
    if (!breaker.tripped) { breaker = { tripped: true, reason }; alert(`CIRCUIT BREAKER TRIPPED: ${reason}`); }
  }
  function resetBreaker() { breaker = { tripped: false, reason: null }; }
  function breakerState() { return { ...breaker }; }

  const seatIndexOf = (game, userId) => {
    const i = game.players.findIndex(p => p && p.userId === userId);
    return i === -1 ? null : i;
  };

  // ======================= DEPOSIT (buy-in) ===============================

  async function createDepositInvoice({ userId, tableId, amountSats, seatIndex }) {
    if (!config.isRealMoney(tableId)) throw new Error('Not a real-money table');
    amountSats = Math.floor(Number(amountSats));
    if (!Number.isInteger(amountSats) || amountSats <= 0) throw new Error('Invalid amount');
    const { bolt11, paymentHash } = await lnd.createInvoice({
      amountSats, memo: `SatoshiStacks buy-in ${tableId}`, expirySec: L().invoiceExpirySec,
    });
    db.createDepositRow({ userId, tableId, amountSats, paymentHash, bolt11, seatIndex: seatIndex ?? null });
    return { bolt11, paymentHash, amountSats };
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
    if (!game) throw new Error('Table is not active');

    // 1. Read-only pre-checks against the authoritative stack.
    const cc = game.canCashOut(userId);
    if (!cc.ok) throw new Error(cc.error);
    const amount = cc.stack;
    if (amount <= 0) throw new Error('No chips to cash out');
    if (amount < L().minWithdrawalSats) throw new Error(`Minimum withdrawal is ${L().minWithdrawalSats} sats`);
    if (L().maxWithdrawalSats && amount > L().maxWithdrawalSats) throw new Error(`Maximum withdrawal is ${L().maxWithdrawalSats} sats`);
    if (L().hotWalletCapSats && amount > L().hotWalletCapSats) throw new Error('Amount exceeds hot-wallet cap');

    // 2. Decode + validate the player-supplied invoice.
    const dec = await lnd.decodeInvoice(bolt11);
    if (!dec || !dec.paymentHash) throw new Error('Invalid invoice');
    if (!(dec.amountSats > 0)) throw new Error('Invoice must specify an amount');
    if (dec.amountSats !== amount) throw new Error(`Invoice amount must equal your stack (${amount} sats)`);
    if (L().ownPubkey && dec.destination === L().ownPubkey) throw new Error('Self-payment is not allowed');
    if (dec.timestamp && dec.expiry && (dec.timestamp + dec.expiry) * 1000 < Date.now()) throw new Error('Invoice has expired');

    // 3. CRITICAL SECTION — one synchronous SQLite transaction. No `await` inside,
    //    so check + reserve + debit cannot interleave with another request. Every
    //    statement that can throw runs BEFORE the in-memory game mutation, and the
    //    game mutation is LAST, so a rollback never leaves chips removed.
    let row;
    try {
      row = db.db.transaction(() => {
        const cc2 = game.canCashOut(userId);        // re-read authoritative stack
        if (!cc2.ok) throw new Error(cc2.error);
        if (cc2.stack !== amount) throw new Error('Your stack changed — please retry');
        db.insertWithdrawalReserved({            // throws on UNIQUE -> replay guard
          userId, tableId, amountSats: amount, paymentHash: dec.paymentHash, bolt11,
          seatIndex: seatIndexOf(game, userId),
        });
        const r = db.getLedgerByHash(dec.paymentHash, 'withdrawal');
        game.removePlayer(userId);               // LAST: free the seat, remove chips
        return r;
      })();
    } catch (e) {
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
    db.updateLedgerStatus(row.id, 'in_flight');
    let result;
    try {
      result = await lnd.sendPayment({
        bolt11: row.bolt11,
        feeLimitSats: L().withdrawalFeeLimitSats,
        timeoutSec: 60,
      });
    } catch (e) {
      // Network error / timeout / unknown fate -> DO NOT refund. Sticky in_flight.
      alert(`Withdrawal ${row.payment_hash} send errored (fate UNKNOWN): ${e.message}. Left in_flight for the reconciler.`);
      return { status: 'in_flight', paymentHash: row.payment_hash };
    }
    if (result && result.status === 'SUCCEEDED') {
      db.updateLedgerStatus(row.id, 'succeeded', { feeSats: result.feeSats || 0, settledAt: nowSec() });
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
    const fresh = db.getLedgerById(row.id);
    if (!fresh || fresh.status !== 'failed') {
      alert(`Refund refused for ${row.payment_hash}: status is ${fresh && fresh.status}, not 'failed'.`);
      return;
    }
    db.updateLedgerStatus(row.id, 'refunded', { settledAt: nowSec() });
    try { onRefund(fresh); }
    catch (e) { alert(`Refund handler failed for ${row.payment_hash}: ${e.message}`); }
  }

  // ======================= RECONCILE + SOLVENCY ===========================

  // Resolve any non-terminal rows (startup + periodic). Crash-safe.
  async function reconcilePending() {
    const rows = db.getPendingLedger();
    for (const row of rows) {
      if (row.direction !== 'withdrawal') continue; // deposit reconciliation handled by the invoice stream
      try {
        const st = await lnd.trackPayment(row.payment_hash);
        if (st && st.status === 'SUCCEEDED') {
          db.updateLedgerStatus(row.id, 'succeeded', { feeSats: st.feeSats || 0, settledAt: nowSec() });
        } else if (st && st.status === 'FAILED') {
          db.updateLedgerStatus(row.id, 'failed');
          doRefund({ ...row, status: 'failed' });
        } else if (row.status === 'reserved') {
          // Reserved but never dispatched (crashed before send) -> safe to dispatch.
          await dispatchPayment(row);
        } // in_flight + non-terminal -> leave for next pass
      } catch (e) {
        alert(`Reconcile could not resolve ${row.payment_hash}: ${e.message}`);
      }
    }
  }

  // The solvency identity: node spendable must cover all live stacks plus every
  // withdrawal we've committed to but not yet definitively settled.
  function outstandingWithdrawals() {
    return db.getPendingLedger()
      .filter(r => r.direction === 'withdrawal' && (r.status === 'reserved' || r.status === 'in_flight'))
      .reduce((s, r) => s + r.amount_sats, 0);
  }
  async function solvencyCheck() {
    const owed = liveStacksTotal() + outstandingWithdrawals();
    let spendable;
    try { spendable = await lnd.getSpendableSats(); }
    catch (e) { tripBreaker(`LND unreachable during solvency check: ${e.message}`); return { ok: false, reason: 'lnd_unreachable' }; }
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
    dispatchPayment,
    reconcilePending,
    solvencyCheck,
    outstandingWithdrawals,
    withdrawalsEnabled,
    tripBreaker,
    resetBreaker,
    breakerState,
  };
}

module.exports = { createPayments };
