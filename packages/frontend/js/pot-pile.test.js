'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {layout, render, WIDTH, HEIGHT, CHIP_SIZE, MAX_VISIBLE} = require('./pot-pile');

test('every chip stays inside the pile with shadow clearance for small and enormous pots', () => {
  for (const count of [0,1,2,7,8,9,16,23,24,25,100,10000]) {
    const chips = Array.from({length:count}, (_,value) => ({value}));
    const positions = layout(chips);
    assert.equal(positions.length, Math.min(count, MAX_VISIBLE));
    for (const {x,y,chip} of positions) {
      assert.ok(x >= 6 && y >= 6);
      assert.ok(x + CHIP_SIZE <= WIDTH-6 && y + CHIP_SIZE <= HEIGHT-6);
      assert.ok(chips.includes(chip));
    }
    assert.deepEqual(layout(chips), positions);
  }
});
test('large piles sample denominations throughout the pot and cap rendered work', () => {
  const chips = Array.from({length:10000}, (_,value) => ({value}));
  const positions = layout(chips);
  assert.equal(positions[0].chip, chips[0]);
  assert.equal(positions.at(-1).chip, chips.at(-1));
  let calls = 0;
  const html = render(positions, (chip,size) => {calls++;assert.equal(size,CHIP_SIZE);return `<svg data-value="${chip.value}"></svg>`;});
  assert.equal(calls, MAX_VISIBLE);
  assert.match(html, /viewBox="0 0 240 64"/);
  assert.equal(render([],()=>assert.fail('empty pile rendered a chip')), '');
});
