# Deployment — November 18, 2026

Public table: https://satoshistacks.com/station100

One application release went out, after a day of server fixes made directly on
the box. Both are recorded here.

## Release: wallet alerts, books check, working backups

- Deployed at 6:34 p.m. Eastern on November 18 (23:34 UTC).
- Application commit: `eb774842b2934e9adec3b8774fa986ba211366cd`, pushed directly to `main`.
- Release: `/opt/satoshistacks-releases/eb77484`.
- Previous release: `/opt/satoshistacks-releases/69ccb98`.
- Node runtime: `/opt/satoshistacks-runtimes/node-v24.22.2-linux-x64/bin/node`.
- PM2 process: `satoshistacks`, now running as the `satoshistacks` user (see below).
- Active demo database: `/var/lib/satoshistacks/demo/satoshistacks.db` (unchanged path).
- Backup: `/var/backups/satoshistacks/release-20261118T233418Z`.
- Current manifest: `/opt/satoshistacks-releases/current-release.json`.
- Real money, deposits, and withdrawals remain disabled.

What changed. Backend only; the frontend is byte-for-byte the previous release.

- Operator alerts (`services/alerts.js`): wallet problems can be pushed to a
  phone by ntfy or an encrypted Nostr DM. No channel is configured on the
  server yet, and the alerts only run in real-money mode.
- Books check (`payments.booksCheck`): players must be owed exactly deposits
  received minus withdrawals paid minus identifier purchases. Unexplained sats
  owed, seen on two passes in a row, trip the circuit breaker. Also real-money
  mode only. The admin wallet view exposes the figures under `books`.
- Neither feature does anything in the current demo configuration.

Verification. GitHub CI passed on `eb77484`. The release was unpacked from that
exact commit, its locked dependencies were installed with the Node 24 runtime,
and all 367 tests passed on the server in a clean environment before the live
`.env` was copied in. The table had no players and no hand in progress. After
the switch: health returned 200, the process ran as `satoshistacks` from the new
release folder, the table page and four assets matched the commit byte for byte
from the public URL, and the page loaded in a browser with all six seats open
and no console errors.

One observer connection was dropped by the restart. The pre-switch check looks
at seated players and hands, not observers.

Not verified: the alerts and books check on the live server, since both need
real-money mode; restart after a server reboot under the new app user.

Rollback: `pm2 delete satoshistacks && pm2 start
/var/backups/satoshistacks/release-20261118T233418Z/rollback.config.json`
(previous release, same app user).

## Server changes made the same day (not part of the release)

Found by checking the live server against the deploy docs, which had never been
verified. Details and current state are in `deployment/README.md`, Security.

- Nightly backups: nothing scheduled the job and it pointed at a database the
  app no longer uses. Now `/etc/cron.d/satoshistacks-backup` runs
  `deployment/backup-satoshistacks.sh` at 03:00 UTC into
  `/var/backups/satoshistacks/nightly/`. A test restore matched the live
  database (62 players, 548 hands, 5 ledger rows).
- The original May 2026 mainnet-test database is preserved byte-for-byte in
  `/var/backups/satoshistacks/legacy-funded-db-raw-20261118T231100Z/`. Its
  ledger holds three refunded deposits (27,500 sats) and two unpaid invoices.
- The app runs as the unprivileged `satoshistacks` user instead of root. PM2
  config and rollback: `/var/backups/satoshistacks/nonroot-20261118T232818Z/`.
- Nginx: rate limits applied, dotfile and exploit-probe paths return 404, the
  landing page sends HSTS and related headers. Previous config:
  `/var/backups/satoshistacks/nginx-20261118T232740Z/`.
- The old checkout `/opt/SatoshiStacks` and the backups folder are root-only.
  The old `.env` there had been world-readable with the live admin token.
- The spend-capable LND macaroon was deleted from the server at the owner's
  request. LND would still honor a copy if one exists elsewhere.
