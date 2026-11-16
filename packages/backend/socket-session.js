'use strict';
const db = require('./database');

// A room mapping alone is not authorization: sessions can expire, be revoked,
// or be replaced by a later login while the WebSocket remains connected.
function authenticatedSocketId(io, userSockets, userId) {
  const socketId = userSockets.get(userId);
  const socket = io.sockets.sockets.get(socketId);
  if (!socket) return null;
  if (db.getPlayerBySession(socket.data?.sessionToken)?.pubkey_hex === userId) return socketId;
  socket.emit('auth-error', { message: 'Session expired or signed out. Sign in again to resume.' });
  socket.disconnect(true);
  return null;
}

// The address rate limits and IP bans should apply to. Behind the bundled
// Nginx proxy every socket's peer address is the loopback interface, which
// would put all players in one shared bucket. When (and only when) the direct
// peer is loopback, use the address the proxy appended to X-Forwarded-For: the
// right-most entry, which a client cannot forge. This mirrors Express's
// `trust proxy = 1` used for the HTTP routes.
const net = require('node:net');
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
function clientAddress(socket) {
  const peer = socket?.handshake?.address || '';
  if (!LOOPBACK.has(peer)) return peer;
  const header = socket.handshake.headers?.['x-forwarded-for'];
  const forwarded = (Array.isArray(header) ? header.join(',') : String(header || '')).split(',').map(part => part.trim()).filter(Boolean).pop();
  return forwarded && net.isIP(forwarded) ? forwarded : peer;
}

module.exports = { authenticatedSocketId, clientAddress };
