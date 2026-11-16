'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { fitTable, fitChat, uiScale, SHAPES, GAP, EDGE } = require('./desktop-table');
const source = fs.readFileSync(require.resolve('./desktop-table.js'), 'utf8');

function rect(left, top, width, height) { return { left, top, right: left + width, bottom: top + height, width, height }; }
// The desktop docks and corner clusters as the stylesheets place them. Chat is
// not among the panels: the table is fitted first and chat takes what is left.
function room(width, height, seated = true) {
  const ui = uiScale(width, height);
  const corners = [rect(12, 10, 112 * ui, 135 * ui), rect(width - 12 - 222 * ui, 10, 222 * ui, 42 * ui)];
  const chat = rect(12, height - 12 - 248 * ui, 340 * ui, 248 * ui);
  const docks = [rect(width - 8 - 520 * ui, height - 8 - 176 * ui, 520 * ui, 176 * ui),
    rect(24 + 340 * ui, height - 12 - 48 * ui, 280 * ui, 48 * ui),
    rect(24 + 340 * ui, height - 12 - 104 * ui, 280 * ui, 48 * ui)];
  return { ui, corners, chat, docks, panels: [...corners, ...(seated ? docks : [])] };
}
// Every shape as a viewport rectangle, plus an independent point test.
function silhouette(width, { scale, centerY }) {
  const centerX = width / 2;
  return SHAPES.map(shape => {
    const b = shape.rx ? { x0: (shape.x || 0) - shape.rx, y0: (shape.y || 0) - shape.ry, x1: (shape.x || 0) + shape.rx, y1: (shape.y || 0) + shape.ry } : shape;
    const covers = (px, py) => {
      const x = (px - centerX) / scale, y = (py - centerY) / scale;
      if (!shape.rx) return x > shape.x0 && x < shape.x1 && y > shape.y0 && y < shape.y1;
      return ((x - (shape.x || 0)) / shape.rx) ** 2 + ((y - (shape.y || 0)) / shape.ry) ** 2 < 1;
    };
    return { left: centerX + b.x0 * scale, right: centerX + b.x1 * scale, top: centerY + b.y0 * scale, bottom: centerY + b.y1 * scale, covers };
  });
}
function assertClear(width, height, panels, fit) {
  const shapes = silhouette(width, fit);
  for (const shape of shapes) {
    assert.ok(shape.left >= EDGE - .01 && shape.right <= width - EDGE + .01, 'table stays inside the window width');
    assert.ok(shape.top >= EDGE - .01 && shape.bottom <= height - EDGE + .01, 'table stays inside the window height');
  }
  // Walk a fine grid over each panel, grown by all but a sliver of the clearance.
  const grow = GAP - 1;
  for (const panel of panels) {
    for (let x = panel.left - grow; x <= panel.right + grow; x += 3) {
      for (let y = panel.top - grow; y <= panel.bottom + grow; y += 3) {
        assert.ok(!shapes.some(shape => shape.covers(x, y)), `table overlaps a panel at ${x},${y} in ${width}x${height}`);
      }
    }
  }
}
const windows = [[901, 501], [950, 930], [1000, 700], [1024, 768], [1100, 1000], [1280, 720], [1366, 768],
  [1440, 900], [1728, 1117], [1920, 1080], [2560, 1440], [3440, 1440], [3840, 2160], [1000, 1400]];

test('the table never overlaps a dock or corner cluster and never leaves the window', () => {
  for (const [width, height] of windows) {
    for (const seated of [true, false]) {
      const { panels } = room(width, height, seated);
      assertClear(width, height, panels, fitTable(width, height, panels));
    }
  }
});

test('a tall or square window gets a full-width table instead of one squeezed under the corner clusters', () => {
  for (const [width, height] of [[950, 930], [1100, 1000], [1000, 1400], [1200, 1600]]) {
    const { panels, corners, docks } = room(width, height);
    const fit = fitTable(width, height, panels);
    const widest = (width - 2 * EDGE) / 1148;
    assert.ok(fit.scale > widest * .995, `${width}x${height} should be limited only by its width`);
    // It rests between the clusters above and the docks below, not against either.
    const top = fit.centerY - 375 * fit.scale, bottom = fit.centerY + 363 * fit.scale;
    assert.ok(top > corners[1].bottom && bottom < docks[0].top, `${width}x${height} should rest between`);
    assert.ok(Math.abs(fit.centerY - height / 2) < height * .12, `${width}x${height} should rest near the middle`);
  }
});

