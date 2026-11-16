'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { renderCardHTML } = require('./cards.js');

const suitPath = html => html.match(/<path d="([^"]+)" transform="translate\(([\d.]+) ([\d.]+)\) scale\(([\d.]+)\)/);

test('every suit has its own artwork', () => {
  const paths = ['s', 'h', 'd', 'c'].map(s => suitPath(renderCardHTML('A' + s, 'small'))[1]);
  assert.equal(new Set(paths).size, 4);
});

test('clubs are three separate round lobes, spades a single pointed blade', () => {
  const club = suitPath(renderCardHTML('Ac', 'small'))[1];
  const spade = suitPath(renderCardHTML('As', 'small'))[1];
  // Each lobe is a full circle drawn with two arcs.
  assert.equal(club.match(/a5\.4 5\.4/g).length, 6);
  assert.ok(!/a\d/.test(spade));
  assert.ok(spade.startsWith('M0-14'));
});

test('overlapping player cards keep rank and suit in the uncovered left half', () => {
  for (const card of ['As', 'Tc', 'Qh', '7d']) {
    const html = renderCardHTML(card, 'small dimmed');
    const [, , x, , scale] = suitPath(html);
    // Suits are at most 26 units wide; the card is 100 units wide.
    assert.ok(Number(x) + 13 * Number(scale) <= 56, `${card} suit stays left of the overlap`);
    assert.match(html, /<text x="30"/);
    assert.ok(!html.includes('deck-full'));
  }
});

test('full cards carry a glance face for narrow renders', () => {
  for (const card of ['As', 'Kc', 'Th', '2d']) {
    const html = renderCardHTML(card);
    assert.match(html, /<g class="deck-full">/);
    const glance = html.split('<g class="deck-glance">')[1];
    assert.ok(glance, `${card} has a glance face`);
    assert.equal(glance.match(/<path /g).length, 1);
    assert.ok(Number(suitPath(glance)[4]) >= 2);
  }
});

test('face-down and invalid cards render the house back', () => {
  for (const card of [null, '??', 'Zx']) {
    const html = renderCardHTML(card);
    assert.match(html, /class="card face-down /);
    assert.match(html, /aria-label="Face-down card"/);
  }
});

test('face-up cards name their suit so the four-color deck can recolour clubs and diamonds', () => {
  assert.match(renderCardHTML('Ac'), /class="card black suit-c "/);
  assert.match(renderCardHTML('Td', 'small'), /class="card red suit-d small"/);
  assert.match(renderCardHTML('Ks'), /class="card black suit-s "/);
  assert.match(renderCardHTML('2h'), /class="card red suit-h "/);
  assert.ok(!/suit-/.test(renderCardHTML(null)));
});
