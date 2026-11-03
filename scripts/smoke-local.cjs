'use strict';
// Run only against an isolated, running DEMO server. Never uses real wallets.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { finalizeEvent, generateSecretKey, getPublicKey } = require('nostr-tools/pure');
const { io } = require('socket.io-client');
const origin = process.env.SMOKE_ORIGIN || 'http://localhost:39002';
const url = new URL(origin);
assert.ok(['localhost','127.0.0.1','[::1]'].includes(url.hostname), 'Smoke test only permits loopback');
const clients=[];
async function post(route,body) {
  const response=await fetch(origin+route,{method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify(body)});
  return {status:response.status,data:await response.json()};
}
async function run() {
  assert.equal((await fetch(origin+'/health')).status,200);
  const tables=await (await fetch(origin+'/api/tables')).json();
  assert.equal(tables.tables.find(t=>t.id==='station100').realMoney,false,'Refuse to exercise a real-money server');
  const probe=io(origin,{transports:['websocket'],forceNew:true});
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Malformed packet check timed out')),5000);
    probe.on('connect',()=>probe.emit('observe-table',null));
    probe.on('error',error=>{clearTimeout(timer);assert.match(error.message,/Invalid request payload/);resolve();});
    probe.on('connect_error',reject);
  }).finally(()=>probe.disconnect());
  assert.equal((await fetch(origin+'/health')).status,200,'Malformed socket packet must not crash server');
  const players=[];
  for(let i=0;i<2;i++) {
    const key=generateSecretKey(),pubkey=getPublicKey(key);
    const challenge=(await post('/api/auth/challenge',{})).data;
    const signedEvent=finalizeEvent({kind:22242,created_at:Math.floor(Date.now()/1000),tags:[['challenge',challenge.nonce],['relay',origin]],content:''},key);
    const auth=await post('/api/auth/verify',{challengeId:challenge.challengeId,signedEvent});
    assert.equal(auth.status,200); assert.equal(auth.data.pubkeyHex,pubkey);
    if(i===0) assert.equal((await post('/api/auth/verify',{challengeId:challenge.challengeId,signedEvent})).status,401,'Challenge cannot be replayed');
    const profile=await (await fetch(origin+'/api/player/'+pubkey)).json();
    assert.equal('session_token' in profile.player,false);
    players.push({pubkey,sessionToken:auth.data.sessionToken});
  }
  let dealt=false,opponentsHidden=false,completed=false;
  const done = new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error('Demo hand did not finish within 25 seconds')),25000);
    for(const player of players) {
      const socket=io(origin,{transports:['websocket'],forceNew:true}); clients.push(socket);
      const acted=new Set();
      socket.on('connect',()=>socket.emit('join-table',{tableId:'station100',sessionToken:player.sessionToken,buyIn:5000}));
      socket.on('connect_error',reject);
      socket.on('error',error=>{ clearTimeout(timeout);reject(new Error(error.message)); });
      socket.on('game-state',state=>{
        const me=state.players.find(p=>p?.userId===player.pubkey);
        if(state.handInProgress && me?.holeCards.length===2 && me.holeCards[0]!=='??') dealt=true;
        const opponent=state.players.find(p=>p && p.userId!==player.pubkey);
        if(state.handInProgress && state.phase!=='showdown' && opponent?.holeCards.length===2) {
          assert.deepEqual(opponent.holeCards,['??','??']);opponentsHidden=true;
        }
        if(!completed && state.yourTurn && state.handInProgress) {
          const fingerprint=JSON.stringify([state.phase,state.pot,state.players.map(p=>p?.currentBet),me.stack]);
          if(acted.has(fingerprint)) return;acted.add(fingerprint);
          // A fold completes a heads-up hand without rate-limit timing effects.
          socket.emit('action',{tableId:'station100',action:'fold',actionId:randomUUID()});
        }
      });
      socket.on('hand-complete',()=>{completed=true;clearTimeout(timeout);resolve();});
    }
  });
  await done;
  assert.ok(dealt && opponentsHidden && completed);
  console.log('SMOKE_OK: demo mode, malformed packet rejection, signed login, replay rejection, public profile privacy, two sockets, private hole cards, completed hand');
}
run().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
  await Promise.all(clients.map(async socket=>{
    try { if(socket.connected) await socket.timeout(2000).emitWithAck('leave-table',{tableId:'station100'}); }
    catch(_) { /* The isolated demo server may already be stopping. */ }
    finally { socket.disconnect(); }
  }));
});
