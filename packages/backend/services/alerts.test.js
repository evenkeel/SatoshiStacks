'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateSecretKey, getPublicKey, verifyEvent } = require('nostr-tools/pure');
const { npubEncode, nsecEncode } = require('nostr-tools/nip19');
const nip04 = require('nostr-tools/nip04');
const { createAlerts, createReadinessWatch, createNtfyChannel, createNostrDmChannel, channelsFromConfig } = require('./alerts');

function recorder(name = 'rec') {
  const sent = [];
  return { name, sent, send: async (m) => { sent.push(m); } };
}
const quiet = () => {};

test('an alert reaches every channel and one failing channel does not stop the others', async () => {
  const good = recorder('good');
  const bad = { name: 'bad', send: async () => { throw new Error('offline'); } };
  const alerts = createAlerts({ channels: [bad, good], log: quiet });
  const outcomes = await alerts.send('CIRCUIT BREAKER TRIPPED: test');
  assert.deepEqual(good.sent, ['CIRCUIT BREAKER TRIPPED: test']);
  assert.deepEqual(outcomes, [{ channel: 'bad', ok: false, error: 'offline' }, { channel: 'good', ok: true }]);
});

test('sending never throws, even with no channels, and always logs', async () => {
  const lines = [];
  const alerts = createAlerts({ channels: [], log: (...a) => lines.push(a.join(' ')) });
  assert.deepEqual(await alerts.send('something broke'), []);
  assert.match(lines[0], /something broke/);
});

test('a repeating message is sent once per window, then again after it', async () => {
  let t = 0;
  const ch = recorder();
  const alerts = createAlerts({ channels: [ch], now: () => t, log: quiet, repeatMs: 1000 });
  await alerts.send('Reconcile could not resolve in-flight abc');
  t = 500; await alerts.send('Reconcile could not resolve in-flight abc');
  await alerts.send('a different problem');
  assert.equal(ch.sent.length, 2);
  t = 1500; await alerts.send('Reconcile could not resolve in-flight abc');
  assert.equal(ch.sent.length, 3);
});

test('an alert storm is capped per hour with a single mute notice, then resumes', async () => {
  let t = 0;
  const ch = recorder();
  const alerts = createAlerts({ channels: [ch], now: () => t, log: quiet, maxPerHour: 3 });
  for (let i = 0; i < 10; i++) await alerts.send(`problem ${i}`);
  assert.equal(ch.sent.length, 4);
  assert.match(ch.sent[3], /muted/);
  t = 61 * 60 * 1000;
  await alerts.send('problem after the storm');
  assert.equal(ch.sent.at(-1), 'problem after the storm');
});

test('long messages are truncated', async () => {
  const ch = recorder();
  await createAlerts({ channels: [ch], log: quiet }).send('x'.repeat(5000));
  assert.equal(ch.sent[0].length, 500);
});

test('readiness watch stays silent for a blip and alerts once for a real outage and its recovery', () => {
  let t = 0;
  const sent = [];
  const report = createReadinessWatch({ send: (m) => sent.push(m), now: () => t, graceMs: 120000 });
  report(true);
  report(false, 'stream reset'); t = 15000; report(true);
  assert.deepEqual(sent, []);

  t = 100000; report(false, 'LND unreachable');
  t = 160000; report(false, 'LND unreachable');
  assert.deepEqual(sent, []);
  t = 230000; report(false, 'LND unreachable');
  t = 245000; report(false, 'LND unreachable');
  assert.equal(sent.length, 1);
  assert.match(sent[0], /NOT READY.*LND unreachable/);

  t = 100000 + 10 * 60000; report(true);
  assert.equal(sent.length, 2);
  assert.match(sent[1], /recovered after about 10 min/);
  report(true);
  assert.equal(sent.length, 2);
});

test('ntfy channel posts the message as text and treats a non-2xx reply as failure', async () => {
  const calls = [];
  const ok = createNtfyChannel({ url: 'https://ntfy.example/topic', fetchImpl: async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200 }; } });
  await ok.send('hello');
  assert.equal(calls[0].url, 'https://ntfy.example/topic');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.body, 'hello');
  const failing = createNtfyChannel({ url: 'https://ntfy.example/topic', fetchImpl: async () => ({ ok: false, status: 403 }) });
  await assert.rejects(failing.send('hello'), /403/);
});

test('nostr channel sends a signed DM only the recipient can read', async () => {
  const serverSk = generateSecretKey();
  const operatorSk = generateSecretKey();
  const published = [];
  const channel = createNostrDmChannel({
    secretKey: serverSk, recipientHex: getPublicKey(operatorSk), relays: ['wss://relay.example'],
    publish: async (event, relays) => { published.push({ event, relays }); return 1; },
  });
  await channel.send('Solvency violation');
  const { event } = published[0];
  assert.equal(event.kind, 4);
  assert.ok(verifyEvent(event));
  assert.deepEqual(event.tags, [['p', getPublicKey(operatorSk)]]);
  assert.ok(!event.content.includes('Solvency'));
  assert.equal(await nip04.decrypt(operatorSk, getPublicKey(serverSk), event.content), 'Solvency violation');

  const unaccepted = createNostrDmChannel({ secretKey: serverSk, recipientHex: getPublicKey(operatorSk), relays: [], publish: async () => 0 });
  await assert.rejects(unaccepted.send('x'), /no relay accepted/);
});

test('channels come from config; bad settings are ignored with a log line, not a crash', () => {
  const nsec = nsecEncode(generateSecretKey());
  const npub = npubEncode(getPublicKey(generateSecretKey()));
  const RELAYS = ['wss://relay.example'];
  const names = (cfg, log = quiet) => channelsFromConfig({ RELAYS, ...cfg }, log).map(c => c.name);

  assert.deepEqual(names({}), []);
  assert.deepEqual(names({ ALERT_NTFY_URL: 'https://ntfy.sh/some-long-topic', ALERT_NOSTR_NPUB: npub, NOSTR_SERVER_NSEC: nsec }), ['ntfy', 'nostr']);

  const lines = [];
  const log = (m) => lines.push(m);
  assert.deepEqual(names({ ALERT_NTFY_URL: 'http://ntfy.sh/topic' }, log), []);
  assert.deepEqual(names({ ALERT_NOSTR_NPUB: npub }, log), []);
  assert.deepEqual(names({ ALERT_NOSTR_NPUB: 'not-an-npub', NOSTR_SERVER_NSEC: nsec }, log), []);
  assert.equal(lines.length, 3);
});
