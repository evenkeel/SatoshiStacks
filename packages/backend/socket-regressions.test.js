'use strict';
// Socket-level regressions from the November 15 review, against the real
// socket-handlers.js and a loopback Socket.IO server in demo or mocked real-money mode.
process.env.SATOSHISTACKS_DB_PATH = process.env.SATOSHISTACKS_DB_PATH || ':memory:';
process.env.ADMIN_TOKEN ||= 'test-admin-token';
process.env.REALMONEY_ENABLED = 'false';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
console.log = () => {};
const { Server } = require('socket.io');
const { io: connect } = require('socket.io-client');
const db = require('./database');
const config = require('./config');
const { setup } = require('./socket-handlers');
const { authenticatedSocketId, clientAddress, networkKey } = require('./socket-session');
const nostr = require('./services/nostr');
nostr.scheduleLiveActivityUpdate = () => {}; nostr.checkAndAwardBadges = () => {}; nostr.publishHandHistory = async () => {};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const T = 'station100';

async function rig({ realMoney = false, host = '127.0.0.1' } = {}) {
  config.isRealMoney = () => realMoney;
  db.db.exec('DELETE FROM abuse_log; DELETE FROM hand_snapshots;');
  const server = http.createServer(); const io = new Server(server);
  const games = new Map(), userSockets = new Map(), socketUsers = new Map(), observerSockets = new Map(), waitlists = new Map();
  // Faithful copy of server.js broadcastGameState (minus badges/waitlist decoration)
  function broadcastGameState(tableId) {
    const game = games.get(tableId); if (!game) return;
    game.players.forEach(p => { if (!p) return; const sid = authenticatedSocketId(io, userSockets, p.userId); if (sid) io.to(sid).emit('game-state', game.getGameState(p.userId)); });
    const base = game.getGameState(null);
    for (const [sid, obs] of observerSockets) if (obs.tableId === tableId) io.to(sid).emit('game-state', base);
  }
  setup(io, games, userSockets, socketUsers, observerSockets, broadcastGameState, waitlists, () => null, () => null);
  const addresses = new Map(); io.on('connection', s => addresses.set(s.id, s.handshake.address));
  await new Promise(r => server.listen(0, host, r));
  const port = server.address().port; const clients = [];
  let n = 0;
  function user(name) { const id = (n++).toString(16).padStart(2, '0').repeat(32); db.upsertNostrPlayer(id, 'npub-' + name, name, null); db.setSessionToken(id, 'tok-' + name + '-' + id.slice(0, 4), Math.floor(Date.now() / 1000) + 3600); return { id, name, token: 'tok-' + name + '-' + id.slice(0, 4) }; }
  async function client(origin = `http://127.0.0.1:${port}`, opts = {}) { const s = connect(origin, { transports: ['websocket'], forceNew: true, reconnection: false, ...opts }); clients.push(s); s.errors = []; s.states = 0; s.on('error', e => s.errors.push(e.message)); s.on('game-state', () => s.states++); await new Promise((res, rej) => { s.once('connect', res); s.once('connect_error', rej); }); return s; }
  const once = (s, ev, ms = 2000) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timeout waiting for ' + ev)), ms); s.once(ev, v => { clearTimeout(t); res(v); }); });
  async function close() { for (const c of clients) c.disconnect(); for (const g of games.values()) { g.clearActionTimer(); g.clearRunoutTimeouts(); clearTimeout(g.handStartTimeout); for (const t of g.sitOutKickTimers.values()) clearTimeout(t);
      // A disconnect-grace timer may still fire after teardown; it must not arm a five-minute clock.
      g.startSitOutKickTimer = () => {}; }
    io.close(); await new Promise(r => server.close(r)); }
  return { io, games, userSockets, socketUsers, observerSockets, broadcastGameState, user, client, once, close, port, addresses };
}
async function seat(r, s, u, buyIn = 10000) { const p = r.once(s, 'seat-assigned'); s.emit('join-table', { tableId: T, sessionToken: u.token, buyIn }); return p; }
function startHand(g) { clearTimeout(g.handStartTimeout); g.handStartTimeout = null; g.startNewHand(); assert.equal(g.handInProgress, true); }

