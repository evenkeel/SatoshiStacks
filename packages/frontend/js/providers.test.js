'use strict';
const { test }=require('node:test');
const assert=require('node:assert/strict');
const {createWallet,authenticate,assertIdentity}=require('./providers');
const pubkey='a'.repeat(64);
test('NIP-07 login signs a server challenge bound to the site, without wallet access',async()=>{
  let signed,verified;
  const result=await authenticate({getPublicKey:async()=>pubkey,signEvent:async event=>{signed=event;return {...event,pubkey};}},
    {origin:'https://example.com',now:()=>123,requestChallenge:async()=>({challengeId:'id',nonce:'nonce'}),verify:async body=>{verified=body;return {success:true};}});
  assert.equal(result.success,true); assert.equal(signed.kind,22242);
  assert.deepEqual(signed.tags,[['challenge','nonce'],['relay','https://example.com']]);
  assert.equal(verified.challengeId,'id');
});
test('a signer account change aborts login before verification',async()=>{
  let verified=false;
  await assert.rejects(authenticate({getPublicKey:async()=>pubkey,signEvent:async()=>({pubkey:'b'.repeat(64)})},
    {origin:'https://example.com',requestChallenge:async()=>({}),verify:async()=>{verified=true;}}),/changed accounts/);
  assert.equal(verified,false);
});
test('wallet is not connected until permission and wallet availability succeed',async()=>{
  const calls=[];
  const provider={isSidecar:true,enable:async()=>calls.push('enable'),getInfo:async()=>calls.push('info'),sendPayment:async()=>calls.push('pay')};
  const wallet=createWallet(()=>provider);
  assert.equal(wallet.isConnected(),false);
  assert.equal((await wallet.connect()).name,'Sidecar');
  assert.deepEqual(calls,['enable','info']); assert.equal(wallet.isConnected(),true);
});
test('missing or declined wallet never reports connected',async()=>{
  const missing=createWallet(()=>undefined); await assert.rejects(missing.connect(),/No WebLN/); assert.equal(missing.isConnected(),false);
  const declinedProvider={enable:async()=>{throw new Error('declined');},sendPayment(){}};
  const declined=createWallet(()=>declinedProvider);
  await assert.rejects(declined.connect(),/declined/); assert.equal(declined.isConnected(),false);
});
test('WebLN pays only after an explicit pay call and creates cash-out requests internally',async()=>{
  const calls=[];
  const provider={enable:async()=>{},sendPayment:async request=>{calls.push(request);return {preimage:'test'};},
    makeInvoice:async options=>{calls.push(options);return {paymentRequest:'lnbc1receiving'};}};
  const wallet=createWallet(()=>provider); await wallet.connect(); assert.deepEqual(calls,[]);
  await wallet.pay('lnbc1test'); assert.equal(calls[0],'lnbc1test');
  assert.equal(await wallet.invoice(5000),'lnbc1receiving'); assert.equal(calls[1].amount,5000);
});
test('provider replacement requires fresh wallet permission',async()=>{
  let provider={enable:async()=>{},sendPayment:async()=>{}};
  const wallet=createWallet(()=>provider); await wallet.connect(); provider={...provider};
  assert.equal(wallet.isConnected(),false); await assert.rejects(wallet.pay('lnbc1test'),/Connect/);
});
test('wallet disconnect forgets the connection',async()=>{
  const provider={enable:async()=>{},sendPayment:async()=>{}};
  const wallet=createWallet(()=>provider);await wallet.connect();wallet.disconnect();assert.equal(wallet.isConnected(),false);
});
test('a signer account change blocks further wallet use',async()=>{
  await assertIdentity({getPublicKey:async()=>pubkey},pubkey);
  await assert.rejects(assertIdentity({getPublicKey:async()=>'b'.repeat(64)},pubkey),/account changed/);
  await assert.rejects(assertIdentity(null,pubkey),/account changed/);
});

test('canceling a delayed signer approval never verifies a session', async () => {
  const controller = new AbortController();
  let approve, verified = false;
  const pending = authenticate({getPublicKey: async()=>pubkey, signEvent:()=>new Promise(resolve=>{approve=resolve;})}, {
    signal:controller.signal, origin:'https://example.com', requestChallenge:async()=>({challengeId:'id',nonce:'n'}), verify:async()=>{verified=true;}
  });
  while(!approve) await new Promise(resolve=>setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending,{name:'AbortError'});
  approve({pubkey});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(verified,false);
});
test('provider waits have a bounded timeout', async () => {
  const {withTimeout}=require('./providers');
  await assert.rejects(withTimeout(()=>new Promise(()=>{}),{timeoutMs:5}),/timed out/);
});
test('disconnect during wallet approval cannot silently restore the connection', async () => {
  let enable;
  const provider={enable:()=>new Promise(resolve=>{enable=resolve;}),sendPayment:async()=>{}};
  const wallet=createWallet(()=>provider), pending=wallet.connect();
  while(!enable) await new Promise(resolve=>setImmediate(resolve));
  wallet.disconnect();enable();
  await assert.rejects(pending,/connection changed/);assert.equal(wallet.isConnected(),false);
});
test('a disconnected receiving request cannot be used for a later account', async () => {
  let finish;
  const wallet=createWallet(()=>provider);
  const provider={enable:async()=>{},sendPayment:async()=>{},makeInvoice:()=>new Promise(resolve=>{finish=resolve;})};
  await wallet.connect();const pending=wallet.invoice(1000);
  while(!finish) await new Promise(resolve=>setImmediate(resolve));
  wallet.disconnect();finish({paymentRequest:'lnbc1oldaccount'});
  await assert.rejects(pending,/connection changed/);
});
