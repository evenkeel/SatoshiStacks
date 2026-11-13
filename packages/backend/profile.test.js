'use strict';
process.env.SATOSHISTACKS_DB_PATH=':memory:';
process.env.ADMIN_TOKEN='test-profile-only';
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const {generateSecretKey,getPublicKey,finalizeEvent}=require('nostr-tools/pure');
const {npubEncode}=require('nostr-tools/nip19');
const db=require('./database');
const {createProfileRoutes,nip05Lookup}=require('./routes/profile');
const {createLightningAddressHandler}=require('./services/lightning-address');
let server,origin,published=[];
const receiver={get:async address=>{
  if(address === 'broken@wallet.example') throw new Error('Receiving wallet unavailable');
  return {tag:'payRequest',callback:'https://wallet.example/pay',minSendable:1000,maxSendable:100000000,metadata:JSON.stringify([['text/plain',address]])};
}};
before(async()=>{
  const app=express(); app.use(express.json());
  app.get('/.well-known/nostr.json',nip05Lookup);
  app.get('/.well-known/lnurlp/:name',createLightningAddressHandler({receiver}));
  app.use('/profile',createProfileRoutes({publish:async event=>{published.push(event);return 1;},canPurchase:()=>true,receiver}));
  app.use('/offline',createProfileRoutes({publish:async()=>0,canPurchase:()=>true,receiver}));
  app.use('/paused',createProfileRoutes({publish:async()=>1,canPurchase:()=>false,receiver}));
  server=await new Promise((resolve,reject)=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));s.on('error',reject);});
  origin=`http://127.0.0.1:${server.address().port}`;
});
after(()=>server ? new Promise(resolve=>server.close(resolve)) : undefined);
function player(){
  const key=generateSecretKey(),pubkey=getPublicKey(key),token=Buffer.from(generateSecretKey()).toString('hex');
  db.upsertNostrPlayer(pubkey,npubEncode(pubkey)); db.setSessionToken(pubkey,token,Math.floor(Date.now()/1000)+3600);
  db.creditAccount(pubkey,db.ACCOUNT,'deposit',30000);
  return {key,pubkey,token};
}
function sign(owner,profile,created_at=Math.floor(Date.now()/1000)){
  return finalizeEvent({kind:0,created_at,tags:[],content:JSON.stringify(profile)},owner.key);
}
async function request(path,token,body){
  if(body?.claimName && !Object.hasOwn(body,'purchase')) body={...body,purchase:{confirmed:true,amountSats:10000}};
  const response=await fetch(origin+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(token?{'x-session-token':token}:{})},...(body?{body:JSON.stringify(body)}:{})});
  return {status:response.status,data:await response.json(),headers:response.headers};
}
test('profile saves signed public metadata and atomically claims a NIP-05 name',async()=>{
  const owner=player(),profile={name:'Poker Alice',about:'Hello!',picture:'https://example.com/avatar.png',website:'https://example.com',nip05:'alice@satoshistacks.com',custom:'keep me'};
  const event=sign(owner,profile);
  const result=await request('/profile',owner.token,{signedEvent:event,previousEventId:null,claimName:'alice'});
  assert.equal(result.status,200);assert.equal(result.data.published,1);assert.equal(published.at(-1).id,event.id);
  assert.equal(result.data.availableSats,20000);
  assert.equal(result.data.chargedSats,10000);assert.match(result.data.message,/Purchased alice@satoshistacks.com for 10,000 sats/);
  assert.equal(db.db.prepare('SELECT amount_sats FROM identifier_purchases WHERE pubkey=?').get(owner.pubkey).amount_sats,10000);
  assert.equal(db.getPlayer(owner.pubkey).nostr_name,'Poker Alice');
  const loaded=await request('/profile',owner.token);
  assert.equal(loaded.data.profile.custom,'keep me');assert.equal(loaded.data.claimName,'alice');
  assert.equal(loaded.headers.get('cache-control'),'no-store');
  const lookup=await request('/.well-known/nostr.json?name=ALICE');
  assert.deepEqual(lookup.data.names,{alice:owner.pubkey});assert.equal(lookup.headers.get('access-control-allow-origin'),'*');
  const newer=sign(owner,{...profile,about:'Updated'},event.created_at+1);
  assert.equal((await request('/profile',owner.token,{signedEvent:newer,previousEventId:event.id,claimName:'alice'})).status,200);
  assert.equal(db.getAccountBalance(owner.pubkey),20000,'profile edits never charge again');
  assert.equal(db.saveNostrProfile(event),false,'late relay metadata must not overwrite an edit');
});
test('identifier conflicts roll back the whole profile and preserve ownership',async()=>{
  const other=player();
  const result=await request('/profile',other.token,{signedEvent:sign(other,{name:'Not Alice',nip05:'alice@satoshistacks.com'}),previousEventId:null,claimName:'alice'});
  assert.equal(result.status,409);assert.match(result.data.error,/taken/);assert.equal(db.getNostrProfile(other.pubkey),null);assert.equal(db.getNip05Claim(other.pubkey),null);
  assert.equal(db.getAccountBalance(other.pubkey),30000,'failed claims must not take payment');
});
test('simultaneous claims have exactly one owner and do not enumerate unrelated names',async()=>{
  const players=[player(),player()];
  const results=await Promise.all(players.map(owner=>request('/profile',owner.token,{signedEvent:sign(owner,{nip05:'concurrent@satoshistacks.com'}),previousEventId:null,claimName:'concurrent'})));
  assert.deepEqual(results.map(result=>result.status).sort(),[200,409]);
  const winner=players[results.findIndex(result=>result.status===200)];
  assert.deepEqual(players.map(owner=>db.getAccountBalance(owner.pubkey)).sort(),[20000,30000]);
  assert.deepEqual((await request('/.well-known/nostr.json?name=concurrent')).data.names,{concurrent:winner.pubkey});
  assert.deepEqual((await request('/.well-known/nostr.json?name=constructor')).data.names,{});
});
test('purchases require confirmation, exact price and settled funds; paused purchases fail closed',async()=>{
  const owner=player(),event=sign(owner,{nip05:'payfirst@satoshistacks.com'});
  const body={signedEvent:event,previousEventId:null,claimName:'payfirst'};
  for(const purchase of [null,{confirmed:false,amountSats:10000},{confirmed:true,amountSats:1}]) {
    assert.equal((await request('/profile',owner.token,{...body,purchase})).status,402);
  }
  assert.equal((await request('/paused',owner.token,body)).status,503);
  db.takeWalletCredit(owner.pubkey,db.ACCOUNT,30000);
  assert.equal((await request('/profile',owner.token,body)).status,402);
  assert.equal(db.getNip05Claim(owner.pubkey),null);
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM identifier_purchases WHERE pubkey=?').get(owner.pubkey).n,0);
  assert.equal((await request('/profile',owner.token,{signedEvent:sign(owner,{name:'Free profile'}),previousEventId:null})).status,200);
});
test('purchase retries are idempotent and emit one durable debit receipt',async()=>{
  const owner=player(),event=sign(owner,{nip05:'retryname@satoshistacks.com'});
  const body={signedEvent:event,previousEventId:null,claimName:'retryname'};
  assert.equal((await request('/profile',owner.token,body)).data.chargedSats,10000);
  assert.equal((await request('/profile',owner.token,body)).data.chargedSats,0);
  assert.equal(db.getAccountBalance(owner.pubkey),20000);
  assert.equal(db.getAccountHistory(owner.pubkey).filter(row=>row.kind==='identifier_purchase').length,1);
});
test('pre-existing identifiers remain owned without a retroactive purchase',async()=>{
  const owner=player();
  db.db.prepare('INSERT INTO nip05_claims(name,pubkey) VALUES(?,?)').run('legacyname',owner.pubkey);
  const event=sign(owner,{nip05:'legacyname@satoshistacks.com',name:'Legacy user'});
  const result=await request('/paused',owner.token,{signedEvent:event,previousEventId:null,claimName:'legacyname'});
  assert.equal(result.status,200);assert.equal(result.data.chargedSats,0);
  assert.equal(db.getAccountBalance(owner.pubkey),30000);
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM identifier_purchases WHERE pubkey=?').get(owner.pubkey).n,0);
});
test('signed Lightning forwarding receives directly through the upstream provider and can be disabled',async()=>{
  const owner=player(),profile={name:'Receiver',nip05:'receiver@satoshistacks.com',lud16:'receiver@satoshistacks.com',satoshistacks_lightning_address:'alice@wallet.example'};
  const event=sign(owner,profile);
  assert.equal((await request('/profile',owner.token,{signedEvent:event,previousEventId:null,claimName:'receiver'})).status,200);
  const result=await request('/.well-known/lnurlp/receiver');
  assert.equal(result.status,200);assert.equal(result.data.callback,'https://wallet.example/pay');
  assert.equal(result.data.metadata,JSON.stringify([['text/plain','alice@wallet.example']]));
  assert.equal(result.headers.get('access-control-allow-origin'),'*');
  assert.equal(db.getAccountBalance(owner.pubkey),20000,'forwarded payments are not poker deposits');
  const externalEdit=sign(owner,{name:'Edited elsewhere',nip05:'receiver@satoshistacks.com',lud16:'receiver@satoshistacks.com'},event.created_at+1);
  assert.equal(db.saveNostrProfile(externalEdit),true);
  assert.equal((await request('/.well-known/lnurlp/receiver')).status,200,'external profile edits cannot remove forwarding configuration');
  assert.equal((await request('/profile',owner.token)).data.forwardingAddress,'alice@wallet.example');
  const authorization=JSON.parse(db.db.prepare('SELECT authorization_event FROM identifier_forwarding WHERE pubkey=?').get(owner.pubkey).authorization_event);
  assert.equal(authorization.id,event.id,'receiving settings retain their signed authorization');
  const clear=sign(owner,{name:'Receiver',nip05:'receiver@satoshistacks.com',lud16:'alice@wallet.example'},event.created_at+2);
  assert.equal((await request('/profile',owner.token,{signedEvent:clear,previousEventId:externalEdit.id,claimName:'receiver'})).status,200);
  assert.equal((await request('/.well-known/lnurlp/receiver')).status,404);
  assert.equal(db.getAccountBalance(owner.pubkey),20000);
});
test('invalid Lightning receiving settings do not take payment or grant an identifier',async()=>{
  const owner=player();
  for(const target of ['another@satoshistacks.com','broken@wallet.example']) {
    const profile={nip05:'invalidreceiver@satoshistacks.com',lud16:'invalidreceiver@satoshistacks.com',satoshistacks_lightning_address:target};
    assert.equal((await request('/profile',owner.token,{signedEvent:sign(owner,profile),previousEventId:null,claimName:'invalidreceiver'})).status,400);
    assert.equal(db.getNip05Claim(owner.pubkey),null);assert.equal(db.getAccountBalance(owner.pubkey),30000);
  }
});
test('anonymous, wrong-author, tampered and stale saves cannot edit a profile',async()=>{
  const owner=player(),other=player(),event=sign(owner,{name:'Alice'});
  assert.equal((await request('/profile',null,{signedEvent:event})).status,401);
  assert.equal((await request('/profile',other.token,{signedEvent:event,previousEventId:null})).status,400);
  assert.equal((await request('/profile',owner.token,{signedEvent:{...event,content:'{}'},previousEventId:null})).status,400);
  assert.equal((await request('/profile',owner.token,{signedEvent:sign(owner,{},1),previousEventId:null})).status,400);
});
test('reserved or malformed identifiers, spoofed domain names and unsafe URLs are rejected',async()=>{
  const owner=player();
  for(const name of ['admin','allen','ab','BadName','contains space','__proto__']) {
    const result=await request('/profile',owner.token,{signedEvent:sign(owner,{nip05:`${name}@satoshistacks.com`}),previousEventId:null,claimName:name});
    assert.equal(result.status,400,name);
  }
  assert.equal((await request('/profile',owner.token,{signedEvent:sign(owner,{nip05:'someone@satoshistacks.com'}),previousEventId:null})).status,409);
  for(const picture of ['javascript:alert(1)','http://example.com/a.png']) assert.equal((await request('/profile',owner.token,{signedEvent:sign(owner,{picture}),previousEventId:null})).status,400);
  assert.deepEqual((await request('/.well-known/nostr.json?name=unknown')).data.names,{});
});
test('publication failures are visible and profile edits can remove fields',async()=>{
  const owner=player(),event=sign(owner,{name:'Before',about:'Remove me',picture:'https://example.com/a.png'});
  const first=await request('/offline',owner.token,{signedEvent:event,previousEventId:null});
  assert.equal(first.status,200);assert.equal(first.data.published,0);assert.match(first.data.message,/did not confirm/);
  const next=sign(owner,{name:'After',picture:'',about:''},event.created_at+1);
  assert.equal((await request('/profile',owner.token,{signedEvent:next,previousEventId:null})).status,409,'stale editors cannot overwrite newer profiles');
  assert.equal((await request('/profile',owner.token,{signedEvent:next,previousEventId:event.id})).status,200);
  assert.equal(db.getPlayer(owner.pubkey).nostr_picture,null);assert.equal(JSON.parse(db.getNostrProfile(owner.pubkey).content).about,'');
});
test('one account cannot rename its claim and failed saves do not reserve names',async()=>{
  const owner=player(),event=sign(owner,{nip05:'stable@satoshistacks.com'});
  assert.equal((await request('/profile',owner.token,{signedEvent:event,previousEventId:null,claimName:'stable'})).status,200);
  assert.equal((await request('/profile',owner.token,{signedEvent:sign(owner,{nip05:'renamed@satoshistacks.com'},event.created_at+1),previousEventId:event.id,claimName:'renamed'})).status,409);
  const another=player();
  assert.equal((await request('/profile',another.token,{signedEvent:sign(another,{}),previousEventId:null,claimName:'rollback'})).status,409);
  assert.deepEqual((await request('/.well-known/nostr.json?name=rollback')).data.names,{});
});
