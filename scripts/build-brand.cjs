'use strict';
// Original, font-independent angular lettering and editable vector geometry.
const fs = require('node:fs');
const path = require('node:path');
const dest = path.join(__dirname, '../packages/frontend/img');
const glyphs = {
  S: 'M6 0H1L0 1V3L1 4H4.6V6.4H0V8H5L6 7V4.5L5 3H1.4V1.6H6Z',
  A: 'M0 8V1.5L1.5 0H4.5L6 1.5V8H4.5V5H1.5V8ZM1.5 3.5H4.5V1.6H1.5Z',
  T: 'M0 0H6V1.6H3.8V8H2.2V1.6H0Z',
  O: 'M1.3 0H4.7L6 1.3V6.7L4.7 8H1.3L0 6.7V1.3ZM1.5 1.6V6.4H4.5V1.6Z',
  H: 'M0 0H1.5V3.2H4.5V0H6V8H4.5V4.8H1.5V8H0Z',
  I: 'M0 0H6V1.5H3.8V6.5H6V8H0V6.5H2.2V1.5H0Z',
  C: 'M6 0H1.4L0 1.4V6.6L1.4 8H6V6.4H1.6V1.6H6Z',
  K: 'M0 0H1.6V3.2H2.5L4.4 0H6.2L3.8 4L6.2 8H4.4L2.5 4.8H1.6V8H0Z',
};
function lettering(word, x, y, sx, sy, tracking) {
  return [...word].map((letter, i) => `<path d="${glyphs[letter]}" transform="translate(${x + i * (6 * sx + tracking)} ${y}) scale(${sx} ${sy})"/>`).join('');
}
const spade = 'M0-55L-47-9Q-65 11-46 28Q-29 42-10 25L-16 49H16L10 25Q29 42 46 28Q65 11 47-9Z';
const bitcoin = 'M-6-21V23M-12-17H3Q23-17 19-5Q17 1 5 1H-6M5 1Q25 1 20 14Q17 20 3 20H-12M-3-25V-17M6-25V-17M-3 20V28M6 20V28';
const frame = 'M62 57H786L819 90H931V366L869 428H214L181 395H62Z';
const rails = 'M62 173V57H236M763 57H786L819 90H931V190M931 292V366L869 428H756M240 428H214L181 395H62V300';
const defs = `<defs>
<linearGradient id="metal" x2="40%" y2="100%"><stop stop-color="#15272f"/><stop offset=".55" stop-color="#08131c"/><stop offset="1" stop-color="#10202a"/></linearGradient>
<linearGradient id="type" x2="0%" y2="100%"><stop stop-color="#f0ffff"/><stop offset=".46" stop-color="#b8f5f7"/><stop offset="1" stop-color="#36b9cb"/></linearGradient>
<filter id="glow" x="-30%" y="-40%" width="160%" height="180%" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="4"/></filter>
<path id="frame" d="${frame}"/><path id="rails" d="${rails}"/>
<g id="satoshi" fill-rule="evenodd">${lettering('SATOSHI', 248, 100, 9, 8, 15)}</g>
<g id="stacks" fill-rule="evenodd">${lettering('STACKS', 154, 192, 16, 17, 23)}</g>
<path id="spade" d="${spade}"/><path id="bitcoin" d="${bitcoin}"/>
</defs>`;
function svg(table = false) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 500" role="img" aria-labelledby="title desc">
<title id="title">Satoshi Stacks</title><desc id="desc">Angular cyberpunk lettering, cyan circuit rails, magenta signal cuts, and a Bitcoin spade.</desc>
${defs}
${table ? '' : '<use href="#frame" fill="url(#metal)" stroke="#34505d" stroke-width="2"/>'}
${table ? '' : '<use href="#rails" fill="none" stroke="#24e6f0" stroke-width="9" opacity=".4" filter="url(#glow)"/>'}
<use href="#rails" fill="none" stroke="#57f4f4" stroke-width="3"/>
<path d="M83 180V82H193M907 270V354L858 403H809" fill="none" stroke="#42717b" stroke-width="1.5"/>
<path d="M837 65L854 82M861 65L878 82M885 65L902 82M98 415L116 433M122 415L140 433" fill="none" stroke="#fa428d" stroke-width="6"/>
<path d="M155 177H845" fill="none" stroke="#41d6e5" stroke-width="1" opacity=".35"/>
<use href="#satoshi" fill="#63e8ee"/>
${table ? '' : '<use href="#stacks" transform="translate(0 3)" fill="#127184"/>'}
<use href="#stacks" fill="${table ? '#a5e6e9' : 'url(#type)'}"/>
<path d="M154 256H213M827 290H845" fill="none" stroke="#fa428d" stroke-width="3"/>
<path d="M262 378H392L409 361H437M563 361H591L608 378H738" fill="none" stroke="#43cbd7" stroke-width="2"/>
<g transform="translate(500 389) scale(.76)">
<use href="#spade" fill="${table ? 'none' : '#0a1b25'}" stroke="#5ae9ed" stroke-width="3"/>
<use href="#bitcoin" fill="none" stroke="#ffb65b" stroke-width="4" stroke-linejoin="miter"/>
</g>
<path d="M278 390H322M678 390H722" stroke="#ffb65b" stroke-width="3"/>
</svg>\n`;
}
for (const name of ['neon-wordmark.svg', 'brand-wordmark.svg']) fs.writeFileSync(path.join(dest, name), svg());
// Felt has its own approved landing-page identity.
require('./build-table-brand.cjs');
const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-70 -70 140 140" role="img" aria-label="Satoshi Stacks"><path d="${spade}" fill="#0a1b25" stroke="#5ae9ed" stroke-width="5"/><path d="${bitcoin}" fill="none" stroke="#ffb65b" stroke-width="5" stroke-linejoin="miter"/><path d="M39-52L53-38" stroke="#fa428d" stroke-width="5"/></svg>\n`;
for (const name of ['brand-icon.svg', 'brand-mark.svg']) fs.writeFileSync(path.join(dest, name), icon);
