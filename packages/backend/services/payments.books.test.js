'use strict';

process.env.SATOSHISTACKS_DB_PATH = process.env.SATOSHISTACKS_DB_PATH || ':memory:';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const db = require('../database');
const PokerGame = require('../poker-game');
const { createPayments } = require('./payments');

beforeEach(() => {
  db.db.exec('DELETE FROM identifier_purchases; DELETE FROM ledger_entries; DELETE FROM wallet_credits; DELETE FROM account_transfers; DELETE FROM hand_snapshots;');
});

function setup() {
  const game = new PokerGame('station100', { smallBlind: 50, bigBlind: 100, realMoney: true });
  game.saveSnapshot = () => {}; game.saveHandToDatabase = () => {};
  game.startActionTimer = () => {}; game.deductTimeBank = () => {};
  const lnd = {
    sendResult: { status: 'SUCCEEDED', preimage: 'p', feeSats: 1 },
    sendShouldThrow: false,
    async createInvoice({ amountSats, secret }) {
      const paymentHash = crypto.createHash('sha256').update(Buffer.from(secret, 'hex')).digest('hex');
      return { bolt11: `mock:${amountSats}:${paymentHash}`, paymentHash };
    },
    async decodeInvoice(bolt11) {
      const [, amt, hash] = bolt11.split(':');
      return { amountSats: parseInt(amt, 10), paymentHash: hash, destination: 'peer', expiresAt: new Date(Date.now() + 3600e3).toISOString() };
    },
    async sendPayment() { if (this.sendShouldThrow) throw new Error('timeout'); return this.sendResult; },
    async trackPayment() { return { status: 'SUCCEEDED', feeSats: 0 }; },
    // Far more than players are owed: exactly the case the solvency check cannot see through.
    async getSpendableSats() { return 25_000_000; },
  };
  const config = {
    WITHDRAWALS_ENABLED: true,
    isRealMoney: () => true,
    TABLE_CONFIGS: { station100: { minBuyin: 5000, maxBuyin: 10000 } },
    LIGHTNING: { maxWithdrawalSats: 1_000_000, hotWalletCapSats: 1_000_000, withdrawalFeeLimitSats: 50, invoiceExpirySec: 600, ownPubkey: 'OURNODE' },
  };
  const alerts = [];
  const payments = createPayments({
    lnd, db, config, getGame: () => game,
    liveStacksTotal: () => game.players.reduce((s, p) => (p ? s + p.stack + (p.currentBet || 0) : s), 0) + (game.pot || 0),
    alert: (m) => alerts.push(m),
  });
  const stopTimers = () => { if (game.handStartTimeout) { clearTimeout(game.handStartTimeout); game.handStartTimeout = null; } };
  async function deposit(userId, amountSats) {
    const inv = await payments.createDepositInvoice({ userId, amountSats });
    payments.creditDeposit(inv.paymentHash, amountSats);
  }
  const invoice = (amount) => `mock:${amount}:w_${crypto.randomBytes(8).toString('hex')}`;
  const balanced = (label) => {
    const r = payments.booksCheck();
    assert.equal(r.ok, true, label);
    assert.equal(r.differenceSats, 0, `${label}: owed must equal deposits − withdrawals − purchases`);
    assert.deepEqual(r.accounts, [], `${label}: every account matches its history`);
  };
  return { game, lnd, payments, alerts, deposit, invoice, balanced, stopTimers };
}

test('books balance at every step of an honest deposit → play → withdraw lifecycle', async () => {
  const { game, payments, alerts, deposit, invoice, balanced, stopTimers } = setup();
  balanced('empty site');
  await deposit('alice', 10000);
  await deposit('bob', 8000);
  balanced('after deposits');

  payments.buyInFromAccount({ userId: 'alice', tableId: 'station100', amountSats: 10000, seatIndex: 0 });
  payments.buyInFromAccount({ userId: 'bob', tableId: 'station100', amountSats: 6000, seatIndex: 1 });
  stopTimers();
  balanced('after buy-ins');

  // Chips changing hands at the table never change what the site owes in total.
  const [a, b] = [game.players[0], game.players[1]];
  a.stack -= 4000; b.stack += 4000;
  balanced('after a pot moves between players');

  payments.returnStackToAccount({ userId: 'bob', tableId: 'station100' });
  stopTimers();
  balanced('after a stack returns to the account');

  const out = await payments.requestWithdrawal({ userId: 'bob', bolt11: invoice(12000) });
  assert.equal(out.status, 'succeeded');
  balanced('after a completed withdrawal');
  assert.equal(payments.breakerState().tripped, false);
  assert.deepEqual(alerts, []);
});

test('a player can withdraw their entire balance at once; the check sets no amount or daily limit', async () => {
  const { payments, deposit, invoice, balanced } = setup();
  for (let i = 0; i < 9; i++) await deposit('whale', 100000);
  const out = await payments.requestWithdrawal({ userId: 'whale', bolt11: invoice(900000) });
  assert.equal(out.status, 'succeeded');
  assert.equal(db.getAccountBalance('whale'), 0);
  balanced('after a full-balance withdrawal');
});

