/* Resolution-independent artwork for the Satoshi Stacks house deck. */
(function (root) {
'use strict';
const SUITS = {
  s: { name: 'spades', path: 'M0-12C-4-7-11-3-11 3A6 6 0 0 0-2 8L-4 13H4L2 8A6 6 0 0 0 11 3C11-3 4-7 0-12Z' },
  h: { name: 'hearts', path: 'M0 12C-3 8-12 2-12-5C-12-13-3-15 0-8C3-15 12-13 12-5C12 2 3 8 0 12Z' },
  d: { name: 'diamonds', path: 'M0-14 10 0 0 14-10 0Z' },
  c: { name: 'clubs', path: 'M-3 7C-13 13-17-3-7-4C-12-17 12-17 7-4C17-3 13 13 3 7L5 13H-5Z' }
};
// Positions are in a fixed 100 × 145 drawing space, independent of viewport size.
const PIPS = {
  2: [[50,37],[50,108]],
  3: [[50,37],[50,72.5],[50,108]],
  4: [[32,37],[68,37],[32,108],[68,108]],
  5: [[32,37],[68,37],[50,72.5],[32,108],[68,108]],
  6: [[32,37],[68,37],[32,72.5],[68,72.5],[32,108],[68,108]],
  7: [[32,37],[68,37],[50,54.75],[32,72.5],[68,72.5],[32,108],[68,108]],
  8: [[32,37],[68,37],[50,54.75],[32,72.5],[68,72.5],[50,90.25],[32,108],[68,108]],
  9: [[32,37],[68,37],[32,60.5],[68,60.5],[50,72.5],[32,84.5],[68,84.5],[32,108],[68,108]],
  T: [[32,37],[68,37],[50,48.75],[32,60.5],[68,60.5],[32,84.5],[68,84.5],[50,96.25],[32,108],[68,108]]
};
function suit(s, x, y, scale = 1, flip = false) {
  return `<path d="${SUITS[s].path}" transform="translate(${x} ${y}) scale(${scale})${flip ? ' rotate(180)' : ''}" fill="currentColor"/>`;
}
function index(rank, s) {
  return `<text x="12" y="22" text-anchor="middle" class="deck-rank" font-size="22">${rank}</text>${suit(s,12,34,0.57)}`;
}
function court(rank, s) {
  const gold = '#b58b46', navy = '#20364d', paper = '#fffaf0';
  const headwear = rank === 'J'
    ? `<path d="M34 36Q37 24 59 29L65 36Z" fill="${navy}"/><path d="M39 29Q38 20 47 21L52 28" fill="${gold}"/><path d="M33 36H66" stroke="${gold}" stroke-width="3"/>`
    : `<path d="M35 34 32 23 42 28 49 18 56 28 66 23 62 34Z" fill="${gold}"/><path d="M36 30H61" stroke="${paper}"/><path d="M37 36H61" stroke="${navy}" stroke-width="2"/>`;
  const hair = rank === 'Q'
    ? `<path d="M38 36Q29 48 36 62L44 59 42 40M58 35Q68 44 62 61L54 59 57 39" fill="${gold}"/>`
    : `<path d="M38 35 36 47 42 51 43 36M56 35 62 39 62 50 57 52" fill="${navy}"/>`;
  const beard = rank === 'K' ? `<path d="M43 48 49 52 57 47 55 57 49 62 44 56Z" fill="${navy}"/><path d="M45 50 49 48 53 50" fill="none" stroke="${navy}"/>` : '';
  const accessory = rank === 'K'
    ? `<path d="M70 68V26L74 20 78 26V68" fill="${paper}" stroke="${gold}" stroke-width="1.3"/><path d="M66 57H81M74 25V58" stroke="${navy}" stroke-width="1.5"/>`
    : rank === 'Q'
    ? `<path d="M72 71V49M72 59 66 54M72 64 78 57" fill="none" stroke="${gold}" stroke-width="2"/><path d="M72 39C62 29 60 45 68 47C60 53 71 57 72 49C78 57 84 46 77 46C86 38 74 32 72 39Z" fill="currentColor"/><circle cx="72" cy="45" r="2" fill="${gold}"/>`
    : `<path d="M72 72V29L76 23 80 29 72 41" fill="${gold}" stroke="${navy}" stroke-width="1.2"/><path d="M68 54H79" stroke="${navy}" stroke-width="2"/>`;
  const half = `<path d="M24 73 29 61 43 55H56L69 62 76 73Z" fill="${navy}"/>
    <path d="M30 62 43 56 60 73H44Z" fill="currentColor"/>
    <path d="M31 62 43 57 59 73" fill="none" stroke="${gold}" stroke-width="1.4"/>
    <path d="M44 51V58L50 64 56 57V49" fill="${paper}" stroke="${navy}" stroke-width="1"/>
    ${hair}<path d="M42 35H57L59 43 56 45V50L50 55 43 51 40 42Z" fill="${paper}" stroke="${navy}" stroke-width="1.1"/>
    <path d="M44 40H48M54 40H57M51 41 50 46H53M48 49H53" fill="none" stroke="${navy}" stroke-width="1"/>
    ${beard}${headwear}${accessory}
    <path d="M60 67 65 63 71 66 69 72" fill="${paper}" stroke="${navy}"/>
    <path d="M25 73H75" stroke="${gold}"/>`;
  return `<rect x="24" y="18" width="52" height="109" rx="1" fill="${paper}" stroke="${gold}" stroke-width="0.7"/>
    ${half}<g transform="rotate(180 50 72.5)">${half}</g>`;
}
function back() {
  let lattice = '';
  for (let n = -140; n <= 140; n += 9) {
    lattice += `<path d="M8 ${n} 92 ${n+84}M8 ${n} 92 ${n-84}"/>`;
  }
  return `<rect x="6" y="6" width="88" height="133" rx="4" fill="#193248"/>
    <svg x="9" y="9" width="82" height="127" viewBox="9 9 82 127"><g stroke="#b7a16b" stroke-width="0.55" opacity="0.48">${lattice}</g></svg>
    <rect x="10" y="10" width="80" height="125" rx="2" fill="none" stroke="#c5aa72" stroke-width="0.8"/>
    <path d="M50 36 75 72.5 50 109 25 72.5Z" fill="#193248" stroke="#c5aa72" stroke-width="1.2"/>
    <path d="M50 42 70 72.5 50 103 30 72.5Z" fill="none" stroke="#c5aa72" stroke-width="0.6"/>
    <text x="50" y="83" fill="#dec38b" font-family="Georgia,serif" font-size="32" text-anchor="middle">₿</text>
    <g fill="#dec38b"><path d="m50 19 3 5-3 5-3-5Zm0 97 3 5-3 5-3-5Z"/></g>`;
}
function renderCardHTML(card, sizeClass = '') {
  const hidden = !card || card === '??';
  if (!hidden && !/^[2-9TJQKA][shdc]$/.test(card)) return renderCardHTML(null, sizeClass);
  const compact = sizeClass.split(/\s+/).includes('small');
  const r = hidden ? '' : card[0], s = hidden ? '' : card[1];
  const rank = r === 'T' ? '10' : r;
  const names = { A: 'Ace', K: 'King', Q: 'Queen', J: 'Jack', T: '10' };
  const label = hidden ? 'Face-down card' : `${names[r] || r} of ${SUITS[s].name}`;
  let art;
  if (hidden) art = back();
  else if (compact) art = `<text x="27" y="48" text-anchor="middle" class="deck-rank" font-size="43">${rank}</text>${suit(s,73,35,1.3)}`;
  else {
    art = index(rank,s) + `<g transform="rotate(180 50 72.5)">${index(rank,s)}</g>`;
    if (PIPS[r]) art += PIPS[r].map(([x,y]) => suit(s,x,y,0.72,y>72.5)).join('');
    else if (r === 'A') {
      art += suit(s,50,71,1.95);
      if (s === 's') art += `<path d="m50 63 4 8-4 8-4-8Z" fill="#fffdf8"/><text x="50" y="105" text-anchor="middle" font-family="Georgia,serif" font-size="4.6" letter-spacing="1.2" fill="#9a7945">SATOSHI STACKS</text>`;
    } else art += court(r,s);
  }
  return `<div class="card ${hidden ? 'face-down' : ('hd'.includes(s) ? 'red' : 'black')} ${sizeClass}" role="img" aria-label="${label}"><svg class="deck-art" viewBox="0 0 100 145" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">${art}</svg></div>`;
}
const api = { renderCardHTML };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.SatoshiDeck = api;
})(typeof window !== 'undefined' ? window : globalThis);
