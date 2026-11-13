/* Persistent loopback-only play-chip players for visual and interaction testing. */
'use strict';
const {randomUUID} = require('node:crypto');
const {io} = require('socket.io-client');
const {generateSecretKey,finalizeEvent} = require('nostr-tools/pure');
const {chooseAction} = require('./demo-bot-strategy.cjs');
const origin = process.env.DEMO_ORIGIN || 'http://127.0.0.1:39006';
const url = new URL(origin);
if (url.protocol !== 'http:' || !['localhost','127.0.0.1','[::1]'].includes(url.hostname)) throw Error('Demo bots require a loopback HTTP server');
const tableId = 'station100';
const clients = [], timers = new Set(), streets = new Map(), hands = new Set();
const totals = {raise:0,call:0,check:0,fold:0};
let stopping = false;
// All six players share one loopback IP. Respect its aggregate action limit,
// including the initial join requests, without changing server protections.
let nextActionAt = Date.now() + 10000;

async function post(path,body) {
  const response = await fetch(origin+path,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(body)});
  const data = await response.json();
  if (!response.ok) throw Error(data.error || `HTTP ${response.status}`);
  return data;
}
async function stop() {
  if (stopping) return;
  stopping = true;
  for (const timer of timers) clearTimeout(timer);
  await Promise.all(clients.map(socket => new Promise(resolve => {
    const timeout = setTimeout(resolve,1500);
    if (!socket.connected) { clearTimeout(timeout); resolve(); return; }
    socket.emit('leave-table',()=>{clearTimeout(timeout);resolve();});
  })));
  clients.forEach(socket=>socket.disconnect());
}
process.once('SIGINT',()=>stop().then(()=>process.exit(0)));
process.once('SIGTERM',()=>stop().then(()=>process.exit(0)));

async function main() {
  const config = await (await fetch(origin+'/api/tables')).json();
  const table = config.tables.find(t=>t.id===tableId);
  if (!table || table.realMoney !== false) throw Error('Demo bots require an explicitly play-money table');
  for (const [index,name] of ['Mira','Theo','June','River','Neon','Ghost'].entries()) {
    const key = generateSecretKey();
    const challenge = await post('/api/auth/challenge',{});
    const signedEvent = finalizeEvent({kind:22242,created_at:Math.floor(Date.now()/1000),
      tags:[['challenge',challenge.nonce],['relay',origin]],content:JSON.stringify({name})},key);
    const user = await post('/api/auth/verify',{challengeId:challenge.challengeId,signedEvent});
    key.fill(0);
    const socket = io(origin,{transports:['websocket'],forceNew:true});
    clients.push(socket);
    let latest, pending, fingerprint, lastSent, rebuyPending = false;
    const identify = state => JSON.stringify([state.handId || state.handCount,state.phase,state.currentPlayerIndex,state.pot,
      state.players.map(p=>p ? [p.userId,p.stack,p.currentBet,p.folded] : null)]);
    socket.on('connect',()=>socket.emit('join-table',{tableId,sessionToken:user.sessionToken,buyIn:10000,preferredSeat:index}));
    socket.on('connect_error',error=>console.error(`${name}: ${error.message}`));
    socket.on('error',error=>{
      console.error(`${name}: ${error.message}`);
      if (pending) { clearTimeout(pending); timers.delete(pending); pending = null; }
      // Retry only a current legal call/check after an unexpected rejected action.
      lastSent = null;
      if (/Too many actions/i.test(error.message)) nextActionAt = Date.now() + 3500;
      if (latest?.yourTurn && latest.handInProgress && !stopping) schedule(latest,true);
    });
    socket.on('hand-complete',({handId})=>{
      if (hands.has(handId)) return;
      hands.add(handId);
      streets.clear();
      console.log(`HAND ${hands.size} complete · ${JSON.stringify(totals)}`);
    });
    function schedule(state, fallback = false) {
      const me = state.players.find(p=>p?.userId===user.pubkeyHex);
      if (!me || !state.yourTurn || !state.handInProgress || me.folded || me.allIn || stopping) return;
      const id = identify(state);
      if (lastSent === id || (pending && fingerprint === id)) return;
      if (pending) { clearTimeout(pending); timers.delete(pending); }
      fingerprint = id;
      pending = setTimeout(()=>{
        timers.delete(pending); pending = null;
        if (!latest || identify(latest)!==id || !latest.yourTurn || stopping) return;
        const street = streets.get(`${state.handId || state.handCount}:${state.phase}`);
        const decision = fallback ? {action:state.currentBetToCall>me.currentBet?'call':'check'} :
          chooseAction(state,me,{aggression:.25+index*.12,raises:street?.raises || 0});
        lastSent = id;
        nextActionAt = Date.now() + 1250;
        totals[decision.action]++;
        console.log(`${name} · ${state.phase} · ${decision.action}${decision.amount ? ` to ${decision.amount}` : ''}`);
        socket.emit('action',{tableId,...decision,actionId:randomUUID(),handCount:state.handCount});
      },Math.max(1250+Math.floor(Math.random()*900),nextActionAt-Date.now()));
      timers.add(pending);
    }
    socket.on('game-state',state=>{
      if (state.realMoney !== false) { console.error('Stopping: table is no longer play-money'); stop(); return; }
      latest = state;
      const key = `${state.handId || state.handCount}:${state.phase}`;
      const previous = streets.get(key) || {max:state.phase==='preflop'?state.bigBlind:0,raises:0};
      if (state.currentBetToCall > previous.max) {
        previous.max = state.currentBetToCall;
        previous.raises++;
      }
      streets.set(key,previous);
      const me = state.players.find(p=>p?.userId===user.pubkeyHex);
      if (!me) return;
      if (!state.handInProgress && me.stack===0 && !rebuyPending) {
        rebuyPending = true;
        socket.emit('rebuy',{tableId,buyIn:10000});
      }
      if (me.stack>0) rebuyPending = false;
      if (me.sittingOut && me.stack>0) socket.emit('sit-back-in',{tableId});
      schedule(state);
    });
  }
  console.log('DEMO_BOTS_READY · six players · varied betting on every street · Ctrl-C to stop');
}
main().catch(async error=>{console.error(error.message);await stop();process.exitCode=1;});
