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

test('imported nsec signs the challenge locally without sending the private key', async () => {
  const { fromNsec } = require('./local-account');
  const secret = pure.generateSecretKey();
  const encoded = nip19.nsecEncode(secret);
  const decoded = nip19.decode(encoded).data;
  const account = fromNsec({ ...tools, decode: () => ({ type: 'nsec', data: decoded }) }, ` ${encoded} `, environment);
  try {
    assert.equal(await account.getPublicKey(), pure.getPublicKey(secret));
    await authenticate(account, {
      origin: 'https://example.com',
      requestChallenge: async () => ({ challengeId: 'import-id', nonce: 'import-challenge' }),
      verify: async body => {
        assert.equal(pure.verifyEvent(body.signedEvent), true);
        assert.equal(body.signedEvent.pubkey, pure.getPublicKey(secret));
        assert.equal(JSON.stringify(body).includes(encoded), false);
        assert.equal(JSON.stringify(body).includes(Buffer.from(secret).toString('hex')), false);
        assert.deepEqual(Object.keys(body).sort(), ['challengeId', 'signedEvent']);
        return { success: true };
      },
    });
    await assert.rejects(account.signEvent({ kind: 1 }), /Only sign-in/);
  } finally { account.destroy(); secret.fill(0); }
  assert.ok(decoded.every(byte => byte === 0));
  await assert.rejects(account.getPublicKey(), /cleared/);
});

test('private-key import rejects public keys, bad checksums, invalid scalars, and insecure pages', () => {
  const { fromNsec } = require('./local-account');
  const secret = pure.generateSecretKey();
  const encoded = nip19.nsecEncode(secret);
  const account = fromNsec(tools, encoded, environment);
  account.destroy();
  for (const input of ['', nip19.npubEncode(pure.getPublicKey(secret)), Buffer.from(secret).toString('hex'), encoded.slice(0, -1) + (encoded.endsWith('q') ? 'p' : 'q')]) {
    assert.throws(() => fromNsec(tools, input, environment), /valid nsec/);
  }
  assert.throws(() => fromNsec(tools, encoded, { isSecureContext: false }), /HTTPS/);
  const invalidScalar = new Uint8Array(32).fill(255);
  assert.throws(() => fromNsec({ ...tools, decode: () => ({ type: 'nsec', data: invalidScalar }) }, encoded, environment));
  assert.ok(invalidScalar.every(byte => byte === 0));
  secret.fill(0);
});
