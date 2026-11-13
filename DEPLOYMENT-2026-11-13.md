# Phone gameplay deployment — November 13, 2026

Public table: https://satoshistacks.com/station100

- Deployed at 4:18 p.m. Eastern (21:18 UTC).
- Application commit: `de4fb2a1356e32764dce72af190327925256139c`.
- Branch: `codex/mvp-readiness`.
- Release: `/opt/satoshistacks-releases/de4fb2a`.
- Previous application release: `/opt/satoshistacks-releases/fd10172`, with frontend updates through `421b5fb`.
- Node runtime: `/opt/satoshistacks-runtimes/node-v24.22.2-linux-x64/bin/node`.
- PM2 process: `satoshistacks`; script, working directory, and interpreter point to the new release.
- Active demo database: `/var/lib/satoshistacks/demo/satoshistacks.db`.
- Backup: `/var/backups/satoshistacks/release-20261113T211840Z`.
- Current manifest: `/opt/satoshistacks-releases/current-release.json`.
- Real money, deposits, and withdrawals remain disabled.

All 271 tests passed on the server before the live configuration was copied into the release. A separate in-memory demo server completed an authenticated phone-header hand through showdown, checked private hole cards and saved history, restored a seat, and rejected a revoked session. This test did not use the public table or its database.

The live table had no seated players or hand in progress before the switch. The demo database backup passed SQLite integrity checks. The backup includes the prior deployment manifest, PM2 dump, process configuration, and rollback ecosystem file. The original funded database, landing page, and Nginx configuration were retained.

Public HTTPS health and the deployed HTML were checked. The public phone stylesheet, responsive layout script, and application script matched the release byte-for-byte. A 390 × 844 browser viewport loaded the new phone layout, connected as an observer, displayed six selectable seats, and reported no browser warnings or errors.

Rollback: use the protected `rollback.config.json` in the backup directory to restore the previous PM2 application, and restore the backed-up current-release manifest. Preserve the active demo database when rolling back application code.
