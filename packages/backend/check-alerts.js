/**
 * Sends one test alert through every configured channel and reports the result.
 * Run with the server's environment:  npm run alert:test
 */
const config = require('./config');
const { createAlerts, channelsFromConfig } = require('./services/alerts');

(async () => {
  const channels = channelsFromConfig(config);
  if (channels.length === 0) {
    console.error('No alert channel configured. Set ALERT_NTFY_URL or ALERT_NOSTR_NPUB in .env.');
    process.exit(1);
  }
  const alerts = createAlerts({ channels, log: () => {} });
  const outcomes = await alerts.send(`Test alert from SatoshiStacks at ${new Date().toISOString()}. If you can read this, wallet alerts work.`);
  for (const o of outcomes) console.log(`${o.channel}: ${o.ok ? 'sent' : `FAILED (${o.error})`}`);
  process.exit(outcomes.every(o => o.ok) ? 0 : 1);
})();
