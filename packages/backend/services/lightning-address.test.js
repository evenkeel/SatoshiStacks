'use strict';
process.env.SATOSHISTACKS_DB_PATH=':memory:';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {createForwarder,parseAddress,isPublicIP}=require('./lightning-address');
const pay={tag:'payRequest',callback:'https://wallet.example/callback?token=example',minSendable:1000,maxSendable:1000000,metadata:'[["text/plain", "Original wallet metadata"]]',allowsNostr:true,nostrPubkey:'a'.repeat(64)};
function mockRequest(data=pay,code=200,capture=()=>{}) {
  return (url,options,onResponse)=>{
    capture(url,options);
    const req=new EventEmitter();
    req.destroy=error=>{if(error)req.emit('error',error);req.emit('close');};
    req.end=()=>queueMicrotask(()=>{
      const res=new EventEmitter();res.statusCode=code;res.resume=()=>{};
      onResponse(res);
      if(code===200){res.emit('data',Buffer.from(typeof data==='string'?data:JSON.stringify(data)));res.emit('end');}
      req.emit('close');
    });
    return req;
  };
}
const lookup=async()=>[{address:'8.8.8.8',family:4}];
test('forwarding preserves provider callback, invoice metadata and zap capabilities',async()=>{
  let calls=0,pinned;
  const receiver=createForwarder({lookup,request:mockRequest(pay,200,(url,options)=>{
    calls++;assert.equal(url.href,'https://wallet.example/.well-known/lnurlp/alice');assert.equal(options.agent,false);
    options.lookup(url.hostname,{},(err,address)=>{assert.equal(err,null);pinned=address;});
  })});
  const result=await receiver.get('alice@wallet.example');
  assert.deepEqual(result,pay);assert.equal(result.metadata,pay.metadata);assert.equal(pinned,'8.8.8.8');
  await receiver.get('alice@wallet.example');assert.equal(calls,1);
});
test('local, reserved, mapped and non-public network destinations are rejected',async()=>{
  for(const ip of ['127.0.0.1','10.1.2.3','169.254.169.254','100.64.0.1','192.168.1.1','198.18.0.1','203.0.113.1','::1','fc00::1','fe80::1','::ffff:127.0.0.1','2001:db8::1','2002:7f00:1::','3fff::1']) assert.equal(isPublicIP(ip),false,ip);
  for(const ip of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111']) assert.equal(isPublicIP(ip),true,ip);
  let requested=false;
  const receiver=createForwarder({lookup:async()=>[{address:'127.0.0.1',family:4}],request:()=>{requested=true;}});
  await assert.rejects(receiver.get('alice@wallet.example'),/public internet/);assert.equal(requested,false);
});
test('mixed public/private DNS answers are rejected before a connection',async()=>{
  const receiver=createForwarder({lookup:async()=>[{address:'8.8.8.8',family:4},{address:'10.0.0.1',family:4}],request:()=>{throw new Error('must not connect');}});
  await assert.rejects(receiver.get('alice@wallet.example'),/public internet/);
});
test('forwarding loops, IP literal providers, credentials and malformed addresses are rejected',()=>{
  for(const target of ['me@satoshistacks.com','me@sub.satoshistacks.com','me@127.0.0.1','me@localhost','me@wallet.local','me@wallet.example:443','me@user:secret@wallet.example','me@wallet.example/path','me@wallet.example.']) assert.throws(()=>parseAddress(target),undefined,target);
});
test('redirects and invalid payment endpoints fail closed',async()=>{
  await assert.rejects(createForwarder({lookup,request:mockRequest(pay,302)}).get('alice@wallet.example'),/payment endpoint/);
  for(const bad of [{...pay,minSendable:0},{...pay,maxSendable:0},{...pay,callback:'http://wallet.example/pay'},{...pay,callback:'https://127.0.0.1/pay'},{...pay,metadata:'[]'},{...pay,tag:'withdrawRequest'}]) {
    await assert.rejects(createForwarder({lookup,request:mockRequest(bad)}).get('alice@wallet.example'));
  }
});
test('DNS timeouts and oversized responses are bounded',async()=>{
  await assert.rejects(createForwarder({lookup:()=>new Promise(()=>{}),timeoutMs:5}).get('alice@wallet.example'),/timed out/);
  await assert.rejects(createForwarder({lookup,request:mockRequest('x'.repeat(262145))}).get('alice@wallet.example'),/too large/);
});
