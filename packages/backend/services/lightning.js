/**
 * Lightning client — a thin adapter over `ln-service` (alexbosworth) that exposes
 * exactly the interface the payments service expects:
 *
 *   createInvoice({ amountSats, memo, expirySec }) -> { bolt11, paymentHash }
 *   decodeInvoice(bolt11)                          -> { amountSats, paymentHash, destination, expiresAt }
 *   sendPayment({ bolt11, paymentHash, feeLimitSats }) -> { status:'SUCCEEDED'|'FAILED', preimage?, feeSats? }  (throws => UNKNOWN/in_flight)
 *   trackPayment(paymentHash)                      -> { status:'SUCCEEDED'|'FAILED'|'PENDING', feeSats? }
 *   getSpendableSats()                             -> number (channel local balance)
 *   subscribeInvoices(onSettled)                   -> subscription (emits settled deposits)
 *   getOwnPubkey()                                 -> hex pubkey
 *
 * Why ln-service rather than the prototype's raw @grpc/proto-loader approach:
 *   - It BUNDLES the LND protos (no LND_PROTO_PATH to supply, and the prototype was
 *     missing router.proto entirely, so its SendPaymentV2/TrackPaymentV2 path could
 *     not work — it used the deprecated sendPaymentSync).
 *   - payViaPaymentRequest + getPayment give clean, idempotent (dedup-by-hash)
 *     payment + authoritative status tracking, which is exactly what the safe
 *     withdrawal state machine needs.
 *   - Battle-tested in production LN tooling (BOS, ThunderHub, etc.).
 *
 * SAFETY: sendPayment never *guesses* a payment's fate. payViaPaymentRequest
 * resolving == confirmed. If it rejects, we ask LND via getPayment for the
 * authoritative status; only an is_failed result returns FAILED (which is what
 * allows a refund). Anything ambiguous throws -> the payments service leaves the
 * withdrawal in_flight (never auto-refunds). This is the anti-double-pay rule.
 *
 * Lazy-loads ln-service so the play-money server boots fine without it installed.
 */
const fs = require('fs');

function createLightning(lightningConfig) {
  let ln = null;   // the ln-service module
  let lnd = null;  // the authenticated connection

  function lib() {
    if (ln) return ln;
    try {
      ln = require('ln-service');
    } catch (e) {
      throw new Error('ln-service is not installed. Run `npm install ln-service` to enable real-money Lightning.');
    }
    return ln;
  }

  async function connect() {
    const { authenticatedLndGrpc } = lib();
    const cert = fs.readFileSync(lightningConfig.tlsCertPath).toString('base64');
    const macaroon = fs.readFileSync(lightningConfig.macaroonPath).toString('base64');
    const socket = `${lightningConfig.host}:${lightningConfig.port}`;
    ({ lnd } = authenticatedLndGrpc({ cert, macaroon, socket }));
    // Health check + verify pubkey matches config (self-pay guard relies on it).
    const info = await lib().getWalletInfo({ lnd });
    if (lightningConfig.ownPubkey && info.public_key !== lightningConfig.ownPubkey) {
      throw new Error(`LND pubkey ${info.public_key} != configured LND_OWN_PUBKEY ${lightningConfig.ownPubkey}`);
    }
    console.log(`[Lightning] Connected to LND ${info.public_key.slice(0, 12)}... on ${lightningConfig.network}`);
    return info.public_key;
  }

  async function createInvoice({ amountSats, memo, expirySec }) {
    const { createInvoice } = lib();
    const inv = await createInvoice({
      lnd,
      tokens: amountSats,
      description: memo,
      expires_at: new Date(Date.now() + (expirySec || 600) * 1000).toISOString(),
    });
    return { bolt11: inv.request, paymentHash: inv.id };
  }

  async function decodeInvoice(bolt11) {
    const { decodePaymentRequest } = lib();
    const d = await decodePaymentRequest({ lnd, request: bolt11 });
    return {
      amountSats: d.tokens,
      paymentHash: d.id,
      destination: d.destination,
      expiresAt: d.expires_at,
    };
  }

  // Returns SUCCEEDED/FAILED, or THROWS to signal an unknown fate (-> in_flight).
  async function sendPayment({ bolt11, paymentHash, feeLimitSats }) {
    const { payViaPaymentRequest, getPayment } = lib();
    try {
      const p = await payViaPaymentRequest({ lnd, request: bolt11, max_fee: feeLimitSats });
      return { status: 'SUCCEEDED', preimage: p.secret, feeSats: p.fee };
    } catch (err) {
      // Do NOT trust the thrown error to mean "failed". Ask LND for the truth.
      let st;
      try { st = await getPayment({ lnd, id: paymentHash }); }
      catch (e2) { throw err; } // can't determine -> unknown -> leave in_flight
      if (st.is_confirmed) return { status: 'SUCCEEDED', preimage: st.payment && st.payment.secret, feeSats: st.payment && st.payment.fee };
      if (st.is_failed) return { status: 'FAILED' };
      throw err; // is_pending / unknown -> leave in_flight
    }
  }

  async function trackPayment(paymentHash) {
    const { getPayment } = lib();
    const st = await getPayment({ lnd, id: paymentHash });
    if (st.is_confirmed) return { status: 'SUCCEEDED', feeSats: st.payment && st.payment.fee };
    if (st.is_failed) return { status: 'FAILED' };
    return { status: 'PENDING' };
  }

  async function getSpendableSats() {
    const { getChannelBalance } = lib();
    const b = await getChannelBalance({ lnd });
    return b.channel_balance;
  }

  // onSettled({ paymentHash, amountSats }) fires once per confirmed invoice.
  function subscribeInvoices(onSettled) {
    const { subscribeToInvoices } = lib();
    const sub = subscribeToInvoices({ lnd });
    sub.on('invoice_updated', (inv) => {
      if (inv.is_confirmed) onSettled({ paymentHash: inv.id, amountSats: inv.received });
    });
    return sub;
  }

  async function getOwnPubkey() {
    const info = await lib().getWalletInfo({ lnd });
    return info.public_key;
  }

  return {
    connect, createInvoice, decodeInvoice, sendPayment, trackPayment,
    getSpendableSats, subscribeInvoices, getOwnPubkey,
  };
}

module.exports = { createLightning };
