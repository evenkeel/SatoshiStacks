/* A bounded visual pile; the pot label remains the authoritative chip amount. */
(function(root) {
  'use strict';
  const WIDTH = 240, HEIGHT = 96, CHIP_SIZE = 28, MAX_VISIBLE = 96;
  function layout(chips, offset = 0, limit = MAX_VISIBLE) {
    const count = Math.min(chips.length, limit, MAX_VISIBLE - offset);
    return Array.from({length:count}, (_,i) => {
      // Sample the whole pile when large, including its first and last denominations.
      const index = count === 1 ? 0 : Math.floor(i * (chips.length - 1) / (count - 1));
      // An irregular overlapping scatter, stable across repeated state updates.
      // Golden-angle spacing avoids rows, columns, and perfectly aligned stacks.
      const slot = offset + i;
      const angle = slot * 2.399963229728653 + .8;
      const radius = slot === 0 ? 0 : Math.sqrt((slot * .618033988749895) % 1);
      return { chip:chips[index],
        x: (WIDTH - CHIP_SIZE) / 2 + Math.cos(angle) * radius * 90,
        y: (HEIGHT - CHIP_SIZE) / 2 + Math.sin(angle) * radius * 22,
        rotation: (slot * 73 + 19) % 71 - 35 };
    });
  }
  function render(positions, chipHTML) {
    if (!positions.length) return '';
    return `<svg class="pot-chip-pile" viewBox="0 0 ${WIDTH} ${HEIGHT}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">${positions.map(p => `<g transform="${transform(p)}">${chipHTML(p.chip, CHIP_SIZE)}</g>`).join('')}</svg>`;
  }
  const signature = chip => JSON.stringify([chip.value, chip.label, chip.fill, chip.text]);
  const transform = p => `translate(${p.x} ${p.y}) rotate(${p.rotation} ${CHIP_SIZE/2} ${CHIP_SIZE/2})`;
  function create() {
    let hand, previous = [], positions = [];
    return { update(chips, handKey) {
      if (hand !== handKey || chips.length < previous.length || previous.some((chip,i) => signature(chip) !== signature(chips[i]))) {
        positions = [];
        previous = [];
      }
      hand = handKey;
      // Sample only the newly collected batch. Older chips keep their objects,
      // denominations, coordinates, rotations, and draw order for this hand.
      const incoming = chips.slice(previous.length);
      const addition = layout(incoming, positions.length, positions.length ? 12 : 24);
      if (addition.length) positions = positions.concat(addition);
      previous = chips.slice();
      return positions;
    }};
  }
  function updateElement(container, positions, chipHTML, handKey) {
    const doc = container.ownerDocument;
    const ns = 'http://www.w3.org/2000/svg';
    let svg = container.firstElementChild;
    const sameHand = container.dataset.pileHand === String(handKey);
    const existing = svg ? [...svg.children] : [];
    const changed = existing.some((node,i) => node.getAttribute('data-chip') !== JSON.stringify(positions[i]));
    let restored = false;
    if (!svg || !sameHand || changed) {
      svg = doc.createElementNS(ns, 'svg');
      svg.setAttribute('class', 'pot-chip-pile');
      svg.setAttribute('viewBox', `0 0 ${WIDTH} ${HEIGHT}`);
      svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      svg.setAttribute('aria-hidden', 'true');
      container.replaceChildren(svg);
      container.dataset.pileHand = String(handKey);
      restored = true;
    }
    for (const p of positions.slice(svg.children.length)) {
      const group = doc.createElementNS(ns, 'g');
      group.setAttribute('data-chip', JSON.stringify(p));
      group.setAttribute('transform', transform(p));
      const artwork = doc.createElementNS(ns, 'g');
      if (!restored) artwork.setAttribute('class', 'pot-chip-arrival');
      artwork.innerHTML = chipHTML(p.chip, CHIP_SIZE);
      group.appendChild(artwork);
      svg.appendChild(group);
    }
  }
  const api = {layout, render, create, updateElement, WIDTH, HEIGHT, CHIP_SIZE, MAX_VISIBLE};
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StacksPotPile = api;
})(typeof window === 'object' ? window : globalThis);
