'use strict';
// Sign-in content limits and per-player request limits (November 15 review).
process.env.SATOSHISTACKS_DB_PATH = process.env.SATOSHISTACKS_DB_PATH || ':memory:';
process.env.ADMIN_TOKEN ||= 'test-admin-token';
process.env.REALMONEY_ENABLED = 'false';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { generateSecretKey, finalizeEvent } = require('nostr-tools/pure');
const db = require('./database');
const config = require('./config');
const auth = require('./routes/auth');
config.AUTH_RATE_LIMIT.maxRequests = 100;
console.log = () => {};
let server, origin;
before(async () => {
  const app = express(); app.use(express.json({ limit: '32kb' })); app.use('/auth', auth);
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise(resolve => server.close(resolve)));
async function post(path, body) {
  const response = await fetch(`${origin}/auth/${path}`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
async function login(content, key = generateSecretKey()) {
  const challenge = (await post('challenge', {})).body;
  const signedEvent = finalizeEvent({ kind: 22242, created_at: Math.floor(Date.now() / 1000), content, tags: [['challenge', challenge.nonce], ['relay', origin]] }, key);
  return post('verify', { challengeId: challenge.challengeId, signedEvent });
}

test('sign-in content cannot set a name or picture outside the saved-profile limits', async () => {
  const oversized = await login(JSON.stringify({ name: 'A'.repeat(12000), picture: 'javascript:alert(1)' }));
  assert.equal(oversized.status, 200);
  const row = db.getPlayer(oversized.body.pubkeyHex);
  assert.equal(row.nostr_name, null, 'an oversized name is ignored, not stored');
  assert.equal(row.nostr_picture, null, 'a non-HTTPS picture is ignored');
  assert.ok(row.username.length <= 64);
  for (const picture of ['http://example.com/a.png', 'https://user:pass@example.com/a.png', 'data:image/png;base64,AAAA', 'x'.repeat(3000)]) {
    const result = await login(JSON.stringify({ name: 'Mira', picture }));
    assert.equal(db.getPlayer(result.body.pubkeyHex).nostr_picture, null, picture.slice(0, 30));
  }
});
test('ordinary sign-in content is kept and malformed content never fails the sign-in', async () => {
  const good = await login(JSON.stringify({ name: 'Mira', picture: 'https://example.com/mira.png' }));
  assert.equal(good.status, 200);
  const row = db.getPlayer(good.body.pubkeyHex);
  assert.equal(row.nostr_name, 'Mira'); assert.equal(row.nostr_picture, 'https://example.com/mira.png');
  for (const content of [JSON.stringify({ name: { a: 1 } }), JSON.stringify({ name: 42, picture: [] }), JSON.stringify(null), JSON.stringify('text'), 'not json', '']) {
    const result = await login(content);
    assert.equal(result.status, 200, content);
    assert.equal(db.getPlayer(result.body.pubkeyHex).nostr_name, null);
  }
  const control = await login(JSON.stringify({ name: 'Line\u0000\nBreak' }));
  assert.equal(db.getPlayer(control.body.pubkeyHex).nostr_name, 'LineBreak');
});

test('a per-player limit never counts another player at the same address', () => {
  db.db.exec('DELETE FROM abuse_log');
  for (let i = 0; i < 10; i++) db.logAction('spammer', '127.0.0.1', 'action-check');
  assert.equal(db.isRateLimited('spammer', null, 10, 10), true);
  assert.equal(db.isRateLimited('bystander', null, 10, 10), false, 'same address, different player');
  assert.equal(db.isRateLimited('bystander', '127.0.0.1', 10, 10), true, 'address-scoped limits still work where requested');
});
test('a typed limit counts only that kind of request', () => {
  db.db.exec('DELETE FROM abuse_log');
  for (let i = 0; i < 8; i++) db.logAction('player', '203.0.113.7', 'action-call');
  for (let i = 0; i < 4; i++) db.logAction('player', '203.0.113.7', 'cashout-request');
  const { windowSec, maxActions } = config.WITHDRAWAL_RATE_LIMIT;
  assert.equal(db.isRateLimited('player', null, windowSec, maxActions, 'cashout-request'), false, 'gameplay does not consume the withdrawal allowance');
  db.logAction('player', '203.0.113.7', 'cashout-request');
  assert.equal(db.isRateLimited('player', null, windowSec, maxActions, 'cashout-request'), true);
  assert.equal(db.isRateLimited('someone-else', null, windowSec, maxActions, 'cashout-request'), false);
});

test('gameplay by others at the same address does not use up a player\'s allowance to sit down', () => {
  db.db.exec('DELETE FROM abuse_log');
  const { windowSec, maxActions } = config.JOIN_RATE_LIMIT;
  for (let i = 0; i < 30; i++) db.logAction(`tablemate-${i % 5}`, '203.0.113.7', 'action-call');
  assert.equal(db.isRateLimited('newcomer', '203.0.113.7', windowSec, maxActions, 'join-table'), false);
  // The join limit itself still applies, by player and by address.
  for (let i = 0; i < maxActions; i++) db.logAction('newcomer', '203.0.113.7', 'join-table');
  assert.equal(db.isRateLimited('newcomer', '198.51.100.1', windowSec, maxActions, 'join-table'), true);
  assert.equal(db.isRateLimited('other', '203.0.113.7', windowSec, maxActions, 'join-table'), true);
  assert.equal(db.isRateLimited('other', '198.51.100.1', windowSec, maxActions, 'join-table'), false);
});
