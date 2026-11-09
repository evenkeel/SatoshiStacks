# Table artwork contract

The desktop playfield is 1000 × 680 logical pixels. `desktop-table.js` fits a
1220 × 820 envelope (including seats and nameplates) into the space between
the account header and visible utility panels. All game elements scale with
that playfield. There is no desktop maximum size; very small windows retain
the composition at the cost of smaller text. Phones retain the watch-only layout.

All files live in `packages/frontend/img/`:

| Asset | Coordinates | Purpose |
| --- | --- | --- |
| `table-felt.svg` | viewBox `-24 -24 1048 728` | Felt and stitching, transparent exterior |
| `table-rail.svg` | same viewBox | Independent metal rail and trim |
| `neon-wordmark.svg` | viewBox `0 0 640 200` | Transparent sign; editable backing, tubes, caption, and glow filter |

The felt boundary is `x=0 y=0 width=1000 height=680 rx=500 ry=340`.
Both table images share the same bounds and overlay exactly. Keep 24 logical
pixels of transparent allowance around the boundary for the rail. Supply
replacement artwork on the same coordinate grid, with no players or controls.
The logo is a separate layer centered on the table, 57% of its width; its
opacity drops during play to preserve card and pot readability.

Desktop avatar circles are 112 logical pixels in diameter. Community cards
are 100 × 145, personal face-up cards are 72 × 104.4, and opponent cards are
38 × 55.1 logical pixels. These sizes scale uniformly with the table; side-seat
hole cards sit further inward to clear the larger avatars.
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
The legacy PNG signs remain as references; the table, header, and login now use
the new vector sign. SVG typography uses Arial/Helvetica with a sans-serif
fallback and needs no downloaded font. For exact cross-platform letter shapes,
an artist can convert the editable lettering to paths in a final export.

## Live theme registration

`packages/frontend/js/table-themes.js` contains an allowlisted theme registry.
Each entry supplies `felt`, `rail`, `logo`, optional `roomImage`, room CSS,
accent color, and optional felt/rail color filters. Add an option with the same
ID to the Room theme selector in `index.html`. A room image uses `cover` and
can crop; the table layers always retain the playfield's proportions. New art
must use the table viewBox above and the logo's 3.2:1 canvas. Avoid opaque
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
