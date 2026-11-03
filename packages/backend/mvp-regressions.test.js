'use strict';
process.env.SATOSHISTACKS_DB_PATH = ':memory:';
process.env.ADMIN_TOKEN ||= 'test-admin-token';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const db = require('./database');
const PokerGame = require('./poker-game');
const { createPayments } = require('./services/payments');
const nostr = require('./services/nostr');
const { finalizeEvent, generateSecretKey, getPublicKey } = require('nostr-tools/pure');
const { setup } = require('./socket-handlers');
nostr.scheduleLiveActivityUpdate = () => {};
const games = [];
beforeEach(() => db.db.exec('DELETE FROM ledger_entries; DELETE FROM wallet_credits; DELETE FROM hand_snapshots;'));
afterEach(() => {
  for (const game of games.splice(0)) {
    clearTimeout(game.handStartTimeout);
    game.clearActionTimer(); game.clearRunoutTimeouts();
    for (const timer of game.sitOutKickTimers.values()) clearTimeout(timer);
  }
});
function fixture({ stack = 10000, onRefund = () => {}, onSeatPlayer } = {}) {
  const game = new PokerGame('station100', { realMoney: true }); games.push(game);
  const io = { on() {}, to() { return { emit() {} }; }, sockets: { sockets: new Map([['socket', { join() {} }]]) } };
  const handlers = setup(io, new Map([['station100', game]]), new Map([['u0', 'socket']]), new Map(), new Map(), () => {}, new Map());
  handlers.wireGame('station100', game);
  if (stack !== null) game.addPlayer('u0', 'Synthetic', { initialStack: stack });
  const sends = [];
  let invoices = 0;
  const lnd = {
    async createInvoice({ amountSats }) { invoices++; return { bolt11: `mock:${amountSats}:dep${invoices}`, paymentHash: `dep${invoices}` }; },
    async decodeInvoice(invoice) { const [, amount, hash] = invoice.split(':'); return { amountSats: Number(amount), paymentHash: hash, destination: 'peer' }; },
    async sendPayment(payment) { sends.push(payment); return { status: 'SUCCEEDED' }; },
    async trackPayment() { return { status: 'SUCCEEDED' }; },
    async getSpendableSats() { return 1000000; },
  };
  const config = { isRealMoney: () => true, WITHDRAWALS_ENABLED: true, DEPOSITS_ENABLED: true,
    LIGHTNING: { minWithdrawalSats: 1000, maxWithdrawalSats: 100000, hotWalletCapSats: 100000, invoiceExpirySec: 600, withdrawalFeeLimitSats: 50 } };
  const payments = createPayments({ lnd, db, config, getGame: () => game,
    liveStacksTotal: () => game.players.reduce((s, p) => s + (p ? p.stack + p.currentBet : 0), game.pot),
    onSeatPlayer: onSeatPlayer || handlers.seatFromDeposit, onRefund, alert() {} });
  return { game, payments, lnd, sends, handlers, config, invoiceCount: () => invoices };
}
function deposit(hash, amount = 5000) {
  db.createDepositRow({ userId: 'u0', tableId: 'station100', amountSats: amount, paymentHash: hash, bolt11: 'mock' });
  return db.settleDeposit(hash, amount).row;
}

