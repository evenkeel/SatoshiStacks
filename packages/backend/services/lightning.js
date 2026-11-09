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
const crypto = require('crypto');

function createLightning(lightningConfig, { lnService } = {}) {
  let ln = lnService || null;   // the ln-service module
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

  function bounded(operation, timeoutMs = lightningConfig.readTimeoutMs || 10000) {
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('LND request timed out')), timeoutMs); });
    return Promise.race([Promise.resolve().then(operation), timeout]).finally(() => clearTimeout(timer));
  }

  async function connect() {
    const { authenticatedLndGrpc } = lib();
    if (!lnd) {
    const cert = fs.readFileSync(lightningConfig.tlsCertPath).toString('base64');
    const macaroon = fs.readFileSync(lightningConfig.macaroonPath).toString('base64');
    const socket = `${lightningConfig.host}:${lightningConfig.port}`;
    ({ lnd } = authenticatedLndGrpc({ cert, macaroon, socket }));
    }
    // Health check + verify pubkey matches config (self-pay guard relies on it).
    const info = await bounded(() => lib().getWalletInfo({ lnd }));
    if (lightningConfig.ownPubkey && info.public_key !== lightningConfig.ownPubkey) {
      throw new Error(`LND pubkey ${info.public_key} != configured LND_OWN_PUBKEY ${lightningConfig.ownPubkey}`);
    }
    if (info.is_synced_to_chain === false) throw new Error('LND is still synchronizing with the Bitcoin chain');
    console.log(`[Lightning] Connected to LND ${info.public_key.slice(0, 12)}... on ${lightningConfig.network}`);
    return info.public_key;
  }

  async function createInvoice({ amountSats, memo, expirySec, secret = crypto.randomBytes(32).toString('hex'), expiresAt }) {
    if (!/^[0-9a-f]{64}$/.test(secret)) throw new Error('Invalid deposit invoice secret');
    const paymentHash = crypto.createHash('sha256').update(Buffer.from(secret,'hex')).digest('hex');
    let inv;
    try {
      inv = await bounded(() => lib().createInvoice({lnd, tokens:amountSats, description:memo, secret,
        expires_at:new Date((expiresAt || Math.floor(Date.now()/1000)+(expirySec || 600))*1000).toISOString(),
        is_including_private_channels:true}));
    } catch (error) {
      // A timeout or duplicate-hash response may mean the original succeeded.
      // Recover by hash; never substitute a new secret or invoice here.
      try { inv = await bounded(() => lib().getInvoice({lnd,id:paymentHash})); }
      catch (_) { throw Object.assign(new Error('Invoice creation is still being checked. Retry to recover the same invoice.'),{code:'INVOICE_UNCERTAIN',cause:error}); }
    }
    if (inv.id !== paymentHash || inv.tokens !== amountSats || !inv.request) throw new Error('LND returned an unexpected deposit invoice');
    return { bolt11: inv.request, paymentHash, expiresAt:inv.expires_at ? Math.floor(Date.parse(inv.expires_at)/1000) : expiresAt };
  }

  async function decodeInvoice(bolt11) {
    const { decodePaymentRequest } = lib();
    const d = await bounded(() => decodePaymentRequest({ lnd, request: bolt11 }));
    return {
      amountSats: d.tokens,
      amountMsats: d.mtokens,
      paymentHash: d.id,
      destination: d.destination,
      expiresAt: d.expires_at,
    };
  }

  // Returns SUCCEEDED/FAILED, or THROWS to signal an unknown fate (-> in_flight).
  async function sendPayment({ bolt11, paymentHash, feeLimitSats, timeoutSec = 60 }) {
    const { payViaPaymentRequest, getPayment } = lib();
    try {
      const p = await bounded(() => payViaPaymentRequest({ lnd, request: bolt11, max_fee: feeLimitSats,
        max_paths:lightningConfig.maxPaymentPaths ?? 8,pathfinding_timeout: timeoutSec * 1000 }), (timeoutSec + 15) * 1000);
      return { status: 'SUCCEEDED', preimage: p.secret, feeSats: p.safe_fee ?? Math.ceil(p.fee || 0) };
    } catch (err) {
      // Do NOT trust the thrown error to mean "failed". Ask LND for the truth.
      let st;
      try { st = await bounded(() => getPayment({ lnd, id: paymentHash })); }
      catch (e2) { throw err; } // can't determine -> unknown -> leave in_flight
      if (st.is_confirmed) return { status: 'SUCCEEDED', preimage: st.payment && st.payment.secret, feeSats: st.payment && st.payment.fee };
      if (st.is_failed) return { status: 'FAILED' };
      throw err; // is_pending / unknown -> leave in_flight
    }
  }

  async function trackPayment(paymentHash) {
    const { getPayment } = lib();
    let st;
    try { st = await bounded(() => getPayment({ lnd, id: paymentHash })); }
    catch (error) {
      // Only this explicit LND response means a send was never initiated.
      // Transport errors remain unknown and can never release the liability.
      if (Array.isArray(error) && error[0] === 404 && error[1] === 'SentPaymentNotFound') return { status: 'NOT_FOUND' };
      throw error;
    }
    if (st.is_confirmed) return { status: 'SUCCEEDED', feeSats: st.payment && st.payment.fee };
    if (st.is_failed) return { status: 'FAILED' };
    return { status: 'PENDING' };
  }

  async function getSpendableSats() {
    const { getChannelBalance } = lib();
    const b = await bounded(() => getChannelBalance({ lnd }));
    return b.channel_balance;
  }

  // onSettled({ paymentHash, amountSats }) fires once per confirmed invoice.
  function subscribeInvoices(onSettled) {
    const { subscribeToInvoices } = lib();
    const sub = subscribeToInvoices({ lnd });
    sub.on('invoice_updated', (inv) => {
      if (inv.is_confirmed) {
        try { onSettled({ paymentHash: inv.id, amountSats: inv.received }); }
        catch (error) { sub.emit('error',new Error('Could not record confirmed deposit; reconciliation is required',{cause:error})); }
      }
    });
    return sub;
  }

  async function getOwnPubkey() {
    const info = await bounded(() => lib().getWalletInfo({ lnd }));
    return info.public_key;
  }

  async function lookupInvoice(paymentHash) {
    const invoice = await bounded(() => lib().getInvoice({ lnd, id: paymentHash }));
    return { confirmed: invoice.is_confirmed, canceled: invoice.is_canceled, held: invoice.is_held, amountSats: invoice.received,
      bolt11:invoice.request,invoiceAmountSats:invoice.tokens,expiresAt:invoice.expires_at ? Math.floor(Date.parse(invoice.expires_at)/1000) : null };
  }

  async function getDiagnostics() {
    const [info,balance,{channels}] = await Promise.all([
      bounded(()=>lib().getWalletInfo({lnd})),bounded(()=>lib().getChannelBalance({lnd})),bounded(()=>lib().getChannels({lnd}))
    ]);
    const active = channels.filter(channel=>channel.is_active && !channel.is_closing && !channel.is_opening);
    return {pubkey:info.public_key,chains:info.chains,syncedToChain:info.is_synced_to_chain,syncedToGraph:info.is_synced_to_graph,
      peers:info.peers_count,activeChannels:active.length,totalChannels:channels.length,
      channelBalanceSats:balance.channel_balance,
      estimatedActiveOutboundSats:active.reduce((sum,c)=>sum+Math.max(0,c.local_balance-(c.local_reserve || 0)),0),
      estimatedActiveInboundSats:active.reduce((sum,c)=>sum+Math.max(0,c.remote_balance-(c.remote_reserve || 0)),0)};
  }

  return {
    connect, createInvoice, decodeInvoice, sendPayment, trackPayment,
    getSpendableSats, subscribeInvoices, getOwnPubkey, lookupInvoice, getDiagnostics,
  };
}

module.exports = { createLightning };
