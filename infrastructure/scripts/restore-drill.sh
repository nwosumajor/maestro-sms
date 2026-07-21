#!/usr/bin/env bash
# =============================================================================
# restore-drill.sh — PROVE a backup is restorable (a backup you have never
# restored is not a backup)
# =============================================================================
# Restores a dump into a throwaway scratch database and asserts the restored
# copy is actually usable:
#   1. the restore itself succeeds,
#   2. the expected tables exist and carry rows,
#   3. RLS is still ENABLED on tenant tables (a restore that silently drops
#      row-level security would be a catastrophic, invisible regression),
#   4. tenant isolation still holds — the app role in tenant A cannot see
#      tenant B's rows in the RESTORED database.
# Drops the scratch DB at the end (keep it with KEEP_SCRATCH=1 to inspect).
#
# Set PG_CONTAINER to run pg_restore inside the database container, which
# guarantees the client version matches the server (a newer client's dump can
# fail to restore — this drill exists to catch exactly that).
#
# Usage:
#   ADMIN_URL=postgres://postgres:pass@host:5432/postgres \
#   APP_ROLE_PASSWORD=... ./restore-drill.sh path/to/sms-….dump
#   PG_CONTAINER=sms-postgres-1 ADMIN_URL=… ./restore-drill.sh …
# =============================================================================
set -euo pipefail

DUMP="${1:-}"
if [ -z "$DUMP" ] || [ ! -f "$DUMP" ]; then
  echo "restore-drill: usage: ADMIN_URL=… ./restore-drill.sh <dump-file>" >&2
  exit 2
fi
if [ -z "${ADMIN_URL:-}" ]; then
  echo "restore-drill: ADMIN_URL (superuser, e.g. .../postgres) is required" >&2
  exit 2
fi

SCRATCH="sms_restore_drill_$(date -u +%s)"
APP_ROLE="${APP_DB_USERNAME:-major_user}"
# Derive a connection URL to the scratch DB from ADMIN_URL by swapping the path.
SCRATCH_URL="$(echo "$ADMIN_URL" | sed -E "s#/[^/?]+(\\?|$)#/${SCRATCH}\\1#")"

cleanup() {
  if [ "${KEEP_SCRATCH:-0}" = "1" ]; then
    echo "[drill] KEEP_SCRATCH=1 — leaving $SCRATCH in place"
    return
  fi
  psql_run "$ADMIN_URL" -v ON_ERROR_STOP=0 -q \
    -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${SCRATCH}';" >/dev/null 2>&1 || true
  psql_run "$ADMIN_URL" -v ON_ERROR_STOP=0 -q -c "DROP DATABASE IF EXISTS \"${SCRATCH}\";" >/dev/null 2>&1 || true
  echo "[drill] scratch database dropped"
}
trap cleanup EXIT

fail() { echo "[drill] FAIL: $*" >&2; exit 1; }

# Route every client tool the SAME way: inside the DB container when
# PG_CONTAINER is set (guaranteeing a version match AND that the URLs are
# container-internal), on the host otherwise.
psql_run() { # psql_run <url> <args...>
  if [ -n "${PG_CONTAINER:-}" ]; then
    docker exec -i "$PG_CONTAINER" psql "$@"
  else
    psql "$@"
  fi
}

echo "[drill] creating scratch database $SCRATCH"
psql_run "$ADMIN_URL" -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE \"${SCRATCH}\";"

echo "[drill] restoring $DUMP"
# --no-owner: the dump may reference roles that differ per environment.
RESTORE_LOG=$(mktemp)
if [ -n "${PG_CONTAINER:-}" ]; then
  docker exec -i "$PG_CONTAINER" pg_restore --no-owner --no-privileges \
    --dbname="$SCRATCH_URL" < "$DUMP" >"$RESTORE_LOG" 2>&1 || true
else
  pg_restore --no-owner --no-privileges --dbname="$SCRATCH_URL" "$DUMP" >"$RESTORE_LOG" 2>&1 || true
