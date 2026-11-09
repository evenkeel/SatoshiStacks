'use strict';
const https = require('node:https');
const dns = require('node:dns').promises;
const { BlockList, isIP } = require('node:net');
const db = require('../database');
const DOMAIN = 'satoshistacks.com';
const blocked4 = new BlockList(), blocked6 = new BlockList(), global6 = new BlockList();
for (const [ip,bits] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]]) blocked4.addSubnet(ip,bits,'ipv4');
global6.addSubnet('2000::',3,'ipv6');
for (const [ip,bits] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]]) blocked6.addSubnet(ip,bits,'ipv6');
function isPublicIP(ip) {
  return isIP(ip) === 4 ? !blocked4.check(ip,'ipv4') : isIP(ip) === 6 && global6.check(ip,'ipv6') && !blocked6.check(ip,'ipv6');
}
function parseAddress(value) {
  if (typeof value !== 'string' || value.length > 320) throw new Error('Enter an existing Lightning address such as you@wallet.example.');
  const address = value.trim().toLowerCase();
  const match = /^([a-z0-9._-]+)@([a-z0-9.-]+)$/.exec(address);
  if (!match) throw new Error('Enter an existing Lightning address such as you@wallet.example.');
  const domain = match[2];
  if (domain === DOMAIN || domain.endsWith(`.${DOMAIN}`)) throw new Error('Choose a receiving wallet outside satoshistacks.com to avoid a forwarding loop.');
  validateHost(domain);
  return {address,url:new URL(`https://${domain}/.well-known/lnurlp/${encodeURIComponent(match[1])}`)};
}
function validateHost(host) {
  if (host.length > 253 || isIP(host.replace(/^\[|\]$/g,'')) || !host.includes('.') || host.endsWith('.') ||
    !host.split('.').every(label=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) ||
    /\.(localhost|local|internal|test|invalid|onion)$/i.test(host)) throw new Error('Use a publicly reachable Lightning-address provider.');
}
function createForwarder({lookup = dns.lookup.bind(dns), request = https.request, timeoutMs = 5000} = {}) {
  const cache = new Map(), pending = new Map();
  async function resolve(host) {
    validateHost(host);
    let timer;
    const answers = await Promise.race([lookup(host,{all:true,verbatim:true}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Lightning provider lookup timed out.')),timeoutMs);})]).finally(()=>clearTimeout(timer));
    if (!answers.length || answers.some(answer=>!isPublicIP(answer.address))) throw new Error('The Lightning provider must resolve only to public internet addresses.');
    return answers[0];
  }
  async function load(url) {
    const pinned = await resolve(url.hostname);
    return new Promise((resolve,reject)=>{
      let timer;
      // Pin the checked IP for this connection, keeping TLS hostname checking.
      // Redirects are deliberately not followed, including same-host redirects.
      const req = request(url,{method:'GET',agent:false,family:pinned.family,
        lookup:(_host,options,callback)=>options?.all ? callback(null,[pinned]) : callback(null,pinned.address,pinned.family),
        headers:{Accept:'application/json'}},res=>{
        let size=0, chunks=[];
        if (res.statusCode !== 200) { res.resume(); req.destroy(new Error('Lightning provider did not return a payment endpoint.')); return; }
        res.on('data',chunk=>{size+=chunk.length;if(size>262144) req.destroy(new Error('Lightning provider response is too large.'));else chunks.push(chunk);});
        res.on('error',reject);
        res.on('aborted',()=>reject(new Error('Lightning provider disconnected before completing its response.')));
        res.on('end',()=>{try {resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));} catch (_) {reject(new Error('Lightning provider returned invalid payment information.'));}});
      });
      timer=setTimeout(()=>req.destroy(new Error('Lightning provider timed out.')),timeoutMs);
      req.on('error',reject);
      req.on('close',()=>clearTimeout(timer));
      req.end();
    });
  }
  async function get(value) {
    const {address,url} = parseAddress(value);
    const hit = cache.get(address);
    if (hit?.until > Date.now()) return hit.data;
    if (pending.has(address)) return pending.get(address);
    const operation = (async()=>{
      const data = await load(url);
      if (data.tag !== 'payRequest' || !Number.isSafeInteger(data.minSendable) || data.minSendable < 1 ||
        !Number.isSafeInteger(data.maxSendable) || data.maxSendable < data.minSendable || typeof data.metadata !== 'string') throw new Error('This address does not offer Lightning payments.');
      const metadata = JSON.parse(data.metadata);
      if (!Array.isArray(metadata) || !metadata.every(Array.isArray) || !metadata.some(entry=>entry[0]==='text/plain' && typeof entry[1]==='string')) throw new Error('Lightning provider returned invalid metadata.');
      const callback = new URL(data.callback);
      if (callback.protocol !== 'https:' || callback.port || callback.username || callback.password || callback.hash) throw new Error('Lightning provider callback must use public HTTPS.');
      await resolve(callback.hostname);
      if (cache.size >= 1000) cache.delete(cache.keys().next().value);
      cache.set(address,{until:Date.now()+30000,data});
      // Preserve metadata byte-for-byte: its hash belongs to the upstream invoice.
      return data;
    })();
    pending.set(address,operation);
    try {return await operation;} finally {pending.delete(address);}
  }
  return {get};
}
const forwarder = createForwarder();
function createLightningAddressHandler({receiver = forwarder} = {}) {
  const requests = new Map();
  return async (req,res)=>{
    res.set({'Access-Control-Allow-Origin':'*','Cache-Control':'no-store'});
    const now=Date.now();
    for(const [key,rate] of requests) if(rate.until < now) requests.delete(key);
    const rate=requests.get(req.ip) || {count:0,until:now+60000};
    requests.set(req.ip,rate);
    if(++rate.count>60) return res.status(429).json({status:'ERROR',reason:'Too many requests. Try again shortly.'});
    const name=String(req.params.name || '').toLowerCase();
    const address=db.db.prepare(`SELECT f.address FROM nip05_claims c
      JOIN identifier_forwarding f ON f.pubkey=c.pubkey WHERE c.name=?`).get(name)?.address;
    if(!address) return res.status(404).json({status:'ERROR',reason:'Lightning receiving is not enabled for this identifier.'});
    try {res.json(await receiver.get(address));}
    catch(_){res.status(502).json({status:'ERROR',reason:'The receiving wallet is unavailable. Try again later.'});}
  };
}
module.exports = {createForwarder,createLightningAddressHandler,forwarder,parseAddress,isPublicIP};
