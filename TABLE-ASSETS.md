# Table artwork contract

The desktop playfield is 1000 × 680 logical pixels. `desktop-table.js` fits a
1220 × 780 envelope (including seats and nameplates) below the account header.
Its tapered corners let the table grow beside chat and betting controls.
Desktop controls reserve fixed space even when hidden: betting uses a 520 ×
176 dock, with separate 280 × 48 rows for pre-actions and table actions.
The betting controls have no enclosing panel. Table bounds remain unchanged
between turns and when chat collapses; viewport and header changes still refit
the layout. All game elements scale with
that playfield. There is no desktop maximum size; very small windows retain
the composition at the cost of smaller text. Phones retain the watch-only layout.

All files live in `packages/frontend/img/`:

| Asset | Coordinates | Purpose |
| --- | --- | --- |
| `table-felt.svg` | viewBox `-24 -24 1048 728` | Felt and stitching, transparent exterior |
| `table-rail.svg` | same viewBox | Independent metal rail and trim |
| `table-wordmark.svg` | viewBox `-0.984 -77.736 435.968 184.456` | Landing-page orange/yellow lettering, dark outline and offset shadow; transparent surroundings |

The felt boundary is `x=0 y=0 width=1000 height=680 rx=500 ry=340`.
Both table images share the same bounds and overlay exactly. Keep 24 logical
pixels of transparent allowance around the boundary for the rail. Supply
replacement artwork on the same coordinate grid, with no players or controls.
The logo is a separate layer centered on the table, 48% of its width. It uses
80% grayscale and soft-light blending at 42% opacity, fading to 12% during
play to preserve card and pot readability.

Desktop avatar circles are 112 logical pixels in diameter. Community cards
are 100 × 145, personal face-up cards are 72 × 104.4, and opponent cards are
38 × 55.1 logical pixels. These sizes scale uniformly with the table; side-seat
hole cards sit further inward to clear the larger avatars.
Desktop nameplates are 152 logical pixels wide, with 14px names and 18px
balances. The dealer disc is 28px with a raised ivory face and engraved ring.
Display amounts use the ₿ sats prefix through `js/amounts.js`; monetary
number inputs and server payloads retain plain numeric values.
The community board always reserves five card widths plus four 6-pixel gaps,
with cards anchored to the left; dealing the turn or river never recenters
existing cards. The dealer station groups table options and observer waitlist
controls above the rail, outside the board and player-label areas. The waitlist
button comes first, above the dealer chips; queue position appears only after
joining. The pot uses a deterministic scattered pile (240 × 96 drawing space).
Settled chip positions, denominations, rotations, SVG nodes, and draw order
persist for the hand. Newly collected batches append on top, and collection
flights target the new chips' landing locations. Only new arrivals animate;
restoring a hand never replays arrivals. Initial snapshots sample up to 24
chips and later collections add up to 12 representatives, with a 96-chip
rendering cap. The numeric pot amount remains authoritative. A cleared pot,
new hand, or corrected snapshot resets the visual pile.

`bunker.css` owns the new atmosphere and desktop sizing overrides. Change the
table dimensions, seat envelope, and asset bounds together if changing its shape.
The legacy PNG signs remain as references. The table uses the landing page's
Lilita One lettering converted to paths, with no runtime font dependencies.
Rebuild it with `node scripts/build-table-brand.cjs`; editable contours and
font licensing are documented in `scripts/README-brand.md`. The header uses
the same lettering in full color; the login uses its separate identity asset.

## Live theme registration

`packages/frontend/js/table-themes.js` contains an allowlisted theme registry.
Each entry supplies `felt`, `rail`, `logo`, optional `roomImage`, room CSS,
accent color, and optional felt/rail color filters. Add an option with the same
ID to the Room theme selector in `index.html`. A room image uses `cover` and
can crop; the table layers always retain the playfield's proportions. New art
must use the table viewBox above and the logo's approximately 2.364:1 canvas. Avoid opaque
padding that would cover gameplay.

Themes preload their image assets before committing together. A failed load
retains the previous room, and rapid selections commit only the latest request.
Selections persist locally, with Neon Bunker as the default. Storage failures
do not block play. Themes change presentation only: they never recreate the
table, reconnect sockets, alter seats, read private cards, or change game state.

The initial Midnight Station and Classic Club themes reuse the vector layers
with different color treatments and room backgrounds. They demonstrate the
contract; future artist assets can replace their individual layer paths.
Card artwork stays in the existing house-deck renderer (`cards.js`), using
100 × 145 coordinates. Room selection currently leaves the deck unchanged;
any future deck skin must preserve rank/suit semantics, hidden-card handling,
accessible labels, card aspect ratio, and small-card readability.

## Arcade clubhouse layer (November 15)

`arcade.css` loads last and owns the current look. It keeps every coordinate
above except these:

- Your hole cards (78 logical px wide) sit above your nameplate at 64% / 93% − 96px,
  leaving your avatar and its turn ring visible.
- Side-seat wagers and the dealer disc for those seats sit at 87.5% / 12.5%, 61%.
- The pot pile box is 336 × 128; the pot pill and the result banner share the
  band under the board.
- Phones show 38px avatars: above the upper side plates, below the lower ones,
  and left of the top and hero plates. Wagers are labelled pills on the felt
  side of each seat; landscape moves them into the gaps beside the plates.

The felt and rail SVGs were redrawn on the same viewBox (padded navy rail,
orange piping, forty marquee bulbs spaced by arc length). Regenerate the bulbs
with any script that walks the 500 × 340 ellipse; nothing else depends on them.

Type is Lilita One (display) and Nunito (text), self-hosted as WOFF2 in
`packages/frontend/fonts/` with `font-display: swap` and system fallbacks. The
wordmark itself is still outlined paths. Licences: `scripts/licenses/`.

A seat shows the player's Nostr profile picture when they have one. Otherwise
`js/avatars.js` draws a house avatar as inline SVG on a 100 × 100 grid from a
hash of the player's public key. It is one fixed face per player and does not
react to play. Replacement art must keep `render(seed)`.
Chip artwork is selected by denomination in `app.js` (`CHIP_STYLE`); pot chips
from the server contribute only their value.
