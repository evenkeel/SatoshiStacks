'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('./app.js'),'utf8');
const code = source.slice(source.indexOf('function summarizeHandResult('),source.indexOf('function addChatMessage('));
const context = vm.createContext({});
vm.runInContext(code,context);
const summarize = context.summarizeHandResult;

test('showdown summaries include the winner, exact chips, and shown hand without hole cards', () => {
  assert.equal(summarize('Seat 1: Mira (big blind) showed [5d 6c] and won (6500) with two pair, Sixes and Fives'),
    'Mira won 6,500 chips with two pair, Sixes and Fives.');
});
test('uncontested pots say everyone folded without guessing or revealing a hand', () => {
  assert.equal(summarize('Seat 3: June (button) collected (450)'), 'June won 450 chips — everyone else folded.');
});
test('split and side-pot winners retain their individual aggregated payouts', () => {
  assert.equal(summarize('Seat 2: Theo showed [Ah Ad] and won (1201) with a pair of Aces'), 'Theo won 1,201 chips with a pair of Aces.');
  assert.equal(summarize('Seat 5: Neon (small blind) showed [Kh Kd] and won (1200) with a pair of Kings'), 'Neon won 1,200 chips with a pair of Kings.');
});
test('routine actions, losing hands, board cards, and full history headers are omitted', () => {
  for (const line of ['Mira: checks','Total pot 6500','Board [4d 5s 6s 9c 4s]',
    'Seat 2: Theo showed [Ah Kd] and lost with a pair of Fours','Seat 3: June folded before Flop']) assert.equal(summarize(line),null);
});
