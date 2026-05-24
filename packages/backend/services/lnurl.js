'use strict';
/**
 * LNURL-pay resolution for Lightning Addresses (lud16, e.g. "name@domain.com").
 * Used to auto-refund a player's un-seatable deposit to the Lightning address in
 * their Nostr profile.
 *
 * SECURITY: the lud16 comes from a user-controlled profile field, so resolving it
 * is an outbound HTTP request to an attacker-chosen host. Guards here:
 *   - https only, no redirects
 *   - reject IP-literal / localhost / private / link-local hosts (SSRF)
 *   - require a valid LNURL payRequest, requested amount within min/max sendable
 *   - short timeouts
 * Defense-in-depth: the CALLER (payments) must STILL decode the returned invoice
 * and verify its amount == the refund amount and its destination != our own node
 * before paying. Never trust the LNURL server to return a correct invoice.
 *
 * Deps (fetchImpl, lookup) are injectable for testing.
 */
const dnsPromises = require('dns').promises;
const net = require('net');

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;       // link-local
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (Tailscale!)
    if (a >= 224) return true;                      // multicast / reserved
    return false;
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    return l === '::1' || l === '::' || l.startsWith('fe80') || l.startsWith('fc') || l.startsWith('fd');
  }
  return true; // unknown form -> treat as unsafe
}

async function assertPublicHost(host, lookup) {
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('Lightning address host is a private IP');
    return;
  }
  const h = host.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan')) {
    throw new Error('Lightning address host is not public');
  }
  let addrs;
  try { addrs = await lookup(host, { all: true }); }
  catch (e) { throw new Error('Lightning address host did not resolve'); }
  if (!addrs || !addrs.length) throw new Error('Lightning address host did not resolve');
  for (const a of addrs) {
    if (isPrivateIp(a.address)) throw new Error('Lightning address host resolves to a private IP');
  }
}

async function fetchJson(url, fetchImpl, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal, redirect: 'error', headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`LNURL endpoint returned HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/**
 * Resolve a Lightning Address to a BOLT11 invoice for `amountSats`.
 * @returns {Promise<string>} bolt11 payment request
 */
async function resolveLightningAddress(lud16, amountSats, opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const lookup = opts.lookup || dnsPromises.lookup;
  if (typeof fetchImpl !== 'function') throw new Error('fetch is not available');

  if (!lud16 || typeof lud16 !== 'string' || !lud16.includes('@')) throw new Error('No valid Lightning address');
  const [name, domain] = lud16.split('@');
  if (!name || !domain || /[^a-zA-Z0-9._-]/.test(name) || /[^a-zA-Z0-9.-]/.test(domain)) {
    throw new Error('Malformed Lightning address');
  }
  if (!(amountSats > 0)) throw new Error('Invalid refund amount');

  await assertPublicHost(domain, lookup);
  const meta = await fetchJson(`https://${domain}/.well-known/lnurlp/${encodeURIComponent(name)}`, fetchImpl);
  if (!meta || meta.tag !== 'payRequest' || !meta.callback) throw new Error('Address is not an LNURL payRequest');

  const amountMsat = amountSats * 1000;
  if (typeof meta.minSendable === 'number' && amountMsat < meta.minSendable) throw new Error('Amount below the address minimum');
  if (typeof meta.maxSendable === 'number' && amountMsat > meta.maxSendable) throw new Error('Amount above the address maximum');

  let cb;
  try { cb = new URL(meta.callback); } catch (e) { throw new Error('Bad LNURL callback URL'); }
  if (cb.protocol !== 'https:') throw new Error('LNURL callback must be https');
  await assertPublicHost(cb.hostname, lookup);
  cb.searchParams.set('amount', String(amountMsat));

  const res = await fetchJson(cb.toString(), fetchImpl);
  if (!res || typeof res.pr !== 'string' || !res.pr) throw new Error('LNURL callback returned no invoice');
  return res.pr;
}

module.exports = { resolveLightningAddress, isPrivateIp, assertPublicHost };
