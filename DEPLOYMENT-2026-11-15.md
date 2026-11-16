# Arcade clubhouse deployment — November 15, 2026

Public table: https://satoshistacks.com/station100

- Deployed at 9:59 p.m. Eastern on November 15 (02:59 UTC, November 16).
- Application commit: `4438c7524b0dbc2a2de111982f7e5f905d566c06`, fast-forwarded
  to `main` after the deployment was verified.
- Release: `/opt/satoshistacks-releases/4438c75`.
- Previous release: `/opt/satoshistacks-releases/de4fb2a`.
- Node runtime: `/opt/satoshistacks-runtimes/node-v24.22.2-linux-x64/bin/node`.
- PM2 process: `satoshistacks`; script, working directory, and interpreter point to the new release.
- Active demo database: `/var/lib/satoshistacks/demo/satoshistacks.db` (unchanged path).
- Backup: `/var/backups/satoshistacks/release-20261116T025910Z`.
- Current manifest: `/opt/satoshistacks-releases/current-release.json`.
- Real money, deposits, and withdrawals remain disabled.

GitHub CI passed on the commit. The release was unpacked from that exact commit,
its locked dependencies were installed with the Node 24 runtime, and all 331
tests passed on the server in an isolated environment before the live `.env`
was copied in. The running release stayed online during preparation.

Before the switch the live table had no seated players and no hand in progress
(one spectator). The demo database was backed up with SQLite's backup API and
passed its integrity check. The backup directory also holds the prior manifest,
the PM2 dump and process list, the new and rollback process configurations, and
the public HTML, `app.js` and `arcade.css` fetched after the switch.

After the switch: local and public HTTPS health returned ok; `/api/tables`
reported demo mode with deposits disabled; the public table HTML and twelve
assets (stylesheets, scripts, both fonts, table art) and `/admin.js` matched the
release byte-for-byte. A headless Chrome at 1440 × 900 and 390 × 844 loaded the
public table, connected as a spectator, showed six open seats and both fonts,
and reported no console warnings, errors or failed requests. The new process
has written nothing to its error log.

Not exercised on the live site: signing in, sitting down or playing a hand
(to avoid creating accounts on the public table), a physical phone, and the
admin dashboard behind its token.

Rollback: `pm2 delete satoshistacks && pm2 start rollback.config.json && pm2 save`
using the protected file in the backup directory, then restore the backed-up
`current-release.json`. Preserve the active demo database when rolling back
application code.
