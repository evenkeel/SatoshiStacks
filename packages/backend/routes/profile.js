'use strict';
const { Router } = require('express');
const { verifyEvent } = require('nostr-tools/pure');
const db = require('../database');
const nostr = require('../services/nostr');
const {forwarder,parseAddress} = require('../services/lightning-address');
const DOMAIN = 'satoshistacks.com';
const IDENTIFIER_PRICE_SATS = 10000;
// Preserve the existing site identifier and prevent impersonation of staff.
const IDENTIFIERS = { allen: '8a3a9236d0eae6bc92eb17782d57e828a01f03cd28d3c68297c7e19d374b9419' };
const RESERVED = new Set(['_', 'admin', 'administrator', 'support', 'help', 'security', 'root', 'postmaster', 'abuse', 'satoshistacks', 'satoshi-stacks', 'www', 'api', 'nostr', ...Object.keys(IDENTIFIERS)]);
const validName = name => typeof name === 'string' && /^[a-z0-9][a-z0-9_-]{2,29}$/.test(name) && !RESERVED.has(name);
function nip05Lookup(req, res) {
  const name = typeof req.query.name === 'string' ? req.query.name.trim().toLowerCase() : '';
  const names = Object.create(null);
  if (name) {
    const pubkey = (Object.hasOwn(IDENTIFIERS,name) ? IDENTIFIERS[name] : null) || db.db.prepare('SELECT pubkey FROM nip05_claims WHERE name=?').get(name)?.pubkey;
    if (pubkey) names[name] = pubkey;
  } else {
    Object.assign(names, IDENTIFIERS);
    for (const row of db.db.prepare('SELECT name,pubkey FROM nip05_claims').all()) names[row.name] = row.pubkey;
  }
  res.set({ 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }).json({ names });
}
function validateProfile(event, pubkey) {
  try {
    if (!event || event.kind !== 0 || event.pubkey !== pubkey || !verifyEvent(event)) return 'Sign this profile with your own Nostr account.';
    if (Math.abs(event.created_at - Math.floor(Date.now()/1000)) > 300) return 'Profile signature expired. Save again.';
    if (event.content.length > 8192) return 'Profile is too large.';
    const profile = JSON.parse(event.content);
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return 'Invalid profile.';
    for (const [key, limit] of Object.entries({ name:64, display_name:64, about:500, picture:2048, website:2048, nip05:320, lud16:320, satoshistacks_lightning_address:320 })) {
      if (profile[key] != null && (typeof profile[key] !== 'string' || profile[key].length > limit)) return `Invalid ${key} (maximum ${limit} characters).`;
    }
    for (const key of ['picture','website']) {
      if (profile[key]) { const url = new URL(profile[key]); if (url.protocol !== 'https:' || url.username || url.password) return `${key} must be an HTTPS URL without credentials.`; }
    }
    return null;
  } catch (_) { return 'Invalid signed profile.'; }
}
function createProfileRoutes({ publish = nostr.publishProfile, onUpdate = () => {}, canPurchase = () => false, receiver = forwarder } = {}) {
  const router = Router();
  const writes = new Map();
  router.use((req,res,next) => {
    res.set('Cache-Control','no-store');
    req.player = db.getPlayerBySession(req.get('x-session-token'));
    if (!req.player) return res.status(401).json({success:false,error:'Sign in to edit your profile.'});
    // Grandfather the site's pre-existing manually assigned identifier.
    const preassigned = Object.entries(IDENTIFIERS).find(([,pubkey])=>pubkey===req.player.user_id);
    if (preassigned && !db.getNip05Claim(req.player.user_id)) db.db.prepare('INSERT INTO nip05_claims(name,pubkey) VALUES(?,?) ON CONFLICT DO NOTHING').run(preassigned[0],req.player.user_id);
    next();
  });
  router.get('/', (req,res) => {
    const event = db.getNostrProfile(req.player.user_id);
    const forwardingAddress = db.db.prepare('SELECT address FROM identifier_forwarding WHERE pubkey=?').get(req.player.user_id)?.address || null;
    res.json({success:true,event,profile:event ? JSON.parse(event.content) : {name:req.player.nostr_name || '',picture:req.player.nostr_picture || '',lud16:req.player.lud16 || '',nip05:req.player.nip05 || ''},claimName:db.getNip05Claim(req.player.user_id),forwardingAddress,domain:DOMAIN,priceSats:IDENTIFIER_PRICE_SATS,purchasesEnabled:!!canPurchase(),availableSats:db.getAccountBalance(req.player.user_id)});
  });
  router.post('/', async (req,res) => {
    const now = Date.now();
    for (const [key, value] of writes) if (value.until < now) writes.delete(key);
    const rate = writes.get(req.player.user_id) || {count:0,until:now+60000};
    if (++rate.count > 10) return res.status(429).json({success:false,error:'Too many profile updates. Try again in a minute.'});
    writes.set(req.player.user_id,rate);
    const { signedEvent:event, previousEventId, claimName, purchase } = req.body || {};
    const error = validateProfile(event, req.player.user_id);
    if (error) return res.status(400).json({success:false,error});
    const profile = JSON.parse(event.content);
    const ownedName = db.getNip05Claim(req.player.user_id);
    if (claimName != null && claimName !== ownedName && !validName(claimName)) return res.status(400).json({success:false,error:'Choose 3–30 lowercase letters, numbers, underscores or hyphens. This name may be reserved.'});
    const buying = claimName && !ownedName;
    if (buying && (!purchase || purchase.amountSats !== IDENTIFIER_PRICE_SATS || purchase.confirmed !== true)) return res.status(402).json({success:false,error:'Confirm the one-time 10,000-sat purchase from your account balance.'});
    if (buying && !canPurchase()) return res.status(503).json({success:false,error:'Identifier purchases are temporarily unavailable. Your profile can still be saved without buying a name.'});
    if (buying && db.getAccountBalance(req.player.user_id) < IDENTIFIER_PRICE_SATS) return res.status(402).json({success:false,error:'Add sats to your account first. A username costs 10,000 sats.'});
    const forwarding = profile.satoshistacks_lightning_address;
    if (forwarding) {
      if (!claimName && !ownedName) return res.status(400).json({success:false,error:'Purchase an identifier before enabling Lightning receiving.'});
      try {
        if (parseAddress(forwarding).address !== forwarding) throw new Error('Use a lowercase Lightning address without surrounding spaces.');
        if (profile.lud16 !== `${claimName || ownedName}@${DOMAIN}`) throw new Error('Your profile must use your identifier as its Lightning address.');
        await receiver.get(forwarding);
      } catch(error) { return res.status(400).json({success:false,error:error.message || 'Could not verify the receiving Lightning address.'}); }
    }
    if (!db.getPlayerBySession(req.get('x-session-token'))) return res.status(401).json({success:false,error:'Your session expired. Sign in again.'});
    let chargedSats = 0;
    try {
      db.db.transaction(() => {
        const old = db.getNostrProfile(req.player.user_id);
        if (old?.id !== event.id && (old?.id || null) !== previousEventId) throw new Error('Your profile changed. Close and reopen the editor before saving.');
        const owned = db.getNip05Claim(req.player.user_id);
        if (claimName && owned && owned !== claimName) throw new Error('This account already has an identifier.');
        if (claimName && !owned) {
          if (!canPurchase()) throw new Error('Identifier purchases are temporarily unavailable.');
          db.db.prepare('INSERT INTO nip05_claims(name,pubkey) VALUES (?,?)').run(claimName,req.player.user_id);
          // Name ownership, settled-balance debit, receipt and profile commit
          // together. Retries and profile edits never charge an existing owner.
          db.debitAccount(req.player.user_id,claimName,'identifier_purchase',IDENTIFIER_PRICE_SATS);
          db.db.prepare('INSERT INTO identifier_purchases(name,pubkey,amount_sats) VALUES(?,?,?)').run(claimName,req.player.user_id,IDENTIFIER_PRICE_SATS);
          chargedSats = IDENTIFIER_PRICE_SATS;
        }
        const localName = claimName || owned;
        if (claimName && profile.nip05 !== `${claimName}@${DOMAIN}`) throw new Error('The signed profile must include your claimed identifier.');
        if (typeof profile.nip05 === 'string' && profile.nip05.toLowerCase().endsWith(`@${DOMAIN}`) &&
          profile.nip05 !== `${localName}@${DOMAIN}` && (!Object.hasOwn(IDENTIFIERS,profile.nip05.split('@')[0]) || IDENTIFIERS[profile.nip05.split('@')[0]] !== req.player.user_id)) throw new Error('Claim this identifier before adding it to your profile.');
        if (old?.id !== event.id && !db.saveNostrProfile(event)) throw new Error('A newer profile is already saved. Close and reopen the editor.');
        if (localName) db.db.prepare(`INSERT INTO identifier_forwarding(pubkey,address,authorization_event) VALUES(?,?,?)
          ON CONFLICT(pubkey) DO UPDATE SET address=excluded.address,authorization_event=excluded.authorization_event`)
          .run(req.player.user_id,forwarding || null,JSON.stringify(event));
      })();
    } catch (error) {
      return res.status(409).json({success:false,error:error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || error.code === 'SQLITE_CONSTRAINT_UNIQUE' ? 'That identifier is already taken. Choose another name.' : error.message});
    }
    onUpdate(event.pubkey, profile);
    let published = 0;
    try { published = await publish(event); } catch (_) { /* saved locally; client can retry */ }
    const availableSats = db.getAccountBalance(event.pubkey);
    const receipt = chargedSats ? `Purchased ${claimName}@${DOMAIN} for 10,000 sats. Account balance: ${availableSats.toLocaleString('en-US')} sats. ` : '';
    res.json({success:true,profile,event,claimName:db.getNip05Claim(event.pubkey),forwardingAddress:forwarding || null,published,chargedSats,priceSats:IDENTIFIER_PRICE_SATS,purchasesEnabled:!!canPurchase(),availableSats,
      message:receipt + (published ? 'Profile saved and published to Nostr.' : 'Profile saved here. Nostr relays did not confirm publication; save again to retry.')});
  });
  return router;
}
module.exports = { createProfileRoutes, nip05Lookup, validateProfile, validName, IDENTIFIER_PRICE_SATS };
