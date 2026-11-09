'use strict';
process.env.SATOSHISTACKS_DB_PATH = ':memory:';
process.env.ADMIN_TOKEN = 'history-test-admin';
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const db=require('./database');
const PokerGame=require('./poker-game');
const {playerHistory}=require('./hand-history');
const alice='a'.repeat(64),bob='b'.repeat(64);
let server,origin,game,handId,liveHistory;
before(async()=>{
  for (const [id,name] of [[alice,'Alice'],[bob,'Bob']]) db.upsertNostrPlayer(id,'npub-'+name,name,null,null);
  db.setSessionToken(alice,'alice-token',Math.floor(Date.now()/1000)+3600);
  db.setSessionToken(bob,'bob-token',Math.floor(Date.now()/1000)+3600);
  const app=express();
  app.use('/api',require('./routes/api'));
  app.use('/api/admin',require('./routes/admin'));
  server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  origin=`http://127.0.0.1:${server.address().port}`;
  game=new PokerGame('history-test');
  game.startActionTimer=()=>{};
  game.addPlayer(alice,'Alice',{initialStack:1000});
  game.addPlayer(bob,'Bob',{initialStack:1000});
  clearTimeout(game.handStartTimeout);game.handStartTimeout=null;
  game.startNewHand();
  handId=game.getHandId();
  game.players[0].holeCards=['Ah','Ad'];game.players[1].holeCards=['Kh','Kd'];
  game.onHandComplete=(userId,text,id)=>{assert.equal(id,handId);if(userId===alice)liveHistory=text;};
  game.setDisconnected(alice,true);
  game.setDisconnected(alice,false);
  assert.equal(game.processAction(bob,'fold').valid,true);
});
after(async()=>{
  clearTimeout(game?.handStartTimeout);
  game?.clearActionTimer();game?.clearRunoutTimeouts();
  for(const timer of game?.sitOutKickTimers.values()||[])clearTimeout(timer);
  if(server)await new Promise(resolve=>server.close(resolve));
});
async function get(path,headers={}){const response=await fetch(origin+path,{headers});return {status:response.status,cache:response.headers.get('cache-control'),body:await response.json()};}

test('one permanent ID appears in live state, history, database and recovery',()=>{
  assert.match(handId,/^SS-[0-9a-f-]{36}$/);
  assert.equal(game.getGameState(alice).handId,handId);
  assert.ok(liveHistory.includes(handId));
  assert.equal(db.getHand(handId).hand_id,handId);
  assert.equal(PokerGame.deserializeState(game.serializeState()).getHandId(),handId);
});
test('completed hand persists ordered timestamps, connection events and precise chip movements',()=>{
  const events=JSON.parse(db.getHand(handId).events);
  assert.ok(events.length>10);
  assert.deepEqual(events.map(e=>e.sequence),events.map((_,i)=>i+1));
  assert.ok(events.every(e=>!Number.isNaN(Date.parse(e.timestamp))));
  assert.equal(events.filter(e=>e.type==='connection').length,2);
  assert.ok(events.some(e=>e.type==='action'&&e.action==='fold'&&e.amount===0&&typeof e.stackAfter==='number'));
  assert.ok(events.some(e=>e.type==='payout'));
  assert.ok(events.some(e=>e.type==='settlement'));
});
test('public history lookup never returns the private event stream',async()=>{
  const result=await get('/api/hand/'+handId);
  assert.equal(result.status,200);
  assert.equal('events' in result.body.hand,false);
  assert.equal(JSON.stringify(result.body).includes('Kh'),false);
  const list=await get('/api/hands/'+alice);
  assert.ok(list.body.hands.every(hand=>!('events' in hand)));
});
test('saved personal histories require a valid session and include only the caller private cards',async()=>{
  assert.equal((await get('/api/my/hands')).status,401);
  const result=await get('/api/my/hands',{'x-session-token':'alice-token'});
  assert.equal(result.status,200);assert.equal(result.cache,'no-store');
  const hand=result.body.hands.find(h=>h.handId===handId);
  assert.equal(hand.history,liveHistory);
  assert.match(hand.history,/Dealt to Alice \[Ah Ad\]/);
  assert.doesNotMatch(hand.history,/Kh|Kd/);
  const bobResult=await get('/api/my/hands',{'x-session-token':'bob-token'});
  assert.match(bobResult.body.hands[0].history,/Dealt to Bob \[Kh Kd\]/);
  assert.doesNotMatch(bobResult.body.hands[0].history,/Ah|Ad/);
});
test('support lookup requires admin authorization and includes private records',async()=>{
  assert.equal((await get('/api/admin/hand/'+handId)).status,401);
  const result=await get('/api/admin/hand/'+handId,{'x-admin-token':'history-test-admin'});
  assert.equal(result.status,200);assert.equal(result.cache,'no-store');
  assert.equal(result.body.hand.players.length,2);
  assert.ok(result.body.hand.events.some(e=>e.type==='deal'));
});
test('legacy histories receive their database ID without exposing an opponent private cards',()=>{
  const text=playerHistory('Hand #1\n*** HOLE CARDS ***\nBob: folds',{username:'Alice',hole_cards:'["Ah","Ad"]'},'old-table-123-1');
  assert.match(text,/Hand ID: old-table-123-1/);
  assert.match(text,/Dealt to Alice \[Ah Ad\]/);
});

test('live history preserves private cards only for their owner',()=>{
 const g=new PokerGame('private-live');g.saveSnapshot=()=>{};g.startActionTimer=()=>{};
 g.addPlayer(alice,'Alice',{initialStack:1000});g.addPlayer(bob,'Bob',{initialStack:1000});
 clearTimeout(g.handStartTimeout);g.handStartTimeout=null;g.startNewHand();
 g.players[0].holeCards=['Ah','Ad'];g.players[1].holeCards=['Kh','Kd'];
 assert.match(g.getGameState(alice).currentHandHistory,/Dealt to Alice \[Ah Ad\]/);
 assert.doesNotMatch(g.getGameState(alice).currentHandHistory,/Kh|Kd/);
 assert.doesNotMatch(g.getGameState().currentHandHistory,/Dealt to|Ah|Ad|Kh|Kd/);
 g.clearActionTimer();g.clearRunoutTimeouts();
});
