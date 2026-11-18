/**
 * Custodial account payments. Lightning deposits credit the account; only an
 * explicit account withdrawal sends Lightning. Table buy-ins and returns are
 * internal transfers. Table stacks are never an external payment source.
 * Unknown outgoing results stay reserved until the node resolves their fate.
 */
const crypto = require('crypto');
const {withdrawalFeeBudget} = require('./payment-policy');
function createPayments(deps) {
  const {
    lnd, db, config, getGame,
    liveStacksTotal = () => 0,
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

  // ======================= ACCOUNT DEPOSITS ===============================

  async function createDepositInvoice({ userId, tableId = db.ACCOUNT, amountSats }) {
    if (tableId !== db.ACCOUNT) throw new Error('Deposits must fund the account, not a table');
    if (!depositsEnabled()) throw new Error('New deposits are temporarily paused');
    amountSats = Number(amountSats);
    if (!Number.isSafeInteger(amountSats) || amountSats <= 0) throw new Error('Invalid amount');
    // One invoice may not reserve the whole exposure allowance: an unpaid
    // request counts against the cap until it expires.
    if (L().maxDepositSats && amountSats > L().maxDepositSats) throw new Error(`Maximum deposit is ${L().maxDepositSats} sats per invoice`);
    const key = `${userId}:${tableId}`;
    if (depositRequests.has(key)) return depositRequests.get(key);
    const mine = db.getPendingLedger().filter(r => r.direction === 'deposit' && r.user_id === userId && r.table_id === tableId);
    // An invoice request that never returned an invoice cannot be retried once
    // its fixed expiry has passed: the node rejects a past expiry, so reusing it
    // would block this account's deposits permanently. Retire it. 'expired' rows
    // are still reconciled and still credit if the node later reports payment.
    for (const stale of mine) {
      if (!stale.bolt11 && invoiceExpiry(stale) <= nowSec()) db.transitionLedgerStatus(stale.id, ['pending'], 'expired');
    }
    let pending = mine.find(r => invoiceExpiry(r) > nowSec());
    if (pending?.bolt11) return { bolt11: pending.bolt11, paymentHash: pending.payment_hash, amountSats: pending.amount_sats, expiresAt: invoiceExpiry(pending) };
    if (!pending) {
      const outstanding = db.getPendingLedger().filter(r => r.direction === 'deposit').reduce((s, r) => s + r.amount_sats, 0);
      if (L().hotWalletCapSats && totalOwed() + outstanding + amountSats > L().hotWalletCapSats) throw new Error('Account deposit exposure limit reached');
      const secret = crypto.randomBytes(32).toString('hex');
      const paymentHash = crypto.createHash('sha256').update(Buffer.from(secret,'hex')).digest('hex');
      pending = db.db.transaction(()=>{
        db.createDepositRow({userId,tableId,amountSats,paymentHash,bolt11:null,seatIndex:null});
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
          memo:'SatoshiStacks account deposit',
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

  // Idempotent account credit, including late settlement of legacy table invoices.
  function creditDeposit(paymentHash, amtPaidSat) {
    const started = Date.now();
    const res = db.db.transaction(() => {
      const result = db.settleDeposit(paymentHash, amtPaidSat);
      if (result.row && ['settled','amount_mismatch'].includes(result.status)) db.db.prepare("UPDATE deposit_invoice_intents SET secret='' WHERE ledger_id=?").run(result.row.id);
      if (result.row && ['settled', 'amount_mismatch'].includes(result.status)) db.getAccountBalance(result.row.user_id);
      return result;
    })();
    if (['settled','amount_mismatch'].includes(res.status)) {
      observe(res.row,'deposit_credited',Date.now()-started);
      try { onDeposit(res.row); } catch (_) { alert('Deposit notification failed; credited funds remain recorded'); }
    }
    if (res.status === 'amount_mismatch') {
      alert(`Deposit ${paymentHash} amount mismatch; actual received sats were credited to the account.`);
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
    if (db.getAccountBalance(userId) < amountSats) throw new Error('Insufficient account balance. Deposit bitcoin first.');
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

  // ======================= ACCOUNT WITHDRAWALS ==========================

  async function requestWithdrawal({ userId, tableId = db.ACCOUNT, bolt11, onReserved = () => {} }) {
    if (tableId !== db.ACCOUNT) throw new Error('Withdrawals can only spend the account balance. Return table funds to the account first.');
    if (!withdrawalsEnabled()) throw new Error('Withdrawals are temporarily paused');

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

    const accountSats = db.getAccountBalance(userId);
    const amount = dec.amountSats;
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > accountSats) throw new Error('Invoice exceeds available account balance or has an invalid amount');
    if (L().maxWithdrawalSats && amount > L().maxWithdrawalSats) throw new Error(`Maximum withdrawal is ${L().maxWithdrawalSats} sats`);
    if (L().hotWalletCapSats && amount > L().hotWalletCapSats) throw new Error('Amount exceeds hot-wallet cap');

    // Validate exact whole-sat amount, destination and expiry.
    if (dec.amountMsats !== undefined && (!/^\d+$/.test(dec.amountMsats) || BigInt(dec.amountMsats) !== BigInt(amount) * 1000n)) throw new Error(`Invoice amount must equal the withdrawal amount (${amount} sats), with no fractional sats`);
    if (L().ownPubkey && dec.destination === L().ownPubkey) throw new Error('Self-payment is not allowed');
    if (dec.expiresAt && (!Number.isFinite(Date.parse(dec.expiresAt)) || Date.parse(dec.expiresAt) <= Date.now())) throw new Error('Invoice has expired or has an invalid expiry');
    // The invoice must outlive the send attempt. One that lapses mid-payment is
    // rejected by the node before a payment exists, leaving nothing to track.
    const sendWindowMs = ((L().paymentTimeoutSec ?? 60) + 30) * 1000;
    if (dec.expiresAt && Date.parse(dec.expiresAt) <= Date.now() + sendWindowMs) throw new Error('Invoice expires too soon. Create a new invoice and try again.');

    const feeBudget = withdrawalFeeBudget(amount,L());
    const feeReserve = L().feeReserveSats ?? 0;
    const spendable = await lnd.getSpendableSats();
    if (!Number.isSafeInteger(spendable) || spendable < 0) throw new Error('Could not verify the wallet balance. Try again shortly.');

    // Reserve only account credit in one transaction. A concurrent buy-in or
    // withdrawal must observe the reduced available account balance.
    let row;
    try {
      row = db.db.transaction(() => {
        if (!withdrawalsEnabled()) throw new Error('Withdrawals are temporarily paused');
        if (spendable < totalOwed()+outstandingFeeBudgets()+feeReserve+feeBudget) throw new Error('The wallet routing-fee reserve is low. Your balance is unchanged; please try again later.');
        if (db.getAccountBalance(userId) < amount) throw new Error('Your balance changed — please retry');
        db.insertWithdrawalReserved({userId, tableId: db.ACCOUNT, amountSats: amount,
          paymentHash: dec.paymentHash, bolt11, seatIndex: null});
        const r = db.getLedgerByHash(dec.paymentHash, 'withdrawal');
        db.db.prepare('INSERT INTO withdrawal_fee_budgets VALUES(?,?)').run(r.id,feeBudget);
        observe(r,'withdrawal_reserved');
        db.debitAccount(userId, db.ACCOUNT, 'withdrawal_reserved', amount);
        return r;
      })();
    } catch (e) {
      if (e && (e.code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE/.test(String(e.message)))) {
        throw new Error('This invoice was already submitted');
      }
      throw e;
    }

    try { onReserved({ paymentHash: row.payment_hash, amountSats: row.amount_sats }); }
    catch (error) { alert(`Withdrawal reservation notification failed: ${error.message}`); }

    // Dispatch only after the account reservation commits.
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
    // Only a persisted withdrawal reservation may send money. A deposit can
    // become account credit, never an automatic payment to a profile address.
    if (current && current.direction !== 'withdrawal') throw new Error('Only withdrawal records can dispatch Lightning payments');
    if (!current || !['reserved', 'in_flight'].includes(current.status)) return { status: current?.status || 'unknown' };
    // Use the committed invoice/hash/amount, never caller-supplied or stale data.
    row = current;
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
      // Only the transition out of in_flight may refund; a row already resolved
      // elsewhere keeps its recorded outcome.
      if (db.transitionLedgerStatus(row.id, ['in_flight'], 'failed')) {
        observe(row,'withdrawal_failed');
        doRefund(row);
        return { status: 'failed' };
      }
      const now = db.getLedgerById(row.id)?.status;
      return { status: now === 'refunded' ? 'failed' : now || 'unknown' };
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
      db.creditAccount(fresh.user_id, fresh.table_id, 'withdrawal_refunded', fresh.amount_sats);
      db.updateLedgerStatus(row.id, 'refunded', { settledAt: nowSec() });
      return fresh;
    })();
    if (!fresh) return;
    try { onRefund(fresh); }
    catch (e) { alert(`Refund handler failed for ${row.payment_hash}: ${e.message}`); }
  }

  function completePayment(row, result) {
    // A payment the node reports as paid must never also be refunded. 'failed'
    // (refund not yet applied) may still be corrected to succeeded.
    if (db.transitionLedgerStatus(row.id, ['reserved', 'in_flight', 'failed'], 'succeeded', { feeSats: result.feeSats || 0, settledAt: nowSec() })) {
      observe(row,'withdrawal_succeeded',elapsedSince(row,'withdrawal_reserved'));
      return true;
    }
    const now = db.getLedgerById(row.id)?.status;
    if (now === 'refunded') {
      tripBreaker(`Withdrawal ${row.payment_hash} was reported PAID after its refund was recorded`);
    }
    return false;
  }

  // ======================= RECONCILE + SOLVENCY ===========================

  // Resolve any non-terminal rows (startup + periodic). Crash-safe.
  async function reconcilePending() {
    if (reconciling) return;
    reconciling = true;
    try {
    const rows = [...db.getPendingLedger(), ...db.getExpiredDeposits()];
    const OPEN_DEPOSIT = ['pending', 'expired'];
    for (const listed of rows) {
      // The list was read before this pass began awaiting the node. A live
      // dispatch or the invoice stream may have resolved a row since then, so
      // every decision uses the row as it is now, and every status change is
      // compare-and-set. Acting on the stale copy could refund or credit twice.
      const row = db.getLedgerById(listed.id);
      if (!row) continue;
      if (row.direction === 'deposit') {
        if (!OPEN_DEPOSIT.includes(row.status)) continue;
        if (lnd.lookupInvoice) {
          try {
            const invoice = await lnd.lookupInvoice(row.payment_hash);
            if (invoice?.bolt11 && !row.bolt11 && invoice.invoiceAmountSats === row.amount_sats) {
              db.db.transaction(()=>{
                db.db.prepare('UPDATE ledger_entries SET bolt11=? WHERE id=? AND bolt11 IS NULL').run(invoice.bolt11,row.id);
                db.db.prepare("UPDATE deposit_invoice_intents SET secret='' WHERE ledger_id=?").run(row.id);
              })();
              observe(row,'invoice_recovered');
            }
            // creditDeposit is idempotent; the others only move a still-open row.
            if (invoice?.confirmed) creditDeposit(row.payment_hash, invoice.amountSats);
            else if (invoice?.canceled) db.transitionLedgerStatus(row.id, OPEN_DEPOSIT, 'canceled');
            else if (invoice?.held) db.transitionLedgerStatus(row.id, OPEN_DEPOSIT, 'pending');
            else if (invoice && (invoice.expiresAt || invoiceExpiry(row)) < nowSec()) db.transitionLedgerStatus(row.id, OPEN_DEPOSIT, 'expired');
          } catch (e) {
            // No invoice was ever returned and its fixed expiry has passed: it can
            // no longer be created or paid, so stop holding the account's deposit slot.
            if (!row.bolt11 && invoiceExpiry(row) < nowSec()) db.transitionLedgerStatus(row.id, OPEN_DEPOSIT, 'expired');
            else alert(`Deposit reconciliation failed: ${e.message}`);
          }
        }
        continue;
      }
      if (!['reserved', 'in_flight', 'failed'].includes(row.status)) continue;
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
        // A dispatch that started or finished during the await owns the outcome.
        if (activeDispatches.has(row.id)) continue;
        if (st && st.status === 'SUCCEEDED') {
          completePayment(row, st);
        } else if (st && st.status === 'FAILED') {
          if (db.transitionLedgerStatus(row.id, ['in_flight'], 'failed')) {
            observe(row,'withdrawal_failed');
            doRefund({ ...row, status: 'failed' });
          }
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
        db.getAccountBalance(row.user_id);
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

  // ======================= BOOKS CHECK ====================================
  // The solvency check compares what players are owed with what the node holds.
  // A node holding far more than that would hide a bug or attack that credits
  // sats nobody deposited. This check needs no node: what players are owed must
  // equal what came in, minus what was paid out, minus what they spent here.
  //
  //   owed  ==  deposits received − withdrawals paid − identifier purchases
  //
  // It also compares each account balance with its own transfer history.
  // Sats that nothing explains ("unbacked") pause payments. The opposite
  // direction — the site holding more than it owes — cannot be drained by a
  // player, so it only alerts. A finding must repeat on consecutive checks
  // before it acts, so one odd reading cannot pause the site.
  const BOOKS_CONFIRMATIONS = 2;
  let unbackedStreak = 0;
  function booksReport() {
    const received = db.sumDepositsReceived();
    const paidOut = db.sumSucceededWithdrawals();
    const revenue = db.sumIdentifierRevenue();
    const expectedOwed = received - paidOut - revenue;
    const owed = totalOwed();
    const accounts = db.accountHistoryMismatches();
    const unbackedAccountSats = accounts.reduce((sum, a) => sum + Math.max(0, a.diffSats), 0);
    return {
      received, paidOut, revenue, expectedOwed, owed,
      differenceSats: owed - expectedOwed, // > 0: owed more than ever came in
      unbackedAccountSats,
      accounts: accounts.map(a => ({ ...a, userId: String(a.userId).slice(0, 12) })),
    };
  }
  function booksCheck() {
    let report;
    try { report = booksReport(); }
    catch (e) { alert(`Books check could not run: ${e.message}`); return { ok: true, skipped: true }; }
    const unbacked = Math.max(report.differenceSats, report.unbackedAccountSats, 0);
    if (unbacked > 0) {
      unbackedStreak++;
      if (unbackedStreak >= BOOKS_CONFIRMATIONS) {
        const who = report.accounts.filter(a => a.diffSats > 0).slice(0, 3).map(a => `${a.userId} +${a.diffSats}`).join(', ');
        tripBreaker(`Books do not balance: ${unbacked} sats are owed to players that no deposit explains `
          + `(owed ${report.owed}, expected ${report.expectedOwed}${who ? `; accounts: ${who}` : ''})`);
        return { ok: false, reason: 'unbacked_sats', ...report };
      }
      return { ok: true, unconfirmed: true, ...report };
    }
    unbackedStreak = 0;
    if (report.differenceSats < 0 || report.accounts.length) {
      alert(`Books check: ${-report.differenceSats} sats received are not credited to any player `
        + `(owed ${report.owed}, expected ${report.expectedOwed}; ${report.accounts.length} account(s) differ from their history). Payments continue; investigate.`);
    }
    return { ok: true, ...report };
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
    booksCheck,
    booksReport,
    outstandingWithdrawals,
    outstandingFeeBudgets,
    metrics: () => db.paymentMetrics(),
    withdrawalsEnabled,
    depositsEnabled,
    tripBreaker,
    resetBreaker,
    breakerState,
  };
}

module.exports = { createPayments };
