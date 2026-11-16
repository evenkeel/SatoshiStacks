'use strict';
// Regression tests for accounting races and deposit availability found in the
// November 15 review. A fake node only: nothing here contacts Lightning.
process.env.SATOSHISTACKS_DB_PATH = process.env.SATOSHISTACKS_DB_PATH || ':memory:';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const db = require('../database');
const PokerGame = require('../poker-game');
const { createPayments } = require('./payments');

beforeEach(() => {
  db.db.exec('DELETE FROM deposit_invoice_intents; DELETE FROM withdrawal_fee_budgets; DELETE FROM payment_events; DELETE FROM account_transfers; DELETE FROM ledger_entries; DELETE FROM wallet_credits; DELETE FROM hand_snapshots;');
});

function mockLnd(overrides = {}) {
  return {
    spendable: 100_000_000,
    async createInvoice({ amountSats, secret }) {
      const paymentHash = crypto.createHash('sha256').update(Buffer.from(secret, 'hex')).digest('hex');
      return { bolt11: `mock:${amountSats}:${paymentHash}`, paymentHash };
    },
    async decodeInvoice(bolt11) {
      const [, amount, hash, dest] = bolt11.split(':');
      return { amountSats: parseInt(amount, 10), paymentHash: hash, destination: dest || 'peer_pubkey',
        expiresAt: new Date(Date.now() + 3600 * 1000).toISOString() };
    },
    async sendPayment() { return { status: 'SUCCEEDED', preimage: 'preimage', feeSats: 1 }; },
    async trackPayment() { return { status: 'SUCCEEDED', feeSats: 0 }; },
    async getSpendableSats() { return this.spendable; },
    ...overrides,
  };
}
function setup({ lnd: lndOverrides = {}, lightning = {} } = {}) {
  const game = new PokerGame('station100', { smallBlind: 50, bigBlind: 100, minBuyin: 5000, maxBuyin: 10000, realMoney: true });
  const lnd = mockLnd(lndOverrides);
  const alerts = [], refunded = [];
  const config = { WITHDRAWALS_ENABLED: true, isRealMoney: () => true,
    TABLE_CONFIGS: { station100: { minBuyin: 5000, maxBuyin: 10000 } },
    LIGHTNING: { maxWithdrawalSats: 1_000_000, hotWalletCapSats: 1_000_000, withdrawalFeeLimitSats: 50,
      invoiceExpirySec: 600, ownPubkey: 'OURNODE', ...lightning } };
  const payments = createPayments({ lnd, db, config, getGame: () => game, liveStacksTotal: () => 0,
    onRefund: row => refunded.push(row), alert: message => alerts.push(message) });
  return { lnd, payments, alerts, refunded, config };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const transfers = userId => db.getAccountHistory(userId).map(t => t.kind);

test('a withdrawal that fails while the reconciler is mid-pass is refunded exactly once', async () => {
  let finishSend, releaseLookup;
  const { payments, refunded, lnd } = setup({ lnd: {
    sendPayment: () => new Promise(resolve => { finishSend = resolve; }),
    async trackPayment() { return { status: 'FAILED' }; },
    lookupInvoice: () => new Promise(resolve => { releaseLookup = () => resolve({ confirmed: false }); }),
  } });
  // An older unpaid deposit is what the pass awaits before reaching the withdrawal.
  await payments.createDepositInvoice({ userId: 'someone-else', tableId: db.ACCOUNT, amountSats: 5000 });
  db.db.prepare("UPDATE ledger_entries SET created_at=created_at-10 WHERE direction='deposit'").run();
  db.creditAccount('player', db.ACCOUNT, 'deposit', 10000);
  const liabilities = db.sumWalletCredits();

  const withdrawal = payments.requestWithdrawal({ userId: 'player', tableId: db.ACCOUNT, bolt11: 'mock:10000:held-then-failed' });
  while (!finishSend) await tick();
  assert.equal(db.getAccountBalance('player'), 0, 'the amount is reserved while the payment is in flight');

  const pass = payments.reconcilePending();           // reads the in_flight row, then awaits the deposit lookup
  while (!releaseLookup) await tick();
  finishSend({ status: 'FAILED' });                   // the live dispatch fails and refunds meanwhile
  assert.equal((await withdrawal).status, 'failed');
  assert.equal(db.getAccountBalance('player'), 10000);
  releaseLookup(); await pass;                        // the pass now reaches its stale copy of the row

  assert.equal(db.getAccountBalance('player'), 10000, 'one failed 10,000-sat withdrawal returns 10,000 sats, not 20,000');
  assert.equal(transfers('player').filter(kind => kind === 'withdrawal_refunded').length, 1);
  assert.equal(refunded.length, 1);
  assert.equal(db.sumWalletCredits(), liabilities);
  assert.equal(db.getLedgerByHash('held-then-failed', 'withdrawal').status, 'refunded');
  lnd.lookupInvoice = async () => ({ confirmed: false });
  await payments.reconcilePending();                  // later passes change nothing
  assert.equal(db.getAccountBalance('player'), 10000);
});

test('a deposit credited by the invoice stream during a stale lookup is not credited again', async () => {
  let release;
  const { payments, lnd } = setup();
  const invoice = await payments.createDepositInvoice({ userId: 'depositor', tableId: db.ACCOUNT, amountSats: 5000 });
  const justExpired = Math.floor(Date.now() / 1000) - 1;
  lnd.lookupInvoice = () => new Promise(resolve => { release = () => resolve({ confirmed: false, expiresAt: justExpired }); });
  const pass = payments.reconcilePending();
  while (!release) await tick();
  assert.equal(payments.creditDeposit(invoice.paymentHash, 5000).status, 'settled');   // stream event arrives first
  assert.equal(db.getAccountBalance('depositor'), 5000);
  release(); await pass;                                                                 // stale "open and expired" answer lands
  assert.equal(db.getLedgerByHash(invoice.paymentHash, 'deposit').status, 'credited', 'a credited deposit is never reopened');

  lnd.lookupInvoice = async () => ({ confirmed: true, amountSats: 5000 });
  await payments.reconcilePending();
  assert.equal(db.getAccountBalance('depositor'), 5000, 'one 5,000-sat payment credits 5,000 sats');
  assert.equal(transfers('depositor').filter(kind => kind === 'deposit').length, 1);
});

test('a stale canceled or held answer cannot reopen a credited deposit either', async () => {
  for (const answer of [{ canceled: true }, { held: true }]) {
    let release;
    const { payments, lnd } = setup();
    const userId = `depositor-${Object.keys(answer)[0]}`;
    const invoice = await payments.createDepositInvoice({ userId, tableId: db.ACCOUNT, amountSats: 5000 });
    lnd.lookupInvoice = () => new Promise(resolve => { release = () => resolve(answer); });
    const pass = payments.reconcilePending();
    while (!release) await tick();
    payments.creditDeposit(invoice.paymentHash, 5000);
    release(); await pass;
    assert.equal(db.getLedgerByHash(invoice.paymentHash, 'deposit').status, 'credited');
    assert.equal(db.getAccountBalance(userId), 5000);
  }
});

test('a payment the node later reports as paid is never completed on top of a recorded refund', async () => {
  const { payments, lnd, alerts } = setup({ lnd: { async sendPayment() { return { status: 'FAILED' }; } } });
  db.creditAccount('player', db.ACCOUNT, 'deposit', 4000);
  assert.equal((await payments.requestWithdrawal({ userId: 'player', tableId: db.ACCOUNT, bolt11: 'mock:4000:contradiction' })).status, 'failed');
  const row = db.getLedgerByHash('contradiction', 'withdrawal');
  assert.equal(row.status, 'refunded');
  // A stale in_flight copy reaching the reconciler must not rewrite the outcome.
  lnd.trackPayment = async () => ({ status: 'SUCCEEDED', feeSats: 1 });
  db.updateLedgerStatus(row.id, 'in_flight');
  const stale = db.getLedgerById(row.id);
  db.updateLedgerStatus(row.id, 'refunded');
  assert.equal(db.transitionLedgerStatus(stale.id, ['reserved', 'in_flight', 'failed'], 'succeeded'), false);
  assert.equal(db.getLedgerById(row.id).status, 'refunded');
  assert.equal(db.getAccountBalance('player'), 4000);
  assert.equal(alerts.filter(message => /CIRCUIT BREAKER/.test(message)).length, 0);
});

test('compare-and-set ledger transitions report whether this caller moved the row', () => {
  db.createDepositRow({ userId: 'cas', tableId: db.ACCOUNT, amountSats: 1000, paymentHash: 'cas-hash', bolt11: null, seatIndex: null });
  const row = db.getLedgerByHash('cas-hash', 'deposit');
  assert.equal(db.transitionLedgerStatus(row.id, ['pending'], 'expired'), true);
  assert.equal(db.transitionLedgerStatus(row.id, ['pending'], 'canceled'), false, 'a second writer with a stale view changes nothing');
  assert.equal(db.getLedgerById(row.id).status, 'expired');
  assert.equal(db.transitionLedgerStatus(row.id, [], 'canceled'), false);
});

test('an invoice request that never produced an invoice stops blocking the account once its expiry passes', async () => {
  let nodeUp = false;
  const { payments, lnd } = setup({ lnd: {
    async createInvoice({ amountSats, secret, expiresAt }) {
      if (!nodeUp) throw new Error('node unavailable');
      // The real adapter and node both refuse to create an invoice that has already expired.
      if (expiresAt <= Math.floor(Date.now() / 1000)) throw new Error('ExpectedFutureDateForInvoiceExpiration');
      const paymentHash = crypto.createHash('sha256').update(Buffer.from(secret, 'hex')).digest('hex');
      return { bolt11: `mock:${amountSats}:${paymentHash}`, paymentHash };
    },
    async lookupInvoice() { throw new Error('unable to locate invoice'); },
  } });
  const request = { userId: 'retrying', tableId: db.ACCOUNT, amountSats: 5000 };
  await assert.rejects(payments.createDepositInvoice(request), /node unavailable/);
  nodeUp = true;
  // Eleven minutes later the original 10-minute intent has expired.
  db.db.prepare('UPDATE deposit_invoice_intents SET expires_at = expires_at - 660').run();
  db.db.prepare("UPDATE ledger_entries SET created_at = created_at - 660 WHERE direction='deposit'").run();

  const invoice = await payments.createDepositInvoice(request);
  assert.match(invoice.bolt11, /^mock:5000:/);
  const rows = db.db.prepare("SELECT status, bolt11 FROM ledger_entries WHERE user_id='retrying' ORDER BY id").all();
  assert.deepEqual(rows.map(row => row.status), ['expired', 'pending']);
  assert.equal(rows[0].bolt11, null);
  // The retired request still credits if the node ever reports it paid.
  const retired = db.db.prepare("SELECT payment_hash FROM ledger_entries WHERE user_id='retrying' AND status='expired'").get();
  assert.equal(payments.creditDeposit(retired.payment_hash, 5000).status, 'settled');
  assert.equal(db.getAccountBalance('retrying'), 5000);
});

test('the reconciler retires an abandoned invoice request without alert noise, but keeps recoverable ones', async () => {
  let nodeUp = false;
  const { payments, alerts } = setup({ lnd: {
    async createInvoice() { if (!nodeUp) throw new Error('node unavailable'); throw new Error('unexpected'); },
    async lookupInvoice() { throw new Error('unable to locate invoice'); },
  } });
  await assert.rejects(payments.createDepositInvoice({ userId: 'abandoned', tableId: db.ACCOUNT, amountSats: 5000 }));
  await payments.reconcilePending();
  assert.equal(db.db.prepare("SELECT status FROM ledger_entries WHERE user_id='abandoned'").get().status, 'pending', 'an unexpired request stays recoverable');
  assert.equal(alerts.filter(message => /Deposit reconciliation failed/.test(message)).length, 1);
  db.db.prepare('UPDATE deposit_invoice_intents SET expires_at = expires_at - 660').run();
  alerts.length = 0;
  await payments.reconcilePending();
  assert.equal(db.db.prepare("SELECT status FROM ledger_entries WHERE user_id='abandoned'").get().status, 'expired');
  assert.equal(alerts.length, 0);
});

test('one unpaid invoice cannot reserve the whole deposit allowance', async () => {
  const { payments } = setup({ lightning: { maxDepositSats: 100000 } });
  await assert.rejects(payments.createDepositInvoice({ userId: 'greedy', tableId: db.ACCOUNT, amountSats: 1_000_000 }), /Maximum deposit is 100000 sats/);
  assert.equal(db.getPendingLedger().length, 0, 'a refused request reserves nothing');
  await payments.createDepositInvoice({ userId: 'greedy', tableId: db.ACCOUNT, amountSats: 100000 });
  const honest = await payments.createDepositInvoice({ userId: 'honest', tableId: db.ACCOUNT, amountSats: 5000 });
  assert.equal(honest.amountSats, 5000);
});

test('a receiving invoice must outlive the send attempt', async () => {
  const soon = seconds => new Date(Date.now() + seconds * 1000).toISOString();
  let expiresAt = soon(20);
  const { payments } = setup({ lightning: { paymentTimeoutSec: 60 }, lnd: {
    async decodeInvoice(bolt11) { const [, amount, hash] = bolt11.split(':'); return { amountSats: Number(amount), paymentHash: hash, destination: 'peer', expiresAt }; },
  } });
  db.creditAccount('player', db.ACCOUNT, 'deposit', 3000);
  await assert.rejects(payments.requestWithdrawal({ userId: 'player', tableId: db.ACCOUNT, bolt11: 'mock:3000:expiring' }), /expires too soon/);
  assert.equal(db.getAccountBalance('player'), 3000, 'a refused invoice reserves nothing');
  assert.equal(db.getLedgerByHash('expiring', 'withdrawal'), undefined);
  expiresAt = soon(600);
  assert.equal((await payments.requestWithdrawal({ userId: 'player', tableId: db.ACCOUNT, bolt11: 'mock:3000:lasting' })).status, 'succeeded');
  assert.equal(db.getAccountBalance('player'), 0);
});
