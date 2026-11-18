#!/bin/bash
# Nightly SatoshiStacks database backup. Installed by harden.sh as
# /usr/local/bin/backup-satoshistacks.sh and run from /etc/cron.d.
#
# Backs up every database under /var/lib/satoshistacks/<name>/satoshistacks.db
# (plus any paths in EXTRA_DB_PATHS) to /var/backups/satoshistacks/nightly/.
# Each copy is taken with VACUUM INTO (consistent while the app is running),
# integrity-checked, compressed, and kept for 30 days.
#
# Exits non-zero and logs FAILED if any database could not be backed up, or if
# the database the running app uses is not one of the databases backed up.
set -uo pipefail
export HOME="${HOME:-/root}"
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"

BACKUP_DIR="${BACKUP_DIR:-/var/backups/satoshistacks/nightly}"
LOGFILE="${LOGFILE:-/var/log/satoshistacks-backup.log}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
DB_GLOB="${DB_GLOB:-/var/lib/satoshistacks/*/satoshistacks.db}"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
FAILED=0

log() { echo "$(date -u '+%Y-%m-%d %H:%M:%S UTC'): $*" >> "$LOGFILE"; }

mkdir -p "$BACKUP_DIR" && chmod 700 "$BACKUP_DIR" || { log "FAILED — cannot create $BACKUP_DIR"; exit 1; }

# shellcheck disable=SC2206
DBS=( $DB_GLOB ${EXTRA_DB_PATHS:-} )
FOUND=()
for db in "${DBS[@]}"; do [ -f "$db" ] && FOUND+=("$db"); done
if [ "${#FOUND[@]}" -eq 0 ]; then
    log "FAILED — no database found (looked for: $DB_GLOB ${EXTRA_DB_PATHS:-})"
    exit 1
fi

for db in "${FOUND[@]}"; do
    label=$(basename "$(dirname "$db")")
    out="$BACKUP_DIR/$label-$STAMP.db"
    rm -f "$out"
    if ! err=$(sqlite3 "$db" "VACUUM INTO '$out'" 2>&1); then
        log "FAILED — $db: could not copy: $err"; rm -f "$out"; FAILED=1; continue
    fi
    check=$(sqlite3 "$out" "PRAGMA integrity_check;" 2>&1)
    if [ "$check" != "ok" ]; then
        log "FAILED — $db: backup copy failed its integrity check: $check"; rm -f "$out"; FAILED=1; continue
    fi
    gzip -f "$out" && chmod 600 "$out.gz" || { log "FAILED — $db: could not compress"; FAILED=1; continue; }
    log "OK — $db -> $out.gz ($(stat -c%s "$out.gz") bytes)"
done

find "$BACKUP_DIR" -name '*.db.gz' -mtime +"$RETENTION_DAYS" -delete

# The app's database has moved before without this job following it. If PM2 is
# reachable, make sure the database the running app uses was among those copied.
if command -v pm2 >/dev/null 2>&1; then
    live=$(pm2 jlist 2>/dev/null | grep -o '"SATOSHISTACKS_DB_PATH":"[^"]*"' | head -1 | cut -d'"' -f4)
    if [ -n "$live" ] && [ "$live" != ":memory:" ]; then
        covered=0
        for db in "${FOUND[@]}"; do [ "$db" = "$live" ] && covered=1; done
        if [ "$covered" -eq 0 ]; then
            log "FAILED — the running app uses $live, which this job does not back up. Add it to EXTRA_DB_PATHS in /etc/cron.d/satoshistacks-backup."
            FAILED=1
        fi
    fi
fi

exit "$FAILED"
