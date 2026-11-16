'use strict';
// Exact landing-page typography, converted to paths for font-independent felt art.
const fs = require('node:fs');
const path = require('node:path');
const letters = require('./table-lettering.json');
const outline = '#1a1a2e';
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${letters.viewBox}" role="img" aria-labelledby="title desc">
<title id="title">Satoshi Stacks</title>
<desc id="desc">Landing-page lettering: orange Satoshi above yellow Stacks, with a dark outline and offset shadow.</desc>
<defs><path id="satoshi" d="${letters.satoshi}"/><path id="stacks" d="${letters.stacks}"/></defs>
<g fill="${outline}" stroke="${outline}" stroke-width="3" stroke-linejoin="round" transform="translate(6 6)"><use href="#satoshi"/><use href="#stacks"/></g>
<g stroke="${outline}" stroke-width="3" stroke-linejoin="round" paint-order="stroke fill"><use href="#satoshi" fill="#f26522"/><use href="#stacks" fill="#ffc72c"/></g>
</svg>\n`;
const img = path.join(__dirname, '../packages/frontend/img');
fs.writeFileSync(path.join(img, 'table-wordmark.svg'), svg);
// Compact icon (browser tab, home screen): the wordmark's own first letter in
// its orange, with the yellow of STACKS as the offset shadow, on an ink tile.
const initial = letters.satoshi.split(/(?=M)/)[0];
const place = 'translate(61 61) scale(1.3) translate(-27.45 36.35)';
const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" role="img" aria-label="Satoshi Stacks">
<rect width="128" height="128" rx="28" fill="${outline}"/>
<path d="${initial}" transform="translate(8 8) ${place}" fill="#ffc72c"/>
<path d="${initial}" transform="${place}" fill="#f26522"/>
</svg>\n`;
fs.writeFileSync(path.join(img, 'brand-icon.svg'), icon);
