'use strict';

// Hermetic, throwaway DB for these tests (no dev-DB pollution skewing solvency).
process.env.SATOSHISTACKS_DB_PATH = process.env.SATOSHISTACKS_DB_PATH || ':memory:';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../database');
const PokerGame = require('../poker-game');
const { createPayments } = require('./payments');

// ---- mock LND ------------------------------------------------------------
// Withdrawal invoices are encoded as "mock:<amount>:<hash>[:<dest>]" so the mock
// decoder can return a deterministic amount/hash/destination.
function mockLnd(overrides = {}) {
  return {
    sendResult: { status: 'SUCCEEDED', preimage: 'preimage', feeSats: 1 },
    sendShouldThrow: false,
    trackResult: { status: 'SUCCEEDED', feeSats: 0 },
    spendable: 100_000_000,
    async createInvoice({ amountSats }) {
      const paymentHash = 'dep_' + Math.random().toString(36).slice(2);
      return { bolt11: `mock:${amountSats}:${paymentHash}`, paymentHash };
    },
    async decodeInvoice(bolt11) {
      const [, amt, hash, dest] = bolt11.split(':');
      return {
        amountSats: parseInt(amt, 10), paymentHash: hash,
        destination: dest || 'peer_pubkey',
        expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
      };
    },
    async sendPayment() { if (this.sendShouldThrow) throw new Error('timeout'); return this.sendResult; },
    async trackPayment() { return this.trackResult; },
    async getSpendableSats() { return this.spendable; },
    ...overrides,
  };
}

const wInvoice = (amount, hash, dest) =>
  `mock:${amount}:${hash || ('w_' + Math.random().toString(36).slice(2))}${dest ? ':' + dest : ''}`;

function setup({ stacks = [10000], lndOverrides = {}, cfgOverrides = {}, resolveImpl } = {}) {
  const game = new PokerGame('station100', { smallBlind: 50, bigBlind: 100, realMoney: true });
  game.saveSnapshot = () => {}; game.saveHandToDatabase = () => {};
  game.startActionTimer = () => {}; game.deductTimeBank = () => {};
  stacks.forEach((s, i) => game.addPlayer('u' + i, 'P' + i, { initialStack: s, preferredSeat: i }));
  if (game.handStartTimeout) { clearTimeout(game.handStartTimeout); game.handStartTimeout = null; }

  const lnd = mockLnd(lndOverrides);
  const config = {
    WITHDRAWALS_ENABLED: true,
    isRealMoney: () => true,
    LIGHTNING: {
      minWithdrawalSats: 1000, maxWithdrawalSats: 1_000_000, hotWalletCapSats: 1_000_000,
      withdrawalFeeLimitSats: 50, invoiceExpirySec: 600, ownPubkey: 'OURNODE',
    },
    ...cfgOverrides,
  };
  const seated = [], refunded = [];
  const payments = createPayments({
    lnd, db, config, getGame: () => game,
    liveStacksTotal: () => game.players.reduce((s, p) => (p ? s + p.stack + (p.currentBet || 0) : s), 0) + (game.pot || 0),
    onSeatPlayer: (row) => seated.push(row),
    onRefund: (row) => refunded.push(row),
    // Default mock LNURL resolver: returns a mock invoice for the exact amount.
    resolveLightningAddress: resolveImpl || (async (lud16, amt) => `mock:${amt}:refund_${Math.random().toString(36).slice(2)}`),
    alert: () => {},
  });
  return { game, lnd, config, payments, seated, refunded };
}

// Insert a settled-but-unseated deposit row (a deposit that couldn't be seated).
function unseatedDeposit(userId, tableId, amount) {
  const hash = 'udep_' + Math.random().toString(36).slice(2);
  db.createDepositRow({ userId, tableId, amountSats: amount, paymentHash: hash, bolt11: 'x', seatIndex: null });
  db.settleDeposit(hash, amount);
  const row = db.getLedgerByHash(hash, 'deposit');
  db.updateLedgerStatus(row.id, 'settled_unseated');
  return db.getLedgerByHash(hash, 'deposit');
}

// ======================= DEPOSITS =======================

test('deposit credits + seats exactly once (idempotent on payment_hash)', async () => {
  const { payments, seated } = setup({ stacks: [] });
  const inv = await payments.createDepositInvoice({ userId: 'd0', tableId: 'station100', amountSats: 10000, seatIndex: 0 });
  const r1 = payments.creditDeposit(inv.paymentHash, 10000);
  const r2 = payments.creditDeposit(inv.paymentHash, 10000); // LND redelivery
  assert.equal(r1.status, 'settled');
  assert.equal(r2.status, 'already_settled');
  assert.equal(seated.length, 1, 'seated exactly once despite double settle');
});

