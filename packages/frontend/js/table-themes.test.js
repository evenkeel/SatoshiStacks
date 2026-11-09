'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require.resolve('./table-themes.js'), 'utf8');

function harness({ saved, storageUnavailable = false } = {}) {
  const pending = [];
  const properties = {};
  const writes = [];
  const select = { value: 'bunker', addEventListener(type, fn) { this.change = fn; } };
  const status = { textContent: '' };
  const felt = { src: '/img/table-felt.svg' };
  const rail = { src: '/img/table-rail.svg' };
  const sign = { style: {} };
  const body = { dataset: {}, style: { setProperty: (key, value) => { properties[key] = value; } } };
  vm.runInNewContext(source, {
    document: {
      body,
      getElementById: id => ({ tableTheme: select, themeStatus: status }[id]),
      // Fail if the presentation controller attempts to access gameplay nodes.
      querySelector: selector => {
        const nodes = { '.table-felt': felt, '.table-rail': rail, '.table-neon-sign': sign };
        assert.ok(selector in nodes, `Unexpected gameplay access: ${selector}`);
        return nodes[selector];
      },
    },
    localStorage: {
      getItem() { if (storageUnavailable) throw Error('Storage denied'); return saved; },
      setItem(key, value) { if (storageUnavailable) throw Error('Storage denied'); writes.push([key, value]); },
    },
    Image: class { set src(value) { this.url = value; pending.push(this); } },
  });
  return { pending, properties, writes, select, status, body,
    choose(value) { select.value = value; select.change(); },
    async load(fail = false) {
      pending.splice(0).forEach(img => fail ? img.onerror() : img.onload());
      // Allow the Promise.all and apply continuations to complete.
      await new Promise(resolve => setImmediate(resolve));
    },
  };
}

test('saved room applies only after all artwork loads and touches no game nodes', async () => {
  const h = harness({ saved: 'classic' });
  assert.equal(h.body.dataset.roomTheme, undefined);
  assert.equal(h.pending.length, 3);
  await h.load();
  assert.equal(h.body.dataset.roomTheme, 'classic');
  assert.equal(h.select.value, 'classic');
  assert.equal(h.writes.length, 0, 'Restoring a preference does not write it again');
});

test('rapid changes commit only the latest requested room and persist that choice', async () => {
  const h = harness();
  h.choose('midnight');
  h.choose('classic');
  await h.load();
  assert.equal(h.body.dataset.roomTheme, 'classic');
  assert.deepEqual(h.writes, [['satoshistacks.room-theme.v1', 'classic']]);
});

test('failed artwork retains the default room and allows a later retry', async () => {
  const h = harness({ saved: 'midnight' });
  await h.load(true);
  assert.equal(h.select.value, 'bunker');
  assert.match(h.status.textContent, /could not load/);
  assert.deepEqual(h.properties, {});
  h.choose('midnight');
  assert.equal(h.pending.length, 3, 'Failed assets can be requested again');
  await h.load();
  assert.equal(h.body.dataset.roomTheme, 'midnight');
});

test('unavailable storage and unknown saved themes never prevent room selection', async () => {
  const denied = harness({ storageUnavailable: true });
  await denied.load();
  denied.choose('midnight');
  await denied.load();
  assert.equal(denied.body.dataset.roomTheme, 'midnight');
  const stale = harness({ saved: 'deleted-theme' });
  await stale.load();
  assert.equal(stale.body.dataset.roomTheme, 'bunker');
});
