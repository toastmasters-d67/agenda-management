#!/usr/bin/env bash
# pg_dump of the compose `db` service onto the separate backup disk.
# Nightly at 03:30 Asia/Taipei (VM clock is UTC), keeps 14 days; deploy's crontab:
#   30 19 * * * /srv/club-management/backup.sh >> /srv/club-management/backup.log 2>&1
# remote-deploy.sh also calls it as `backup.sh pre-deploy` before migrating.
set -euo pipefail
cd /srv/club-management
BACKUP_DIR=/mnt/backup-disk/club-management
LABEL=${1:-nightly}
mkdir -p "$BACKUP_DIR"
STAMP=$(TZ=Asia/Taipei date +%Y%m%d-%H%M%S)
OUT="$BACKUP_DIR/agenda-$LABEL-$STAMP.dump"
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$OUT.tmp"
mv "$OUT.tmp" "$OUT"
find "$BACKUP_DIR" -name 'agenda-*.dump' -mtime +14 -delete
echo "$(date -Is) backup ok: $(basename "$OUT")"
