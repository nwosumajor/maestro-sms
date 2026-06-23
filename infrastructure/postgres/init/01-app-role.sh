#!/bin/bash
# Runs once on first DB init. Provisions the least-privilege app role the backend
# connects as (RLS is enforced for it). Migrations + RLS grants run later as the
# superuser via the backend entrypoint. Golden Rule #4: app role != migration role.
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  DO \$\$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='major_user') THEN
      CREATE ROLE major_user LOGIN PASSWORD '${APP_DB_PASSWORD}';
    END IF;
  END \$\$;
  GRANT CONNECT ON DATABASE "$POSTGRES_DB" TO major_user;
  GRANT USAGE ON SCHEMA public TO major_user;
EOSQL
