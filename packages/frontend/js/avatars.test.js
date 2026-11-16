'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const avatars = require('./avatars');
const { render, traits, PALETTE, ACCESSORIES } = avatars;

test('a player keeps the same house avatar across renders and sessions', () => {
  const seed = 'a'.repeat(64);
  assert.equal(render(seed), render(seed));
  assert.deepEqual(traits(seed), traits(seed));
  assert.ok(PALETTE.includes(traits(seed).color));
  assert.ok(ACCESSORIES.includes(traits(seed).accessory));
});

test('different players are spread across colours and accessories', () => {
  const seeds = Array.from({ length: 200 }, (_, i) => i.toString(16).padStart(64, '0'));
  assert.ok(new Set(seeds.map(seed => traits(seed).color.base)).size >= 6);
  assert.ok(new Set(seeds.map(seed => traits(seed).accessory)).size >= 6);
});

test('the house avatar is one fixed face: it takes no mood and never changes with play', () => {
  const seed = 'f00d';
  assert.equal(render(seed, 'winner'), render(seed));
  assert.equal(render(seed, 'folded'), render(seed));
  assert.match(render(seed), /^<svg class="chip-buddy" /);
  assert.equal(avatars.moodFor, undefined);
  assert.equal(avatars.MOODS, undefined);
});

test('hostile seeds are hashed and never copied into the markup', () => {
  for (const seed of ['"><img src=x onerror=alert(1)>', '</svg><script>alert(1)</script>', null, undefined, 42, {}]) {
    const svg = render(seed);
    assert.doesNotMatch(svg, /<script|onerror|<img/i);
    assert.match(svg, /^<svg class="chip-buddy"[^]*<\/svg>$/);
    assert.equal((svg.match(/<svg/g) || []).length, 1);
  }
});
