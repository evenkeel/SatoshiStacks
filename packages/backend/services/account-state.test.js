'use strict';
process.env.SATOSHISTACKS_DB_PATH = ':memory:';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const db = require('../database');
const {accountState} = require('./account-state');
const config = {isRealMoney: () => false, LIGHTNING: {invoiceExpirySec: 600}};
const userId = 'account-state-user';
const tableId = 'station100';
const games = new Map([[tableId, {players: [{userId, stack: 10000}], canCashOut: () => ({ok:true})}]]);
const payments = {depositsEnabled: () => true, withdrawalsEnabled: () => true, breakerState: () => ({tripped:false})};

test('accounts can be read without Lightning; demo chips cannot become sats', () => {
  const state = accountState({db,config,games,userId,tableId,payments});
  assert.equal(state.lightningStatus, 'disabled');
  assert.equal(state.availableSats, 0);
  assert.equal(state.tableStackSats, 0);
  assert.equal(state.seated, false);
  assert.equal(state.canReturnStack, false);
  assert.equal(state.canBuyIn, false);
  assert.equal(state.depositsEnabled, false);
  assert.equal(state.withdrawalsEnabled, false);
});

test('readiness gates external payments while an outage preserves balance and table return', () => {
  db.creditAccount(userId, db.ACCOUNT, 'deposit', 3000);
  const args = {db,config:{...config,isRealMoney:()=>true},games,userId,tableId};
  const offline = accountState(args);
  assert.equal(offline.lightningStatus, 'offline');
  assert.equal(offline.availableSats, 3000);
  assert.equal(offline.tableStackSats, 10000);
  assert.equal(offline.canReturnStack, true);
  assert.equal(offline.canBuyIn, false);
  assert.equal(offline.withdrawalsEnabled, false);
  const ready = accountState({...args,payments});
  assert.equal(ready.lightningStatus, 'ready');
  assert.equal(ready.canBuyIn, true);
  assert.equal(ready.depositsEnabled, true);
  assert.equal(ready.withdrawalsEnabled, true);
  assert.equal(accountState({...args,payments,watchOnly:true}).canBuyIn, false);
  const paused = accountState({...args,payments:{...payments,depositsEnabled:()=>false,withdrawalsEnabled:()=>false}});
  assert.equal(paused.lightningStatus, 'paused');
  assert.equal(paused.availableSats, 3000);
});

test('reserved total includes older payments and stays private to the authenticated account', () => {
  db.insertWithdrawalReserved({userId,tableId:db.ACCOUNT,amountSats:700,paymentHash:'old-pending',bolt11:'test'});
  for (let i=0;i<21;i++) {
    db.insertWithdrawalReserved({userId,tableId:db.ACCOUNT,amountSats:1,paymentHash:`recent-${i}`,bolt11:'test'});
    db.updateLedgerStatus(db.getLedgerByHash(`recent-${i}`,'withdrawal').id,'succeeded');
  }
  const state = accountState({db,config,games,userId,tableId});
  assert.equal(state.payments.length, 20);
  assert.equal(state.pendingWithdrawalSats, 700);
  assert.ok(state.payments.every(row => row.status === 'succeeded'));
  const other = accountState({db,config,games,userId:'different-account',tableId});
  assert.equal(other.pendingWithdrawalSats, 0);
  assert.equal(other.availableSats, 0);
  assert.deepEqual(other.transfers, []);
  assert.deepEqual(other.payments, []);
});
