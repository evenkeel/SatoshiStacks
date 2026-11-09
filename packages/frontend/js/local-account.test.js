'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const pure = require('nostr-tools/pure');
const nip19 = require('nostr-tools/nip19');
const { create } = require('./local-account');
const { authenticate } = require('./providers');
const tools = { ...pure, ...nip19 };
const environment = { isSecureContext: true, crypto: webcrypto };

test('new accounts have distinct keys and valid NIP-19 encodings', async () => {
  const first = create(tools, environment), second = create(tools, environment);
  try {
    assert.notEqual(first.nsec(), second.nsec());
    const decoded = nip19.decode(first.nsec());
    assert.equal(decoded.type, 'nsec');
    assert.equal(decoded.data.length, 32);
    assert.equal(pure.getPublicKey(decoded.data), await first.getPublicKey());
    assert.equal(nip19.decode(first.npub).data, await first.getPublicKey());
  } finally { first.destroy(); second.destroy(); }
});

test('generated account authenticates with a valid signature and never sends its nsec', async () => {
  const account = create(tools, environment);
  const nsec = account.nsec();
  try {
    const result = await authenticate(account, {
      origin: 'https://example.com',
      requestChallenge: async () => ({ challengeId: 'id', nonce: 'test-challenge' }),
      verify: async body => {
        assert.equal(pure.verifyEvent(body.signedEvent), true);
        assert.deepEqual(body.signedEvent.tags, [['challenge', 'test-challenge'], ['relay', 'https://example.com']]);
        assert.equal(JSON.stringify(body).includes(nsec), false);
        assert.deepEqual(Object.keys(body).sort(), ['challengeId', 'signedEvent']);
        return { success: true };
      },
    });
    assert.equal(result.success, true);
    const profileEvent = await account.signEvent({kind:0,created_at:Math.floor(Date.now()/1000),tags:[],content:JSON.stringify({name:'New player'})});
    assert.equal(pure.verifyEvent(profileEvent),true);
    assert.equal(profileEvent.pubkey,await account.getPublicKey());
    await assert.rejects(account.signEvent({ kind: 1 }), /Only sign-in/);
  } finally { account.destroy(); }
});

test('insecure contexts and unavailable or failing cryptographic randomness fail closed', () => {
  let generated = false;
  const fakeTools = { generateSecretKey() { generated = true; } };
  assert.throws(() => create(fakeTools, { ...environment, isSecureContext: false }), /HTTPS/);
  assert.throws(() => create(fakeTools, { isSecureContext: true, crypto: {} }), /randomness/);
  assert.equal(generated, false);
  assert.throws(() => create({ generateSecretKey() { throw new Error('CSPRNG unavailable'); } }, environment), /CSPRNG unavailable/);
});

test('discarding an account zeroes secret bytes and disables further signing or export', async () => {
  const secret = pure.generateSecretKey();
  const account = create({ ...tools, generateSecretKey: () => secret }, environment);
  account.destroy();
  assert.ok(secret.every(byte => byte === 0));
  assert.throws(() => account.nsec(), /cleared/);
  await assert.rejects(account.getPublicKey(), /cleared/);
  await assert.rejects(account.signEvent({ kind: 22242 }), /cleared/);
  account.destroy();
});

test('failed account setup also zeroes secret bytes', () => {
  const secret = pure.generateSecretKey();
  assert.throws(() => create({ ...tools, generateSecretKey: () => secret, npubEncode() { throw new Error('encoding failed'); } }, environment), /encoding failed/);
  assert.ok(secret.every(byte => byte === 0));
});
