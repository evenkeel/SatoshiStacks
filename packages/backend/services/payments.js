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
const crypto = require('crypto');
const {withdrawalFeeBudget} = require('./payment-policy');
function createPayments(deps) {
  const {
    lnd, db, config, getGame,
    liveStacksTotal = () => 0,
    onSeatPlayer = () => {},
    onRefund = () => {},
    onDeposit = () => {},
    alert = (m) => console.error('[Payments][ALERT]', m),
  } = deps;

  const nowSec = () => Math.floor(Date.now() / 1000);
  const L = () => config.LIGHTNING;
  const depositRequests = new Map();
  let reconciling = false;
  const activeDispatches = new Map();
  function observe(row,event,elapsedMs=null) {
    try { db.recordPaymentEvent(row.id,event,elapsedMs); }
    catch (_) { alert('Payment telemetry could not be recorded'); }
  }
  function elapsedSince(row,event,fallback=null) {
    try {
      const started = db.db.prepare('SELECT created_at_ms FROM payment_events WHERE ledger_id=? AND event=?').get(row.id,event)?.created_at_ms;
      return started ? Date.now()-started : fallback;
    } catch (_) { return fallback; }
  }
  const intentFor = row => db.db.prepare('SELECT * FROM deposit_invoice_intents WHERE ledger_id=?').get(row.id);
  const invoiceExpiry = row => intentFor(row)?.expires_at || row.created_at + L().invoiceExpirySec;
  const feeBudgetFor = row => db.db.prepare('SELECT max_fee_sats FROM withdrawal_fee_budgets WHERE ledger_id=?').get(row.id)?.max_fee_sats ?? withdrawalFeeBudget(row.amount_sats,L());
  function outstandingFeeBudgets() {
    return db.getPendingLedger().filter(r=>r.direction==='withdrawal').reduce((sum,row)=>sum+feeBudgetFor(row),0);
  }
  function totalOwed() {return liveStacksTotal()+db.sumWalletCredits()+db.sumHeldDeposits()+outstandingWithdrawals();}

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
    const game = tableId === db.ACCOUNT ? null : getGame(tableId);
    const seated = game && game.players.some(p => p && p.userId === userId);
    const cc = seated ? game.canCashOut(userId) : { ok: true, stack: 0 };
    if (!cc.ok) return cc;
    const credit = tableId === db.ACCOUNT ? db.getAccountBalance(userId) : db.getWalletCredit(userId, tableId);
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
    if (tableId !== db.ACCOUNT && !config.isRealMoney(tableId)) throw new Error('Not a real-money table');
    if (!depositsEnabled()) throw new Error('New deposits are temporarily paused');
    const game = tableId === db.ACCOUNT ? null : getGame(tableId);
    if (game?.players.some(p => p && p.userId === userId)) throw new Error('You already have a seat');
    if (game?.players.every(Boolean)) throw new Error('Table is full — wait for a seat before paying');
    if (tableId !== db.ACCOUNT && (db.getWalletCredit(userId, tableId) > 0 || db.getUnseatedDeposits(userId, tableId).length)) throw new Error('You have funds to recover. Open Cash out before making another buy-in.');
    amountSats = Number(amountSats);
    if (!Number.isSafeInteger(amountSats) || amountSats <= 0) throw new Error('Invalid amount');
    const table = config.TABLE_CONFIGS?.[tableId];
    if (table && (amountSats < table.minBuyin || amountSats > table.maxBuyin)) throw new Error('Amount outside table buy-in limits');
    const key = `${userId}:${tableId}`;
    if (depositRequests.has(key)) return depositRequests.get(key);
    let pending = db.getPendingLedger().find(r => r.direction === 'deposit' && r.user_id === userId && r.table_id === tableId && (!r.bolt11 || invoiceExpiry(r) > nowSec()));
    if (pending?.bolt11) return { bolt11: pending.bolt11, paymentHash: pending.payment_hash, amountSats: pending.amount_sats, expiresAt: invoiceExpiry(pending) };
    if (!pending) {
      const outstanding = db.getPendingLedger().filter(r => r.direction === 'deposit').reduce((s, r) => s + r.amount_sats, 0);
      if (L().hotWalletCapSats && totalOwed() + outstanding + amountSats > L().hotWalletCapSats) throw new Error('Table deposit exposure limit reached');
      const secret = crypto.randomBytes(32).toString('hex');
      const paymentHash = crypto.createHash('sha256').update(Buffer.from(secret,'hex')).digest('hex');
      pending = db.db.transaction(()=>{
        db.createDepositRow({userId,tableId,amountSats,paymentHash,bolt11:null,seatIndex:seatIndex ?? null});
        const row = db.getLedgerByHash(paymentHash,'deposit');
        db.db.prepare('INSERT INTO deposit_invoice_intents VALUES(?,?,?)').run(row.id,secret,nowSec()+L().invoiceExpirySec);
        return row;
      })();
      observe(pending,'invoice_requested');
    }
    const row = pending, intent = intentFor(row);
    if (!intent) throw new Error('An earlier invoice is still being checked. Refresh your account before trying again.');
    const started = Date.now();
    const request = (async () => {
      try {
        const {bolt11,paymentHash} = await lnd.createInvoice({amountSats:row.amount_sats,
          memo:tableId === db.ACCOUNT ? 'SatoshiStacks account deposit' : `SatoshiStacks buy-in ${tableId}`,
          secret:intent.secret,expiresAt:intent.expires_at,expirySec:L().invoiceExpirySec});
        if (paymentHash !== row.payment_hash || !bolt11) throw new Error('Unexpected invoice returned for this deposit');
        db.db.transaction(()=>{
          db.db.prepare('UPDATE ledger_entries SET bolt11=? WHERE id=?').run(bolt11,row.id);
          db.db.prepare("UPDATE deposit_invoice_intents SET secret='' WHERE ledger_id=?").run(row.id);
        })();
        observe(row,'invoice_ready',elapsedSince(row,'invoice_requested',Date.now()-started));
        return {bolt11,paymentHash,amountSats:row.amount_sats,expiresAt:intent.expires_at};
      } catch(error) {
        observe(row,'invoice_uncertain',Date.now()-started);
        throw error;
      }
    })();
    depositRequests.set(key, request);
    try { return await request; } finally { depositRequests.delete(key); }
  }

  // Idempotent. Seats the player exactly once, on the pending->settled edge.
  function creditDeposit(paymentHash, amtPaidSat) {
    const started = Date.now();
    const res = db.db.transaction(() => {
      const result = db.settleDeposit(paymentHash, amtPaidSat);
      if (result.row && ['settled','amount_mismatch'].includes(result.status)) db.db.prepare("UPDATE deposit_invoice_intents SET secret='' WHERE ledger_id=?").run(result.row.id);
      if (result.row?.table_id === db.ACCOUNT && ['settled', 'amount_mismatch'].includes(result.status)) db.getAccountBalance(result.row.user_id);
      return result;
    })();
    if (['settled','amount_mismatch'].includes(res.status)) {
      observe(res.row,res.row.table_id === db.ACCOUNT ? 'deposit_credited' : 'deposit_settled',Date.now()-started);
      try { onDeposit(res.row); } catch (_) { alert('Deposit notification failed; credited funds remain recorded'); }
    }
    if (res.status === 'settled' && res.row.table_id !== db.ACCOUNT) {
      try { onSeatPlayer(res.row); }
      catch (e) { alert(`Deposit ${paymentHash} settled but seating failed: ${e.message}`); }
    } else if (res.status === 'amount_mismatch') {
      alert(`Deposit ${paymentHash} amount mismatch (paid ${amtPaidSat} != invoice ${res.row && res.row.amount_sats}); NOT seating.`);
    }
    return res;
  }

  function buyInFromAccount({ userId, tableId, amountSats, player = {}, seatIndex }) {
    if (!config.isRealMoney(tableId)) throw new Error('Not a real-money table');
    if (breaker.tripped) throw new Error('Table wallet is temporarily paused');
    const game = getGame(tableId);
    if (!game) throw new Error('Table is unavailable');
    const tc = config.TABLE_CONFIGS?.[tableId] || game;
    if (!Number.isSafeInteger(amountSats) || amountSats < tc.minBuyin || amountSats > tc.maxBuyin) throw new Error('Amount outside table buy-in limits');
    const existing = game.players.findIndex(p => p && p.userId === userId);
    if (existing !== -1) return existing; // lost response/reconnect must never debit twice
    if (game.players.every(Boolean)) throw new Error('Table is full');
    if (db.getAccountBalance(userId) < amountSats) throw new Error('Insufficient account balance. Deposit sats first.');
    const before = game.players.slice();
    const previousTimer = game.handStartTimeout;
    try {
      return db.db.transaction(() => {
        db.debitAccount(userId, tableId, 'table_buyin', amountSats);
        return game.addPlayer(userId, player.nostr_name || player.username || userId.slice(0, 8), {
          initialStack: amountSats, preferredSeat: seatIndex,
          nostrName: player.nostr_name, nostrPicture: player.nostr_picture,
        });
      })();
    } catch (error) {
      if (game.handStartTimeout !== previousTimer) clearTimeout(game.handStartTimeout);
      game.handStartTimeout = previousTimer;
      game.players = before;
      throw error;
    }
  }

  function returnStackToAccount({ userId, tableId }) {
    if (!config.isRealMoney(tableId)) throw new Error('Not a real-money table');
    const game = getGame(tableId);
    if (!game?.players.some(p => p && p.userId === userId)) return { amountSats: 0 };
    const funds = game.canCashOut(userId);
    if (!funds.ok) throw new Error(funds.error);
    const before = game.players.slice();
    try {
      return db.db.transaction(() => {
        game.removePlayer(userId, { payoutReserved: true });
        db.creditAccount(userId, tableId, 'table_cashout', funds.stack);
        return { amountSats: funds.stack };
      })();
    } catch (error) { game.players = before; throw error; }
  }

  // ======================= WITHDRAWAL (cash-out) ==========================

  async function requestWithdrawal({ userId, tableId, bolt11, onReserved = () => {} }) {
    if (tableId !== db.ACCOUNT && !config.isRealMoney(tableId)) throw new Error('Not a real-money table');
    if (!withdrawalsEnabled()) throw new Error('Withdrawals are temporarily paused');

    const game = tableId === db.ACCOUNT ? null : getGame(tableId);
    if (typeof bolt11 !== 'string' || !bolt11 || bolt11.length > 10000) throw new Error('Invalid receiving invoice');
    const dec = await lnd.decodeInvoice(bolt11);
    if (!dec || !dec.paymentHash) throw new Error('Invalid invoice');
    // A lost socket reply must be retryable with the original invoice. Never
    // reserve or send a second payment for the same account and payment hash.
    const existing = db.getLedgerByHash(dec.paymentHash, 'withdrawal');
    if (existing) {
      if (existing.user_id !== userId || existing.table_id !== tableId || existing.bolt11 !== bolt11) throw new Error('This invoice was already submitted');
      return { status: existing.status === 'refunded' ? 'failed' : existing.status === 'reserved' ? 'in_flight' : existing.status,
        paymentHash: existing.payment_hash, amountSats: existing.amount_sats };
    }

    // 1. Read-only pre-checks against the authoritative stack.
    const cc = availableFunds(userId, tableId);
    if (!cc.ok) throw new Error(cc.error);
    const amount = tableId === db.ACCOUNT ? dec.amountSats : cc.stack;
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > cc.stack) throw new Error('Invoice exceeds available account balance or has an invalid amount');
    // A full-balance exit must also work for a stack below the normal minimum.
    if (L().maxWithdrawalSats && amount > L().maxWithdrawalSats) throw new Error(`Maximum withdrawal is ${L().maxWithdrawalSats} sats`);
    if (L().hotWalletCapSats && amount > L().hotWalletCapSats) throw new Error('Amount exceeds hot-wallet cap');

    // 2. Decode + validate the player-supplied invoice.
    if (!(dec.amountSats > 0)) throw new Error('Invoice must specify an amount');
    if (dec.amountMsats !== undefined && (!/^\d+$/.test(dec.amountMsats) || BigInt(dec.amountMsats) !== BigInt(amount) * 1000n)) throw new Error(`Invoice amount must equal your stack (${amount} sats), with no fractional sats`);
    if (dec.amountSats !== amount) throw new Error(`Invoice amount must equal your stack (${amount} sats)`);
    if (L().ownPubkey && dec.destination === L().ownPubkey) throw new Error('Self-payment is not allowed');
    if (dec.expiresAt && (!Number.isFinite(Date.parse(dec.expiresAt)) || Date.parse(dec.expiresAt) <= Date.now())) throw new Error('Invoice has expired or has an invalid expiry');

    const feeBudget = withdrawalFeeBudget(amount,L());
    const feeReserve = L().feeReserveSats ?? 0;
    const spendable = await lnd.getSpendableSats();
    if (!Number.isSafeInteger(spendable) || spendable < 0) throw new Error('Could not verify the wallet balance. Try again shortly.');

    // Reserve the liability and commit the debited table snapshot in one DB
    // transaction. No await can interleave; restore memory on an outer rollback.
    let row;
    const beforePlayers = game?.players.slice();
    try {
      row = db.db.transaction(() => {
        if (!withdrawalsEnabled()) throw new Error('Withdrawals are temporarily paused');
        if (spendable < totalOwed()+outstandingFeeBudgets()+feeReserve+feeBudget) throw new Error('The wallet routing-fee reserve is low. Your balance is unchanged; please try again later.');
        const cc2 = availableFunds(userId, tableId);
        if (!cc2.ok) throw new Error(cc2.error);
        if (tableId === db.ACCOUNT ? cc2.stack < amount : cc2.stack !== amount) throw new Error('Your balance changed — please retry');
        db.insertWithdrawalReserved({            // throws on UNIQUE -> replay guard
          userId, tableId, amountSats: amount, paymentHash: dec.paymentHash, bolt11,
          seatIndex: cc2.seated ? seatIndexOf(game, userId) : null,
        });
        const r = db.getLedgerByHash(dec.paymentHash, 'withdrawal');
        db.db.prepare('INSERT INTO withdrawal_fee_budgets VALUES(?,?)').run(r.id,feeBudget);
        observe(r,'withdrawal_reserved');
        db.takeWalletCredit(userId, tableId, tableId === db.ACCOUNT ? amount : cc2.credit);
        if (tableId === db.ACCOUNT) db.recordAccountTransfer(userId, tableId, 'withdrawal_reserved', amount);
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

    try { onReserved({ paymentHash: row.payment_hash, amountSats: row.amount_sats }); }
    catch (error) { alert(`Withdrawal reservation notification failed: ${error.message}`); }

    // 4. OUTSIDE the transaction: dispatch the payment.
    return { ...await dispatchPayment(row), paymentHash: row.payment_hash, amountSats: row.amount_sats };
  }

  // Dispatch (or re-dispatch) a reserved withdrawal. LND dedups by payment_hash,
  // so re-dispatch after a crash is safe and never double-pays.
  function dispatchPayment(row) {
    if (activeDispatches.has(row.id)) return activeDispatches.get(row.id);
    const request = runPayment(row).finally(() => activeDispatches.delete(row.id));
    activeDispatches.set(row.id, request);
    return request;
  }
  async function runPayment(row) {
    const current = db.getLedgerById(row.id);
    if (!current || !['reserved', 'in_flight'].includes(current.status)) return { status: current?.status || 'unknown' };
    db.updateLedgerStatus(row.id, 'in_flight');
    let result;
    try {
      result = await lnd.sendPayment({
        bolt11: row.bolt11,
        paymentHash: row.payment_hash,
        feeLimitSats: feeBudgetFor(row),
        timeoutSec: L().paymentTimeoutSec ?? 60,
      });
    } catch (e) {
      observe(row,'withdrawal_uncertain');
      // Network error / timeout / unknown fate -> DO NOT refund. Sticky in_flight.
      alert(`Withdrawal ${row.payment_hash} send errored (fate UNKNOWN): ${e.message}. Left in_flight for the reconciler.`);
      return { status: 'in_flight', paymentHash: row.payment_hash };
    }
    if (result && result.status === 'SUCCEEDED') {
      completePayment(row, result);
      return { status: 'succeeded', preimage: result.preimage, feeSats: result.feeSats || 0 };
    }
    if (result && result.status === 'FAILED') {
      observe(row,'withdrawal_failed');
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
      if (fresh.table_id === db.ACCOUNT) db.creditAccount(fresh.user_id, db.ACCOUNT, 'withdrawal_refunded', fresh.amount_sats);
      else db.addWalletCredit(fresh.user_id, fresh.table_id, fresh.amount_sats);
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
    observe(row,'withdrawal_succeeded',elapsedSince(row,'withdrawal_reserved'));
  }

  // ======================= RECONCILE + SOLVENCY ===========================

  // Resolve any non-terminal rows (startup + periodic). Crash-safe.
  async function reconcilePending() {
    if (reconciling) return;
    reconciling = true;
    try {
    const rows = [...db.getPendingLedger(), ...db.getExpiredDeposits()];
    for (const row of rows) {
      if (row.direction === 'deposit') {
        if (lnd.lookupInvoice) {
          try {
            const invoice = await lnd.lookupInvoice(row.payment_hash);
            if (invoice?.bolt11 && !row.bolt11 && invoice.invoiceAmountSats === row.amount_sats) {
              db.db.transaction(()=>{
                db.db.prepare('UPDATE ledger_entries SET bolt11=? WHERE id=?').run(invoice.bolt11,row.id);
                db.db.prepare("UPDATE deposit_invoice_intents SET secret='' WHERE ledger_id=?").run(row.id);
              })();
              observe(row,'invoice_recovered');
            }
            if (invoice?.confirmed) creditDeposit(row.payment_hash, invoice.amountSats);
            else if (invoice?.canceled) db.updateLedgerStatus(row.id, 'canceled');
            else if (invoice?.held) db.updateLedgerStatus(row.id, 'pending');
            else if (invoice && (invoice.expiresAt || invoiceExpiry(row)) < nowSec()) db.updateLedgerStatus(row.id, 'expired');
          } catch (e) { alert(`Deposit reconciliation failed: ${e.message}`); }
        }
        continue;
      }
      if (activeDispatches.has(row.id)) continue;
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
          observe(row,'withdrawal_failed');
          db.updateLedgerStatus(row.id, 'failed');
          doRefund({ ...row, status: 'failed' });
        } else if (st && st.status === 'NOT_FOUND') {
          // Recover a crash after persisting in_flight but before the RPC reached
          // LND. Resend the SAME invoice/hash; never mint a refund from absence.
          await dispatchPayment(row);
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
    if (!Number.isSafeInteger(spendable) || spendable < 0) {
      tripBreaker('LND returned an invalid spendable balance');
      return { ok: false, reason: 'invalid_balance' };
    }
    const owed = totalOwed();
    if (spendable < owed) {
      tripBreaker(`Solvency violation: node spendable ${spendable} < owed ${owed}`);
      return { ok: false, spendable, owed };
    }
    const feeReserveSats = L().feeReserveSats ?? 0;
    const committedFeeSats = outstandingFeeBudgets();
    if (spendable < owed+feeReserveSats+committedFeeSats) return {ok:false,reason:'fee_reserve_low',spendable,owed,feeReserveSats,committedFeeSats};
    return { ok: true, spendable, owed, feeReserveSats, committedFeeSats };
  }

  return {
    buyInFromAccount, returnStackToAccount,
    createDepositInvoice,
    creditDeposit,
    requestWithdrawal,
    releaseUnseatedDeposits,
    dispatchPayment,
    reconcilePending,
    solvencyCheck,
    outstandingWithdrawals,
    outstandingFeeBudgets,
    metrics: () => db.paymentMetrics(),
    withdrawalsEnabled,
    depositsEnabled,
    availableFunds,
    tripBreaker,
    resetBreaker,
    breakerState,
  };
}

module.exports = { createPayments };
