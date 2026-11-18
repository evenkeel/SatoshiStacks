'use strict';
/**
 * Operator alerts — pushes wallet problems to the operator's phone.
 *
 * Two optional channels, each enabled by one env var:
 *   ALERT_NTFY_URL    — an ntfy topic URL; the message is POSTed as plain text.
 *   ALERT_NOSTR_NPUB  — an encrypted Nostr DM (NIP-04) from the server identity.
 *
 * Sending never throws and never blocks the caller: a failed alert must not
 * change what the payments code does. Every alert is also written to the log.
 * Messages must never contain secrets (preimages, macaroons, keys).
 */

const MAX_MESSAGE_CHARS = 500;

function createNtfyChannel({ url, fetchImpl = fetch, timeoutMs = 5000 }) {
  return {
    name: 'ntfy',
    async send(message) {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { Title: 'SatoshiStacks wallet alert', Priority: 'urgent', Tags: 'rotating_light' },
        body: message,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`ntfy responded ${response.status}`);
    },
  };
}

// Publishes one event and resolves with the number of relays that accepted it.
async function publishAndCount(event, relays, timeoutMs) {
  const WebSocket = require('ws');
  const results = await Promise.all(relays.map(url => new Promise(resolve => {
    let done = false;
    let ws;
    const finish = (accepted) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws.close(); } catch (_) { /* already closed */ }
      resolve(accepted);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    try {
      ws = new WebSocket(url);
      ws.on('open', () => ws.send(JSON.stringify(['EVENT', event])));
      ws.on('message', (raw) => {
        try {
          const reply = JSON.parse(raw.toString());
          if (reply[0] === 'OK' && reply[1] === event.id) finish(reply[2] === true);
        } catch (_) { /* ignore non-JSON relay chatter */ }
      });
      ws.on('error', () => finish(false));
      ws.on('close', () => finish(false));
    } catch (_) { finish(false); }
  })));
  return results.filter(Boolean).length;
}

function createNostrDmChannel({ secretKey, recipientHex, relays, publish = publishAndCount, timeoutMs = 5000 }) {
  const { finalizeEvent } = require('nostr-tools/pure');
  const nip04 = require('nostr-tools/nip04');
  return {
    name: 'nostr',
    async send(message) {
      const content = await nip04.encrypt(secretKey, recipientHex, message);
      const event = finalizeEvent({
        kind: 4,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['p', recipientHex]],
        content,
      }, secretKey);
      const accepted = await publish(event, relays, timeoutMs);
      if (accepted === 0) throw new Error('no relay accepted the message');
    },
  };
}

/**
 * @param channels     list of { name, send(message) }
 * @param repeatMs     the same message is not re-sent within this window
 * @param maxPerHour   ceiling on sent alerts per rolling hour (a stuck loop
 *                     must not bury the phone); one notice marks the cut-off
 */
function createAlerts({
  channels = [],
  now = Date.now,
  log = (...args) => console.error(...args),
  repeatMs = 30 * 60 * 1000,
  maxPerHour = 20,
} = {}) {
  const lastSent = new Map(); // message -> timestamp
  let sentTimes = [];
  let capNoticeSent = false;

  async function deliver(message) {
    const outcomes = await Promise.all(channels.map(async (channel) => {
      try { await channel.send(message); return { channel: channel.name, ok: true }; }
      catch (error) {
        log(`[Alerts] ${channel.name} delivery failed: ${error.message}`);
        return { channel: channel.name, ok: false, error: error.message };
      }
    }));
    return outcomes;
  }

  // Returns a promise of per-channel outcomes ([] when suppressed). Never rejects.
  function send(rawMessage) {
    const message = String(rawMessage).slice(0, MAX_MESSAGE_CHARS);
    log('[Wallet][ALERT]', message);
    if (channels.length === 0) return Promise.resolve([]);

    const t = now();
    for (const [key, at] of lastSent) if (t - at >= repeatMs) lastSent.delete(key);
    if (lastSent.has(message)) return Promise.resolve([]);

    sentTimes = sentTimes.filter(at => t - at < 60 * 60 * 1000);
    if (sentTimes.length >= maxPerHour) {
      if (capNoticeSent) return Promise.resolve([]);
      capNoticeSent = true;
      return deliver(`More than ${maxPerHour} alerts in the last hour. Further alerts are muted until the rate drops; check the server log.`);
    }
    capNoticeSent = false;
    lastSent.set(message, t);
    sentTimes.push(t);
    return deliver(message);
  }

  return { send, channelNames: () => channels.map(c => c.name) };
}

/**
 * Turns the wallet's ready/not-ready samples into at most one "down" alert and
 * one "recovered" alert per outage. Brief blips shorter than `graceMs` (an
 * invoice stream reconnect, one slow call) stay silent.
 */
function createReadinessWatch({ send, now = Date.now, graceMs = 2 * 60 * 1000 }) {
  let downSince = null;
  let downAlerted = false;
  return function report(ready, reason) {
    if (ready) {
      if (downAlerted) {
        const minutes = Math.max(1, Math.round((now() - downSince) / 60000));
        send(`Wallet recovered after about ${minutes} min. Deposits and withdrawals are available again.`);
      }
      downSince = null;
      downAlerted = false;
      return;
    }
    if (downSince === null) downSince = now();
    if (!downAlerted && now() - downSince >= graceMs) {
      downAlerted = true;
      send(`Wallet NOT READY for ${Math.round(graceMs / 60000)}+ min: ${reason || 'unknown reason'}. Deposits and withdrawals are unavailable.`);
    }
  };
}

// Builds the channel list from config. Invalid settings are reported, not fatal.
function channelsFromConfig(config, log = (...args) => console.error(...args)) {
  const channels = [];
  if (config.ALERT_NTFY_URL) {
    try {
      const url = new URL(config.ALERT_NTFY_URL);
      if (url.protocol !== 'https:') throw new Error('must be an https URL');
      channels.push(createNtfyChannel({ url: url.toString() }));
    } catch (error) { log(`[Alerts] ALERT_NTFY_URL ignored: ${error.message}`); }
  }
  if (config.ALERT_NOSTR_NPUB) {
    try {
      const { decode } = require('nostr-tools/nip19');
      if (!config.NOSTR_SERVER_NSEC) throw new Error('NOSTR_SERVER_NSEC is required to send Nostr alerts');
      const recipient = decode(config.ALERT_NOSTR_NPUB);
      if (recipient.type !== 'npub') throw new Error('must be an npub');
      const sender = decode(config.NOSTR_SERVER_NSEC);
      if (sender.type !== 'nsec') throw new Error('NOSTR_SERVER_NSEC is not an nsec');
      channels.push(createNostrDmChannel({ secretKey: sender.data, recipientHex: recipient.data, relays: config.RELAYS }));
    } catch (error) { log(`[Alerts] ALERT_NOSTR_NPUB ignored: ${error.message}`); }
  }
  return channels;
}

module.exports = { createAlerts, createReadinessWatch, createNtfyChannel, createNostrDmChannel, channelsFromConfig };
