/* Resolution-independent artwork for the Satoshi Stacks house deck. */
(function (root) {
'use strict';
// Each suit is drawn around (0,0) in a roughly 26 × 28 box and is built to keep
// its own silhouette when it is only a few pixels tall:
//   spade   – one sharp point on top, smooth shoulders, flared foot
//   club    – three separate round lobes with open notches between them
//   heart   – two round lobes with a deep cleft, pointed bottom
//   diamond – four sharp points joined by inward-curving sides
// Each face-up card also carries a suit-s/h/d/c class so styles.css can give
// clubs and diamonds their own colours for the optional four-color deck.
const SUITS = {
  s: { name: 'spades', path: 'M0-14C-2-8.5-12.5-3.5-12.5 3.5C-12.5 7.6-9.6 10.2-6.2 10.2C-3.9 10.2-2 9-.9 7.1C-1.2 9.8-2.6 11.8-5.2 13.5H5.2C2.6 11.8 1.2 9.8.9 7.1C2 9 3.9 10.2 6.2 10.2C9.6 10.2 12.5 7.6 12.5 3.5C12.5-3.5 2-8.5 0-14Z' },
  h: { name: 'hearts', path: 'M0 13.5C-2.5 9-13 3.5-13-4.5C-13-9-9.9-12.5-6.5-12.5C-3.4-12.5-1-10.3 0-6.6C1-10.3 3.4-12.5 6.5-12.5C9.9-12.5 13-9 13-4.5C13 3.5 2.5 9 0 13.5Z' },
  d: { name: 'diamonds', path: 'M0-14C2.4-8.6 6-4.2 11.5 0C6 4.2 2.4 8.6 0 14C-2.4 8.6-6 4.2-11.5 0C-6-4.2-2.4-8.6 0-14Z' },
  c: { name: 'clubs', path: 'M-5.4-7a5.4 5.4 0 1 0 10.8 0a5.4 5.4 0 1 0-10.8 0ZM-12 1.8a5.4 5.4 0 1 0 10.8 0a5.4 5.4 0 1 0-10.8 0ZM1.2 1.8a5.4 5.4 0 1 0 10.8 0a5.4 5.4 0 1 0-10.8 0ZM0-7-6.6 1.8H6.6ZM0 0C-.5 6-2.4 10.8-5.6 13.5H5.6C2.4 10.8.5 6 0 0Z' }
};
// Positions are in a fixed 100 × 145 drawing space, independent of viewport size.
const PIPS = {
  2: [[50,37],[50,108]],
  3: [[50,37],[50,72.5],[50,108]],
  4: [[33,37],[67,37],[33,108],[67,108]],
  5: [[33,37],[67,37],[50,72.5],[33,108],[67,108]],
  6: [[33,37],[67,37],[33,72.5],[67,72.5],[33,108],[67,108]],
  7: [[33,37],[67,37],[50,54.75],[33,72.5],[67,72.5],[33,108],[67,108]],
  8: [[33,37],[67,37],[50,54.75],[33,72.5],[67,72.5],[50,90.25],[33,108],[67,108]],
  9: [[33,37],[67,37],[33,60.5],[67,60.5],[50,72.5],[33,84.5],[67,84.5],[33,108],[67,108]],
  T: [[33,37],[67,37],[50,48.75],[33,60.5],[67,60.5],[33,84.5],[67,84.5],[50,96.25],[33,108],[67,108]]
};
function suit(s, x, y, scale = 1, flip = false) {
  return `<path d="${SUITS[s].path}" transform="translate(${x} ${y}) scale(${scale})${flip ? ' rotate(180)' : ''}" fill="currentColor"/>`;
}
function index(rank, s) {
  return `<text x="12" y="22" text-anchor="middle" class="deck-rank" font-size="22">${rank}</text>${suit(s,12,36,0.68)}`;
}
// Small cards drop the pips and court figures for one rank and one large suit.
// "stack" keeps both in the left half, which stays visible when cards overlap.
function glance(rank, s, stack) {
  const size = rank === '10' ? 44 : 54;
  return `<text x="30" y="50" text-anchor="middle" class="deck-rank" font-size="${size}">${rank}</text>`
    + (stack ? suit(s,30,95,1.85) : suit(s,59,96,2.3));
}
function court(rank, s) {
  // Wordmark palette: sun yellow and ink on the card's own paper.
  const gold = '#ffc72c', navy = '#1a1a2e', paper = '#fffdf6';
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
    ? `<path d="M72 71V49M72 59 66 54M72 64 78 57" fill="none" stroke="${gold}" stroke-width="2"/>${suit(s,72,42,0.6)}`
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
  // House back: clubhouse navy, orange lattice, sun-yellow trim.
  return `<rect x="6" y="6" width="88" height="133" rx="5" fill="#232a5c"/>
    <svg x="9" y="9" width="82" height="127" viewBox="9 9 82 127"><g stroke="#f26522" stroke-width="0.9" opacity="0.5">${lattice}</g></svg>
    <rect x="10" y="10" width="80" height="125" rx="3" fill="none" stroke="#ffc72c" stroke-width="1.6"/>
    <path d="M50 34 77 72.5 50 111 23 72.5Z" fill="#1a1a2e" stroke="#ffc72c" stroke-width="2"/>
    <text x="50" y="84" fill="#ffc72c" font-family="ui-rounded,'SF Pro Rounded',-apple-system,'Segoe UI',Arial,sans-serif" font-weight="800" font-size="34" text-anchor="middle">₿</text>
    <g fill="#ffc72c"><path d="m50 17 3.5 5.5-3.5 5.5-3.5-5.5Zm0 100 3.5 5.5-3.5 5.5-3.5-5.5Z"/></g>`;
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
  else if (compact) art = glance(rank,s,true);
  else {
    art = index(rank,s) + `<g transform="rotate(180 50 72.5)">${index(rank,s)}</g>`;
    if (PIPS[r]) {
      // Crowded faces use smaller pips so neighbouring suits never touch.
      const pip = PIPS[r].length >= 7 ? 0.6 : 0.72;
      art += PIPS[r].map(([x,y]) => suit(s,x,y,pip,y>72.5)).join('');
    }
    else if (r === 'A') art += suit(s,50,71,1.95);
    else art += court(r,s);
    // styles.css swaps to the glance face when the card itself is narrow.
    art = `<g class="deck-full">${art}</g><g class="deck-glance">${glance(rank,s,false)}</g>`;
  }
  return `<div class="card ${hidden ? 'face-down' : `${'hd'.includes(s) ? 'red' : 'black'} suit-${s}`} ${sizeClass}" role="img" aria-label="${label}"><svg class="deck-art" viewBox="0 0 100 145" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">${art}</svg></div>`;
}
const api = { renderCardHTML };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.SatoshiDeck = api;
})(typeof window !== 'undefined' ? window : globalThis);
