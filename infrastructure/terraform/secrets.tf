# =============================================================================
# Secrets Manager — every secret the tasks need. Generated here; never in code.
# ECS injects these into containers via the task execution role (see iam.tf).
# =============================================================================

# AUTH_SECRET (HS256 signing for the session/service/step-up/impersonation JWTs).
resource "random_password" "auth_secret" {
  length  = 64
  special = false
}

# DATA_ENCRYPTION_KEY — 32 random bytes, base64 (matches the app's field-crypto).
resource "random_id" "data_encryption_key" {
  byte_length = 32
}

# METRICS_TOKEN — bearer token gating the Prometheus /metrics endpoint.
# SECURITY: the endpoint is OPEN when this is unset, so production always
# generates one; the scraper reads it from Secrets Manager.
resource "random_password" "metrics_token" {
  length  = 48
  special = false
}

locals {
  # App reads/writes go through the RDS Proxy pooler when enabled (transaction
  # pooling is safe — the tenant GUC is transaction-local; `?pgbouncer=true`
  # keeps Prisma from leaning on persistent prepared statements). Migrations
  # ALWAYS connect direct to the writer (DDL/advisory locks need a real session).
  db_app_url     = var.enable_rds_proxy ? "postgresql://${var.db_app_username}:${random_password.db_app.result}@${aws_db_proxy.main[0].endpoint}:5432/${var.db_name}?pgbouncer=true" : "postgresql://${var.db_app_username}:${random_password.db_app.result}@${aws_db_instance.main.address}:5432/${var.db_name}"
  db_migrate_url = "postgresql://${var.db_master_username}:${random_password.db_master.result}@${aws_db_instance.main.address}:5432/${var.db_name}"
  # Read path: the replica endpoint when one exists, else the primary (so the
  # app's read-only tenant path is always valid and identical in single-DB mode).
  db_replica_url = var.db_read_replica_count > 0 ? "postgresql://${var.db_app_username}:${random_password.db_app.result}@${aws_db_instance.replica[0].address}:5432/${var.db_name}" : local.db_app_url

  # Base secrets, plus the Redis auth token only when transit encryption is on.
  secret_values = merge(
    {
      "auth-secret"          = random_password.auth_secret.result
      "auth-secret-previous" = var.auth_secret_previous
      "data-encryption-key" = random_id.data_encryption_key.b64_std
      "db-app-url"          = local.db_app_url
      "db-migrate-url"      = local.db_migrate_url
      "db-replica-url"      = local.db_replica_url
      "db-app-password"     = random_password.db_app.result
      "paystack-secret-key" = var.paystack_secret_key
      "stripe-secret-key"       = var.stripe_secret_key
      "stripe-webhook-secret"   = var.stripe_webhook_secret
      "email-api-key"           = var.email_api_key
      "twilio-auth-token"       = var.twilio_auth_token
      "metrics-token"           = random_password.metrics_token.result
    },
    var.redis_transit_encryption ? {
      "redis-auth-token" = random_password.redis_auth[0].result
    } : {},
  )
}

resource "aws_secretsmanager_secret" "this" {
  for_each = local.secret_values
  name     = "${local.name}/${each.key}"
}

resource "aws_secretsmanager_secret_version" "this" {
  for_each      = aws_secretsmanager_secret.this
  secret_id     = each.value.id
  secret_string = local.secret_values[each.key]
}
