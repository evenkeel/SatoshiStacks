# Live demo deployment — November 10, 2026

Public table: https://satoshistacks.com/station100

- Deployed at 3:44 p.m. Eastern (20:44 UTC).
- Application commit: `131b0de920588172185fe40a6c6b981a04bee670`.
- Release: `/opt/satoshistacks-releases/131b0de`.
- Previous release: `/opt/satoshistacks-releases/4b5a319`.
- Node runtime: `/opt/satoshistacks-runtimes/node-v24.22.2-linux-x64/bin/node`.
- PM2 process: `satoshistacks`; script and working directory use the new release.
- Active demo database: `/var/lib/satoshistacks/demo/satoshistacks.db`.
- Backup: `/var/backups/satoshistacks/release-20261110T204407Z` (integrity-checked
  demo database, previous manifest, previous PM2 dump, and rollback ecosystem file).
- Current manifest: `/opt/satoshistacks-releases/current-release.json`.
- Real money, deposits, and withdrawals remain disabled.
- The original funded database, landing page, and Nginx configuration were retained.

All 255 tests passed on the server with the deployment environment isolated.
The public HTTPS page returned 200, loaded the new vector table and neon sign,
used the latest stylesheet/script versions, connected as an observer, and
defaulted to hand-summary chat. The live site was verified in a browser.

The November 9 push had updated GitHub and passed CI, but had not been deployed;
the server was still running `4b5a319`. GitHub CI currently validates code only.
Future pushes require a separate deployment and public-site verification.

Demo bot tooling is included in the release but was not started on the public
table; local preview bots are separate from the public service.
