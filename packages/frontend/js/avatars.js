/* House avatars: a stand-in for players who have no Nostr profile picture
   (or whose picture fails to load). A player's own picture is always preferred.
   The seed selects a colour and an accessory; the face is fixed — it does not
   react to play. Output is static SVG built from fixed fragments — the seed is
   hashed and never copied into markup. */
(function(root) {
  'use strict';
  const PALETTE = [
    { base: '#f26522', dark: '#b6410c', face: '#ffd9b8' }, // orange
    { base: '#ffc72c', dark: '#c68f00', face: '#fff3c4' }, // yellow
    { base: '#22b8a7', dark: '#127a70', face: '#c9f5ee' }, // teal
    { base: '#3fa9f5', dark: '#1f6fb4', face: '#d3ecff' }, // sky
    { base: '#ff5c8a', dark: '#c22f5c', face: '#ffd6e2' }, // pink
    { base: '#9b6bff', dark: '#6238c7', face: '#e5d9ff' }, // violet
    { base: '#6ccb5f', dark: '#3d8f33', face: '#dcf6d6' }, // green
    { base: '#ef4e4e', dark: '#ad2727', face: '#ffd5d0' }, // red
  ];
  const ACCESSORIES = ['none', 'visor', 'cap', 'headphones', 'bowtie', 'beanie', 'crown', 'antenna'];
  const INK = '#1a1a2e';

  // FNV-1a: stable across sessions and platforms; not security sensitive.
  function hash(value) {
    let h = 0x811c9dc5;
    const text = String(value ?? '');
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }
  function traits(seed) {
    const h = hash(seed);
    return {
      color: PALETTE[h % PALETTE.length],
      accessory: ACCESSORIES[(h >>> 8) % ACCESSORIES.length],
      eyeGap: 13 + ((h >>> 16) % 4),      // 13–16
      blush: ((h >>> 20) & 1) === 1,
      tilt: ((h >>> 21) % 5) - 2,          // -2..2 degrees of personality
    };
  }

  function face(gap) {
    const y = 50;
    const eye = x => `<ellipse cx="${x}" cy="${y}" rx="4.6" ry="5.4" fill="${INK}"/><circle cx="${x + 1.5}" cy="${y - 1.9}" r="1.5" fill="#fff"/>`;
    return eye(50 - gap) + eye(50 + gap) +
      `<path d="M42 63Q50 71 58 63" fill="none" stroke="${INK}" stroke-width="3" stroke-linecap="round"/>`;
  }
  function accessory(kind, color) {
    switch (kind) {
      case 'visor': return `<path d="M24 38Q50 16 76 38L78 44Q50 30 22 44Z" fill="#1fa67a" stroke="${INK}" stroke-width="2.2" stroke-linejoin="round"/><path d="M28 37Q50 21 72 37" fill="none" stroke="#ffffff66" stroke-width="2"/>`;
      case 'cap': return `<path d="M27 37Q29 17 50 17Q71 17 73 37Z" fill="${INK}"/><path d="M27 37Q52 30 82 39Q84 43 78 43Q52 36 27 41Z" fill="#ffc72c" stroke="${INK}" stroke-width="2"/><circle cx="50" cy="17.5" r="3" fill="#ffc72c" stroke="${INK}" stroke-width="1.6"/>`;
      case 'headphones': return `<path d="M22 50Q22 20 50 20Q78 20 78 50" fill="none" stroke="${INK}" stroke-width="5" stroke-linecap="round"/><rect x="15" y="43" width="12" height="20" rx="5" fill="#ff5c8a" stroke="${INK}" stroke-width="2.2"/><rect x="73" y="43" width="12" height="20" rx="5" fill="#ff5c8a" stroke="${INK}" stroke-width="2.2"/>`;
      case 'bowtie': return `<path d="M50 79L37 72V86ZM50 79L63 72V86Z" fill="#ef4e4e" stroke="${INK}" stroke-width="2" stroke-linejoin="round"/><circle cx="50" cy="79" r="3.2" fill="#ffc72c" stroke="${INK}" stroke-width="1.6"/>`;
      case 'beanie': return `<path d="M26 39Q26 15 50 15Q74 15 74 39Z" fill="${color.dark}" stroke="${INK}" stroke-width="2.2"/><rect x="23" y="34" width="54" height="9" rx="4.5" fill="#fff8e7" stroke="${INK}" stroke-width="2.2"/><circle cx="50" cy="13" r="5" fill="#fff8e7" stroke="${INK}" stroke-width="2"/>`;
      case 'crown': return `<path d="M31 36L28 18 40 27 50 13 60 27 72 18 69 36Z" fill="#ffc72c" stroke="${INK}" stroke-width="2.2" stroke-linejoin="round"/><circle cx="50" cy="29" r="2.6" fill="#ef4e4e"/>`;
      case 'antenna': return `<path d="M50 30V15" stroke="${INK}" stroke-width="2.6" stroke-linecap="round"/><circle cx="50" cy="12" r="5" fill="#2fd3a8" stroke="${INK}" stroke-width="2"/>`;
      default: return '';
    }
  }

  /** Static SVG markup for a player's house avatar. */
  function render(seed) {
    const t = traits(seed);
    const c = t.color;
    // Eight cream edge inserts make the body read as a poker chip at any size.
    const inserts = `<circle cx="50" cy="50" r="43" fill="none" stroke="#fff8e7" stroke-width="8" stroke-dasharray="14 19.77" stroke-dashoffset="7"/>`;
    const blush = t.blush ? `<ellipse cx="${50 - t.eyeGap - 7}" cy="60" rx="5" ry="3" fill="#ff7a8a" opacity=".45"/><ellipse cx="${50 + t.eyeGap + 7}" cy="60" rx="5" ry="3" fill="#ff7a8a" opacity=".45"/>` : '';
    return `<svg class="chip-buddy" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">` +
      `<circle cx="50" cy="50" r="48" fill="${c.base}" stroke="${INK}" stroke-width="3"/>${inserts}` +
      `<circle cx="50" cy="50" r="35" fill="${c.face}" stroke="${c.dark}" stroke-width="2.5"/>` +
      `<g transform="rotate(${t.tilt} 50 50)">${blush}${face(t.eyeGap)}${accessory(t.accessory, c)}</g></svg>`;
  }

  const api = { render, traits, hash, PALETTE, ACCESSORIES };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StacksAvatars = api;
})(typeof window === 'object' ? window : globalThis);