test('the table keeps growing with the window, up to very large displays', () => {
  let previous = 0;
  for (const [width, height] of [[1280, 720], [1920, 1080], [2560, 1440], [3840, 2160], [5120, 2880], [7680, 4320]]) {
    const { panels } = room(width, height);
    const { scale } = fitTable(width, height, panels);
    assert.ok(scale > previous * 1.2, `${width}x${height} should be clearly larger than the size before`);
    previous = scale;
  }
  // On a 4K display the rail spans nearly the whole height of the window.
  const { panels } = room(3840, 2160);
  assert.ok(fitTable(3840, 2160, panels).scale * 726 > 2160 * .95);
});

test('landscape windows fill most of their height beside the bottom docks', () => {
  for (const [width, height, share] of [[1280, 720, .7], [1440, 900, .75], [1920, 1080, .82], [2560, 1440, .9]]) {
    const { panels } = room(width, height);
    assert.ok(fitTable(width, height, panels).scale * 726 >= height * share, `${width}x${height}`);
  }
});

test('spectators get the room a seated player needs for betting controls', () => {
  for (const [width, height] of [[1280, 720], [1440, 900], [1920, 1080]]) {
    const seated = fitTable(width, height, room(width, height, true).panels).scale;
    const watching = fitTable(width, height, room(width, height, false).panels).scale;
    assert.ok(watching > seated * 1.05, `${width}x${height}`);
  }
});

test('docks keep their designed size on ordinary desktops, shrink in small windows and grow on huge ones', () => {
  assert.equal(uiScale(1440, 900), 1);
  assert.equal(uiScale(2560, 1440), 1);
  assert.ok(uiScale(950, 930) < 1 && uiScale(1280, 600) < 1);
  assert.ok(uiScale(3840, 2160) > 1.2 && uiScale(3840, 2160) < 1.5);
});

// Run the browser wiring against a minimal DOM.
function layout(width, height, { seated = true, mobile = false } = {}) {
  const listeners = {};
  const { ui, corners, chat, docks } = room(width, height);
  const make = (box, classes = []) => {
    const set = new Set(classes);
    return { box, getBoundingClientRect() { return this.box; }, classList: { contains: name => set.has(name) },
      style: { setProperty(name, value) { this[name] = value; } },
      setClass(name, on) { if (on) set.add(name); else set.delete(name); } };
  };
  const nodes = {
    '.table-identity': make(corners[0]), '.account-bar nav': make(corners[1]), '.chat-box': make(chat),
    '.controls-area': make(docks[0]), '.table-actions-bar': make(docks[1], seated ? ['visible'] : []), '.pre-action-bar': make(docks[2]),
  };
  const area = { style: { removeProperty(name) { delete this[name]; }, setProperty(name, value) { this[name] = value; } } };
  const window = { addEventListener(event, callback) { listeners[event] = callback; } };
  vm.runInNewContext(source, {
    window, innerWidth: width, innerHeight: height,
    document: {
      body: { classList: { contains: () => mobile }, style: { setProperty() {} } },
      getElementById: id => id === 'tableArea' ? area : null,
      querySelector: selector => nodes[selector] || null,
    },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    requestAnimationFrame: callback => { callback(); return 1; }, cancelAnimationFrame() {},
    ResizeObserver: class { observe() {} }, MutationObserver: class { observe() {} },
  });
  return { area, nodes, ui, chat, refit: listeners.resize, snapshot: () => JSON.stringify(area.style),
    setMobile(value) { mobile = value; listeners['table-layout-change'](); } };
}

test('the page places the table where the fit says, scaled as one unit', () => {
  const result = layout(1440, 900);
  const { panels } = room(1440, 900);
  const fit = fitTable(1440, 900, panels);
  assert.equal(Number(result.area.style['--table-scale']), fit.scale);
  assert.equal(parseFloat(result.area.style.height), 680 * fit.scale);
  assert.equal(parseFloat(result.area.style.top), fit.centerY - 340 * fit.scale);
});

test('table bounds stay identical as turn controls appear and disappear', () => {
  for (const [width, height] of [[1031, 920], [1280, 720], [2048, 1072]]) {
    const result = layout(width, height);
    const initial = result.snapshot();
    for (const visible of [false, true, false]) {
      result.nodes['.controls-area'].setClass('visible', visible);
      result.nodes['.pre-action-bar'].setClass('visible', !visible);
      result.refit();
      assert.equal(result.snapshot(), initial);
    }
  }
});

