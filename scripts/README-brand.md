# Landing-page lettering for the table and header

`packages/frontend/img/table-wordmark.svg` reproduces the public landing-page
identity: orange SATOSHI, yellow STACKS, dark outline and offset shadow, with
transparent surroundings. No frame, chips, or Bitcoin symbol.

The header and login popup show the original colors. Felt CSS reduces the logo to 48% of table
width, applies 80% grayscale and soft-light blending, and fades it from 42%
opacity while waiting to 12% during hands. Mobile uses a smaller bounded layer.
Compact icons retain their separate existing assets.

Run `node scripts/build-table-brand.cjs` to rebuild the SVG. Its editable path
contours live in `scripts/table-lettering.json`; no font installation or network
request is required at runtime or rebuild time. These Lilita One outlines match
the landing page at 104px, 2px / 6px letter spacing and .92 line height, with
#F26522, #FFC72C, #1A1A2E, a 3px outline and a 6px shadow. Font licensing is in
`scripts/licenses/Lilita-One-OFL.txt`.
