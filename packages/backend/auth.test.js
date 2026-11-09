'use strict';
process.env.SATOSHISTACKS_DB_PATH=':memory:';
process.env.ADMIN_TOKEN='test-only-auth-admin';
process.env.REALMONEY_ENABLED='false';
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const {generateSecretKey,finalizeEvent}=require('nostr-tools/pure');
const db=require('./database');
const config=require('./config');
const auth=require('./routes/auth');
config.AUTH_RATE_LIMIT.maxRequests=100;
let server,origin;
before(async()=>{
  const app=express();app.use(express.json());app.use('/auth',auth);
  server=await new Promise((resolve,reject)=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));s.on('error',reject);});
  origin=`http://127.0.0.1:${server.address().port}`;
});
after(()=>server ? new Promise(resolve=>server.close(resolve)) : undefined);
async function request(path,body,token) {
  const response=await fetch(origin+'/auth/'+path,{method:body===undefined?'GET':'POST',headers:{origin,'content-type':'application/json',...(token?{'x-session-token':token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {status:response.status,body:await response.json(),cache:response.headers.get('cache-control')};
}
function signed(challenge,site=origin,extra={}) {
  return finalizeEvent({kind:22242,created_at:Math.floor(Date.now()/1000),content:'',tags:[['challenge',challenge.nonce],['relay',site]],...extra},generateSecretKey());
}
test('valid signed login restores a session, blocks replay, and revokes on logout',async()=>{
  const challenge=(await request('challenge',{})).body;
  const body={challengeId:challenge.challengeId,signedEvent:signed(challenge)};
  const result=await request('verify',body);
  assert.equal(result.status,200);assert.equal(result.cache,'no-store');
  assert.equal(result.body.profile.availableSats,0);
  db.creditAccount(result.body.pubkeyHex,db.ACCOUNT,'deposit',1234);
  assert.equal((await request('session',undefined,result.body.sessionToken)).body.profile.availableSats,1234);
  assert.equal((await request('verify',body)).status,401);
  assert.equal((await request('session',undefined,result.body.sessionToken)).status,200);
  await request('logout',{},result.body.sessionToken);
  assert.equal((await request('session',undefined,result.body.sessionToken)).status,401);
});
test('a valid signature for another website cannot authenticate this site',async()=>{
  const challenge=(await request('challenge',{})).body;
  const result=await request('verify',{challengeId:challenge.challengeId,signedEvent:signed(challenge,'https://another.example')});
  assert.equal(result.status,401);assert.match(result.body.error,/different site/);
});
test('a signed event with a stale timestamp cannot create a session',async()=>{
  const challenge=(await request('challenge',{})).body;
  assert.equal((await request('verify',{challengeId:challenge.challengeId,signedEvent:signed(challenge,origin,{created_at:1})})).status,401);
});
test('expired challenges do not authenticate even with a correct signature',async()=>{
  const challenge=(await request('challenge',{})).body;
  db.db.prepare('UPDATE nostr_challenges SET expires_at=0 WHERE challenge_id=?').run(challenge.challengeId);
  assert.equal((await request('verify',{challengeId:challenge.challengeId,signedEvent:signed(challenge)})).status,401);
});
