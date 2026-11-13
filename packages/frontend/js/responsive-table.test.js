'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require.resolve('./responsive-table.js'), 'utf8');

function setup(initial) {
  const parents = new Map();
  const nodes = new Map();
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, { id, before(marker) { parents.set(marker.id, parents.get(id)); },
      after(child) { parents.set(child.id, parents.get(id)); }, append(child) { parents.set(child.id, id); } });
    return nodes.get(id);
  }
  let change, queries = [], events = [];
  const classes = new Set();
  const media = { matches:initial, addEventListener(event, fn) { assert.equal(event, 'change'); change=fn; } };
  parents.set('tableActionsBar','body'); parents.set('account','header'); parents.set('dealerStation','table');
  const body = node('body');
  body.classList = { toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); } };
  vm.runInNewContext(source, {matchMedia(query) { queries.push(query); return media; }, Event:class { constructor(type) { this.type=type; } },
    window:{ dispatchEvent(event) { events.push(event.type); } },
    document:{body, getElementById:node, querySelector:()=>node('account'),createComment:node} });
  return {parents,classes,queries,events, resize(matches) {media.matches=matches;change();}};
}
test('compact layout is determined by viewport dimensions, without device detection', () => {
  const ui=setup(true);
  assert.deepEqual(ui.queries,['(max-width: 900px), (max-height: 500px)']);
  assert.ok(ui.classes.has('is-mobile'));
  assert.equal(ui.parents.get('account'),'mobileAccountActions');
  assert.equal(ui.parents.get('tableActionsBar'),'mobileSeatActions');
  assert.equal(ui.parents.get('dealerStation'),'body');
});
test('resizing back and forth restores the same controls to their desktop positions', () => {
  const ui=setup(false);
  for (let i=0;i<3;i++) {
    ui.resize(true);
    assert.ok(ui.classes.has('is-mobile'));
    ui.resize(false);
    assert.equal(ui.classes.has('is-mobile'),false);
    assert.equal(ui.parents.get('account'),'header');
    assert.equal(ui.parents.get('tableActionsBar'),'body');
    assert.equal(ui.parents.get('dealerStation'),'table');
  }
  assert.equal(ui.events.length,7);
  assert.ok(ui.events.every(type=>type==='table-layout-change'));
});
