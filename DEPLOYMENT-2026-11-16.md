# Deployments — November 16, 2026

Public table: https://satoshistacks.com/station100

Three releases went out on this day. The third is the one now running.

## Third release (current): card secrecy, one seat per network, admin cards withheld

- Deployed at 7:14 p.m. Eastern on November 16 (00:14 UTC on November 17).
- Application commit: `9a92d2a7e07e352105d5a538c282246aa09d70c6`, pushed
  directly to `main` (two commits: `e056cb3` and `9a92d2a`).
- Release: `/opt/satoshistacks-releases/9a92d2a`.
- Previous release: `/opt/satoshistacks-releases/1be918a`.
- Node runtime: `/opt/satoshistacks-runtimes/node-v24.22.2-linux-x64/bin/node`.
- PM2 process: `satoshistacks`; script, working directory, and interpreter point to the new release.
- Active demo database: `/var/lib/satoshistacks/demo/satoshistacks.db` (unchanged path).
- Backup: `/var/backups/satoshistacks/release-20261117T001457Z`.
- Current manifest: `/opt/satoshistacks-releases/current-release.json`.
- Real money, deposits, and withdrawals remain disabled.

What changed. This is the first release in several that changes the backend.

- The admin hand lookup no longer returns hole cards or the cards in the deal
  record while a hand is still being played. The full record is available once
  the hand is over. The admin page says so, and its script tag now carries a
  version because Nginx serves scripts as immutable for seven days.
- A second player on the same network is refused a seat at the table, on the
  demo path and on the real-money buy-in (before any sats are debited). A
  network is an IPv4 address or an IPv6 /64. A seated player whose connection
  moves onto another player's network keeps the seat and the event is written to
  the abuse log, as are refusals. `ONE_SEAT_PER_NETWORK=false` in `.env`
  switches the rule off; it is not set on the server, so the rule is on.
- The client no longer keeps a copy of the player's hole cards between states;
  it draws only what the server just sent.
- A new engine test plays 400 random hands and checks every payload sent to
  each seat, a spectator and a stranger for cards they may not see.

GitHub CI passed on `9a92d2a`. The release was unpacked from that exact commit,
its locked dependencies were installed with the Node 24 runtime, and all 349
tests passed on the server in an isolated environment before the live `.env`
was copied in. The running release stayed online during preparation.

Before the switch the live table had no seated players, no spectators and no
hand in progress. The demo database was backed up with SQLite's backup API at
the moment of the switch and passed its integrity check. The backup directory
also holds the prior manifest, the PM2 dump and process list, the new and
rollback process configurations, and the public HTML, `app.js` and `admin.js`
fetched after the switch.

After the switch: local and public HTTPS health returned ok; `/api/tables`
reported demo mode with deposits disabled; the public table HTML and 32 assets
(every stylesheet, script, icon and manifest the page references, both fonts and
the table art) matched the commit byte-for-byte, as did the admin page and its
script. The public `app.js` contains no hole-card cache. Requests without
credentials to the admin hand lookup and to personal hand histories returned
401. The built-in browser loaded the public table, connected as a spectator,
showed six open seats and reported no console messages. The new process has
written nothing to its error log. The landing page still answers.

The seating rule depends on the server seeing each player's real address. That
was checked: DNS points straight at the server (no proxy service in front), and
the live Nginx `/socket.io/` location passes `X-Forwarded-For`.

Not exercised on the live site: signing in, sitting down or playing a hand, so
neither the same-network refusal nor dealt cards were seen on production. They
were tested locally: the refusal through the socket tests with proxied
addresses, and dealt cards by a headless browser playing against bots with
every drawn card compared against the server's record. The admin dashboard
behind its token was not opened, so the withheld-cards notice was not seen live;
the endpoint behaviour is covered by a test. A physical phone was not used.

Rollback: `pm2 delete satoshistacks && pm2 start rollback.config.json && pm2 save`
using the protected file in the backup directory, then restore the backed-up
`current-release.json`. Preserve the active demo database when rolling back
application code.

## Second release: one table size, equal action buttons, four-color deck

