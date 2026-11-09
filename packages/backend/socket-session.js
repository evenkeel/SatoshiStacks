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

module.exports = { authenticatedSocketId };
