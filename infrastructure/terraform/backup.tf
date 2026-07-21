# =============================================================================
# AWS Backup — archival retention BEYOND the RDS 14-day PITR window
# =============================================================================
# RDS automated backups give point-in-time recovery for `backup_retention_period`
# days (14, see rds.tf) — excellent for "someone deleted rows this morning",
# useless for "we need the state from last term". This plan takes weekly and
# monthly snapshots of the database AND the Document Vault bucket into a
# dedicated, access-controlled vault with long retention.
#
# Restore is documented in docs/RUNBOOK-BACKUP-RESTORE.md and must be REHEARSED
# on the cadence stated there — an untested backup is not a backup.
# =============================================================================

resource "aws_backup_vault" "main" {
  name        = "${local.name}-vault"
  kms_key_arn = aws_kms_key.documents.arn
  tags        = { Name = "${local.name}-vault" }
}

# Deny deletion of recovery points before their retention elapses — protects
# the archive from an attacker (or a mistake) with backup permissions.
resource "aws_backup_vault_lock_configuration" "main" {
  count               = var.backup_vault_lock_enabled ? 1 : 0
  backup_vault_name   = aws_backup_vault.main.name
  min_retention_days  = 7
  max_retention_days  = 400
  changeable_for_days = 3
}

resource "aws_backup_plan" "main" {
  name = "${local.name}-plan"

  rule {
    rule_name         = "weekly"
    target_vault_name = aws_backup_vault.main.name
    schedule          = "cron(0 3 ? * SUN *)" # 03:00 UTC Sundays
    start_window      = 60
    completion_window = 300
    lifecycle {
      delete_after = var.backup_weekly_retention_days
    }
  }

  rule {
    rule_name         = "monthly"
    target_vault_name = aws_backup_vault.main.name
    schedule          = "cron(0 4 1 * ? *)" # 04:00 UTC on the 1st
    start_window      = 60
    completion_window = 420
    lifecycle {
      cold_storage_after = 30
      delete_after       = var.backup_monthly_retention_days
    }
  }

  tags = { Name = "${local.name}-plan" }
}

data "aws_iam_policy_document" "backup_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["backup.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "backup" {
  name               = "${local.name}-backup"
  assume_role_policy = data.aws_iam_policy_document.backup_assume.json
}

resource "aws_iam_role_policy_attachment" "backup_service" {
  role       = aws_iam_role.backup.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup"
}

resource "aws_iam_role_policy_attachment" "backup_restore" {
  role       = aws_iam_role.backup.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForRestores"
}

resource "aws_iam_role_policy_attachment" "backup_s3" {
  role       = aws_iam_role.backup.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForS3Backup"
}

resource "aws_backup_selection" "main" {
  iam_role_arn = aws_iam_role.backup.arn
  name         = "${local.name}-selection"
  plan_id      = aws_backup_plan.main.id

  resources = [
    aws_db_instance.main.arn,
    aws_s3_bucket.documents.arn,
  ]
}