test('an opponent sharing the proxy address cannot exhaust the acting player\'s action allowance', async () => {
  const r = await rig(); try {
    const a = r.user('alice'), b = r.user('bob');
    const sa = await r.client(undefined, { extraHeaders: { 'X-Forwarded-For': '203.0.113.7' } }), sb = await r.client(undefined, { extraHeaders: { 'X-Forwarded-For': '198.51.100.9' } });
    await seat(r, sa, a); await seat(r, sb, b);
    db.db.exec('DELETE FROM abuse_log');            // forget the two join-table rows; start from a clean window
    const g = r.games.get(T); startHand(g);
    const actor = g.players[g.currentPlayerIndex].userId;
    const [sActor, sOther] = actor === a.id ? [sa, sb] : [sb, sa];
    for (let i = 0; i < 10; i++) sOther.emit('action', { tableId: T, action: 'check', amount: 0 });   // out of turn -> rejected, but logged
    await sleep(300);
    const before = g.currentPlayerIndex;
    sActor.emit('action', { tableId: T, action: 'call', amount: 0, handCount: g.handCount });
    await sleep(300);
    assert.deepEqual(sActor.errors, [], 'the legal action of the player to act must be accepted');
  } finally { await r.close(); }
});

test('standing up during a hand keeps an earlier "sit out next hand" choice', async () => {
  const r = await rig({ realMoney: true }); try {
    const a = r.user('alice'), b = r.user('bob');
    const sa = await r.client(), sb = await r.client();
    let p = r.once(sa, 'observer-joined'); sa.emit('observe-table', { tableId: T, sessionToken: a.token }); await p;
    const g = r.games.get(T); assert.equal(g.realMoney, true);
    g.addPlayer(a.id, 'alice', { initialStack: 10000 }); g.addPlayer(b.id, 'bob', { initialStack: 10000 });
    p = r.once(sa, 'seat-assigned'); sa.emit('observe-table', { tableId: T, sessionToken: a.token }); await p;
    p = r.once(sb, 'seat-assigned'); sb.emit('observe-table', { tableId: T, sessionToken: b.token }); await p;
    startHand(g);
    const pa = g.players.find(x => x.userId === a.id);
    sa.emit('sit-out', { tableId: T }); await sleep(200);
    assert.equal(pa.sittingOutNextHand, true);
    const ack = await new Promise(res => sa.emit('leave-table', { tableId: T }, res));
    assert.equal(pa.sittingOutNextHand, true, 'a player who asked to stand up must still be sat out next hand');
  } finally { await r.close(); }
});

test('a refused join (table full) leaves the socket watching the table', async () => {
  const r = await rig(); try {
    const so = await r.client(); const o = r.user('olivia');
    let p = r.once(so, 'observer-joined'); so.emit('observe-table', { tableId: T, sessionToken: o.token }); await p;
    const g = r.games.get(T);
    for (let i = 0; i < 6; i++) g.addPlayer('f'.repeat(62) + '0' + i, 'P' + i, { initialStack: 10000 });
    clearTimeout(g.handStartTimeout); g.handStartTimeout = null;
    await sleep(150);                       // let seating broadcasts settle before counting
    so.states = 0; r.broadcastGameState(T); await sleep(200);
    assert.ok(so.states >= 1, 'an observer receives table updates');
    so.emit('join-table', { tableId: T, sessionToken: o.token, buyIn: 10000 }); await sleep(300);
    assert.ok(so.errors.some(message => /Table is full/.test(message)), JSON.stringify(so.errors));
    assert.equal(r.socketUsers.has(so.id), false);
    so.states = 0; r.broadcastGameState(T); await sleep(200);
    assert.ok(so.states >= 1, 'a refused join must leave the socket watching the table');
  } finally { await r.close(); }
});

