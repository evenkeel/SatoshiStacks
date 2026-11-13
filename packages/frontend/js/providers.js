/* Browser-provider adapters. No private keys or wallet connection secrets are stored. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StacksProviders = api;
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';
  function createWallet(getProvider) {
    let connectedProvider = null;
    let generation = 0;
    return {
      isConnected() { return !!connectedProvider && connectedProvider === getProvider(); },
      name() { return connectedProvider?.isSidecar ? 'Sidecar' : 'Lightning wallet'; },
      disconnect() { generation++; connectedProvider = null; },
      async connect() {
        const version = ++generation;
        const provider = getProvider();
        if (!provider || typeof provider.enable !== 'function' || typeof provider.sendPayment !== 'function') {
          throw new Error('No WebLN wallet found. Set up a wallet in Sidecar, then reload this page.');
        }
        await withTimeout(() => { if (version !== generation || provider !== getProvider()) throw new Error('Wallet connection changed. Connect again.'); return provider.enable(); }, { timeoutMs:90000, message:'Wallet approval timed out. Unlock your wallet and connect again.' });
        // A provider can be present without a configured wallet. Probe actual
        // wallet availability instead of claiming a pasted connection is live.
        if (typeof provider.getInfo === 'function') await withTimeout(() => provider.getInfo());
        if (version !== generation || provider !== getProvider()) throw new Error('Wallet connection changed. Connect again.');
        connectedProvider = provider;
        return { name: this.name(), canReceive: typeof provider.makeInvoice === 'function' };
      },
      async pay(invoice) {
        if (!this.isConnected()) throw new Error('Connect your Lightning wallet first');
        if (typeof invoice !== 'string' || !/^ln(?:bc|tb|bcrt|sb)[0-9a-z]+$/i.test(invoice)) throw new Error('Invalid Lightning invoice');
        // Payment is only called by the explicit Pay button; success here never
        // credits chips. Only the server's confirmed invoice does that.
        const provider = connectedProvider;
        return withTimeout(() => { if (provider !== connectedProvider || provider !== getProvider()) throw new Error('Wallet connection changed. Connect again.'); return provider.sendPayment(invoice); }, { timeoutMs:90000, message:'Payment confirmation timed out. Check your wallet; the server will still recognize a settled invoice.' });
      },
      async invoice(amount) {
        if (!this.isConnected()) throw new Error('Connect your Lightning wallet first');
        if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('Invalid cash-out amount');
        if (typeof connectedProvider.makeInvoice !== 'function') throw new Error('This wallet cannot receive invoices. Paste an invoice instead.');
        const provider = connectedProvider, version = generation;
        const result = await withTimeout(() => { if (version !== generation || provider !== getProvider()) throw new Error('Wallet connection changed. Request a new invoice.'); return provider.makeInvoice({ amount, defaultMemo: 'SatoshiStacks cash-out' }); }, { timeoutMs:90000, message:'Receiving invoice approval timed out. Your table balance has not been withdrawn.' });
        if (version !== generation || provider !== getProvider()) throw new Error('Wallet connection changed. Request a new invoice.');
        if (!result || typeof result.paymentRequest !== 'string') throw new Error('Your wallet returned no invoice');
        return result.paymentRequest;
      },
    };
  }
  // A canceled signer prompt can resolve later. Ignore it without accepting a
  // session, and put a bound on network/provider waits without guessing payments.
  function withTimeout(operation, { signal, timeoutMs = 15000, message = 'Request timed out — please try again' } = {}) {
    return new Promise((resolve, reject) => {
      let timer;
      const abort = () => finish(reject, Object.assign(new Error('Sign-in canceled'), { name: 'AbortError' }));
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      const finish = (callback, value) => { cleanup(); callback(value); };
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => finish(reject, new Error(message)), timeoutMs);
      Promise.resolve().then(() => {
        if (signal?.aborted) throw Object.assign(new Error('Sign-in canceled'), { name: 'AbortError' });
        return typeof operation === 'function' ? operation() : operation;
      }).then(value => finish(resolve, value), error => finish(reject, error));
    });
  }
  async function authenticate(signer, { requestChallenge, verify, origin, signal, now = () => Math.floor(Date.now() / 1000) }) {
    if (!signer || typeof signer.getPublicKey !== 'function' || typeof signer.signEvent !== 'function') throw new Error('No NIP-07 signer found. Unlock your browser signer or connect a phone signer.');
    const step = (operation, timeoutMs = 90000) => withTimeout(operation, { signal, timeoutMs });
    // Ask for the account first so an approval delay cannot expire the challenge.
    const pubkey = await step(() => signer.getPublicKey());
    if (!/^[0-9a-f]{64}$/.test(pubkey)) throw new Error('Your signer returned an invalid public key');
    const challenge = await step(requestChallenge, 15000);
    const event = await step(() => signer.signEvent({ kind: 22242, created_at: now(),
      tags: [['challenge', challenge.nonce], ['relay', origin]], content: '' }));
    if (event.pubkey !== pubkey) throw new Error('Your signer changed accounts. Please sign in again.');
    return step(() => verify({ challengeId: challenge.challengeId, signedEvent: event }), 15000);
  }
  async function assertIdentity(signer, expectedPubkey) {
    if (!signer || typeof signer.getPublicKey !== 'function' || await signer.getPublicKey() !== expectedPubkey) {
      throw new Error('Your signer account changed. Sign out and sign in with the intended account before using the wallet.');
    }
  }
  return { createWallet, authenticate, assertIdentity, withTimeout };
});
