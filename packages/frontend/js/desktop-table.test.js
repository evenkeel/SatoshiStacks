'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require.resolve('./desktop-table.js'), 'utf8');
function layout(width, height, panels = [], mobile = false) {
  let fit;
  const area = { style: { setProperty(name, value) { this[name] = value; } } };
  const header = { getBoundingClientRect: () => ({ bottom: 92 }) };
  const nodes = panels.map(rect => ({ getBoundingClientRect: () => rect, style: { display: 'block', visibility: 'visible' } }));
  vm.runInNewContext(source, {
    innerWidth: width, innerHeight: height,
    document: {
      body: { classList: { contains: () => mobile }, style: { setProperty() {} } },
      getElementById: id => id === 'tableArea' ? area : null,
      querySelector: selector => selector === '.account-bar' ? header : null,
      querySelectorAll: () => nodes,
    },
    getComputedStyle: panel => panel.style,
    requestAnimationFrame: callback => { callback(); return 1; }, cancelAnimationFrame() {},
    ResizeObserver: class { observe() {} }, MutationObserver: class { observe() {} },
    window: { addEventListener(event, callback) { fit = callback; } },
  });
  return { area, scale: Number(area.style['--table-scale']), resize: fit, nodes };
}
function rect(left, top, width, height) { return { left, top, right: left + width, bottom: top + height, width, height }; }

test('fullscreen table uses height beside corner chat instead of reserving a full-width strip', () => {
  const chat = rect(12, 888, 340, 172);
  const result = layout(2048, 1072, [chat]);
  const previous = (chat.top - 12 - 100) / 820;
  assert.ok(result.scale > previous * 1.3, 'Fullscreen table should be at least 30% larger');
  assert.ok(100 + parseFloat(result.area.style.height) <= 1060);
});

test('a centered bottom panel still reserves room below the table', () => {
  const result = layout(1440, 900, [rect(400, 700, 640, 188)]);
  assert.ok(100 + parseFloat(result.area.style.height) <= 688.01);
});

test('small desktop windows remain inside viewport and avoid corner utilities', () => {
  for (const [width, height] of [[1031, 920], [1280, 720], [900, 600]]) {
    const chat = rect(12, height - 160, 280, 148);
    const result = layout(width, height, [chat]);
    assert.ok(result.scale > 0);
    assert.ok(result.scale * 1220 <= width - 16);
    assert.ok(100 + parseFloat(result.area.style.height) <= height - 12);
    // At the top of chat, the protected lower-left edge must clear its right side.
    const y = (chat.top - 12 - 100) / result.scale - 390;
    if (y < 390) {
      const edge = width / 2 - (610 - Math.max(0, y - 120) * 180 / 270) * result.scale;
      assert.ok(edge >= chat.right + 12 - .01);
    }
  }
});

test('opening or expanding a utility panel recalculates table clearance', () => {
  const result = layout(1440, 900, [rect(400, 820, 640, 68)]);
  result.nodes[0].getBoundingClientRect = () => rect(400, 680, 640, 208);
  result.resize();
  assert.ok(Number(result.area.style['--table-scale']) < result.scale);
});

test('phone layouts keep their existing sizing', () => {
  assert.ok(Number.isNaN(layout(390, 844, [], true).scale));
});
