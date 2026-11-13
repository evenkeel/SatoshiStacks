'use strict';
process.env.SATOSHISTACKS_DB_PATH=':memory:';
process.env.ADMIN_TOKEN='account-flow-test-only';
process.env.REALMONEY_ENABLED='false';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {Server}=require('socket.io');
const {io:connect}=require('socket.io-client');
const db=require('./database');
const config=require('./config');
const {setup}=require('./socket-handlers');
const {createPayments}=require('./services/payments');
const nostr=require('./services/nostr');
function next(socket,event) {
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{socket.off(event,receive); reject(new Error(`Timed out waiting for ${event}`));},3000);
    function receive(value) {clearTimeout(timer);resolve(value);}
    socket.once(event,receive);
  });
}
async function request(socket,event,payload,response) {
  const pending=next(socket,response); socket.emit(event,payload); return pending;
}
test('authenticated account flow separates deposits, table stacks and withdrawals across reconnects', async () => {
  const original=config.isRealMoney; config.isRealMoney=()=>true;
  nostr.scheduleLiveActivityUpdate=()=>{};
  const server=http.createServer(); const io=new Server(server);
  const games=new Map(), users=new Map(), sockets=new Map(), observers=new Map();
  const clients=[]; let payments, walletAvailable=true;
  const handlers=setup(io,games,users,sockets,observers,()=>{},new Map(),()=>walletAvailable ? payments : null,()=>payments);
  let invoiceCount=0;
  const lnd={
    async createInvoice({amountSats,secret}) {invoiceCount++;const paymentHash=require('node:crypto').createHash('sha256').update(Buffer.from(secret,'hex')).digest('hex');return {bolt11:`mock:${amountSats}:${paymentHash}`,paymentHash};},
    async getSpendableSats(){return 1000000;},
    async decodeInvoice(invoice) {const [,amount,paymentHash]=invoice.split(':');return {amountSats:Number(amount),paymentHash,destination:'peer'};},
    async sendPayment() {return {status:'SUCCEEDED'};},
  };
  payments=createPayments({db,lnd,config,getGame:id=>games.get(id),onSeatPlayer:handlers.seatFromDeposit});
  const user='a'.repeat(64), other='b'.repeat(64);
  for (const [id,token] of [[user,'alice-session'],[other,'bob-session']]) {
    db.upsertNostrPlayer(id,'npub-test','Player',null);
    db.setSessionToken(id,token,Math.floor(Date.now()/1000)+3600);
  }
  try {
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const origin=`http://127.0.0.1:${server.address().port}`;
    async function client(options = {}) {const s=connect(origin,{transports:['websocket'],forceNew:true,...options});clients.push(s);await next(s,'connect');return s;}
    let alice=await client({extraHeaders:{'User-Agent':'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'}}); const bob=await client();
    const args={tableId:'station100',sessionToken:'alice-session'};
    for (const tableId of ['__proto__','constructor','pond','table-1']) {
      const error=await request(bob,'observe-table',{tableId},'error');
      assert.match(error.message,/Invalid table/);
      assert.equal(games.has(tableId),false);
    }
    await request(alice,'observe-table',args,'observer-joined');
    const unauthorized=await request(bob,'account-deposit-request',{tableId:'station100',npub:user,amountSats:10000},'auth-error');
    assert.match(unauthorized.message,/Sign in/);
    const invoice=await request(alice,'account-deposit-request',{...args,amountSats:20000},'buyin-invoice');
    payments.creditDeposit(invoice.paymentHash,20000);
    const state=await request(alice,'wallet-state-request',args,'wallet-state');
    assert.equal(state.availableSats,20000);assert.equal(state.seated,false);
    await request(alice,'buyin-request',{...args,amountSats:10000},'account-buyin-confirmed');
    assert.equal(db.getAccountBalance(user),10000);assert.equal(games.get('station100').players[0].stack,10000);
    // Explicit watch-only connections cannot reclaim a seat or spend a balance.
    for (const options of [
      {auth:{watchOnly:true}},
    ]) {
      const phone=await client(options);
      await request(phone,'observe-table',{...args,resumeSeat:true},'observer-joined');
      await request(phone,'observer-authenticate',{sessionToken:args.sessionToken},'observer-authenticated');
      assert.equal(sockets.has(phone.id),false);
      assert.equal(users.get(user),alice.id);
      assert.equal(observers.get(phone.id).userId,user);
      for (const event of ['join-table','join-waitlist','waitlist-accept','buyin-request','action','sit-back-in','sit-out','rebuy']) {
        const error=await request(phone,event,{...args,buyIn:5000,amountSats:5000,action:'fold'},'error');
        assert.match(error.message,/watch-only/);
      }
      assert.equal(db.getAccountBalance(user),10000);
      assert.equal(games.get('station100').players[0].stack,10000);
      assert.equal(users.get(user),alice.id);
      phone.disconnect();
    }
    // Phone headers allow authenticated seat restoration without another debit.
    for (const extraHeaders of [
      {'User-Agent':'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'},
      {'User-Agent':'Mozilla/5.0 (Linux; Android 15)', 'Sec-CH-UA-Mobile':'?1'},
    ]) {
      const phone=await client({extraHeaders});
      await request(phone,'observe-table',{...args,resumeSeat:true},'seat-assigned');
      assert.equal(sockets.get(phone.id).userId,user);
      assert.equal(users.get(user),phone.id);
      assert.equal(db.getAccountBalance(user),10000);
      assert.equal(games.get('station100').players[0].stack,10000);
      phone.disconnect();
    }
    // A second tab repeats a buy-in after a lost response: no second debit.
    await request(bob,'buyin-request',{...args,amountSats:10000},'account-buyin-confirmed');
    assert.equal(db.getAccountBalance(user),10000);
    await request(bob,'observe-table',{tableId:'station100'},'auth-error');
    await request(bob,'wallet-state-request',{tableId:'station100',sessionToken:'bob-session'},'auth-error');
    assert.equal(sockets.get(bob.id).userId,user);
    const activeGame=games.get('station100');
    activeGame.handInProgress=true; activeGame.phase='preflop'; activeGame.players[0].participatedThisHand=true;
    for (let attempt=0;attempt<2;attempt++) {
      const error=await request(bob,'table-cashout-request',args,'error');
      assert.match(error.message,/active hand/);
      assert.equal(activeGame.players[0].sittingOutNextHand,true);
    }
    activeGame.handInProgress=false; activeGame.phase='idle'; activeGame.players[0].participatedThisHand=false;
    const payment=await request(bob,'cashout-request',{...args,bolt11:'mock:3000:partial'},'cashout-result');
    assert.equal(payment.status,'succeeded'); assert.equal(games.get('station100').players[0].stack,10000);
    assert.equal(db.getAccountBalance(user),7000);
    walletAvailable=false;
    await request(bob,'table-cashout-request',args,'account-table-cashout');
    assert.equal(db.getAccountBalance(user),17000);assert.equal(games.get('station100').players[0],null);
    walletAvailable=true;
    alice.disconnect();alice=await client();
    const recovered=await request(alice,'wallet-state-request',args,'wallet-state');
    assert.equal(recovered.availableSats,17000);assert.ok(recovered.transfers.some(t=>t.kind==='table_cashout'));
    const isolated=await request(bob,'wallet-state-request',{tableId:'station100',sessionToken:'bob-session'},'wallet-state');
    assert.equal(isolated.availableSats,0);assert.equal(isolated.payments.length,0);assert.equal(isolated.transfers.length,0);
    await request(alice,'buyin-request',{...args,amountSats:5000},'account-buyin-confirmed');
    const game=games.get('station100');
    game.startSitOutKickTimer(user,1);
    await new Promise(resolve=>setTimeout(resolve,20));
    assert.equal(sockets.has(alice.id),false);
    assert.equal(users.has(user),false);
    assert.equal(observers.get(alice.id).userId,user);
    assert.equal(db.getAccountBalance(user),17000);
    db.revokeSession('alice-session');
    await request(alice,'chat-message',{text:'stale authenticated chat'},'auth-error');
    await request(alice,'table-cashout-request',args,'auth-error');
  } finally {
    for (const client of clients) client.disconnect();
    for (const game of games.values()) {clearTimeout(game.handStartTimeout);game.clearActionTimer();for (const timer of game.sitOutKickTimers.values()) clearTimeout(timer);}
    await new Promise(resolve=>io.close(resolve));
    config.isRealMoney=original;
  }
});