fi
# pg_restore exits non-zero for ignorable warnings too, so judge by ERRORS in
# the log — but a genuine error (including a version-mismatch SET it could not
# execute) still fails the drill.
if grep -q "^pg_restore: error:" "$RESTORE_LOG"; then
  echo "[drill] restore errors:" >&2
  grep "^pg_restore: error:" "$RESTORE_LOG" | head -5 >&2
  rm -f "$RESTORE_LOG"
  fail "pg_restore reported errors"
fi
rm -f "$RESTORE_LOG"

# --- 2. tables + rows -------------------------------------------------------
TABLES=$(psql_run "$SCRATCH_URL" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';")
[ "$TABLES" -gt 50 ] || fail "expected >50 public tables in the restore, found $TABLES"
echo "[drill] ok: $TABLES tables restored"

SCHOOLS=$(psql_run "$SCRATCH_URL" -tAc "SELECT count(*) FROM school;")
[ "$SCHOOLS" -ge 1 ] || fail "no rows in school — the restore looks empty"
echo "[drill] ok: $SCHOOLS school row(s)"

# --- 3. RLS still enabled ---------------------------------------------------
# `ultimate_participant` is the ONE documented RLS-exempt table: the
# cross-school Ultimate arena is cross-tenant BY DESIGN and carries no PII
# (see prisma/rls/21_ultimate_rls.sql and the RLS coverage gate in
# apps/api/test/rls.e2e-spec.ts, which exempts the same table).
RLS_OFF=$(psql_run "$SCRATCH_URL" -tAc "
  SELECT count(*) FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname='public' AND c.relkind IN ('r','p') AND c.relispartition = false
    AND c.relrowsecurity = false
    AND c.relname <> 'ultimate_participant'
    AND EXISTS (SELECT 1 FROM information_schema.columns col
                WHERE col.table_schema='public' AND col.table_name=c.relname
                  AND col.column_name='schoolId');")
[ "$RLS_OFF" = "0" ] || fail "$RLS_OFF tenant table(s) came back WITHOUT row-level security"
echo "[drill] ok: row-level security intact on every tenant table"

# --- 4. tenant isolation actually holds in the restored copy -----------------
# Needs two schools and the app role; skipped (with a warning) otherwise.
if [ "$SCHOOLS" -ge 2 ] && [ -n "${APP_ROLE_PASSWORD:-}" ]; then
  psql_run "$ADMIN_URL" -v ON_ERROR_STOP=1 -q \
    -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='${APP_ROLE}') THEN
          EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L', '${APP_ROLE}', '${APP_ROLE_PASSWORD}'); END IF; END \$\$;"
  psql_run "$ADMIN_URL" -v ON_ERROR_STOP=1 -q -c "GRANT CONNECT ON DATABASE \"${SCRATCH}\" TO ${APP_ROLE};"
  psql_run "$SCRATCH_URL" -v ON_ERROR_STOP=1 -q -c "GRANT USAGE ON SCHEMA public TO ${APP_ROLE};"
  psql_run "$SCRATCH_URL" -v ON_ERROR_STOP=1 -q -c "GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${APP_ROLE};"
  A=$(psql_run "$SCRATCH_URL" -tAc "SELECT id FROM school ORDER BY \"createdAt\" LIMIT 1;")
  APP_URL="$(echo "$SCRATCH_URL" | sed -E "s#://[^@]+@#://${APP_ROLE}:${APP_ROLE_PASSWORD}@#")"
  LEAK=$(psql_run "$APP_URL" -tAc "
    SELECT set_config('app.current_school_id','${A}',false);
    SELECT count(*) FROM \"user\" WHERE \"schoolId\" <> '${A}';" | tail -1)
  [ "$LEAK" = "0" ] || fail "tenant isolation BROKEN in the restore: saw $LEAK foreign-tenant user rows"
  echo "[drill] ok: tenant isolation holds in the restored database"
else
  echo "[drill] note: cross-tenant check skipped (needs >=2 schools + APP_ROLE_PASSWORD)"
fi

echo "[drill] PASS — this backup is restorable and safe."
