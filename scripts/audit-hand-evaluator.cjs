'use strict';
// Exhaustively classify C(52,5)=2,598,960 hands. Expected counts follow the
// standard combinatorial counts; royal flushes are separate in this engine.
const assert = require('node:assert/strict');
const { createDeck, eval5 } = require('../packages/shared');
const deck = createDeck();
const counts = Array(10).fill(0);
for (let a=0; a<48; a++) for (let b=a+1; b<49; b++)
for (let c=b+1; c<50; c++) for (let d=c+1; d<51; d++)
for (let e=d+1; e<52; e++) counts[eval5([deck[a],deck[b],deck[c],deck[d],deck[e]]).rank]++;
assert.deepEqual(counts, [1302540,1098240,123552,54912,10200,5108,3744,624,36,4]);
console.log('PASS: all 2,598,960 five-card hands match the expected category counts.');