test('books stay balanced while a withdrawal is unresolved and after a failed one is refunded', async () => {
  const { lnd, payments, deposit, invoice, balanced } = setup();
  await deposit('carol', 10000);
  lnd.sendShouldThrow = true;
  assert.equal((await payments.requestWithdrawal({ userId: 'carol', bolt11: invoice(4000) })).status, 'in_flight');
  balanced('withdrawal in flight');

  lnd.sendShouldThrow = false;
  lnd.sendResult = { status: 'FAILED' };
  assert.equal((await payments.requestWithdrawal({ userId: 'carol', bolt11: invoice(3000) })).status, 'failed');
  assert.equal(db.getAccountBalance('carol'), 6000);
  balanced('failed withdrawal refunded');
});

test('sats credited without a deposit pause payments once confirmed, even though the node is flush', async () => {
  const { payments, alerts, deposit, invoice } = setup();
  await deposit('dave', 10000);
  db.addWalletCredit('mallory', db.ACCOUNT, 500000); // a bug or attack: balance with no deposit behind it

  assert.equal((await payments.solvencyCheck()).ok, true, 'the solvency check alone does not notice');

  const first = payments.booksCheck();
  assert.equal(first.ok, true);
  assert.equal(first.unconfirmed, true);
  assert.equal(payments.breakerState().tripped, false, 'one reading never pauses the site');

  const second = payments.booksCheck();
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'unbacked_sats');
  assert.equal(second.differenceSats, 500000);
  assert.equal(payments.breakerState().tripped, true);
  assert.match(alerts.join('\n'), /CIRCUIT BREAKER TRIPPED: Books do not balance: 500000 sats/);
  assert.match(alerts.join('\n'), /mallory \+500000/);

  await assert.rejects(payments.requestWithdrawal({ userId: 'mallory', bolt11: invoice(500000) }), /paused/);
  await assert.rejects(payments.requestWithdrawal({ userId: 'dave', bolt11: invoice(1000) }), /paused/);
  assert.equal(db.getAccountBalance('dave'), 10000, 'honest balances are untouched while paused');
});

test('chips that appear at the table without a buy-in are caught too', async () => {
  const { game, payments, deposit, stopTimers } = setup();
  await deposit('erin', 10000);
  payments.buyInFromAccount({ userId: 'erin', tableId: 'station100', amountSats: 10000, seatIndex: 0 });
  stopTimers();
  game.players[0].stack += 7000;
  payments.booksCheck();
  const r = payments.booksCheck();
  assert.equal(r.ok, false);
  assert.equal(r.differenceSats, 7000);
  assert.equal(payments.breakerState().tripped, true);
});

test('a balance that offsets a loss elsewhere is still caught by the per-account history', async () => {
  const { payments, deposit } = setup();
  await deposit('frank', 10000);
  await deposit('grace', 10000);
  // Totals still match, but 3000 sats moved between accounts with no record.
  db.takeWalletCredit('frank', db.ACCOUNT, 3000);
  db.addWalletCredit('grace', db.ACCOUNT, 3000);
  assert.equal(payments.booksReport().differenceSats, 0);
  payments.booksCheck();
  const r = payments.booksCheck();
  assert.equal(r.ok, false);
  assert.equal(r.unbackedAccountSats, 3000);
  assert.equal(payments.breakerState().tripped, true);
});

test('a reading that clears before it repeats never pauses the site', async () => {
  const { payments, deposit, balanced } = setup();
  await deposit('heidi', 10000);
  db.addWalletCredit('heidi', db.ACCOUNT, 50);
  assert.equal(payments.booksCheck().unconfirmed, true);
  db.takeWalletCredit('heidi', db.ACCOUNT, 50);
  balanced('cleared');
  db.addWalletCredit('heidi', db.ACCOUNT, 50);
  assert.equal(payments.booksCheck().unconfirmed, true, 'the count starts again from one');
  assert.equal(payments.breakerState().tripped, false);
});

test('the site holding more than it owes alerts but does not pause anyone', async () => {
  const { payments, alerts, deposit, invoice } = setup();
  await deposit('ivan', 10000);
  db.takeWalletCredit('ivan', db.ACCOUNT, 2500); // credit lost: bad for ivan, but nothing a player can drain
  for (let i = 0; i < 3; i++) assert.equal(payments.booksCheck().ok, true);
  assert.equal(payments.breakerState().tripped, false);
  assert.match(alerts[0], /2500 sats received are not credited to any player/);
  assert.equal((await payments.requestWithdrawal({ userId: 'ivan', bolt11: invoice(7500) })).status, 'succeeded');
});

test('sats spent on an identifier leave the books balanced', async () => {
  const { payments, deposit, balanced } = setup();
  await deposit('judy', 15000);
  db.db.pragma('foreign_keys = OFF');
  try {
    db.db.transaction(() => {
      db.debitAccount('judy', 'judy-name', 'identifier_purchase', 10000);
      db.db.prepare('INSERT INTO identifier_purchases(name,pubkey,amount_sats) VALUES(?,?,?)').run('judy-name', 'judy', 10000);
    })();
    assert.equal(payments.booksReport().revenue, 10000);
    balanced('after an identifier purchase');
  } finally {
    db.db.exec('DELETE FROM identifier_purchases');
    db.db.pragma('foreign_keys = ON');
  }
});
