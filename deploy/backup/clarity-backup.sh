#!/usr/bin/env bash
# Nightly pg_dump of the clarity database to Garage S3. Keeps 14 dailies and 8 weeklies (Sunday dumps).
# systemd loads /etc/clarity-backup.env (S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_FORCE_PATH_STYLE,
# AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY) into the environment; this script never reads or writes that file.
set -euo pipefail

: "${S3_ENDPOINT:?}" "${S3_BUCKET:?}" "${AWS_ACCESS_KEY_ID:?}" "${AWS_SECRET_ACCESS_KEY:?}"
DB_NAME="${CLARITY_DB_NAME:-clarity}"
KEEP_DAILY="${CLARITY_BACKUP_KEEP_DAILY:-14}"
KEEP_WEEKLY="${CLARITY_BACKUP_KEEP_WEEKLY:-8}"

# An rclone remote named "garage", defined by environment only
export RCLONE_CONFIG_GARAGE_TYPE=s3
export RCLONE_CONFIG_GARAGE_PROVIDER=Other
export RCLONE_CONFIG_GARAGE_ENDPOINT="$S3_ENDPOINT"
export RCLONE_CONFIG_GARAGE_REGION="${S3_REGION:-garage}"
export RCLONE_CONFIG_GARAGE_ACCESS_KEY_ID="$AWS_ACCESS_KEY_ID"
export RCLONE_CONFIG_GARAGE_SECRET_ACCESS_KEY="$AWS_SECRET_ACCESS_KEY"
export RCLONE_CONFIG_GARAGE_FORCE_PATH_STYLE="${S3_FORCE_PATH_STYLE:-true}"
export RCLONE_CONFIG_GARAGE_NO_CHECK_BUCKET=true
remote="garage:${S3_BUCKET}"

work="$(mktemp -d)"
trap 'rm -r -- "$work"' EXIT
name="clarity-$(date -u +%Y-%m-%d).dump"

pg_dump --format=custom --host=/var/run/postgresql --dbname="$DB_NAME" --file="$work/$name"
# A dump that pg_restore cannot list is not uploaded
pg_restore --list "$work/$name" > /dev/null

rclone copyto "$work/$name" "$remote/daily/$name"
if [ "$(date -u +%u)" = 7 ]; then
  rclone copyto "$work/$name" "$remote/weekly/$name"
fi

prune() {
  local prefix="$1" keep="$2"
  rclone lsf --files-only "$remote/$prefix/" | { grep -E '^clarity-[0-9]{4}-[0-9]{2}-[0-9]{2}\.dump$' || true; } | sort | head -n "-$keep" |
    while read -r old; do
      rclone deletefile "$remote/$prefix/$old"
    done
}
prune daily "$KEEP_DAILY"
prune weekly "$KEEP_WEEKLY"

echo "[backup] uploaded $name ($(stat -c %s "$work/$name") bytes)"
