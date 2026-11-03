/* Browser-provider adapters. No private keys or wallet connection secrets are stored. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StacksProviders = api;
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';
  function createWallet(getProvider) {
    let connectedProvider = null;
    return {
      isConnected() { return !!connectedProvider && connectedProvider === getProvider(); },
      name() { return connectedProvider?.isSidecar ? 'Sidecar' : 'Lightning wallet'; },
      disconnect() { connectedProvider = null; },
      async connect() {
        const provider = getProvider();
        if (!provider || typeof provider.enable !== 'function' || typeof provider.sendPayment !== 'function') {
          throw new Error('No WebLN wallet found. Set up a wallet in Sidecar, then reload this page.');
        }
        await provider.enable();
        // A provider can be present without a configured wallet. Probe actual
        // wallet availability instead of claiming a pasted connection is live.
        if (typeof provider.getInfo === 'function') await provider.getInfo();
        connectedProvider = provider;
        return { name: this.name(), canReceive: typeof provider.makeInvoice === 'function' };
      },
      async pay(invoice) {
        if (!this.isConnected()) throw new Error('Connect your Lightning wallet first');
        if (typeof invoice !== 'string' || !/^ln(?:bc|tb|bcrt|sb)[0-9a-z]+$/i.test(invoice)) throw new Error('Invalid Lightning invoice');
        // Payment is only called by the explicit Pay button; success here never
        // credits chips. Only the server's confirmed invoice does that.
        return connectedProvider.sendPayment(invoice);
      },
      async invoice(amount) {
        if (!this.isConnected()) throw new Error('Connect your Lightning wallet first');
        if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('Invalid cash-out amount');
        if (typeof connectedProvider.makeInvoice !== 'function') throw new Error('This wallet cannot receive invoices. Paste an invoice instead.');
        const result = await connectedProvider.makeInvoice({ amount, defaultMemo: 'SatoshiStacks cash-out' });
        if (!result || typeof result.paymentRequest !== 'string') throw new Error('Your wallet returned no invoice');
        return result.paymentRequest;
      },
    };
  }
  async function authenticate(signer, { requestChallenge, verify, origin, now = () => Math.floor(Date.now() / 1000) }) {
    if (!signer || typeof signer.getPublicKey !== 'function' || typeof signer.signEvent !== 'function') throw new Error('No NIP-07 signer found. Unlock Sidecar and reload this page.');
    const challenge = await requestChallenge();
    const pubkey = await signer.getPublicKey();
    if (!/^[0-9a-f]{64}$/.test(pubkey)) throw new Error('Your signer returned an invalid public key');
    const event = await signer.signEvent({ kind: 22242, created_at: now(),
      tags: [['challenge', challenge.nonce], ['relay', origin]], content: '' });
    if (event.pubkey !== pubkey) throw new Error('Your signer changed accounts. Please sign in again.');
    return verify({ challengeId: challenge.challengeId, signedEvent: event });
  }
  async function assertIdentity(signer, expectedPubkey) {
    if (!signer || typeof signer.getPublicKey !== 'function' || await signer.getPublicKey() !== expectedPubkey) {
      throw new Error('Your signer account changed. Sign out and sign in with the intended account before using the wallet.');
    }
  }
  return { createWallet, authenticate, assertIdentity };
});
