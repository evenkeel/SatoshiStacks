'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {EventEmitter}=require('node:events');
const {createLightning}=require('./lightning');
test('LND sends include the configured fee cap and routing timeout',async()=>{
  let options;
  const client=createLightning({}, {lnService:{async payViaPaymentRequest(args){options=args;return {fee:1,safe_fee:2};}}});
  const result=await client.sendPayment({bolt11:'invoice',paymentHash:'hash',feeLimitSats:50,timeoutSec:60});
  assert.equal(options.max_fee,50);assert.equal(options.pathfinding_timeout,60000);assert.equal(options.max_paths,8);assert.equal(result.feeSats,2);
});
test('configured multi-path limits reach the Lightning router',async()=>{
  let paths;
  const client=createLightning({maxPaymentPaths:4},{lnService:{async payViaPaymentRequest(args){paths=args.max_paths;return {};}}});
  await client.sendPayment({bolt11:'invoice',feeLimitSats:70});assert.equal(paths,4);
});
test('invoice creation timeouts recover the original invoice by its precommitted hash',async()=>{
  const secret=crypto.randomBytes(32).toString('hex');
  const hash=crypto.createHash('sha256').update(Buffer.from(secret,'hex')).digest('hex');
  let options;
  const client=createLightning({readTimeoutMs:5},{lnService:{
    createInvoice:args=>{options=args;return new Promise(()=>{});},
    getInvoice:async({id})=>{assert.equal(id,hash);return {id,request:'original-invoice',tokens:5000};}
  }});
  const invoice=await client.createInvoice({amountSats:5000,secret,expiresAt:Math.floor(Date.now()/1000)+600});
  assert.equal(invoice.paymentHash,hash);assert.equal(invoice.bolt11,'original-invoice');
  assert.equal(options.secret,secret);assert.equal(options.is_including_private_channels,true);
});
test('unresolved invoice creation has a bounded wait and never switches identifiers',async()=>{
  let creates=0,lookups=0;
  const client=createLightning({readTimeoutMs:5},{lnService:{
    createInvoice:()=>{creates++;return new Promise(()=>{});},getInvoice:()=>{lookups++;return new Promise(()=>{});}
  }});
  await assert.rejects(client.createInvoice({amountSats:1000}),error=>error.code==='INVOICE_UNCERTAIN');
  assert.equal(creates,1);assert.equal(lookups,1);
});
test('duplicate invoice errors recover rather than minting another invoice',async()=>{
  const secret='12'.repeat(32),id=crypto.createHash('sha256').update(Buffer.from(secret,'hex')).digest('hex');
  const client=createLightning({}, {lnService:{createInvoice:async()=>{throw [409,'InvoiceWithGivenHashAlreadyExists'];},getInvoice:async()=>({id,tokens:1000,request:'same-invoice'})}});
  assert.equal((await client.createInvoice({amountSats:1000,secret})).bolt11,'same-invoice');
});
test('an unexpected invoice hash or amount cannot be presented as the requested deposit',async()=>{
  const client=createLightning({}, {lnService:{createInvoice:async()=>({id:'wrong',tokens:1000,request:'invoice'})}});
  await assert.rejects(client.createInvoice({amountSats:1000}),/unexpected/);
});
test('deposit persistence errors become stream errors instead of crashing the process',()=>{
  const stream=new EventEmitter();let failure;
  const client=createLightning({}, {lnService:{subscribeToInvoices:()=>stream}});
  client.subscribeInvoices(()=>{throw new Error('disk unavailable');}).on('error',error=>failure=error);
  stream.emit('invoice_updated',{is_confirmed:true,id:'hash',received:1000});
  assert.match(failure.message,/reconciliation/);
});
test('node diagnostics distinguish active usable estimates from aggregate balances',async()=>{
  const client=createLightning({}, {lnService:{
    getWalletInfo:async()=>({public_key:'pubkey',chains:['chain'],is_synced_to_chain:true,peers_count:2}),
    getChannelBalance:async()=>({channel_balance:10000}),
    getChannels:async()=>({channels:[{is_active:true,local_balance:6000,local_reserve:1000,remote_balance:4000,remote_reserve:1000},{is_active:false,local_balance:4000,remote_balance:6000}]})
  }});
  const data=await client.getDiagnostics();assert.equal(data.activeChannels,1);assert.equal(data.estimatedActiveOutboundSats,5000);assert.equal(data.estimatedActiveInboundSats,3000);
});
test('only an explicit LND not-initiated response permits dispatch recovery',async()=>{
  for(const error of [[404,'SentPaymentNotFound'],[503,'UnexpectedGetPaymentError'],new Error('offline')]) {
    const client=createLightning({}, {lnService:{async getPayment(){throw error;}}});
    if(Array.isArray(error)&&error[0]===404) assert.equal((await client.trackPayment('hash')).status,'NOT_FOUND');
    else await assert.rejects(client.trackPayment('hash'));
  }
});
test('invoice decoding preserves millisatoshis for exact balance validation',async()=>{
  const client=createLightning({}, {lnService:{async decodePaymentRequest(){return {tokens:100,mtokens:'100001',id:'hash'};}}});
  assert.equal((await client.decodeInvoice('invoice')).amountMsats,'100001');
});
test('a stalled LND read times out instead of blocking all wallet maintenance',async()=>{
  const client=createLightning({readTimeoutMs:5},{lnService:{getPayment:()=>new Promise(()=>{})}});
  await assert.rejects(client.trackPayment('hash'),/timed out/);
});
