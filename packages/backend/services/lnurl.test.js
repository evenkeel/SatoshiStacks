'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveLightningAddress, isPrivateIp } = require('./lnurl');

// fetch mock: returns the queued responses in order.
function mockFetch(responses) {
  let i = 0;
  return async () => {
    const r = responses[i++] || {};
    if (r.throw) throw new Error('network error');
    return { ok: r.ok !== false, status: r.status || 200, json: async () => r.json };
  };
}
const lookupPublic = async () => [{ address: '1.2.3.4' }];

test('isPrivateIp flags private / loopback / CGNAT / link-local, allows public', () => {
  for (const ip of ['10.0.0.1', '127.0.0.1', '192.168.1.1', '172.16.0.1', '169.254.1.1', '100.76.39.70', '::1', 'fe80::1']) {
    assert.equal(isPrivateIp(ip), true, `${ip} should be private`);
  }
  for (const ip of ['1.1.1.1', '8.8.8.8', '203.0.113.5']) {
    assert.equal(isPrivateIp(ip), false, `${ip} should be public`);
  }
});

test('resolves a Lightning address to a bolt11 invoice', async () => {
  const fetchImpl = mockFetch([
    { json: { tag: 'payRequest', callback: 'https://primal.net/lnurlp/cb', minSendable: 1000, maxSendable: 100000000 } },
    { json: { pr: 'lnbc100u1ptestinvoice' } },
  ]);
  const pr = await resolveLightningAddress('biophoton@primal.net', 10000, { fetchImpl, lookup: lookupPublic });
  assert.equal(pr, 'lnbc100u1ptestinvoice');
});

test('rejects when the requested amount exceeds the address maximum', async () => {
  const fetchImpl = mockFetch([{ json: { tag: 'payRequest', callback: 'https://x.com/cb', minSendable: 1000, maxSendable: 5000 } }]);
  await assert.rejects(
    resolveLightningAddress('a@x.com', 10000, { fetchImpl, lookup: lookupPublic }),
    /above the address maximum/,
  );
});

test('rejects when the endpoint is not an LNURL payRequest', async () => {
  const fetchImpl = mockFetch([{ json: { tag: 'withdrawRequest' } }]);
  await assert.rejects(
    resolveLightningAddress('a@x.com', 10000, { fetchImpl, lookup: lookupPublic }),
    /payRequest/,
  );
});

test('SSRF: rejects a private/loopback IP-literal host before any fetch', async () => {
  const neverFetch = () => { throw new Error('should not have fetched'); };
  await assert.rejects(
    resolveLightningAddress('a@127.0.0.1', 10000, { fetchImpl: neverFetch, lookup: lookupPublic }),
    /private IP/,
  );
});

test('SSRF: rejects a host that resolves to a private IP', async () => {
  const lookupPrivate = async () => [{ address: '10.1.2.3' }];
  const neverFetch = () => { throw new Error('should not have fetched'); };
  await assert.rejects(
    resolveLightningAddress('a@evil.example', 10000, { fetchImpl: neverFetch, lookup: lookupPrivate }),
    /private IP/,
  );
});

test('rejects a malformed Lightning address', async () => {
  await assert.rejects(resolveLightningAddress('notanaddress', 10000, { lookup: lookupPublic, fetchImpl: mockFetch([]) }), /valid Lightning address/);
});
