/* Temporary browser-only identity. Never persist or transmit the private key. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StacksLocalAccount = api;
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';
  function create(tools, environment = globalThis) {
    if (!environment.isSecureContext || typeof environment.crypto?.getRandomValues !== 'function') {
      throw new Error('Secure account creation requires HTTPS and browser cryptographic randomness.');
    }
    // nostr-tools uses noble's CSPRNG-backed secp256k1 key generator. No
    // passwords, timestamps, Math.random(), or weak-randomness fallback.
    const secret = tools.generateSecretKey();
    return makeSigner(tools, secret);
  }
  function makeSigner(tools, secret) {
    let destroyed = false;
    const assertActive = () => { if (destroyed) throw new Error('This key has been cleared. Sign in again.'); };
    try {
      const pubkey = tools.getPublicKey(secret);
      return {
        npub: tools.npubEncode(pubkey),
        nsec() { assertActive(); return tools.nsecEncode(secret); },
        async getPublicKey() { assertActive(); return pubkey; },
        async signEvent(event) {
          assertActive();
          // Only authentication and the explicitly requested profile setup.
          if (event.kind !== 22242 && event.kind !== 0) throw new Error('Only sign-in challenges and profiles may be signed.');
          return tools.finalizeEvent(event, secret);
        },
        destroy() { secret.fill(0); destroyed = true; },
      };
    } catch (error) { secret.fill(0); throw error; }
  }
  function fromNsec(tools, encoded, environment = globalThis) {
    if (!environment.isSecureContext) throw new Error('Private-key sign-in requires HTTPS.');
    // Accept only NIP-19 private keys, not npubs, raw hex, or arbitrary text.
    const value = typeof encoded === 'string' ? encoded.trim() : '';
    if (!/^nsec1[023456789acdefghjklmnpqrstuvwxyz]{58}$/.test(value)) throw new Error('Enter a valid nsec private key.');
    let decoded;
    try { decoded = tools.decode(value); } catch (_) { throw new Error('Enter a valid nsec private key.'); }
    if (decoded.type !== 'nsec' || !(decoded.data instanceof Uint8Array) || decoded.data.length !== 32) {
      if (decoded.data instanceof Uint8Array) decoded.data.fill(0);
      throw new Error('Enter a valid nsec private key.');
    }
    return makeSigner(tools, decoded.data);
  }
  return { create, fromNsec };
});
