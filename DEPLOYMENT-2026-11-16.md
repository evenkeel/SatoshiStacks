# Card suits, single brand and table scaling deployment — November 16, 2026

Public table: https://satoshistacks.com/station100

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
