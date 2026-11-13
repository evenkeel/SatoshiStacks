'use strict';

// Hermetic, throwaway DB for these tests (no dev-DB pollution skewing solvency).
process.env.SATOSHISTACKS_DB_PATH = process.env.SATOSHISTACKS_DB_PATH || ':memory:';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const db = require('../database');
const PokerGame = require('../poker-game');
const { createPayments } = require('./payments');

beforeEach(() => { db.db.exec('DELETE FROM ledger_entries; DELETE FROM wallet_credits; DELETE FROM hand_snapshots;'); });

// ---- mock LND ------------------------------------------------------------
// Withdrawal invoices are encoded as "mock:<amount>:<hash>[:<dest>]" so the mock
// decoder can return a deterministic amount/hash/destination.
function mockLnd(overrides = {}) {
  return {
    sendResult: { status: 'SUCCEEDED', preimage: 'preimage', feeSats: 1 },
    sendShouldThrow: false,
    trackResult: { status: 'SUCCEEDED', feeSats: 0 },
    spendable: 100_000_000,
    async createInvoice({ amountSats, secret }) {
      const paymentHash = crypto.createHash('sha256').update(Buffer.from(secret,'hex')).digest('hex');
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

function setup({ stacks = [10000], lndOverrides = {}, cfgOverrides = {} } = {}) {
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
    alert: () => {},
  });
  return { game, lnd, config, payments, seated, refunded };
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
test('solvency rejects malformed balances instead of reporting wallet readiness', async () => {
  for (const spendable of [undefined, null, NaN, Infinity, -1, 0.5, '1000000']) {
    const { payments } = setup({ stacks: [], lndOverrides: { spendable } });
    assert.deepEqual(await payments.solvencyCheck(), { ok: false, reason: 'invalid_balance' });
    assert.equal(payments.breakerState().tripped, true);
    assert.equal(payments.withdrawalsEnabled(), false);
  }
});

// ======================= CASH-OUT TO LUD16 =======================

test('lost cash-out responses can be retried with the same invoice without a second send', async () => {
  let sends=0;
  const {payments}=setup({lndOverrides:{async sendPayment(){sends++;return {status:'SUCCEEDED'};}}});
  const args={userId:'u0',tableId:'station100',bolt11:wInvoice(10000,'retry-reply')};
  assert.equal((await payments.requestWithdrawal(args)).status,'succeeded');
  assert.equal((await payments.requestWithdrawal(args)).status,'succeeded');
  assert.equal(sends,1);
});
test('fractional sats cannot be hidden by a rounded-down invoice amount', async () => {
  const {payments,game}=setup({lndOverrides:{async decodeInvoice(){return {amountSats:10000,amountMsats:'10000001',paymentHash:'fractional',destination:'peer'};}}});
  await assert.rejects(payments.requestWithdrawal({userId:'u0',tableId:'station100',bolt11:'mock'}),/fractional sats/);
  assert.equal(game.players[0].stack,10000);assert.equal(db.getLedgerByHash('fractional','withdrawal'),undefined);
});
test('reconciliation cannot race an active dispatch into a refund', async () => {
  let finish, tracks=0;
  const {payments}=setup({lndOverrides:{sendPayment:()=>new Promise(resolve=>{finish=resolve;}),async trackPayment(){tracks++;return {status:'FAILED'};}}});
  const pending=payments.requestWithdrawal({userId:'u0',tableId:'station100',bolt11:wInvoice(10000,'live-send')});
  while(!finish) await new Promise(resolve=>setImmediate(resolve));
  await payments.reconcilePending();assert.equal(tracks,0);
  finish({status:'SUCCEEDED'});await pending;
  assert.equal(db.getWalletCredit('u0','station100'),0);
  assert.equal(db.getLedgerByHash('live-send','withdrawal').status,'succeeded');
});
test('restart after reservation but before LND accepts it re-dispatches the same invoice', async () => {
  const {payments,lnd}=setup({lndOverrides:{sendShouldThrow:true,trackResult:{status:'NOT_FOUND'}}});
  const args={userId:'u0',tableId:'station100',bolt11:wInvoice(10000,'never-reached-lnd')};
  await payments.requestWithdrawal(args);
  lnd.sendShouldThrow=false;
  await payments.reconcilePending();
  assert.equal(db.getLedgerByHash('never-reached-lnd','withdrawal').status,'succeeded');
  assert.equal(db.getWalletCredit('u0','station100'),0);
});
test('transport errors during reconciliation never refund or resend an unknown payment', async () => {
  let sends=0;
  const {payments}=setup({lndOverrides:{async sendPayment(){sends++;throw new Error('offline');},async trackPayment(){throw new Error('offline');}}});
  await payments.requestWithdrawal({userId:'u0',tableId:'station100',bolt11:wInvoice(10000,'unknown')});
  await payments.reconcilePending();assert.equal(sends,1);
  assert.equal(db.getLedgerByHash('unknown','withdrawal').status,'in_flight');assert.equal(db.getWalletCredit('u0','station100'),0);
});
test('reservation notification failure cannot lose or roll back a withdrawal', async () => {
  const {payments}=setup();
  const result=await payments.requestWithdrawal({userId:'u0',tableId:'station100',bolt11:wInvoice(10000,'notify'),onReserved(){throw new Error('disconnected');}});
  assert.equal(result.status,'succeeded');
});
test('a deposit that settles after expiry is recovered even after the invoice stream was offline',async()=>{
  const {payments,lnd}=setup({stacks:[]});
  const inv=await payments.createDepositInvoice({userId:'late-deposit',tableId:'station100',amountSats:5000});
  db.updateLedgerStatus(db.getLedgerByHash(inv.paymentHash,'deposit').id,'expired');
  lnd.lookupInvoice=async()=>({confirmed:true,amountSats:5000});
  await payments.reconcilePending();await payments.reconcilePending();
  assert.equal(payments.availableFunds('late-deposit','station100').stack,5000);
  assert.equal(db.getLedgerByHash(inv.paymentHash,'deposit').status,'settled_unseated');
});
test('an expired invoice with an accepted HTLC keeps reserving deposit exposure',async()=>{
  const {payments,lnd,config}=setup({stacks:[]});config.LIGHTNING.hotWalletCapSats=5000;
  const inv=await payments.createDepositInvoice({userId:'held-deposit',tableId:'station100',amountSats:5000});
  db.db.prepare("UPDATE ledger_entries SET created_at=0 WHERE payment_hash=?").run(inv.paymentHash);
  lnd.lookupInvoice=async()=>({confirmed:false,held:true});
  await payments.reconcilePending();
  assert.equal(db.getLedgerByHash(inv.paymentHash,'deposit').status,'pending');
  await assert.rejects(payments.createDepositInvoice({userId:'other-deposit',tableId:'station100',amountSats:5000}),/exposure/);
});

// Persistent npub account: external payments and table transfers are independent.
test('account deposits settle once without seating and can be made while playing', async () => {
  const {payments,game,seated}=setup();
  const inv=await payments.createDepositInvoice({userId:'u0',tableId:db.ACCOUNT,amountSats:1234});
  payments.creditDeposit(inv.paymentHash,1234); payments.creditDeposit(inv.paymentHash,1234);
  assert.equal(db.getAccountBalance('u0'),1234);
  assert.equal(game.players[0].stack,10000); assert.equal(seated.length,0);
  assert.equal(db.getLedgerByHash(inv.paymentHash,'deposit').status,'credited');
});
test('legacy recoverable balances across tables migrate exactly once', () => {
  setup({stacks:[]});
  db.addWalletCredit('legacy','station100',2000); db.addWalletCredit('legacy','other',3000);
  db.createDepositRow({userId:'legacy',tableId:'station100',amountSats:5000,paymentHash:'legacy-dep'});
  db.settleDeposit('legacy-dep',5000);
  assert.equal(db.getAccountBalance('legacy'),10000); assert.equal(db.getAccountBalance('legacy'),10000);
  assert.equal(db.sumWalletCredits()+db.sumHeldDeposits(),10000);
});
test('account buy-in and table return conserve funds and duplicate requests do not double debit', () => {
  const {payments,game}=setup({stacks:[]});
  db.creditAccount('u0',db.ACCOUNT,'deposit',20000);
  assert.equal(payments.buyInFromAccount({userId:'u0',tableId:'station100',amountSats:10000}),0);
  payments.buyInFromAccount({userId:'u0',tableId:'station100',amountSats:10000});
  assert.equal(db.getAccountBalance('u0'),10000); assert.equal(game.players[0].stack,10000);
  assert.equal(payments.returnStackToAccount({userId:'u0',tableId:'station100'}).amountSats,10000);
  payments.returnStackToAccount({userId:'u0',tableId:'station100'});
  assert.equal(db.getAccountBalance('u0'),20000); assert.equal(game.players[0],null);
});
test('insufficient balance, invalid table limits, and active hands cannot move account sats', () => {
  const {payments,game}=setup({stacks:[]});
  assert.throws(()=>payments.buyInFromAccount({userId:'u0',tableId:'station100',amountSats:10000}),/Insufficient/);
  db.creditAccount('u0',db.ACCOUNT,'deposit',10000);
  assert.throws(()=>payments.buyInFromAccount({userId:'u0',tableId:'station100',amountSats:1}),/limits/);
  payments.buyInFromAccount({userId:'u0',tableId:'station100',amountSats:10000});
  game.handInProgress=true; game.players[0].participatedThisHand=true;
  assert.throws(()=>payments.returnStackToAccount({userId:'u0',tableId:'station100'}),/active hand/);
  assert.equal(db.getAccountBalance('u0'),0); assert.equal(game.players[0].stack,10000);
});
test('partial account withdrawals leave the live stack untouched and deduplicate invoices', async () => {
  const {payments,game}=setup();
  db.creditAccount('u0',db.ACCOUNT,'deposit',10000);
  const args={userId:'u0',tableId:db.ACCOUNT,bolt11:wInvoice(3000,'partial-account')};
  await payments.requestWithdrawal(args); await payments.requestWithdrawal(args);
  assert.equal(db.getAccountBalance('u0'),7000); assert.equal(game.players[0].stack,10000);
});
test('concurrent account withdrawals cannot overspend available funds', async () => {
  const {payments}=setup({stacks:[]}); db.creditAccount('u0',db.ACCOUNT,'deposit',5000);
  const results=await Promise.allSettled(['a','b'].map(hash=>payments.requestWithdrawal({userId:'u0',tableId:db.ACCOUNT,bolt11:wInvoice(4000,'account-'+hash)})));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(db.getAccountBalance('u0'),1000);
});
test('definitive failure refunds only the reserved account amount once', async () => {
  const {payments}=setup({lndOverrides:{sendResult:{status:'FAILED'}}});
  db.creditAccount('u0',db.ACCOUNT,'deposit',5000);
  await payments.requestWithdrawal({userId:'u0',tableId:db.ACCOUNT,bolt11:wInvoice(2000,'account-failed')});
  await payments.reconcilePending();
  assert.equal(db.getAccountBalance('u0'),5000);
});
test('unknown account payment remains reserved through reconciliation', async () => {
  const {payments}=setup({lndOverrides:{sendShouldThrow:true,trackResult:{status:'IN_FLIGHT'}}});
  db.creditAccount('u0',db.ACCOUNT,'deposit',5000);
  await payments.requestWithdrawal({userId:'u0',tableId:db.ACCOUNT,bolt11:wInvoice(2000,'account-unknown')});
  await payments.reconcilePending();
  assert.equal(db.getAccountBalance('u0'),3000); assert.equal(payments.outstandingWithdrawals(),2000);
});
test('failed table snapshot rolls back both account debit and stack', () => {
  const {payments,game}=setup({stacks:[]}); db.creditAccount('u0',db.ACCOUNT,'deposit',10000);
  game.saveSnapshot=()=>{throw new Error('disk failure');};
  assert.throws(()=>payments.buyInFromAccount({userId:'u0',tableId:'station100',amountSats:10000}),/disk failure/);
  assert.equal(db.getAccountBalance('u0'),10000); assert.equal(game.players[0],null);
});
test('failed account credit rolls back table return and durable snapshot', () => {
  const {payments,game}=setup();
  const original=db.creditAccount;
  db.creditAccount=()=>{throw new Error('credit failed');};
  try { assert.throws(()=>payments.returnStackToAccount({userId:'u0',tableId:'station100'}),/credit failed/); }
  finally { db.creditAccount=original; }
  assert.equal(game.players[0].stack,10000); assert.equal(db.getAccountBalance('u0'),0);
});

test('a lost invoice reply survives service restart with one durable deposit hash',async()=>{
  const {payments,lnd,config}=setup({stacks:[]});
  const secrets=[];
  lnd.createInvoice=async args=>{secrets.push(args.secret);throw new Error('reply lost');};
  const request={userId:'restart-deposit',tableId:db.ACCOUNT,amountSats:5000};
  await assert.rejects(payments.createDepositInvoice(request),/reply lost/);
  const pending=db.getPendingLedger();assert.equal(pending.length,1);assert.equal(pending[0].bolt11,null);
  const hash=pending[0].payment_hash;
  lnd.createInvoice=async args=>{secrets.push(args.secret);return {paymentHash:hash,bolt11:'recovered-original'};};
  const restarted=createPayments({lnd,db,config,getGame:()=>null});
  const invoice=await restarted.createDepositInvoice({...request,amountSats:6000});
  assert.equal(invoice.paymentHash,hash);assert.equal(invoice.amountSats,5000);
  assert.equal(secrets[0],secrets[1]);assert.equal(db.getPendingLedger().length,1);
  assert.equal(db.db.prepare('SELECT secret FROM deposit_invoice_intents WHERE ledger_id=?').get(pending[0].id).secret,'');
});

test('invoice reconciliation recovers a lost reply and credits the account once',async()=>{
  const {payments,lnd,config}=setup({stacks:[]});
  lnd.createInvoice=async()=>{throw new Error('offline');};
  await assert.rejects(payments.createDepositInvoice({userId:'recover',tableId:db.ACCOUNT,amountSats:5000}));
  const row=db.getPendingLedger()[0];let notifications=0;
  lnd.lookupInvoice=async()=>({bolt11:'original',invoiceAmountSats:5000,confirmed:true,amountSats:5000});
  const restarted=createPayments({lnd,db,config,getGame:()=>null,onDeposit:()=>notifications++});
  await restarted.reconcilePending();await restarted.reconcilePending();
  assert.equal(db.getAccountBalance('recover'),5000);assert.equal(notifications,1);
  assert.equal(db.getLedgerById(row.id).bolt11,'original');
  assert.equal(db.db.prepare("SELECT count(*) AS n FROM payment_events WHERE event='deposit_credited'").get().n,1);
});

test('deposit settlement can arrive before the invoice RPC returns',async()=>{
  const {payments,lnd}=setup({stacks:[]});
  lnd.createInvoice=async({secret})=>{
    const paymentHash=crypto.createHash('sha256').update(Buffer.from(secret,'hex')).digest('hex');
    assert.equal(payments.creditDeposit(paymentHash,5000).status,'settled');
    return {paymentHash,bolt11:'early-settlement'};
  };
  await payments.createDepositInvoice({userId:'early',tableId:db.ACCOUNT,amountSats:5000});
  assert.equal(db.getAccountBalance('early'),5000);
});

test('a low fee reserve rejects a withdrawal before debiting the account',async()=>{
  const {payments,lnd,config}=setup({stacks:[]});
  db.creditAccount('reserve',db.ACCOUNT,'deposit',10000);
  config.LIGHTNING.feeReserveSats=5000;lnd.spendable=15049;
  await assert.rejects(payments.requestWithdrawal({userId:'reserve',tableId:db.ACCOUNT,bolt11:wInvoice(10000,'reserve-low')}),/reserve is low/);
  assert.equal(db.getAccountBalance('reserve'),10000);
  assert.equal(db.getLedgerByHash('reserve-low','withdrawal'),undefined);
});

test('reconciliation uses the reserved fee budget after operator policy changes',async()=>{
  const {payments,lnd,config}=setup({stacks:[]});let sends=[];
  db.creditAccount('frozen',db.ACCOUNT,'deposit',10000);
  lnd.sendPayment=async options=>{sends.push(options);throw new Error('lost reply');};
  const result=await payments.requestWithdrawal({userId:'frozen',tableId:db.ACCOUNT,bolt11:wInvoice(10000,'frozen-fee')});
  assert.equal(result.status,'in_flight');assert.equal(db.getAccountBalance('frozen'),0);
  config.LIGHTNING.withdrawalFeeLimitSats=500;lnd.trackPayment=async()=>({status:'NOT_FOUND'});
  lnd.sendPayment=async options=>{sends.push(options);return {status:'SUCCEEDED',feeSats:2};};
  await payments.reconcilePending();
  assert.deepEqual(sends.map(s=>s.feeLimitSats),[50,50]);
  assert.equal(db.getLedgerByHash('frozen-fee','withdrawal').amount_sats,10000);
  assert.equal(db.getLedgerByHash('frozen-fee','withdrawal').status,'succeeded');
});
