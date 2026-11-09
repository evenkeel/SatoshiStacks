'use strict';
process.env.SATOSHISTACKS_DB_PATH = ':memory:';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const db = require('./database');
const { authenticatedSocketId } = require('./socket-session');

test('private socket delivery stops on logout, session rotation, expiry, or account mismatch', () => {
  const user = 'c'.repeat(64), other = 'd'.repeat(64);
  for (const id of [user, other]) db.upsertNostrPlayer(id, 'npub-test', 'Player', null);
  let disconnected = 0;
  const socket = { data: { sessionToken: 'original' }, emit(event) { assert.equal(event, 'auth-error'); },
    disconnect() { disconnected++; } };
  const io = { sockets: { sockets: new Map([['socket', socket]]) } };
  const users = new Map([[user, 'socket']]);
  const expires = Math.floor(Date.now() / 1000) + 60;
  db.setSessionToken(user, 'original', expires);
  assert.equal(authenticatedSocketId(io, users, user), 'socket');
  db.revokeSession('original');
  assert.equal(authenticatedSocketId(io, users, user), null);
  db.setSessionToken(user, 'replacement', expires);
  assert.equal(authenticatedSocketId(io, users, user), null);
  socket.data.sessionToken = 'replacement';
  assert.equal(authenticatedSocketId(io, users, user), 'socket');
  db.setSessionToken(user, 'replacement', expires - 120);
  assert.equal(authenticatedSocketId(io, users, user), null);
  db.setSessionToken(other, 'other-account', expires);
  socket.data.sessionToken = 'other-account';
  assert.equal(authenticatedSocketId(io, users, user), null);
  assert.equal(disconnected, 4);
  assert.equal(authenticatedSocketId(io, users, 'missing'), null);
  for (const token of [{}, [], 5, 'a'.repeat(257)]) assert.equal(db.getPlayerBySession(token), null);
});
