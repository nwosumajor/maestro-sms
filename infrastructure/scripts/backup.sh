#!/usr/bin/env bash
# =============================================================================
# backup.sh — logical backup of the SMS Postgres database
# =============================================================================
# Takes a compressed custom-format pg_dump (restorable selectively with
# pg_restore) and prunes dumps older than BACKUP_RETENTION_DAYS.
#
# This is the SELF-HOSTED / compose path and the source for restore drills.
# On AWS, RDS automated backups (14-day PITR) + the AWS Backup plan are the
# primary mechanism — but a logical dump is still what you restore INTO a
# scratch database to PROVE the data is recoverable (see restore-drill.sh).
#
# CLIENT VERSION MATTERS: a pg_dump NEWER than the server emits settings the
# older server rejects on restore (e.g. PG17+ writes `SET transaction_timeout`,
# which a PG16 server refuses). Always dump with a client whose major version
# MATCHES the server. Set PG_CONTAINER to run the tools inside the database
# container, which guarantees the match:
#   PG_CONTAINER=sms-postgres-1 ./backup.sh
#
# Usage:
#   DATABASE_URL=postgres://user:pass@host:5432/sms ./backup.sh [outdir]
#   PG_CONTAINER=sms-postgres-1 DATABASE_URL=… ./backup.sh
# =============================================================================
set -euo pipefail

OUT_DIR="${1:-${BACKUP_DIR:-./backups}}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "backup: DATABASE_URL is required (use the PRIVILEGED/migrate role — the" >&2
  echo "        least-privilege app role cannot read every table under RLS)." >&2
  exit 2
fi

mkdir -p "$OUT_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="$OUT_DIR/sms-${STAMP}.dump"

echo "[backup] dumping to $FILE"
if [ -n "${PG_CONTAINER:-}" ]; then
  # Version-matched client: run pg_dump INSIDE the database container and
  # stream the dump out to the host.
  docker exec -i "$PG_CONTAINER" pg_dump --format=custom --compress=9 \
    --no-owner --no-privileges "$DATABASE_URL" > "$FILE"
else
  SERVER_MAJOR=$(psql "$DATABASE_URL" -tAc "SHOW server_version_num;" | cut -c1-2)
  CLIENT_MAJOR=$(pg_dump --version | grep -oE '[0-9]+' | head -1)
  if [ -n "$SERVER_MAJOR" ] && [ "$CLIENT_MAJOR" -gt "$SERVER_MAJOR" ]; then
    echo "[backup] WARNING: pg_dump $CLIENT_MAJOR is NEWER than server $SERVER_MAJOR." >&2
    echo "[backup]          The dump may fail to restore. Use PG_CONTAINER=… to" >&2
    echo "[backup]          dump with a version-matched client." >&2
  fi
  pg_dump --format=custom --compress=9 --no-owner --no-privileges \
    --file="$FILE" "$DATABASE_URL"
fi

SIZE=$(du -h "$FILE" | cut -f1)
echo "[backup] wrote $FILE ($SIZE)"

# Prune old dumps. Retention is deliberately conservative — pruning happens
# only AFTER the new dump succeeded (set -e above), so a failed run never
# destroys the previous good backup.
find "$OUT_DIR" -name 'sms-*.dump' -type f -mtime "+${RETENTION_DAYS}" -print -delete \
  | sed 's/^/[backup] pruned /' || true

echo "[backup] done. Verify it: ./restore-drill.sh $FILE"
