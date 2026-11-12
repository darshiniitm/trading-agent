#!/usr/bin/env bash
# Weekly pg_dump of Supabase to the GCS bucket (second copy of the forward-test history). Run by screener-backup.timer.
# Uses the VM's attached service account (Storage Object Creator on the bucket); no key file. Needs: postgresql-client, gsutil/gcloud.
set -euo pipefail
BUCKET="${BACKUP_BUCKET:?e.g. gs://engine-backups}"
DB_URL_FILE="${DB_URL_FILE:-/srv/screener/secrets/supabase_db_url}"   # root-only file written at bootstrap, never in Git
out="$(mktemp -d)"; trap 'rm -rf "$out"' EXIT
f="$out/supabase-$(date -u +%F).dump"
pg_dump --format=custom --no-owner --dbname="$(cat "$DB_URL_FILE")" --file="$f"
gcloud storage cp "$f" "$BUCKET/$(basename "$f")"
echo "backup uploaded: $BUCKET/$(basename "$f")"
