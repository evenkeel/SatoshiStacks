/**
 * Standalone LND connectivity check. Run with the SAME env you'll give the server:
 *
 *   cd packages/backend
 *   REALMONEY_ENABLED=true LIGHTNING_NETWORK=regtest \
 *   LND_HOST=127.0.0.1 LND_PORT=10009 \
 *   LND_MACAROON_PATH=/path/to/poker.macaroon LND_TLS_CERT_PATH=/path/to/tls.cert \
 *   LND_OWN_PUBKEY=<identity_pubkey> HOT_WALLET_CAP_SATS=1000000 MAX_WITHDRAWAL_SATS=100000 \
 *   ADMIN_TOKEN=anything node check-lnd.js
 *
 * Verifies the poker backend can authenticate to LND and read node info + balance,
 * without starting the web server. Use it to debug the connection (and, on
 * mainnet, the Tailscale/SSH tunnel) before exercising the full payment loop.
 */
const config = require('./config');
const { createLightning } = require('./services/lightning');

(async () => {
  if (!config.REALMONEY_ENABLED) {
    console.error('Set REALMONEY_ENABLED=true (plus the LND_* env) to run this check.');
    process.exit(1);
  }
  const ln = createLightning(config.LIGHTNING);
  try {
    const pubkey = await ln.connect();
    const spendable = await ln.getSpendableSats();
    console.log('✅ Connected to LND');
    console.log('   network:           ', config.LIGHTNING.network);
    console.log('   node pubkey:        ' + pubkey);
    console.log('   channel spendable:  ' + spendable + ' sats');
    if (config.LIGHTNING.ownPubkey && config.LIGHTNING.ownPubkey !== pubkey) {
      console.warn('⚠️  LND_OWN_PUBKEY (' + config.LIGHTNING.ownPubkey + ') does not match the node pubkey above.');
      console.warn('    Fix it — the self-pay-loop guard compares against it.');
    } else if (!config.LIGHTNING.ownPubkey) {
      console.warn('⚠️  LND_OWN_PUBKEY is not set. Set it to: ' + pubkey);
    }
    process.exit(0);
  } catch (e) {
    console.error('❌ Could not connect to LND:', e.message);
    console.error('   Check LND_HOST/PORT reachability, the macaroon + TLS cert paths,');
    console.error('   and that the macaroon has info:read / invoices / offchain permissions.');
    process.exit(1);
  }
})();
