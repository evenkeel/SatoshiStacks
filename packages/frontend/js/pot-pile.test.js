'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {layout, render, create, updateElement, WIDTH, HEIGHT, CHIP_SIZE, MAX_VISIBLE} = require('./pot-pile');

test('every chip stays inside the pile with shadow clearance for small and enormous pots', () => {
  for (const count of [0,1,2,7,8,9,16,23,24,25,100,10000]) {
    const chips = Array.from({length:count}, (_,value) => ({value}));
    const positions = layout(chips);
    assert.equal(positions.length, Math.min(count, MAX_VISIBLE));
    for (const {x,y,chip,rotation} of positions) {
      const radians = rotation * Math.PI / 180;
      const extra = CHIP_SIZE / 2 * (Math.abs(Math.cos(radians)) + Math.abs(Math.sin(radians)) - 1);
      assert.ok(x - extra >= 6 && y - extra >= 6);
      assert.ok(x + CHIP_SIZE + extra <= WIDTH-6 && y + CHIP_SIZE + extra <= HEIGHT-6);
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
  assert.match(html, /viewBox="0 0 240 96"/);
  assert.equal(render([],()=>assert.fail('empty pile rendered a chip')), '');
});

test('a full pile scatters and overlaps chips without moving them on repeated renders', () => {
  const positions = layout(Array.from({length:24}, (_,value) => ({value})));
  const ys = positions.map(p => p.y);
  assert.ok(Math.max(...ys) - Math.min(...ys) > 30, 'Use depth instead of a single row');
  assert.equal(new Set(positions.map(p => p.rotation)).size, 24);
  assert.ok(positions.some((a,i) => positions.slice(i+1).some(b => Math.hypot(a.x-b.x,a.y-b.y) < CHIP_SIZE)), 'Chips overlap into a pile');
});

test('flop, turn, and river collections add chips without relocating or resampling settled chips', () => {
  const pile = create();
  const chips = Array.from({length:150}, (_,value) => ({value, label:String(value)}));
  let previous = [];
  for (const count of [35, 65, 110, 150]) {
    const positions = pile.update(chips.slice(0,count), 'hand-1');
    assert.ok(positions.length > previous.length);
    for (let i=0;i<previous.length;i++) assert.equal(positions[i], previous[i], 'Preserve the settled chip object and its position');
    assert.equal(positions.at(-1).chip, chips[count-1], 'The latest collection appears on top');
    assert.equal(pile.update(chips.slice(0,count), 'hand-1'), positions, 'Repeated snapshots do not change the pile');
    previous = positions;
  }
});

test('joining a large pot, hand changes, corrections, and clearing never replay old arrivals', () => {
  const pile = create();
  const chips = Array.from({length:1000}, (_,value) => ({value}));
  const restored = pile.update(chips, 'hand-1');
  assert.equal(restored.length,24);
  assert.equal(restored.at(-1).chip, chips.at(-1));
  const next = pile.update(chips, 'hand-2');
  assert.notEqual(next[0], restored[0]);
  const corrected = pile.update([{value:7}], 'hand-2');
  assert.equal(corrected.length,1);
  assert.equal(corrected[0].chip.value,7);
  assert.deepEqual(pile.update([], 'hand-2'), []);
  const cap = create();
  for (let n=1;n<=1000;n++) assert.ok(cap.update(chips.slice(0,n),'hand').length<=MAX_VISIBLE);
});

test('DOM updates retain settled SVG nodes and animate only newly added chips', () => {
  const doc = {createElementNS: () => new Element()};
  class Element {
    constructor() { this.children=[]; this.attributes={}; this.dataset={}; this.ownerDocument=doc; }
    get firstElementChild() { return this.children[0]; }
    setAttribute(key,value) { this.attributes[key]=value; }
    getAttribute(key) { return this.attributes[key] ?? null; }
    appendChild(child) { this.children.push(child); }
    replaceChildren(...children) { this.children=children; }
  }
  const container = new Element(), pile = create();
  const chips = Array.from({length:12}, (_,value) => ({value}));
  const artwork = () => '<svg></svg>';
  updateElement(container,pile.update(chips.slice(0,8),'hand-1'),artwork,'hand-1');
  const svg = container.firstElementChild, settled = svg.children.slice();
  assert.ok(settled.every(chip=>!chip.firstElementChild.getAttribute('class')), 'Restored chips do not animate');
  updateElement(container,pile.update(chips,'hand-1'),artwork,'hand-1');
  assert.equal(container.firstElementChild,svg);
  settled.forEach((chip,i)=>assert.equal(svg.children[i],chip));
  assert.ok(svg.children.slice(8).every(chip=>chip.firstElementChild.getAttribute('class')==='pot-chip-arrival'));
  updateElement(container,pile.update(chips,'hand-1'),artwork,'hand-1');
  assert.equal(svg.children.length,12);
  updateElement(container,pile.update(chips,'hand-2'),artwork,'hand-2');
  assert.notEqual(container.firstElementChild,svg);
});