- Deployed at 6:18 p.m. Eastern on November 16 (23:18 UTC).
- Application commit: `1be918ae6cebefea339d87bebee1fb1c4a201151`
  ([pull request 4](https://github.com/evenkeel/SatoshiStacks/pull/4)),
  fast-forwarded to `main` after the deployment was verified.
- Release: `/opt/satoshistacks-releases/1be918a`.
- Previous release: `/opt/satoshistacks-releases/d01d176`.
- Node runtime: `/opt/satoshistacks-runtimes/node-v24.22.2-linux-x64/bin/node`.
- PM2 process: `satoshistacks`; script, working directory, and interpreter point to the new release.
- Active demo database: `/var/lib/satoshistacks/demo/satoshistacks.db` (unchanged path).
- Backup: `/var/backups/satoshistacks/release-20261116T231737Z`.
- Current manifest: `/opt/satoshistacks-releases/current-release.json`.
- Real money, deposits, and withdrawals remain disabled.

What changed: the desktop betting controls moved into the bottom-right corner
beside the oval and the seat buttons above the message box, both reserved at all
times, so the table is the same size and in the same place watching, seated and
after standing up. Fold, Check/Call and Bet/Raise are three equal buttons. A
four-color deck (clubs green, diamonds blue) can be switched on from Table
options. Only frontend files, tests and the demo-bot script changed; the backend
is the same code as the previous release.

The first staging attempt, from commit `3f018f2`, was abandoned before anything
was switched: one backend test failed on the server. The cause was the test
itself, which crashed whenever its random all-in ended in a split pot (about one
run in thirty). Commit `1be918a` fixes that test; the staged `3f018f2` folder
was removed and never ran.

GitHub CI passed on `1be918a`. The release was unpacked from that exact commit,
its locked dependencies were installed with the Node 24 runtime, and all 344
tests passed on the server in an isolated environment before the live `.env`
was copied in. The running release stayed online during preparation.

Before the switch the live table had no seated players and no hand in progress
(two spectators). The demo database was backed up with SQLite's backup API at
the moment of the switch and passed its integrity check. The backup directory
also holds the prior manifest, the PM2 dump and process list, the new and
rollback process configurations, and the public HTML, `app.js`,
`desktop-table.js` and `arcade.css` fetched after the switch.

After the switch: local and public HTTPS health returned ok; `/api/tables`
reported demo mode with deposits disabled; the public table HTML and 31 assets
(every stylesheet, script, icon and manifest the page references, both fonts and
the table art) matched the commit byte-for-byte. The built-in browser at
1440 × 900 and 390 × 844 loaded the public table, connected as a spectator,
showed six open seats, the reserved betting dock and both four-color switches,
and reported no console messages or failed requests. The new process has
written nothing to its error log.

Not exercised on the live site: signing in, sitting down or playing a hand, so
the betting buttons and the four-color deck were not seen in play on production
(they were played locally against five bots at 1440 × 820 and 2000 × 1217); a
physical phone; and the admin dashboard behind its token.

Rollback: `pm2 delete satoshistacks && pm2 start rollback.config.json && pm2 save`
using the protected file in the backup directory, then restore the backed-up
`current-release.json`. Preserve the active demo database when rolling back
application code.

## First release: card suits, single brand and table scaling

- Deployed at 5:46 p.m. Eastern on November 16 (22:46 UTC).
- Application commit: `d01d1765d2364539945688be2cdf40113884ac0e`
  ([pull request 3](https://github.com/evenkeel/SatoshiStacks/pull/3)),
  fast-forwarded to `main` after the deployment was verified.
- Release: `/opt/satoshistacks-releases/d01d176`.
- Previous release: `/opt/satoshistacks-releases/4438c75`.
- Node runtime: `/opt/satoshistacks-runtimes/node-v24.22.2-linux-x64/bin/node`.
- PM2 process: `satoshistacks`; script, working directory, and interpreter point to the new release.
- Active demo database: `/var/lib/satoshistacks/demo/satoshistacks.db` (unchanged path).
- Backup: `/var/backups/satoshistacks/release-20261116T224621Z`.
- Current manifest: `/opt/satoshistacks-releases/current-release.json`.
- Real money, deposits, and withdrawals remain disabled.

What changed: all four card suits were redrawn and small cards show one rank
with one large suit; the earlier logos and the cyan accent taken from them were
removed, leaving the orange and yellow lettering as the only brand; and the
desktop table sizing and ambient chat feed from the responsive scaling work
went out with it. Only frontend files and brand scripts changed; the backend is
the same code as the previous release.

GitHub CI passed on the commit. The release was unpacked from that exact commit,
its locked dependencies were installed with the Node 24 runtime, and all 342
tests passed on the server in an isolated environment before the live `.env`
was copied in. The running release stayed online during preparation.

Before the switch the live table had no seated players, no spectators and no
hand in progress. The demo database was backed up with SQLite's backup API and
passed its integrity check. The backup directory also holds the prior manifest,
the PM2 dump and process list, the new and rollback process configurations, and
the public HTML, `cards.js` and `arcade.css` fetched after the switch.

After the switch: local and public HTTPS health returned ok; `/api/tables`
reported demo mode with deposits disabled; the public table HTML and 33 assets
(every stylesheet, script, icon and manifest the page references, both fonts,
the table art, and the deck preview's stylesheet and script) matched the commit
byte-for-byte. The five removed logo files return 404. The built-in browser at
1440 × 900 and 390 × 844 loaded the public table, connected as a spectator,
showed six open seats and both fonts, and reported no console messages or
failed requests. The new process has written nothing to its error log.

Not exercised on the live site: signing in, sitting down or playing a hand, so
dealt cards were not seen on production (they were checked locally with bots at
desktop and phone widths); a physical phone; and the admin dashboard behind its
token. `/deck-preview.html` is not publicly routed — Nginx answers that path
with the landing page, as before — so the deck preview remains a local page.

Rollback: `pm2 delete satoshistacks && pm2 start rollback.config.json && pm2 save`
using the protected file in the backup directory, then restore the backed-up
`current-release.json`. Preserve the active demo database when rolling back
application code.