// Chat's corner of the window, as the page describes it to fitChat.
function chatCorner(width, height) {
  const { ui, corners } = room(width, height);
  return { ui, corner: { left: 12, bottom: height - 12, composer: 48 * ui, ceiling: corners[0].bottom + 40 * ui,
    minWidth: 160 * ui, maxWidth: 340 * ui, step: 10 * ui } };
}

test('chat has no say in the table: it is the same size with chat open, closed or showing the hand history', () => {
  const result = layout(1440, 900);
  const initial = result.snapshot();
  const { chat } = result;
  for (const box of [rect(chat.left, chat.bottom - 48, 230, 48), rect(chat.left, chat.bottom - 460, 520, 460)]) {
    result.nodes['.chat-box'].box = box;
    result.refit();
    assert.equal(result.snapshot(), initial);
  }
  // And it is exactly the table a window with no chat at all would get.
  assert.equal(Number(result.area.style['--table-scale']), fitTable(1440, 900, room(1440, 900).panels).scale);
});

test('chat takes the corner the table leaves, and its clear lines never touch the table', () => {
  for (const [width, height] of windows) {
    for (const seated of [true, false]) {
      const fit = fitTable(width, height, room(width, height, seated).panels);
      const { corner } = chatCorner(width, height);
      const column = fitChat(width, fit, corner);
      assert.ok(column.width >= corner.minWidth - .01 && column.width <= corner.maxWidth + .01);
      if (column.room <= 0) continue;
      const shapes = silhouette(width, fit);
      for (let x = 0; x <= corner.left + column.width; x += 3) {
        for (let y = corner.bottom - corner.composer - column.room + 1; y <= corner.bottom; y += 3) {
          assert.ok(!shapes.some(shape => shape.covers(x, y)), `chat meets the table at ${x},${y} in ${width}x${height}`);
        }
      }
    }
  }
});

test('chat is full width with a long feed where the table leaves room, and narrows beside a full-height table', () => {
  // Seated in landscape, the table stops above the betting controls: chat gets a tall column.
  let fit = fitTable(1440, 900, room(1440, 900, true).panels);
  let column = fitChat(1440, fit, chatCorner(1440, 900).corner);
  assert.equal(column.width, 340);
  assert.ok(column.room > 200);
  // A tall window leaves the whole band under the table.
  fit = fitTable(950, 930, room(950, 930, true).panels);
  column = fitChat(950, fit, chatCorner(950, 930).corner);
  assert.ok(column.width > 260 * uiScale(950, 930) && column.room > 120);
  // A spectator's table fills the height, so chat keeps to the corner beside the bottom-left seat.
  fit = fitTable(1440, 900, room(1440, 900, false).panels);
  column = fitChat(1440, fit, chatCorner(1440, 900).corner);
  assert.ok(column.width < 340 && column.width >= 160);
  assert.ok(column.room > 40, 'a few lines stay clear even then');
});

test('the page hands chat its fitted column', () => {
  const result = layout(1440, 900);
  const chat = result.nodes['.chat-box'].style;
  assert.equal(chat['--chat-width'], '340px');
  assert.ok(parseFloat(chat['--feed-height']) > 200);
  assert.ok(parseFloat(chat['--feed-clear']) < parseFloat(chat['--feed-height']));
});

test('taking a seat makes room for the betting controls and standing up gives it back', () => {
  const result = layout(1440, 900, { seated: false });
  const watching = Number(result.area.style['--table-scale']);
  result.nodes['.table-actions-bar'].setClass('visible', true);
  result.refit();
  const seated = Number(result.area.style['--table-scale']);
  assert.ok(seated < watching);
  result.nodes['.table-actions-bar'].setClass('visible', false);
  result.refit();
  assert.equal(Number(result.area.style['--table-scale']), watching);
});

test('phone layouts keep their own sizing, and desktop sizing is cleared when a window shrinks to one', () => {
  const result = layout(1280, 720, { mobile: true });
  assert.equal(result.area.style['--table-scale'], undefined);
  result.setMobile(false);
  assert.ok(Number(result.area.style['--table-scale']) > 0);
  result.setMobile(true);
  assert.equal(result.area.style.top, '');
  assert.equal(result.area.style.height, '');
  assert.equal(result.area.style['--table-scale'], undefined);
});