test('folded players cannot reserve their unchanged stack twice mid-hand', async () => {
  const { game, payments, sends } = fixture();
  game.handInProgress = true; game.currentPlayerIndex = 1;
  game.players[0].participatedThisHand = true; game.players[0].folded = true;
  const results = await Promise.allSettled(['a','b'].map(hash => payments.requestWithdrawal({ userId: 'u0', tableId: 'station100', bolt11: `mock:10000:${hash}` })));
  assert.ok(results.every(r => r.status === 'rejected'));
  assert.equal(sends.length, 0); assert.equal(game.players[0].stack, 10000);
});
test('concurrent cash-outs debit both the live and recoverable snapshot only once', async () => {
  const { game, payments, sends } = fixture();
  const results = await Promise.allSettled(['a','b'].map(hash => payments.requestWithdrawal({ userId: 'u0', tableId: 'station100', bolt11: `mock:10000:${hash}` })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(sends.length, 1); assert.equal(game.players[0], null);
  assert.equal(db.getHandSnapshot('station100').snapshot.players[0], null);
});
test('a player sitting out of the current hand can leave without waiting for another hand gap', async () => {
  const { game,payments }=fixture();
  game.handInProgress=true;game.players[0].participatedThisHand=false;game.players[0].sittingOut=true;
  const result=await payments.requestWithdrawal({userId:'u0',tableId:'station100',bolt11:'mock:10000:sitout'});
  assert.equal(result.status,'succeeded');assert.equal(game.players[0],null);
  assert.equal(db.getHandSnapshot('station100').snapshot.players[0],null);
});
test('idle paid stack is restorable before the first hand', () => {
  const { game } = fixture();
  const restored = PokerGame.deserializeState(db.getHandSnapshot('station100').snapshot);
  assert.equal(restored.realMoney, true); assert.equal(restored.handInProgress, false);
  assert.equal(restored.players[0].stack, game.players[0].stack);
});
test('restoration cannot convert free chips into payable sats or erase funded mode', () => {
  const { game }=fixture();
  assert.throws(()=>PokerGame.deserializeState(game.serializeState(),{expectedRealMoney:false}),/money mode differs/);
  const demo=game.serializeState();demo.realMoney=false;
  assert.throws(()=>PokerGame.deserializeState(demo,{expectedRealMoney:true}),/money mode differs/);
});
test('idle exit atomically moves the stack to independently withdrawable credit', async () => {
  const { game, payments } = fixture();
  game.startSitOutKickTimer('u0', 1);
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(game.players[0], null); assert.equal(db.getWalletCredit('u0','station100'), 10000);
  assert.equal(db.getHandSnapshot('station100').snapshot.players[0], null);
  assert.equal(payments.availableFunds('u0','station100').stack, 10000);
});
test('failed payout preserves money despite a broken notification callback, with exactly-once refund', async () => {
  const { payments, lnd, game } = fixture({ onRefund() { throw new Error('notification failed'); } });
  lnd.sendPayment = async () => ({ status: 'FAILED' });
  await payments.requestWithdrawal({ userId: 'u0', tableId: 'station100', bolt11: 'mock:10000:failed' });
  await payments.reconcilePending(); await payments.reconcilePending();
  assert.equal(game.players[0], null); assert.equal(db.getWalletCredit('u0','station100'), 10000);
  lnd.sendPayment = async () => ({ status: 'SUCCEEDED' });
  assert.equal((await payments.requestWithdrawal({ userId: 'u0', tableId: 'station100', bolt11: 'mock:10000:retry' })).status, 'succeeded');
  assert.equal(db.getWalletCredit('u0','station100'), 0);
});
test('additional settled payment for an occupied seat is held, then credited exactly once', () => {
  const { game, handlers, payments } = fixture();
  const row = deposit('additional'); handlers.seatFromDeposit(row);
  assert.equal(db.getLedgerById(row.id).status, 'settled_unseated'); assert.equal(game.players[0].stack, 10000);
  db.db.prepare('UPDATE ledger_entries SET settled_at=1 WHERE id=?').run(row.id);
  payments.releaseUnseatedDeposits(); payments.releaseUnseatedDeposits();
  assert.equal(db.getWalletCredit('u0','station100'), 5000);
  assert.equal(payments.availableFunds('u0','station100').stack, 15000);
});
test('settlement survives a seating callback failure as an unconsumed liability', async () => {
  const { payments } = fixture({ stack: null, onSeatPlayer() { throw new Error('seating failed'); } });
  const invoice = await payments.createDepositInvoice({ userId:'u0', tableId:'station100', amountSats:5000 });
  payments.creditDeposit(invoice.paymentHash,5000);
  assert.equal(db.getLedgerByHash(invoice.paymentHash,'deposit').status,'settled_unseated');
  assert.equal(payments.availableFunds('u0','station100').stack,5000);
});
test('duplicate and concurrent buy-in requests reuse one invoice', async () => {
  const { payments, invoiceCount } = fixture({ stack: null });
  const args = { userId:'u0', tableId:'station100', amountSats:5000 };
  const [a,b] = await Promise.all([payments.createDepositInvoice(args),payments.createDepositInvoice(args)]);
  const c = await payments.createDepositInvoice(args);
  assert.equal(a.paymentHash,b.paymentHash); assert.equal(a.paymentHash,c.paymentHash); assert.equal(invoiceCount(),1);
});
test('deposit exposure cap includes invoice creation currently awaiting LND', async () => {
  const { payments, lnd, config } = fixture({ stack: null }); config.LIGHTNING.hotWalletCapSats=5000;
  let finish;
  lnd.createInvoice = () => new Promise(resolve => { finish=resolve; });
  const first=payments.createDepositInvoice({userId:'u0',tableId:'station100',amountSats:5000});
  await assert.rejects(payments.createDepositInvoice({userId:'u1',tableId:'station100',amountSats:5000}),/exposure/);
  finish({bolt11:'mock',paymentHash:'cap'}); await first;
});
test('a full positive remaining stack below the old minimum can cash out', async () => {
  const { payments }=fixture({stack:500});
  assert.equal((await payments.requestWithdrawal({userId:'u0',tableId:'station100',bolt11:'mock:500:dust'})).status,'succeeded');
});
test('missed deposit settlement is recovered from LND lookup after restart', async () => {
  const { payments,lnd }=fixture({stack:null});
  db.createDepositRow({userId:'u0',tableId:'station100',amountSats:5000,paymentHash:'offline',bolt11:'mock'});
  lnd.lookupInvoice=async()=>({confirmed:true,amountSats:5000});
  await payments.reconcilePending(); await payments.reconcilePending();
  assert.equal(db.getHandSnapshot('station100').snapshot.players[0].stack,5000);
  assert.equal(db.getLedgerByHash('offline','deposit').status,'settled');
});
test('snapshot failure rolls back the payout reservation and sends no payment', async () => {
  const { game,payments,sends }=fixture();
  game.saveSnapshot=()=>{throw new Error('simulated disk failure');};
  await assert.rejects(payments.requestWithdrawal({userId:'u0',tableId:'station100',bolt11:'mock:10000:disk'}),/disk failure/);
  assert.equal(sends.length,0); assert.equal(db.getLedgerByHash('disk','withdrawal'),undefined);
  assert.equal(game.players[0].stack,10000); assert.equal(game.persistenceFailed,true);
  assert.equal(db.getHandSnapshot('station100').snapshot.players[0].stack,10000);
});
test('amount mismatch retains the actual received funds without seating', async () => {
  const { payments,game }=fixture({stack:null});
  db.createDepositRow({userId:'u0',tableId:'station100',amountSats:5000,paymentHash:'mismatch',bolt11:'mock'});
  payments.creditDeposit('mismatch',6000);
  assert.equal(game.players[0],null); assert.equal(payments.availableFunds('u0','station100').stack,6000);
});
test('public player response excludes session and balance metadata', () => {
  const api=require('./routes/api');
  const pubkey='a'.repeat(64); db.upsertNostrPlayer(pubkey,'npub-test','Test',null);
  db.setSessionToken(pubkey,'synthetic',Math.floor(Date.now()/1000)+300);
  let result;
  api.stack.find(layer=>layer.route?.path==='/player/:userId').route.stack[0].handle({params:{userId:pubkey}}, {json(value){result=value;}});
  for(const key of ['session_token','session_expires','current_chips','ban_reason']) assert.equal(key in result.player,false);
});
test('profile events require valid signatures and the requested author', () => {
  const key=generateSecretKey(), pubkey=getPublicKey(key);
  const event=finalizeEvent({kind:0,created_at:Math.floor(Date.now()/1000),tags:[],content:JSON.stringify({name:'Test',lud16:'me@example.com'})},key);
  assert.equal(nostr.isValidProfileEvent(event,pubkey),true);
  assert.equal(nostr.isValidProfileEvent(event,'b'.repeat(64)),false);
  const tampered=JSON.parse(JSON.stringify(event)); tampered.content='{}';
  assert.equal(nostr.isValidProfileEvent(tampered,pubkey),false);
});

test('200 six-player hands conserve all sats and retain the final between-hands snapshot', () => {
  const { game } = fixture();
  game.startActionTimer = () => {};
  for (let i=1;i<6;i++) game.addPlayer(`u${i}`,`Synthetic ${i}`,{initialStack:10000});
  const total = () => game.players.reduce((sum,p)=>sum+(p?p.stack+p.currentBet:0),game.pot);
  for(let hand=0;hand<200;hand++) {
    clearTimeout(game.handStartTimeout);game.handStartTimeout=null;
    game.startNewHand();
    assert.equal(game.handInProgress,true);
    let steps=0;
    while(game.handInProgress && steps++<100) {
      if(game.phase==='showdown') {
        game.clearRunoutTimeouts();
        while(game.communityCards.length<5) game.communityCards.push(game.deck.pop());
        game.endHand();
      } else {
        const player=game.players[game.currentPlayerIndex];
        assert.ok(player);
        const action=player.currentBet<game.getMaxBet()?'call':'check';
        assert.equal(game.processAction(player.userId,action).valid,true);
      }
      assert.equal(total()+db.sumWalletCredits(),60000,`chip conservation in hand ${hand+1}`);
    }
    assert.equal(game.handInProgress,false);
    assert.equal(db.getHandSnapshot('station100').snapshot.handInProgress,false);
  }
  assert.equal(game.handCount,200);
});
