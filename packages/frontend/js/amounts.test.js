'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {format, symbol} = require('./amounts');
const {cashoutHTML} = require('./wallet-ui');

test('sats display covers zero, balances and grouped amounts', () => {
  assert.equal(symbol, '₿');
  assert.equal(format(0), '₿\u00a00');
  assert.equal(format(9800), '₿\u00a09,800');
  assert.equal(format(1000000), '₿\u00a01,000,000');
  assert.equal(format(undefined), '₿\u00a00');
});

test('wallet displays sats while preserving numeric withdrawal values', () => {
  const html = cashoutHTML({withdrawalsEnabled:true, availableSats:9800});
  assert.ok(html.includes('₿\u00a09,800 sats'));
  assert.match(html, /max="9800"/);
  assert.match(html, /value="9800"/);
  assert.doesNotMatch(html, /(?:value|max)="₿/);
});
