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
const playThrough = process.env.SMOKE_PLAY_THROUGH === 'true';
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
  let dealt=false,opponentsHidden=false,completed=false,completedHandId=null;
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
          const toCall = (state.currentBetToCall ?? Math.max(...state.players.filter(Boolean).map(p=>p.currentBet))) - me.currentBet;
          const action = playThrough ? (toCall > 0 ? 'call' : 'check') : 'fold';
          socket.emit('action',{tableId:'station100',action,actionId:randomUUID(),handCount:state.handCount});
        }
      });
      socket.on('hand-complete',({history,handId})=>{
        assert.ok(handId && history.includes(handId), 'Copyable history contains the permanent hand ID');
        completedHandId=handId;
        if (playThrough) {
          for (const phase of ['FLOP','TURN','RIVER','SHOW DOWN']) assert.ok(history.includes(`*** ${phase} ***`), `Full hand includes ${phase}`);
        }
        completed=true;clearTimeout(timeout);resolve();
      });
    }
  });
  await done;
  assert.ok(dealt && opponentsHidden && completed);
  const saved=await (await fetch(origin+'/api/my/hands',{headers:{'x-session-token':players[0].sessionToken}})).json();
  assert.ok(saved.hands.some(hand=>hand.handId===completedHandId && hand.history.includes('Dealt to')), 'Personal history reloads from the database');
  const publicHand=await (await fetch(origin+'/api/hand/'+encodeURIComponent(completedHandId))).json();
  assert.equal('events' in publicHand.hand,false,'Private audit events never enter the public API');
  // An authenticated observer must reclaim an existing seat without another
  // buy-in; a revoked session must no longer authorize gameplay on that socket.
  const resumed=io(origin,{transports:['websocket'],forceNew:true});clients.push(resumed);
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Seat restoration timed out')),5000);
    resumed.on('connect',()=>resumed.emit('observe-table',{tableId:'station100',sessionToken:players[0].sessionToken}));
    resumed.on('seat-assigned',()=>{clearTimeout(timer);resolve();});
    resumed.on('connect_error',reject);
  });
  const logout=await fetch(origin+'/api/auth/logout',{method:'POST',headers:{origin,'x-session-token':players[0].sessionToken}});
  assert.equal(logout.status,200);
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Revoked socket session was not rejected')),5000);
    resumed.on('auth-error',()=>{clearTimeout(timer);resolve();});
    resumed.emit('sit-out',{tableId:'station100'});
  });
  console.log('SMOKE_OK: demo mode, malformed packet rejection, signed login, replay rejection, public profile privacy, two sockets, private hole cards, completed hand, authenticated seat restoration, revoked-session rejection');
}
run().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
  await Promise.all(clients.map(async socket=>{
    try { if(socket.connected) await socket.timeout(2000).emitWithAck('leave-table',{tableId:'station100'}); }
    catch(_) { /* The isolated demo server may already be stopping. */ }
    finally { socket.disconnect(); }
  }));
});
