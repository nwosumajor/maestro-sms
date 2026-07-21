# Runbook — backup & restore

> **A backup you have never restored is not a backup.** This runbook exists to
> be *rehearsed*, not just read. The drill in §4 is the part that matters.

## 1. What is protected, and how

| Asset | Mechanism | Window | Where |
|---|---|---|---|
| Postgres (all tenant data) | RDS automated backups → point-in-time recovery | **14 days** | `infrastructure/terraform/rds.tf` (`backup_retention_period`) |
| Postgres (archival) | AWS Backup plan — weekly + monthly snapshots | **90 / 365 days** | `infrastructure/terraform/backup.tf` |
| Document Vault (S3: report cards, receipts, certificates) | Bucket **versioning** (undelete/overwrite recovery) + AWS Backup | versioning: indefinite; plan: 90 / 365 days | `s3.tf`, `backup.tf` |
| Postgres (self-hosted / compose) | `infrastructure/scripts/backup.sh` (logical `pg_dump`) | `BACKUP_RETENTION_DAYS`, default 14 | run it from cron |
| Deletion safety | RDS `deletion_protection = true`, final snapshot on destroy | — | `rds.tf` |

Encryption: RDS storage and the S3 vault use the customer-managed KMS key; the
AWS Backup vault uses the same key. Logical dumps are **not** encrypted at rest
by the script — store them on an encrypted volume or pipe through `age`/`gpg`.

## 2. Taking a backup

### Managed (AWS)
Automatic. Nothing to run. Verify recovery points exist:

```bash
aws backup list-recovery-points-by-backup-vault --backup-vault-name sms-prod-vault
aws rds describe-db-instances --db-instance-identifier sms-prod-pg \
  --query 'DBInstances[0].LatestRestorableTime'
```

### Self-hosted / compose (and for drills)
```bash
# ALWAYS dump with a client whose major version MATCHES the server —
# PG_CONTAINER runs pg_dump inside the DB container to guarantee that.
PG_CONTAINER=sms-postgres-1 \
DATABASE_URL="postgresql://postgres:$POSTGRES_PASSWORD@localhost:5432/sms" \
  ./infrastructure/scripts/backup.sh /var/backups/sms
```

> **Version trap (real, and it bit us):** a newer `pg_dump` (17+) writes
> `SET transaction_timeout`, which a PG16 server **rejects on restore** — the
> dump looks fine and is unrestorable. `backup.sh` warns when the host client is
> newer than the server; `PG_CONTAINER` removes the risk entirely.

## 3. Restoring for real (incident)

### 3a. Point-in-time (RDS) — "we need the state from 09:40 today"
```bash
aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier sms-prod-pg \
  --target-db-instance-identifier sms-prod-pg-restored \
  --restore-time 2026-07-21T09:40:00Z \
  --db-subnet-group-name sms-prod-db-subnets \
  --no-publicly-accessible
```
Restores into a **new instance** — the live one is untouched. Point the app at it
only after verifying (§4 checks apply here too), by updating the
`DATABASE_URL` secret and rolling the ECS services.

### 3b. Archival (AWS Backup) — "we need last term"
Restore the recovery point from the vault (console or `aws backup
start-restore-job`), then verify before cutting over.

### 3c. Logical dump
```bash
PG_CONTAINER=sms-postgres-1 \
  pg_restore --no-owner --no-privileges --dbname="$TARGET_URL" sms-….dump
```

### 3d. Document Vault object
Versioning is on: recover a deleted/overwritten object by restoring the prior
version (`aws s3api list-object-versions` → `copy-object` from the version id).

## 4. The drill — proving a backup is restorable

`infrastructure/scripts/restore-drill.sh` restores a dump into a **throwaway
scratch database** and asserts four things, failing loudly on any:

1. `pg_restore` completes with **no errors** (catches the version trap above).
2. The expected tables exist and carry rows (`school` is non-empty).
3. **Row-level security is still enabled on every tenant table** — a restore
   that silently lost RLS would be a catastrophic, invisible regression.
   (`ultimate_participant` is the one documented exemption — cross-tenant by
   design, no PII.)
4. **Tenant isolation actually holds in the restored copy**: the app role, with
   tenant A's GUC set, sees zero of tenant B's rows.

```bash
PG_CONTAINER=sms-postgres-1 \
ADMIN_URL="postgresql://postgres:$POSTGRES_PASSWORD@localhost:5432/postgres" \
APP_ROLE_PASSWORD="$APP_DB_PASSWORD" \
  ./infrastructure/scripts/restore-drill.sh /var/backups/sms/sms-….dump
```

Exit code 0 = the backup is restorable and safe. The scratch database is dropped
automatically (`KEEP_SCRATCH=1` to keep it for inspection).

### Cadence (do not skip)
| When | What |
|---|---|
| **Monthly** | Run the drill against the latest dump. Record the date + result. |
| **Quarterly** | Do a full §3a point-in-time restore into a scratch RDS instance; run the drill's checks against it; delete the instance. |
| **After any schema migration that adds a tenant table** | Run the drill — check 3 catches an RLS file that was never applied. |
| **Before any destructive maintenance** | Take a fresh dump and drill it. |

## 5. What is NOT covered

- **Redis** (cache, queues, rate-limit counters) is deliberately not backed up —
  it is derivable state. A cold Redis costs a warm-up, not data.
- **Secrets** live in AWS Secrets Manager (its own versioning); rotating or
  losing `AUTH_SECRET` invalidates sessions, and losing `DATA_ENCRYPTION_KEY`
  makes field-encrypted PII (medical, salaries) **permanently unreadable** —
  that key must be escrowed separately from the database backups.
- Logical dumps are unencrypted at rest unless you encrypt the destination.
