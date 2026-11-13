'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {cashoutHTML}=require('./wallet-ui');
test('pending funds cannot expose a new payment button',()=>{
  const html=cashoutHTML({withdrawalsEnabled:true,availableSats:0,payments:[{amount_sats:5000,status:'in_flight'}]});
  assert.match(html,/5,000 sats are reserved/);assert.doesNotMatch(html,/data-action="confirm-/);
});
test('a paused wallet never offers a withdrawal even when a balance exists',()=>{
  assert.doesNotMatch(cashoutHTML({withdrawalsEnabled:false,availableSats:10000}),/data-action="confirm-/);
});
test('a recovered balance supports both WebLN and a receiving invoice',()=>{
  const html=cashoutHTML({withdrawalsEnabled:true,availableSats:500});
  assert.match(html,/up to ₿\s500 sats/);assert.match(html,/confirm-cashout/);assert.match(html,/confirm-pasted-cashout/);
});
test('server errors are escaped before rendering in the wallet',()=>{
  const html=cashoutHTML({error:'<img src=x onerror=alert(1)>',withdrawalsEnabled:true,availableSats:10000});
  assert.doesNotMatch(html,/<img/);assert.doesNotMatch(html,/data-action="confirm-/);
});
test('account balance remains withdrawable while a table stack is in an active hand',()=>{
  const html=cashoutHTML({withdrawalsEnabled:true,depositsEnabled:true,availableSats:3000,seated:true,tableStackSats:10000,canReturnStack:false});
  assert.match(html,/Finish the current hand/);assert.match(html,/confirm-cashout/);
  assert.match(html,/max="3000"/);assert.match(html,/account-deposit/);
});
test('pending payments older than the recent history remain visible in the reserved total',()=>{
  const html=cashoutHTML({withdrawalsEnabled:true,availableSats:0,payments:[...Array.from({length:5},()=>({amount_sats:10,status:'succeeded'})),{amount_sats:900,status:'in_flight'}]});
  assert.match(html,/900 sats are reserved/);
});

test('unresolved invoice creation explains recovery without rendering a null invoice',()=>{
  const html=cashoutHTML({availableSats:0,deposits:[{status:'pending',bolt11:null}]});
  assert.match(html,/recover the same invoice/);assert.doesNotMatch(html,/null/);
});
test('an uncertain withdrawal explains that closing the window does not cancel it',()=>{
  const html=cashoutHTML({availableSats:0,payments:[{amount_sats:1000,status:'in_flight'}]});
  assert.match(html,/timeout does not mean it failed/);assert.match(html,/close this window/);
});

test('phone spectators can withdraw without being offered a table buy-in',()=>{
  const html=cashoutHTML({watchOnly:true,withdrawalsEnabled:true,availableSats:5000});
  assert.doesNotMatch(html,/account-buyin/);
  assert.match(html,/confirm-cashout/);
});