test('deposit with a mismatched paid amount is NOT credited', async () => {
  const { payments, seated } = setup({ stacks: [] });
  const inv = await payments.createDepositInvoice({ userId: 'd1', tableId: 'station100', amountSats: 10000 });
  const r = payments.creditDeposit(inv.paymentHash, 9000);
  assert.equal(r.status, 'amount_mismatch');
  assert.equal(seated.length, 0);
});

// ======================= WITHDRAWALS =======================

test('withdrawal invoice for more than the stack is rejected (no ledger row, still seated)', async () => {
  const { payments, game } = setup({ stacks: [10000] });
  const hash = 'over_' + Date.now();
  await assert.rejects(
    payments.requestWithdrawal({ userId: 'u0', tableId: 'station100', bolt11: wInvoice(15000, hash) }),
    /must equal your stack/,
  );
  assert.equal(db.getLedgerByHash(hash, 'withdrawal'), undefined);
  assert.equal(game.players[0].stack, 10000, 'untouched');
});

test('full-stack withdrawal succeeds: seat freed, ledger succeeded', async () => {
  const { payments, game } = setup({ stacks: [10000] });
  const hash = 'ok_' + Date.now();
  const res = await payments.requestWithdrawal({ userId: 'u0', tableId: 'station100', bolt11: wInvoice(10000, hash) });
  assert.equal(res.status, 'succeeded');
  assert.equal(game.players[0], null, 'seat freed');
  assert.equal(db.getLedgerByHash(hash, 'withdrawal').status, 'succeeded');
});

test('concurrent withdrawals on one seat: exactly one succeeds, never double-pays', async () => {
  const { payments, game } = setup({ stacks: [10000] });
  const h1 = 'c1_' + Date.now(), h2 = 'c2_' + Date.now();
  const results = await Promise.allSettled([
    payments.requestWithdrawal({ userId: 'u0', tableId: 'station100', bolt11: wInvoice(10000, h1) }),
    payments.requestWithdrawal({ userId: 'u0', tableId: 'station100', bolt11: wInvoice(10000, h2) }),
  ]);
  const succeeded = results.filter(r => r.status === 'fulfilled' && r.value.status === 'succeeded');
  assert.equal(succeeded.length, 1, 'exactly one withdrawal succeeded');
  assert.equal(game.players[0], null);
  const rows = [db.getLedgerByHash(h1, 'withdrawal'), db.getLedgerByHash(h2, 'withdrawal')].filter(Boolean);
  assert.equal(rows.length, 1, 'only one reserved ledger row exists');
});

test('payment timeout leaves the withdrawal in_flight and does NOT refund', async () => {
  const { payments, game, refunded } = setup({ stacks: [10000], lndOverrides: { sendShouldThrow: true } });
  const hash = 'tmo_' + Date.now();
  const res = await payments.requestWithdrawal({ userId: 'u0', tableId: 'station100', bolt11: wInvoice(10000, hash) });
  assert.equal(res.status, 'in_flight');
  assert.equal(db.getLedgerByHash(hash, 'withdrawal').status, 'in_flight');
  assert.equal(refunded.length, 0, 'NO refund while the payment fate is unknown');
  assert.equal(game.players[0], null, 'chips stay removed (not double-credited)');
});

test('definitive FAILED triggers exactly one refund', async () => {
  const { payments, refunded } = setup({ stacks: [10000], lndOverrides: { sendResult: { status: 'FAILED' } } });
  const hash = 'fail_' + Date.now();
  const res = await payments.requestWithdrawal({ userId: 'u0', tableId: 'station100', bolt11: wInvoice(10000, hash) });
  assert.equal(res.status, 'failed');
  assert.equal(db.getLedgerByHash(hash, 'withdrawal').status, 'refunded');
  assert.equal(refunded.length, 1);
});

test('reconciler resolves an in_flight withdrawal to succeeded via trackPayment', async () => {
  const { payments, lnd } = setup({ stacks: [10000], lndOverrides: { sendShouldThrow: true } });
  const hash = 'rec_' + Date.now();
  await payments.requestWithdrawal({ userId: 'u0', tableId: 'station100', bolt11: wInvoice(10000, hash) });
  assert.equal(db.getLedgerByHash(hash, 'withdrawal').status, 'in_flight');
  lnd.trackResult = { status: 'SUCCEEDED', feeSats: 2 };
  await payments.reconcilePending();
  assert.equal(db.getLedgerByHash(hash, 'withdrawal').status, 'succeeded');
});

test('cash-out is rejected mid-hand (committed chips)', async () => {
  const { payments, game } = setup({ stacks: [10000, 10000] });
  game.startNewHand();
  const active = game.players[game.currentPlayerIndex].userId;
  await assert.rejects(
    payments.requestWithdrawal({ userId: active, tableId: 'station100', bolt11: wInvoice(10000) }),
    /active hand/,
  );
});

