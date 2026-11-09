/* A bounded visual pile; the pot label remains the authoritative chip amount. */
(function(root) {
  'use strict';
  const WIDTH = 240, HEIGHT = 64, CHIP_SIZE = 28, MAX_VISIBLE = 24;
  function layout(chips) {
    const count = Math.min(chips.length, MAX_VISIBLE);
    const columns = Math.min(count, 8);
    return Array.from({length:count}, (_,i) => {
      // Sample the whole pile when large, including its first and last denominations.
      const index = count === 1 ? 0 : Math.floor(i * (chips.length - 1) / (count - 1));
      const column = i % 8, row = Math.floor(i / 8);
      return { chip:chips[index], x:15 + (8-columns)*13 + column*26,
        y:28-row*8+(column%3-1)*2 };
    });
  }
  function render(positions, chipHTML) {
    if (!positions.length) return '';
    return `<svg class="pot-chip-pile" viewBox="0 0 ${WIDTH} ${HEIGHT}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">${positions.map(p => `<g transform="translate(${p.x} ${p.y})">${chipHTML(p.chip, CHIP_SIZE)}</g>`).join('')}</svg>`;
  }
  const api = {layout, render, WIDTH, HEIGHT, CHIP_SIZE, MAX_VISIBLE};
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StacksPotPile = api;
})(typeof window === 'object' ? window : globalThis);