test('a player who leaves mid-hand and re-joins keeps the seat they resumed', async () => {
  const r = await rig(); try {
    const us = [r.user('alice'), r.user('bob'), r.user('carol')]; const ss = [];
    for (const u of us) { const s = await r.client(); await seat(r, s, u); ss.push(s); }
    const g = r.games.get(T); startHand(g);
    const ack = await new Promise(res => ss[0].emit('leave-table', { tableId: T }, res));
    const pa = g.players.find(x => x && x.userId === us[0].id);
    const assigned = await seat(r, ss[0], us[0]);
    ss[0].emit('sit-back-in', { tableId: T }); await sleep(150);
    let guard = 0; while (g.handInProgress && guard++ < 10) g.processAction(g.players[g.currentPlayerIndex].userId, 'fold');
    await sleep(3400);                                   // endHand's 3 s next-hand timer runs cleanupPendingRemovals()
    const still = g.players.some(x => x && x.userId === us[0].id);
    assert.equal(still, true, 'a player who re-took their seat must not be silently removed');
  } finally { await r.close(); }
});

test('disconnect grace is measured from the latest disconnect', async () => {
  const saved = [config.DISCONNECT_GRACE_MS, config.SOCKET_CLEANUP_MS]; config.DISCONNECT_GRACE_MS = 800; config.SOCKET_CLEANUP_MS = 100;
  const r = await rig(); try {
    const a = r.user('alice'); const s1 = await r.client(); await seat(r, s1, a);
    const g = r.games.get(T); const pa = g.players.find(x => x && x.userId === a.id);
    const t0 = Date.now(); s1.disconnect(); await sleep(150);                 // disconnect #1 at t0 (grace should end t0+800)
    const s2 = await r.client(); let p = r.once(s2, 'seat-assigned'); s2.emit('observe-table', { tableId: T, sessionToken: a.token }); await p;
    await sleep(450 - (Date.now() - t0) + 150); s2.disconnect(); const t2 = Date.now() - t0; await sleep(50);   // disconnect #2 at ~t0+600 (its grace ends ~t0+1400)
    await sleep(900 - (Date.now() - t0));
    assert.equal(pa.sittingOut, false, 'grace period must be measured from the latest disconnect');
  } finally { [config.DISCONNECT_GRACE_MS, config.SOCKET_CLEANUP_MS] = saved; await r.close(); }
});


test('the client address comes from the proxy only when the peer is the local proxy', () => {
  const socket = (address, forwarded) => ({ handshake: { address, headers: forwarded === undefined ? {} : { 'x-forwarded-for': forwarded } } });
  assert.equal(clientAddress(socket('127.0.0.1', '203.0.113.7')), '203.0.113.7');
  assert.equal(clientAddress(socket('::ffff:127.0.0.1', '198.51.100.9')), '198.51.100.9');
  // The proxy appends the real peer last; earlier entries are client-supplied.
  assert.equal(clientAddress(socket('::1', '10.0.0.1, 203.0.113.7')), '203.0.113.7');
  // A direct (non-proxied) peer cannot choose its own address with a header.
  assert.equal(clientAddress(socket('203.0.113.50', '127.0.0.1')), '203.0.113.50');
  assert.equal(clientAddress(socket('127.0.0.1')), '127.0.0.1');
  assert.equal(clientAddress(socket('127.0.0.1', 'not-an-address')), '127.0.0.1');
  assert.equal(clientAddress(socket('127.0.0.1', '')), '127.0.0.1');
});

test('a network is an IPv4 address or an IPv6 /64, and a local connection has none', () => {
  assert.equal(networkKey('203.0.113.7'), '203.0.113.7');
  assert.equal(networkKey('::ffff:203.0.113.7'), '203.0.113.7');
  // Devices in one home share the first 64 bits, however the address is written.
  assert.equal(networkKey('2001:db8:1:2::10'), networkKey('2001:0db8:0001:0002:aaaa:bbbb:cccc:dddd'));
  assert.notEqual(networkKey('2001:db8:1:2::10'), networkKey('2001:db8:1:3::10'));
  assert.equal(networkKey('2001:db8::1'), '2001:db8:0:0::/64');
  for (const local of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '', undefined, 'not-an-address']) assert.equal(networkKey(local), null);
});