test('self-pay invoice (destination == our own node) is rejected', async () => {
  const { payments } = setup({ stacks: [10000] });
  await assert.rejects(
    payments.requestWithdrawal({ userId: 'u0', tableId: 'station100', bolt11: wInvoice(10000, 'sp_' + Date.now(), 'OURNODE') }),
    /Self-payment/,
  );
});

test('kill switch (WITHDRAWALS_ENABLED=false) rejects withdrawals', async () => {
  const { payments } = setup({ stacks: [10000], cfgOverrides: { WITHDRAWALS_ENABLED: false } });
  await assert.rejects(
    payments.requestWithdrawal({ userId: 'u0', tableId: 'station100', bolt11: wInvoice(10000) }),
    /paused/,
  );
});

// ======================= SOLVENCY / BREAKER =======================

test('solvency: breaker trips and halts withdrawals when node cannot cover owed', async () => {
  const { payments, lnd } = setup({ stacks: [10000] });
  const owed = 10000 + payments.outstandingWithdrawals(); // liveStacks + outstanding
  lnd.spendable = owed - 1;
  const r = await payments.solvencyCheck();
  assert.equal(r.ok, false);
  assert.equal(payments.withdrawalsEnabled(), false, 'tripped breaker halts withdrawals');
});

test('solvency: ok when node spendable covers owed', async () => {
  const { payments, lnd } = setup({ stacks: [10000] });
  const owed = 10000 + payments.outstandingWithdrawals();
  lnd.spendable = owed + 1;
  const r = await payments.solvencyCheck();
  assert.equal(r.ok, true);
  assert.equal(payments.withdrawalsEnabled(), true);
});

// ======================= CASH-OUT TO LUD16 =======================

test('cashout: sends a seated stack to the lud16 and frees the seat', async () => {
  const { payments, game } = setup({ stacks: [10000] });
  const res = await payments.cashoutToAddress({ userId: 'u0', tableId: 'station100', lud16: 'name@example.com' });
  assert.equal(res.status, 'succeeded');
  assert.equal(game.players[0], null, 'seat freed');
});

test('cashout: rejected with no lud16 on file', async () => {
  const { payments } = setup({ stacks: [10000] });
  await assert.rejects(payments.cashoutToAddress({ userId: 'u0', tableId: 'station100', lud16: null }), /Lightning address/);
});

test('cashout: rejected mid-hand', async () => {
  const { payments, game } = setup({ stacks: [10000, 10000] });
  game.startNewHand();
  const active = game.players[game.currentPlayerIndex].userId;
  await assert.rejects(payments.cashoutToAddress({ userId: active, tableId: 'station100', lud16: 'name@example.com' }), /active hand/);
});

// ======================= REFUND UNSEATED DEPOSIT =======================

test('refund: pushes an unseated deposit to the lud16 and marks it refunded', async () => {
  const { payments } = setup({ stacks: [] });
  const row = unseatedDeposit('r0', 'station100', 10000);
  const res = await payments.refundDepositToAddress(row, 'name@example.com');
  assert.equal(res.status, 'refunded');
  assert.equal(db.getLedgerById(row.id).status, 'refunded');
});

test('refund: a resolved invoice for the wrong amount is rejected and the deposit reverts', async () => {
  const { payments } = setup({ stacks: [], resolveImpl: async (l, amt) => `mock:${amt - 1}:wrong` });
  const row = unseatedDeposit('r1', 'station100', 10000);
  await assert.rejects(payments.refundDepositToAddress(row, 'name@example.com'), /amount/);
  assert.equal(db.getLedgerById(row.id).status, 'settled_unseated', 'reverted for retry');
});

test('refund: a FAILED payment reverts the deposit to settled_unseated (retryable)', async () => {
  const { payments } = setup({ stacks: [], lndOverrides: { sendResult: { status: 'FAILED' } } });
  const row = unseatedDeposit('r2', 'station100', 10000);
  const res = await payments.refundDepositToAddress(row, 'name@example.com');
  assert.equal(res.status, 'failed');
  assert.equal(db.getLedgerById(row.id).status, 'settled_unseated');
});

test('refund: a second concurrent refund is skipped (deposit is locked)', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const { payments } = setup({ stacks: [], lndOverrides: { sendPayment: async function () { await gate; return this.sendResult; } } });
  const row = unseatedDeposit('r3', 'station100', 10000);
  const p1 = payments.refundDepositToAddress(row, 'name@example.com');
  await new Promise(r => setTimeout(r, 5)); // let p1 acquire the lock + reach the gated send
  const r2 = await payments.refundDepositToAddress(row, 'name@example.com');
  assert.equal(r2.status, 'skipped', 'second refund skipped while first is locked');
  release();
  assert.equal((await p1).status, 'refunded');
});

test('refund: no lud16 on file is rejected', async () => {
  const { payments } = setup({ stacks: [] });
  const row = unseatedDeposit('r4', 'station100', 10000);
  await assert.rejects(payments.refundDepositToAddress(row, null), /Lightning address/);
});