test('two players on one network cannot sit at the same table', async () => {
  const r = await rig();
  const logged = type => db.db.prepare('SELECT COUNT(*) AS n FROM abuse_log WHERE action_type = ?').get(type).n;
  try {
    const origin = `http://127.0.0.1:${r.port}`, from = ip => ({ extraHeaders: { 'x-forwarded-for': ip } });
    const [ann, bob, cy, dee, eve] = ['Ann', 'Bob', 'Cy', 'Dee', 'Eve'].map(r.user);
    const refused = async (socket, user) => { const error = r.once(socket, 'error'); socket.emit('join-table', { tableId: T, sessionToken: user.token, buyIn: 10000 }); return (await error).message; };
    const seated = user => r.games.get(T).players.some(p => p?.userId === user.id);

    await seat(r, await r.client(origin, from('203.0.113.7')), ann);
    const bobSocket = await r.client(origin, from('203.0.113.7'));
    assert.match(await refused(bobSocket, bob), /Only one seat per network/);
    assert.equal(seated(bob), false);
    assert.equal(logged('same-network-seat-refused'), 1);
    await seat(r, await r.client(origin, from('203.0.113.8')), cy);            // a different network is welcome

    // IPv6: another device in the same home is the same network; the house next door is not.
    await seat(r, await r.client(origin, from('2001:db8:1:2::10')), dee);
    assert.match(await refused(await r.client(origin, from('2001:db8:1:2:aaaa:bbbb:cccc:dddd')), eve), /Only one seat per network/);
    await seat(r, await r.client(origin, from('2001:db8:1:3::10')), eve);

    // The rule holds while the seated player is disconnected but still holds the seat.
    r.userSockets.get(ann.id) && r.io.sockets.sockets.get(r.userSockets.get(ann.id)).disconnect(true);
    await sleep(60);
    assert.equal(seated(ann), true);
    assert.match(await refused(bobSocket, bob), /Only one seat per network/);

    // A seated player whose connection moves onto another player's network keeps the seat; it is recorded.
    await seat(r, await r.client(origin, from('203.0.113.8')), ann);
    assert.equal(logged('same-network-seat-resumed'), 1);
    assert.equal(seated(ann), true);

    // The operator can switch the rule off for a venue.
    config.ONE_SEAT_PER_NETWORK = false;
    await seat(r, await r.client(origin, from('203.0.113.8')), bob);
    assert.equal(seated(bob), true);
  } finally { config.ONE_SEAT_PER_NETWORK = true; await r.close(); }
});

test('a player still has their own action limit, and it does not spill onto others', async () => {
  const r = await rig(); try {
    const a = r.user('alice'), b = r.user('bob');
    const sa = await r.client(), sb = await r.client();
    await seat(r, sa, a); await seat(r, sb, b);
    db.db.exec('DELETE FROM abuse_log');
    const g = r.games.get(T); startHand(g);
    const actor = g.players[g.currentPlayerIndex].userId;
    const [sActor, sOther] = actor === a.id ? [sa, sb] : [sb, sa];
    for (let i = 0; i < 14; i++) sOther.emit('action', { tableId: T, action: 'check', amount: 0 });
    await sleep(300);
    assert.ok(sOther.errors.includes('Too many actions. Slow down.'), 'the spamming player is limited');
    assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM abuse_log WHERE action_type NOT IN ('action-fold','action-check','action-call','action-raise','action-invalid')").get().n, 0);
    sActor.emit('action', { tableId: T, action: 'call', amount: 0, handCount: g.handCount });
    await sleep(300);
    assert.deepEqual(sActor.errors, []);
  } finally { await r.close(); }
});
